import { beforeAll, describe, expect, it } from 'vitest';
import { buildMacroIndex, findRaw, parseSource } from '../../src/core/source';
import { fx, setupParser } from '../helpers';

beforeAll(setupParser);

describe('source', () => {
  it('UT-SRC-01 CST とコメント', async () => {
    const src = await parseSource(fx('basic/basic.dts'));
    expect(src.tree.rootNode.type).toBe('document');
    expect(src.comments).toEqual([{ line: 9, text: '// メモリ' }]);
    expect(src.errors).toEqual([]);
    expect(findRaw(src, 37, 'expr')).toBe('<(1 + 2) (0x10 << 4) (-1) (5 > 3 ? 7 : 9)>');
    expect(findRaw(src, 34, 'small')).toBe('/bits/ 8 <0x12 0x34>');
    expect(findRaw(src, 38, 'flag')).toBe('');
    expect(findRaw(src, 38, 'nosuch')).toBeUndefined();
  });

  it('UT-SRC-02 #define 索引', async () => {
    const h = await parseSource(fx('macro/include/dt-bindings/acme.h'));
    const d = await parseSource(fx('macro/macro.dts'));
    expect(d.includes).toEqual([{ path: 'dt-bindings/acme.h', line: 2 }]);
    const idx = buildMacroIndex([h, d], (f) => f.endsWith('.h'));
    expect(idx.get('LOCAL_SPEED')).toMatchObject({ value: '115200', def: { file: fx('macro/macro.dts'), line: 4, shared: false } });
    expect(idx.get('LOCAL_SPEED')!.uses).toEqual([{ file: fx('macro/macro.dts'), line: 13, endLine: 13, shared: false }]);
    expect(idx.get('ACME_IRQ')).toMatchObject({ value: '(ACME_IRQ_BASE + (n))', def: { line: 6, shared: true } });
    expect(idx.get('ACME_IRQ')!.uses.map((u) => u.line)).toEqual([12]);
    // マクロの本体に出てくるマクロも使用箇所
    expect(idx.get('ACME_IRQ_BASE')!.uses).toEqual([{ file: fx('macro/include/dt-bindings/acme.h'), line: 6, endLine: 6, shared: true }]);
    expect(idx.get('BOARD_NAME')!.uses.map((u) => u.line)).toEqual([8]);
    // #ifndef で使っている
    expect(idx.get('_ACME_H')!.uses.map((u) => u.line)).toEqual([1]);
  });

  it('UT-SRC-03 構文エラーでも読める', async () => {
    const src = await parseSource(fx('errors/errors.dts'));
    expect(src.errors.length).toBeGreaterThan(0);
    expect(src.errors[0].line).toBe(11);
    // エラーの後ろのプロパティも索引にある
    expect(findRaw(src, 15, 'ok')).toBe('"yes"');
    expect(findRaw(src, 7, 'value')).toBe('<1>');
  });

  it('テキストを渡して読める', async () => {
    const src = await parseSource('/virtual.dts', '#define A 1\n/ { x = <A>; };\n');
    expect(src.defines).toEqual([{ name: 'A', value: '1', params: undefined, line: 1, endLine: 1 }]);
    expect(buildMacroIndex([src]).get('A')!.uses).toHaveLength(1);
  });
});
