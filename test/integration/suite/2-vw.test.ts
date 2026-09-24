import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { DtViewerApi } from '../../../src/extension';
import type { Elem, NodeElem } from '../../../src/views/structure';
import { api, reset, ws } from './helpers';

function find(elems: Elem[], pred: (e: Elem) => boolean): Elem | undefined {
  for (const e of elems) {
    if (pred(e)) return e;
    const hit = find(e.children, pred);
    if (hit) return hit;
  }
  return undefined;
}

const label = (a: DtViewerApi, e: Elem): string => String(a.structure.getTreeItem(e).label);

async function boardA(): Promise<DtViewerApi> {
  const a = await api();
  await reset(a);
  await a.manager.load({ top: ws('boards/a.dts'), profile: undefined });
  return a;
}

suite('IT-VW 構造ビュー', () => {
  teardown(async () => {
    await vscode.commands.executeCommand('dtviewer.viewByCategory');
    await vscode.commands.executeCommand('dtviewer.showDisabled');
  });

  test('IT-VW-01 カテゴリ別ツリー（バス配下は子、別カテゴリはリンク項目）', async () => {
    const a = await boardA();
    const roots = a.structure.getRoots();
    const groups = roots.map((r) => label(a, r));
    assert.deepEqual(groups, ['電源', '通信', 'GPIO・LED', 'その他']);
    const comm = roots.find((r) => label(a, r) === '通信')!;
    assert.deepEqual(comm.children.map((c) => label(a, c)), ['UART', 'I2C']);
    const uart = comm.children[0];
    assert.deepEqual(uart.children.map((c) => label(a, c)), ['● serial@1000', '○ serial@2000']);
    const i2c = comm.children[1].children[0] as NodeElem;
    assert.equal(label(a, i2c), '● i2c@3000');
    assert.deepEqual(i2c.children.map((c) => label(a, c)), ['● pmic@20']);
    // PMIC カテゴリにはリンク項目で出る
    const pmicLink = find(roots, (e) => e.kind === 'node' && e.link && e.node.name === 'pmic@20') as NodeElem;
    assert.ok(pmicLink);
    assert.equal(label(a, pmicLink), '● → pmic@20');
    assert.equal(a.structure.elemFor(pmicLink.node), i2c.children[0]);
    const other = roots.find((r) => label(a, r) === 'その他')!;
    assert.ok(find([other], (e) => e.kind === 'node' && e.node.name === 'mystery@4000'));
  });

  test('IT-VW-02 アドレス順', async () => {
    const a = await boardA();
    await vscode.commands.executeCommand('dtviewer.viewByAddress');
    const names = a.structure.getRoots().map((r) => (r as NodeElem).node.name);
    assert.deepEqual(names, ['leds', 'gpio@500', 'serial@1000', 'serial@2000', 'i2c@3000', 'mystery@4000']);
    const i2c = a.structure.getRoots().find((r) => (r as NodeElem).node.name === 'i2c@3000')!;
    assert.deepEqual(i2c.children.map((c) => (c as NodeElem).node.name), ['pmic@20']);
  });

  test('IT-VW-03 disabled を隠す', async () => {
    const a = await boardA();
    assert.ok(find(a.structure.getRoots(), (e) => e.kind === 'node' && e.node.name === 'serial@2000'));
    await vscode.commands.executeCommand('dtviewer.hideDisabled');
    assert.equal(find(a.structure.getRoots(), (e) => e.kind === 'node' && e.node.name === 'serial@2000'), undefined);
    await vscode.commands.executeCommand('dtviewer.viewByAddress');
    assert.equal(find(a.structure.getRoots(), (e) => e.kind === 'node' && e.node.name === 'serial@2000'), undefined);
    await vscode.commands.executeCommand('dtviewer.showDisabled');
    assert.ok(find(a.structure.getRoots(), (e) => e.kind === 'node' && e.node.name === 'serial@2000'));
  });

  test('IT-VW-04 ツールチップに分類理由と書かれた場所', async () => {
    const a = await boardA();
    const uart0 = a.structure.elemFor(a.manager.result!.model.byLabel.get('uart0')!)!;
    const tip = (a.structure.getTreeItem(uart0).tooltip as vscode.MarkdownString).value;
    assert.match(tip, /compatible acme,soc-uart が \*uart\* に一致/);
    assert.match(tip, /boards\/soc\.dtsi:6-10（共通）/);
    assert.match(tip, /boards\/common\.dtsi:3-5 ← 効いている/);
    const mystery = a.structure.elemFor(a.manager.result!.model.byPath.get('/mystery@4000')!)!;
    const tip2 = (a.structure.getTreeItem(mystery).tooltip as vscode.MarkdownString).value;
    assert.match(tip2, /どのルールにも一致しません/);
  });
});
