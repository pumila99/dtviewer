import * as path from 'node:path';
import * as vscode from 'vscode';
import type { WorkspaceManager } from '../workspace/manager';

export function statusText(profile: string | undefined, top: string | undefined, soc: string | undefined, partial = false): string {
  const name = profile ?? (top ? path.basename(top) : '（未選択）');
  return `DT: ${name}${partial ? '（部分表示）' : ''} | ${soc ?? '?'}`;
}

/** ステータスバーの `DT: <プロファイル名> | <SoC>` */
export class DtStatusBar implements vscode.Disposable {
  readonly item = vscode.window.createStatusBarItem('dtviewer.status', vscode.StatusBarAlignment.Left, 50);

  constructor(private readonly manager: WorkspaceManager) {
    this.item.name = 'DTビューア';
    this.item.command = 'dtviewer.selectTopDts';
    this.update();
  }

  update(): void {
    const m = this.manager;
    this.item.text = statusText(m.profileName, m.target?.top, m.result?.model.soc, m.target?.partial);
    this.item.tooltip = m.lastError ? `読み込みエラー: ${m.lastError}` : (m.target?.top ?? 'クリックでトップ dts を選ぶ');
    if (m.target) this.item.show();
    else this.item.hide();
  }

  dispose(): void {
    this.item.dispose();
  }
}
