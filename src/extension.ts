import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DtNode, SourceLoc } from './core/model';
import { initParser } from './core/parser';
import { DtStatusBar } from './views/statusBar';
import { StructureProvider, type Elem, type NodeElem } from './views/structure';
import { isDtsFile } from './workspace/decide';
import { WorkspaceManager } from './workspace/manager';

export interface OpenOptions {
  /** 一覧を出さずに効いている場所（defs の末尾）を開く */
  direct?: boolean;
  /** defs の何番目を開くか */
  index?: number;
}

/** 画面テストなどから使う */
export interface DtViewerApi {
  manager: WorkspaceManager;
  structure: StructureProvider;
  treeView: vscode.TreeView<Elem>;
  statusBar: DtStatusBar;
  /** 起動時の読み込みが終わったら解決する */
  started: Promise<void>;
}

function nodeFromArg(manager: WorkspaceManager, arg: unknown): DtNode | undefined {
  const model = manager.result?.model;
  if (!model) return undefined;
  if (typeof arg === 'string') return model.byPath.get(arg);
  if (arg && typeof arg === 'object' && 'node' in arg) return model.byPath.get((arg as NodeElem).node.path);
  return undefined;
}

async function openLoc(loc: SourceLoc): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(loc.file));
  const last = Math.min(loc.endLine, doc.lineCount) - 1;
  const range = new vscode.Range(loc.line - 1, 0, last, doc.lineAt(last).text.length);
  return vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, selection: range, preserveFocus: false });
}

export async function activate(context: vscode.ExtensionContext): Promise<DtViewerApi> {
  const dist = path.join(context.extensionPath, 'dist');
  await initParser({ runtime: path.join(dist, 'web-tree-sitter.wasm'), grammar: path.join(dist, 'tree-sitter-devicetree.wasm') });

  const output = vscode.window.createOutputChannel('DTビューア');
  const manager = new WorkspaceManager(context, output);
  const structure = new StructureProvider(() => manager.root);
  const treeView = vscode.window.createTreeView('dtviewer.structure', { treeDataProvider: structure, showCollapseAll: true });
  const statusBar = new DtStatusBar(manager);
  void vscode.commands.executeCommand('setContext', 'dtviewer.viewMode', 'category');
  void vscode.commands.executeCommand('setContext', 'dtviewer.hideDisabled', false);

  const refresh = (): void => {
    structure.setModel(manager.result?.model, manager.categories);
    treeView.message = manager.lastError
      ? `読み込みエラー: ${manager.lastError.split('\n')[0]}`
      : manager.target?.partial
        ? 'dtsi 単体で部分表示しています'
        : undefined;
    statusBar.update();
  };

  // エディタのカーソル位置 → ツリーで選択
  let timer: ReturnType<typeof setTimeout> | undefined;
  const revealAt = async (editor: vscode.TextEditor | undefined): Promise<void> => {
    if (!editor || !treeView.visible) return;
    const node = structure.nodeAt(editor.document.uri.fsPath, editor.selection.active.line + 1);
    const elem = node && structure.elemFor(node);
    if (elem) await treeView.reveal(elem, { select: true, focus: false, expand: false });
  };

  context.subscriptions.push(
    output,
    manager,
    treeView,
    statusBar,
    manager.onDidChange(refresh),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!isDtsFile(e.textEditor.document.uri.fsPath)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void revealAt(e.textEditor), 100);
    }),
    vscode.commands.registerCommand('dtviewer.openInEditor', async (arg?: unknown, opts?: OpenOptions) => {
      const node = nodeFromArg(manager, arg ?? treeView.selection[0]);
      if (!node || node.defs.length === 0) return undefined;
      let loc = node.defs[opts?.index ?? node.defs.length - 1];
      if (opts?.index === undefined && !opts?.direct && node.defs.length > 1) {
        const root = manager.root;
        const items = node.defs
          .map((d, i) => ({
            label: `${path.basename(d.file)}:${d.line}`,
            description: `${i === node.defs.length - 1 ? '効いている' : ''}${d.shared ? '（共通）' : ''}`,
            detail: root ? path.relative(root, d.file) : d.file,
            index: i,
          }))
          .reverse();
        const picked = (await manager.pick(items, { placeHolder: `${node.name} が書かれた場所` })) as (typeof items)[number] | undefined;
        if (!picked) return undefined;
        loc = node.defs[picked.index];
      }
      return openLoc(loc);
    }),
    vscode.commands.registerCommand('dtviewer.selectTopDts', () => manager.selectTopDts()),
    vscode.commands.registerCommand('dtviewer.reload', () => manager.reload()),
    vscode.commands.registerCommand('dtviewer.switchToFileBoard', (file?: string) => manager.switchToFileBoard(file)),
    vscode.commands.registerCommand('dtviewer.viewByAddress', () => structure.setMode('address')),
    vscode.commands.registerCommand('dtviewer.viewByCategory', () => structure.setMode('category')),
    vscode.commands.registerCommand('dtviewer.hideDisabled', () => structure.setHideDisabled(true)),
    vscode.commands.registerCommand('dtviewer.showDisabled', () => structure.setHideDisabled(false)),
  );

  const started = manager.start().then(() => manager.whenIdle());
  return { manager, structure, treeView, statusBar, started };
}

export function deactivate(): void {
  // 破棄は context.subscriptions に任せる
}
