import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DtViewerApi } from '../../../src/extension';

export const WS = process.env.DTV_IT_WORKSPACE ?? vscode.workspace.workspaceFolders![0].uri.fsPath;
export const ws = (...p: string[]): string => path.join(WS, ...p);

export async function api(): Promise<DtViewerApi> {
  const ext = vscode.extensions.getExtension<DtViewerApi>('pumila99.dtviewer')!;
  const a = ext.isActive ? ext.exports : await ext.activate();
  await a.started;
  return a;
}

export async function waitFor<T>(fn: () => T | undefined | false, what: string, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`待ちきれませんでした: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function open(file: string): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  return vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
}

/** トップ未決定の状態に戻す */
export async function reset(a: DtViewerApi): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await a.manager.whenIdle();
  a.manager.target = undefined;
  a.manager.result = undefined;
  a.manager.pendingSwitch = undefined;
}
