import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { SWITCH_ACTION } from '../../../src/workspace/manager';
import { api, open, reset, waitFor, ws } from './helpers';

suite('IT-WS トップ dts の決め方', () => {
  test('IT-WS-01 プロファイルにトップがあればそれ（ステータスバー・保存で再読込）', async () => {
    const a = await api();
    assert.equal(a.manager.target?.profile?.name, 'BoardA');
    assert.equal(a.manager.target?.top, ws('boards/a.dts'));
    assert.equal(a.statusBar.item.text, 'DT: BoardA | acme,soc');
    assert.ok(a.manager.result?.model.byPath.has('/leds/led0'));

    // 保存時に再読込
    const ed = await open(ws('boards/a.dts'));
    const original = ed.document.getText();
    const all = (): vscode.Range => new vscode.Range(0, 0, ed.document.lineCount, 0);
    await ed.edit((e) => e.replace(all(), `${original}\n/ {\n\tadded-node {\n\t};\n};\n`));
    await ed.document.save();
    await waitFor(() => a.manager.result?.model.byPath.has('/added-node'), '保存後の再読込');
    await ed.edit((e) => e.replace(all(), original));
    await ed.document.save();
    await waitFor(() => !a.manager.result?.model.byPath.has('/added-node'), '元に戻した後の再読込');
  });

  test('IT-WS-02 開いたのが .dts ならそれ', async () => {
    const a = await api();
    await reset(a);
    await open(ws('boards/other.dts'));
    await waitFor(() => a.manager.target?.top === ws('boards/other.dts'), 'other.dts がトップ');
    await a.manager.whenIdle();
    assert.equal(a.manager.result?.model.soc, 'acme,other');
    assert.equal(a.statusBar.item.text, 'DT: other.dts | acme,other');
  });

  test('IT-WS-03 .dtsi は include している dts を逆引き（多段・1 つ）', async () => {
    const a = await api();
    await reset(a);
    await open(ws('boards/deep/single-deep.dtsi'));
    await waitFor(() => a.manager.target?.top === ws('boards/single.dts'), 'single.dts がトップ');
    await a.manager.whenIdle();
    assert.ok(a.manager.result?.model.byPath.has('/deep-node'));
  });

  test('IT-WS-03 .dtsi を複数の dts が include していれば選ばせて topByDtsi に記憶', async () => {
    const a = await api();
    await reset(a);
    const asked: string[][] = [];
    const orig = a.manager.pick;
    a.manager.pick = async (items) => {
      asked.push(items.map((i) => i.label));
      return items.find((i) => i.label === 'b.dts');
    };
    try {
      await open(ws('boards/common.dtsi'));
      await waitFor(() => a.manager.target?.top === ws('boards/b.dts'), 'b.dts がトップ');
    } finally {
      a.manager.pick = orig;
    }
    assert.deepEqual(asked, [['a.dts', 'b.dts']]);
    const text = fs.readFileSync(ws('.dtviewer/profiles.jsonc'), 'utf8');
    assert.match(text, /"common.dtsi": "boards\/b.dts"/);
    assert.match(text, /画面テスト用のプロファイル/);

    // 2 回目は記憶が使われて聞かれない
    await reset(a);
    a.manager.pick = async () => assert.fail('聞かれないはず');
    try {
      await open(ws('boards/common.dtsi'));
      await waitFor(() => a.manager.target?.top === ws('boards/b.dts'), '記憶した b.dts がトップ');
    } finally {
      a.manager.pick = orig;
    }
  });

  test('IT-WS-04 だれも include していない .dtsi は単体で部分表示', async () => {
    const a = await api();
    await reset(a);
    await open(ws('boards/lone.dtsi'));
    await waitFor(() => a.manager.target?.top === ws('boards/lone.dtsi'), 'lone.dtsi がトップ');
    await a.manager.whenIdle();
    assert.equal(a.manager.target?.partial, true);
    assert.ok(a.manager.result?.model.byPath.has('/lone-node'));
    assert.match(a.statusBar.item.text, /部分表示/);
    assert.equal(a.treeView.message, 'dtsi 単体で部分表示しています');
  });

  test('IT-WS-05 トップに含まれないファイルはツリーを変えずに切り替えを提案', async () => {
    const a = await api();
    await reset(a);
    await a.manager.load({ top: ws('boards/a.dts') });
    const before = a.structure.getRoots();
    const notes: string[] = [];
    const orig = a.manager.notify;
    a.manager.notify = async (msg, ...actions) => {
      notes.push(`${msg} [${actions.join(',')}]`);
      return undefined;
    };
    try {
      await open(ws('boards/other.dts'));
      await waitFor(() => a.manager.pendingSwitch === ws('boards/other.dts'), '切り替えの提案');
    } finally {
      a.manager.notify = orig;
    }
    assert.equal(a.manager.target?.top, ws('boards/a.dts'));
    assert.equal(a.structure.getRoots(), before);
    assert.ok(notes.some((n) => n.includes(SWITCH_ACTION)));
    // 含まれるファイルなら提案しない
    await open(ws('boards/common.dtsi'));
    await waitFor(() => a.manager.pendingSwitch === undefined, '提案の取り消し');

    await open(ws('boards/other.dts'));
    await waitFor(() => a.manager.pendingSwitch === ws('boards/other.dts'), '再度の提案');
    await vscode.commands.executeCommand('dtviewer.switchToFileBoard');
    await a.manager.whenIdle();
    assert.equal(a.manager.target?.top, ws('boards/other.dts'));
  });
});
