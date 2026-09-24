import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cppArgs, parseLineMarkers, preprocess, PreprocessError } from '../../src/core/preprocess';
import { findTool } from '../../src/core/tools';
import { fx } from '../helpers';

function lineOf(text: string, needle: string): number {
  return text.split('\n').findIndex((l) => l.includes(needle));
}

describe('preprocess', () => {
  it('UT-PRE-01 cpp 出力と行対応表', async () => {
    const top = fx('basic/basic.dts');
    const r = await preprocess({ cpp: 'cpp', top });
    expect(r.text).not.toMatch(/^#/m);
    expect(r.lineMap.length).toBe(r.text.split('\n').length - 1);
    const i = lineOf(r.text, 'model = "Basic Board"');
    expect(r.lineMap[i]).toEqual({ file: top, line: 4 });
    expect(r.files).toEqual([top]);
  });

  it('UT-PRE-02 多段 include で元に戻せる', async () => {
    const r = await preprocess({ cpp: 'cpp', top: fx('include/top.dts') });
    const i = lineOf(r.text, 'from = "deep"');
    expect(r.lineMap[i]).toEqual({ file: fx('include/inc/sub/deep.dtsi'), line: 4 });
    const j = lineOf(r.text, 'from = "mid"');
    expect(r.lineMap[j]).toEqual({ file: fx('include/inc/mid.dtsi'), line: 5 });
    const k = lineOf(r.text, 'model = "Include Board"');
    expect(r.lineMap[k]).toEqual({ file: fx('include/top.dts'), line: 5 });
    expect(r.files).toEqual([fx('include/top.dts'), fx('include/inc/mid.dtsi'), fx('include/inc/sub/deep.dtsi')]);
  });

  it('UT-PRE-03 -D で ifdef 切替', async () => {
    const off = await preprocess({ cpp: 'cpp', top: fx('ifdef/ifdef.dts') });
    expect(off.text).toContain('hdmi');
    expect(off.text).not.toContain('panel');
    const on = await preprocess({ cpp: 'cpp', top: fx('ifdef/ifdef.dts'), defines: { USE_LCD: '2' } });
    expect(on.text).toContain('panel');
    expect(on.text).toContain('backlight');
    expect(on.text).not.toContain('hdmi');
    const flag = await preprocess({ cpp: 'cpp', top: fx('ifdef/ifdef.dts'), defines: { USE_LCD: '' } });
    expect(flag.text).toContain('panel');
  });

  it('UT-PRE-04 include パス', async () => {
    await expect(preprocess({ cpp: 'cpp', top: fx('macro/macro.dts') })).rejects.toBeInstanceOf(PreprocessError);
    const r = await preprocess({ cpp: 'cpp', top: fx('macro/macro.dts'), includes: [fx('macro/include')] });
    expect(r.files).toContain(fx('macro/include/dt-bindings/acme.h'));
    expect(r.text).toContain('(32 + (3))');
    expect(cppArgs({ cpp: 'cpp', top: 'a.dts', includes: ['x'], defines: { A: '1', B: '' } })).toEqual([
      '-nostdinc', '-undef', '-D__DTS__', '-x', 'assembler-with-cpp', '-Ix', '-DA=1', '-DB', 'a.dts',
    ]);
  });

  it('キャンセルできる', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(preprocess({ cpp: 'cpp', top: fx('basic/basic.dts'), signal: ac.signal })).rejects.toThrow('キャンセル');
    const ac2 = new AbortController();
    const slow = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dtv-slow-')), 'cpp');
    fs.writeFileSync(slow, '#!/bin/sh\nexec sleep 5\n');
    fs.chmodSync(slow, 0o755);
    const p = preprocess({ cpp: slow, top: fx('basic/basic.dts'), signal: ac2.signal });
    setTimeout(() => ac2.abort(), 20);
    await expect(p).rejects.toThrow('キャンセル');
  });

  it('cpp が無いときはエラー', async () => {
    await expect(preprocess({ cpp: '/nonexistent/cpp', top: fx('basic/basic.dts') })).rejects.toThrow('cpp を実行できません');
  });

  it('行マーカーの解析（built-in や引用符のエスケープ）', () => {
    const out = ['# 1 "a b.dts"', '# 1 "<built-in>"', 'x', '# 3 "a b.dts"', 'y', '# 1 "dir/q\\"x.dtsi" 1', 'z'].join('\n');
    const r = parseLineMarkers(out, '/w');
    expect(r.lineMap).toEqual([undefined, undefined, undefined, undefined, { file: '/w/a b.dts', line: 3 }, undefined, { file: '/w/dir/q"x.dtsi', line: 1 }]);
    expect(r.files).toEqual(['/w/a b.dts', '/w/dir/q"x.dtsi']);
  });
});

describe('findTool', () => {
  it('PATH と Buildroot と scripts/dtc から探す', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtv-tool-'));
    const mk = (p: string): string => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '#!/bin/sh\n');
      fs.chmodSync(p, 0o755);
      return p;
    };
    const cross = mk(path.join(tmp, 'br', 'output', 'host', 'bin', 'aarch64-linux-cpp'));
    const dtc = mk(path.join(tmp, 'linux', 'scripts', 'dtc', 'dtc'));
    const brLinuxDtc = mk(path.join(tmp, 'br2', 'output', 'build', 'linux-6.1', 'scripts', 'dtc', 'dtc'));
    expect(findTool('cpp', [tmp], '')).toBe(cross);
    expect(findTool('dtc', [path.join(tmp, 'linux')], '')).toBe(dtc);
    expect(findTool('dtc', [path.join(tmp, 'br2')], '')).toBe(brLinuxDtc);
    expect(findTool('dtc', [path.join(tmp, 'br')], '')).toBeUndefined();
    const onPath = mk(path.join(tmp, 'bin', 'cpp'));
    expect(findTool('cpp', [tmp], path.join(tmp, 'bin'))).toBe(onPath);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
