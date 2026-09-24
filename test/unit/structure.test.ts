import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config';
import { loadModel } from '../../src/core/load';
import type { DtModel } from '../../src/core/model';
import { statusText } from '../../src/views/statusBar';
import { addressKey, buildTree, nodeTooltip, type Elem } from '../../src/views/structure';
import { fx, ROOT, setupParser } from '../helpers';

beforeAll(setupParser);

const rules = loadConfig(path.join(ROOT, 'resources')).categories;
let model: DtModel;
beforeAll(async () => {
  model = (await loadModel({ cpp: 'cpp', top: fx('workspace/boards/a.dts'), rules, workspaceRoots: [fx('workspace')] })).model;
});

const name = (e: Elem): string => (e.kind === 'node' ? `${e.link ? '→' : ''}${e.node.name}` : e.kind === 'group' ? e.label : e.label);
const dump = (es: Elem[]): unknown => es.map((e) => (e.children.length ? { [name(e)]: dump(e.children) } : name(e)));

describe('構造ビューの組み立て', () => {
  it('カテゴリ別', () => {
    const { roots, primary } = buildTree(model, rules, 'category', false);
    expect(dump(roots)).toEqual([
      { 電源: [{ PMIC: ['→pmic@20'] }] },
      { 通信: [{ UART: ['serial@1000', 'serial@2000'] }, { I2C: [{ 'i2c@3000': ['pmic@20'] }] }] },
      { 'GPIO・LED': [{ LED: [{ leds: ['led0'] }, '→led0'] }, { GPIO: ['gpio@500'] }] },
      { その他: [{ その他: ['mystery@4000'] }] },
    ]);
    const pmic = model.byPath.get('/i2c@3000/pmic@20')!;
    expect(primary.get(pmic)!.parent!.kind).toBe('node');
    // 全ノードに本体の項目がある
    for (const n of model.byPath.values()) if (n !== model.root) expect(primary.has(n), n.path).toBe(true);
  });

  it('アドレス順と disabled 非表示', () => {
    const { roots } = buildTree(model, rules, 'address', false);
    expect(roots.map(name)).toEqual(['leds', 'gpio@500', 'serial@1000', 'serial@2000', 'i2c@3000', 'mystery@4000']);
    const hidden = buildTree(model, rules, 'address', true).roots.map(name);
    expect(hidden).not.toContain('serial@2000');
    expect(JSON.stringify(dump(buildTree(model, rules, 'category', true).roots))).not.toContain('serial@2000');
    expect(addressKey('x@0,1a')).toEqual([0n, 0x1an]);
    expect(addressKey('x@zz')).toBeUndefined();
    expect(addressKey('x')).toBeUndefined();
  });

  it('ツールチップとステータスバー', () => {
    const tip = nodeTooltip(model.byLabel.get('uart0')!, fx('workspace'));
    expect(tip).toContain('compatible acme,soc-uart が *uart* に一致');
    expect(tip).toContain('boards/soc.dtsi:6-10（共通）');
    expect(tip).toContain('boards/common.dtsi:3-5 ← 効いている');
    expect(nodeTooltip(model.byPath.get('/mystery@4000')!)).toContain('どのルールにも一致しません');
    expect(statusText('BoardA', undefined, 'acme,soc')).toBe('DT: BoardA | acme,soc');
    expect(statusText(undefined, '/x/lone.dtsi', undefined, true)).toBe('DT: lone.dtsi（部分表示） | ?');
    expect(statusText(undefined, undefined, undefined)).toBe('DT: （未選択） | ?');
  });
});
