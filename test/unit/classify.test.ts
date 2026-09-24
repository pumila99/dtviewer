import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { classify, globMatch, OTHER_REASON } from '../../src/core/classify';
import { loadModel } from '../../src/core/load';
import { loadConfig, mergeCategories, parseCategories } from '../../src/config/config';
import { fx, ROOT, setupParser } from '../helpers';

beforeAll(setupParser);

const builtin = loadConfig(path.join(ROOT, 'resources')).categories;

async function model() {
  return (await loadModel({ cpp: 'cpp', top: fx('classify/classify.dts'), rules: builtin })).model;
}

describe('classify', () => {
  it('UT-CLS-01 compatible で分類＋理由', async () => {
    const m = await model();
    const uart = m.byPath.get('/serial@ff130000')!;
    expect(uart.category).toMatchObject({ id: 'uart', reason: 'compatible rockchip,rk3328-uart が *uart* に一致' });
    expect(uart.category!.ruleSource!.file).toBe(path.join(ROOT, 'resources', 'categories.jsonc'));
    expect(m.byPath.get('/i2c@ff150000')!.category!.reason).toBe('compatible rockchip,rk3328-i2c が *i2c* に一致');
  });

  it('UT-CLS-02 ノード名で分類', async () => {
    const m = await model();
    expect(m.byPath.get('/i2c@ff160000')!.category).toMatchObject({ id: 'i2c', reason: 'ノード名 i2c@ff160000 が i2c@* に一致' });
  });

  it('UT-CLS-03 その他', async () => {
    const m = await model();
    expect(m.byPath.get('/mystery@ff170000')!.category).toEqual({ id: 'other', reason: OTHER_REASON });
    expect(m.root.category).toBeUndefined();
  });

  it('UT-CLS-04 ユーザールール優先', async () => {
    const user = parseCategories('/ws/.dtviewer/categories.jsonc', `{
      "categories": [
        { "id": "mystery", "label": "謎", "group": "独自", "match": { "compatible": ["acme,*"] } },
        { "id": "uart", "label": "シリアル", "group": "通信", "match": { "nodeName": ["serial@*"] } }
      ]
    }`);
    expect(user.errors).toEqual([]);
    const rules = mergeCategories(builtin, user.rules);
    expect(rules.filter((r) => r.id === 'uart')).toHaveLength(1);
    const m = (await loadModel({ cpp: 'cpp', top: fx('classify/classify.dts'), rules })).model;
    expect(m.byPath.get('/mystery@ff170000')!.category).toMatchObject({ id: 'mystery', ruleSource: { file: '/ws/.dtviewer/categories.jsonc', line: 3 } });
    // ユーザーの uart は nodeName だけなので、内蔵の compatible ルールは消えている
    expect(m.byPath.get('/serial@ff130000')!.category!.reason).toBe('ノード名 serial@ff130000 が serial@* に一致');
  });

  it('ワイルドカード', () => {
    expect(globMatch('*uart*', 'snps,dw-apb-UART')).toBe(true);
    expect(globMatch('i2c@?', 'i2c@1')).toBe(true);
    expect(globMatch('a.b', 'axb')).toBe(false);
    const node = { name: 'x', props: new Map(), children: [], defs: [], labels: [], path: '/x', status: 'okay' as const };
    expect(classify(node, []).id).toBe('other');
  });

  it('内蔵カテゴリがそろっている', () => {
    const groups = new Set(builtin.map((r) => r.group));
    for (const g of ['通信', 'GPIO・LED', 'ディスプレイ', '電源', 'ストレージ']) expect(groups).toContain(g);
    for (const id of ['uart', 'i2c', 'spi', 'gpio', 'led', 'display', 'regulator', 'pmic', 'emmc', 'sd']) expect(builtin.map((r) => r.id)).toContain(id);
  });
});
