import * as path from 'node:path';
import * as vscode from 'vscode';
import { CATEGORIES_FILE, loadConfig, PROFILES_FILE, rememberTopByDtsi, USER_DIR, type LoadedConfig } from '../config/config';
import { loadModel, type LoadResult } from '../core/load';
import { PreprocessError } from '../core/preprocess';
import { findTool } from '../core/tools';
import { decideByProfile, decideForFile, isDtsFile, rememberValue, targetFor, type Decision, type Target } from './decide';
import { IncludeGraph } from './includeGraph';
import { defaultIncludes, resolveIn } from './paths';

export type Picker = (items: vscode.QuickPickItem[], options: vscode.QuickPickOptions) => Thenable<vscode.QuickPickItem | undefined>;
export type Notifier = (message: string, ...actions: string[]) => Thenable<string | undefined>;

export const SWITCH_ACTION = 'このファイルのボードに切り替え';
export const AUTOSAVE_ACTION = 'このワークスペースで自動保存を ON にする';
const AUTOSAVE_ASKED = 'dtviewer.autoSaveAsked';

/** トップ dts の決定、読み込み、保存時の再読込を受け持つ */
export class WorkspaceManager implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<LoadResult | undefined>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private config: LoadedConfig;
  private graph: IncludeGraph | undefined;
  private abort: AbortController | undefined;
  private loading: Promise<void> = Promise.resolve();
  target: Target | undefined;
  result: LoadResult | undefined;
  lastError: string | undefined;
  /** 今のトップに含まれないファイルを開いたときの、切り替え候補 */
  pendingSwitch: string | undefined;

  /** テストで差し替えられるように */
  pick: Picker = (items, options) => vscode.window.showQuickPick(items, options);
  notify: Notifier = (message, ...actions) => vscode.window.showInformationMessage(message, ...actions);

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    this.config = loadConfig(this.resourcesDir, this.root);
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((d) => this.onSaved(d.uri.fsPath)),
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e) void this.onOpened(e.document.uri.fsPath);
      }),
    );
    if (this.root) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, `${USER_DIR}/*.jsonc`));
      const reload = (): void => void this.reloadConfig();
      this.disposables.push(w, w.onDidChange(reload), w.onDidCreate(reload), w.onDidDelete(reload));
    }
  }

  get root(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  get roots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  }

  private get resourcesDir(): string {
    return path.join(this.context.extensionPath, 'resources');
  }

  get categories(): LoadedConfig['categories'] {
    return this.config.categories;
  }

  get profileName(): string | undefined {
    return this.target?.profile?.name;
  }

  /** 読み込み中のものが終わるまで待つ */
  whenIdle(): Promise<void> {
    return this.loading;
  }

  dispose(): void {
    this.abort?.abort();
    for (const d of this.disposables) d.dispose();
  }

  async start(): Promise<void> {
    this.reportConfigErrors();
    void this.suggestAutoSave();
    const root = this.root;
    if (!root) return;
    const byProfile = decideByProfile(root, this.config.profiles);
    if (byProfile.kind === 'target') return this.load(byProfile.target);
    const file = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (file && isDtsFile(file)) await this.onOpened(file);
  }

  private reportConfigErrors(): void {
    for (const e of this.config.errors) {
      this.output.appendLine(`${e.file}:${e.line}:${e.column}: ${e.message}`);
    }
    const first = this.config.errors[0];
    if (first) {
      void vscode.window.showWarningMessage(
        `DTビューア: 設定の書式ミスがあるため内蔵設定で動きます（${path.basename(first.file)} ${first.line} 行目: ${first.message}）`,
      );
    }
  }

  async reloadConfig(): Promise<void> {
    this.config = loadConfig(this.resourcesDir, this.root);
    this.reportConfigErrors();
    if (this.target) {
      // プロファイルの中身が変わっているかもしれないので引き直す
      const t = this.target.profile ? this.config.profiles.profiles.get(this.target.profile.name) : undefined;
      const next = t && this.root ? { top: path.resolve(resolveIn(this.root, t.top)), profile: t } : this.target;
      await this.load(next);
    }
  }

  private async getGraph(): Promise<IncludeGraph> {
    if (!this.graph) {
      const uris = await vscode.workspace.findFiles('**/*.{dts,dtsi}', '**/node_modules/**');
      this.graph = new IncludeGraph(
        uris.map((u) => u.fsPath),
        this.root ? [path.join(this.root, 'include')] : [],
      );
    }
    return this.graph;
  }

  /** エディタで dts/dtsi を開いた（アクティブになった） */
  async onOpened(file: string): Promise<void> {
    if (!isDtsFile(file) || !this.root) return;
    if (this.target) {
      const files = this.result?.model.files ?? [];
      if (files.includes(file) || path.resolve(this.target.top) === path.resolve(file)) {
        this.pendingSwitch = undefined;
        return;
      }
      // 6.3-4: ツリーは変えずに切り替えを提案する
      this.pendingSwitch = file;
      void this.notify(`${path.basename(file)} は今のボード（${path.basename(this.target.top)}）に含まれていません`, SWITCH_ACTION).then((a) => {
        if (a === SWITCH_ACTION && this.pendingSwitch === file) void this.switchToFileBoard(file);
      });
      return;
    }
    await this.applyDecision(decideForFile(this.root, this.config.profiles, await this.getGraph(), file));
  }

  async switchToFileBoard(file = this.pendingSwitch): Promise<void> {
    if (!file || !this.root) return;
    this.pendingSwitch = undefined;
    await this.applyDecision(decideForFile(this.root, this.config.profiles, await this.getGraph(), file));
  }

  private async applyDecision(d: Decision): Promise<void> {
    if (d.kind === 'target') return this.load(d.target);
    if (d.kind !== 'choose' || !this.root) return;
    const root = this.root;
    const picked = await this.pick(
      d.candidates.map((c) => ({ label: path.basename(c), description: path.relative(root, c), detail: c })),
      { placeHolder: `${path.basename(d.dtsi)} を include している dts が複数あります。トップを選んでください` },
    );
    if (!picked?.detail) return;
    const target = targetFor(root, this.config.profiles, picked.detail);
    try {
      rememberTopByDtsi(root, path.basename(d.dtsi), rememberValue(root, target));
      this.config = loadConfig(this.resourcesDir, root);
    } catch (e) {
      this.output.appendLine(`topByDtsi を保存できませんでした: ${String(e)}`);
    }
    await this.load(target);
  }

  /** トップ dts を選び直す（プロファイルとワークスペースの dts から） */
  async selectTopDts(): Promise<void> {
    const root = this.root;
    if (!root) return;
    const items: vscode.QuickPickItem[] = [];
    for (const p of this.config.profiles.profiles.values()) {
      items.push({ label: `$(settings) ${p.name}`, description: p.top, detail: `profile:${p.name}` });
    }
    const uris = await vscode.workspace.findFiles('**/*.dts', '**/node_modules/**');
    for (const u of uris.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
      items.push({ label: path.basename(u.fsPath), description: path.relative(root, u.fsPath), detail: u.fsPath });
    }
    const picked = await this.pick(items, { placeHolder: 'トップ dts（またはプロファイル）を選んでください' });
    if (!picked?.detail) return;
    if (picked.detail.startsWith('profile:')) {
      const d = decideByProfile(root, this.config.profiles, picked.detail.slice('profile:'.length));
      if (d.kind === 'target') await this.load(d.target);
      return;
    }
    await this.load(targetFor(root, this.config.profiles, picked.detail));
  }

  private onSaved(file: string): void {
    const root = this.root;
    if (root && path.dirname(file) === path.join(root, USER_DIR) && [PROFILES_FILE, CATEGORIES_FILE].includes(path.basename(file))) {
      return; // ファイル監視で拾う
    }
    if (isDtsFile(file) || file.endsWith('.h')) this.graph = undefined;
    if (!this.target) return;
    const files = this.result?.model.files ?? [this.target.top];
    if (files.includes(file) || isDtsFile(file)) void this.reload();
  }

  async reload(): Promise<void> {
    if (this.target) await this.load(this.target);
  }

  /** トップを読み込む。前の読み込みは中断する。モデルは毎回作り直す */
  load(target: Target): Promise<void> {
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;
    this.target = target;
    this.pendingSwitch = undefined;
    const run = async (): Promise<void> => {
      const roots = this.roots;
      const cpp = findTool('cpp', roots);
      if (!cpp) {
        this.fail('cpp が見つかりません（PATH・Buildroot の output/host/bin を探しました）');
        return;
      }
      const root = this.root ?? path.dirname(target.top);
      const includes = target.profile
        ? [...target.profile.include.map((i) => resolveIn(root, i)), ...defaultIncludes(target.top)]
        : defaultIncludes(target.top);
      try {
        const r = await loadModel({
          cpp,
          top: target.top,
          includes: [...new Set(includes)],
          defines: target.profile?.defines,
          soc: target.profile?.soc,
          rules: this.config.categories,
          workspaceRoots: roots,
          signal: ac.signal,
        });
        if (ac.signal.aborted) return;
        this.result = r;
        this.lastError = undefined;
        for (const p of r.problems) {
          this.output.appendLine(`${p.loc ? `${p.loc.file}:${p.loc.line}: ` : ''}${p.message}`);
        }
        this.changed.fire(r);
      } catch (e) {
        if (ac.signal.aborted) return;
        const msg = e instanceof PreprocessError ? `${e.message}\n${e.stderr}` : String(e);
        this.fail(msg);
      }
    };
    const p = this.loading.then(run, run);
    this.loading = p;
    return p;
  }

  private fail(message: string): void {
    this.lastError = message;
    this.result = undefined;
    this.output.appendLine(message);
    void vscode.window.showErrorMessage(`DTビューア: ${message.split('\n')[0]}`);
    this.changed.fire(undefined);
  }

  /** 自動保存が OFF なら、初回だけ ON を提案する */
  private async suggestAutoSave(): Promise<void> {
    if (!this.root || this.context.workspaceState.get<boolean>(AUTOSAVE_ASKED)) return;
    const mode = vscode.workspace.getConfiguration('files').get<string>('autoSave');
    if (mode && mode !== 'off') return;
    await this.context.workspaceState.update(AUTOSAVE_ASKED, true);
    const a = await this.notify('DTビューアは保存時に再読込します（未保存の内容は反映されません）', AUTOSAVE_ACTION);
    if (a === AUTOSAVE_ACTION) {
      await vscode.workspace.getConfiguration('files').update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Workspace);
    }
  }
}
