import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { NodeElem } from '../../../src/views/structure';
import { api, open, reset, waitFor, ws } from './helpers';

suite('IT-LK エディタとの連動', () => {
  test('IT-LK-01 カーソル移動 → ツリーで選択', async () => {
    const a = await api();
    await reset(a);
    await a.manager.load({ top: ws('boards/a.dts') });
    await vscode.commands.executeCommand('workbench.view.extension.dtviewer');
    await waitFor(() => a.treeView.visible, 'ツリーが見える');
    const ed = await open(ws('boards/a.dts'));
    // led0 { の行（12 行目）
    ed.selection = new vscode.Selection(12, 2, 12, 2);
    const sel = await waitFor(() => a.treeView.selection[0] as NodeElem | undefined, 'ツリーの選択');
    assert.equal(sel.node.path, '/leds/led0');
    ed.selection = new vscode.Selection(5, 2, 5, 2);
    await waitFor(() => (a.treeView.selection[0] as NodeElem | undefined)?.node.path === '/', 'ルートは選ばない', 1000).catch(() => undefined);
    assert.notEqual((a.treeView.selection[0] as NodeElem).node.path, '/');
  });

  test('IT-LK-02 openInEditor で横のエディタを開いて範囲選択', async () => {
    const a = await api();
    await reset(a);
    await a.manager.load({ top: ws('boards/a.dts') });
    await open(ws('boards/a.dts'));
    const ed = (await vscode.commands.executeCommand('dtviewer.openInEditor', '/leds/led0', { direct: true })) as vscode.TextEditor;
    assert.equal(ed.document.uri.fsPath, ws('boards/a.dts'));
    assert.equal(ed.viewColumn, vscode.ViewColumn.Two);
    assert.equal(ed.selection.start.line, 10);
    assert.equal(ed.selection.end.line, 12);

    // 場所が複数あれば一覧から選べる（効いている場所が先頭）
    const orig = a.manager.pick;
    let offered: string[] = [];
    a.manager.pick = async (items) => {
      offered = items.map((i) => `${i.label} ${i.description}`);
      return items[items.length - 1];
    };
    try {
      const ed2 = (await vscode.commands.executeCommand('dtviewer.openInEditor', '/i2c@3000')) as vscode.TextEditor;
      assert.deepEqual(offered, ['common.dtsi:7 効いている', 'soc.dtsi:18 （共通）']);
      assert.equal(ed2.document.uri.fsPath, ws('boards/soc.dtsi'));
      assert.equal(ed2.selection.start.line, 17);
      assert.equal(ed2.selection.end.line, 23);
    } finally {
      a.manager.pick = orig;
    }
  });
});
