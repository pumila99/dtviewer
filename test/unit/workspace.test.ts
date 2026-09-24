import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyProfiles, parseProfiles } from '../../src/config/config';
import { decideByProfile, decideForFile, isDtsFile, rememberValue } from '../../src/workspace/decide';
import { IncludeGraph, readIncludes } from '../../src/workspace/includeGraph';
import { defaultIncludes, findKernelRoot } from '../../src/workspace/paths';
import { fx } from '../helpers';

const graphOf = (files: Record<string, string[]>, dirs: string[] = []) => new IncludeGraph(Object.keys(files), dirs, (f) => files[f] ?? []);

describe('workspace', () => {
  it('include の逆引き（多段）', () => {
    const g = graphOf({
      '/w/a/board1.dts': ['soc-board.dtsi'],
      '/w/a/board2.dts': ['soc-board.dtsi', 'dt-bindings/gpio/gpio.h'],
      '/w/a/soc-board.dtsi': ['soc.dtsi'],
      '/w/a/soc.dtsi': [],
      '/w/b/other.dts': ['../a/soc.dtsi'],
      '/w/lone.dtsi': [],
      '/w/c/x.dts': ['sub/y.dtsi'],
      '/w/d/sub/y.dtsi': [],
    });
    expect(g.topsIncluding('/w/a/soc.dtsi')).toEqual(['/w/a/board1.dts', '/w/a/board2.dts', '/w/b/other.dts']);
    expect(g.topsIncluding('/w/lone.dtsi')).toEqual([]);
    // 見つからないときはファイル名で照合
    expect(g.topsIncluding('/w/d/sub/y.dtsi')).toEqual(['/w/c/x.dts']);
  });

  it('ファイルから include を読む', () => {
    expect(readIncludes(fx('override/board.dts'))).toEqual(['soc.dtsi', 'board.dtsi']);
    expect(readIncludes('/nonexistent')).toEqual([]);
    expect(readIncludes('x', '/include/ "a.dtsi"\n  #include <b.h>\n')).toEqual(['a.dtsi', 'b.h']);
  });

  it('トップの決め方', () => {
    const root = '/w';
    const g = graphOf({
      '/w/one.dts': ['one.dtsi'],
      '/w/one.dtsi': [],
      '/w/m1.dts': ['multi.dtsi'],
      '/w/m2.dts': ['multi.dtsi'],
      '/w/multi.dtsi': [],
      '/w/alone.dtsi': [],
    });
    const none = emptyProfiles();
    expect(decideForFile(root, none, g, '/w/m1.dts')).toMatchObject({ kind: 'target', target: { top: '/w/m1.dts' } });
    expect(decideForFile(root, none, g, '/w/one.dtsi')).toMatchObject({ kind: 'target', target: { top: '/w/one.dts' } });
    expect(decideForFile(root, none, g, '/w/multi.dtsi')).toEqual({ kind: 'choose', dtsi: '/w/multi.dtsi', candidates: ['/w/m1.dts', '/w/m2.dts'] });
    expect(decideForFile(root, none, g, '/w/alone.dtsi')).toMatchObject({ kind: 'target', target: { top: '/w/alone.dtsi', partial: true } });
    expect(decideForFile(root, none, g, '/w/readme.txt')).toEqual({ kind: 'none' });
    const prof = parseProfiles('p', '{ "profiles": { "P": { "top": "m2.dts" } }, "default": "P", "topByDtsi": { "multi.dtsi": "m1.dts", "one.dtsi": "P" } }').profiles;
    expect(decideForFile(root, prof, g, '/w/multi.dtsi')).toMatchObject({ kind: 'target', target: { top: '/w/m1.dts' }, reason: '記憶した選択' });
    expect(decideForFile(root, prof, g, '/w/one.dtsi')).toMatchObject({ kind: 'target', target: { top: '/w/m2.dts', profile: { name: 'P' } } });
    expect(decideForFile(root, prof, g, '/w/m2.dts')).toMatchObject({ kind: 'target', target: { profile: { name: 'P' } } });
    expect(decideByProfile(root, prof)).toMatchObject({ kind: 'target', target: { top: '/w/m2.dts' } });
    expect(decideByProfile(root, none)).toEqual({ kind: 'none' });
    expect(rememberValue(root, { top: '/w/sub/a.dts' })).toBe('sub/a.dts');
    expect(rememberValue(root, { top: '/w/m2.dts', profile: prof.profiles.get('P') })).toBe('P');
    expect(isDtsFile('a.dtsi') && isDtsFile('a.dts') && !isDtsFile('a.h')).toBe(true);
  });

  it('カーネルの include パス', () => {
    const top = fx('kernel/arch/arm64/boot/dts/rockchip/rk3328-rock64.dts');
    expect(findKernelRoot(top)).toBe(fx('kernel'));
    expect(defaultIncludes(top)).toEqual([path.dirname(top), fx('kernel/include'), fx('kernel/arch/arm64/boot/dts')]);
    expect(findKernelRoot('/nonexistent/x.dts')).toBeUndefined();
  });
});
