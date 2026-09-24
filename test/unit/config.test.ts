import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, parseCategories, parseProfiles, rememberTopByDtsi, resolveSoc } from '../../src/config/config';
import { loadModel } from '../../src/core/load';
import { fx, ROOT, setupParser } from '../helpers';

beforeAll(setupParser);

const RES = path.join(ROOT, 'resources');

function workspace(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtv-cfg-'));
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), text);
  }
  return dir;
}

const PROFILES = `// コメント OK
{
  "profiles": {
    "DM1000": {
      "top": "arch/arm64/boot/dts/rockchip/rk3326-dm1000.dts",
      "include": ["include", "arch/arm64/boot/dts"],
      "defines": { "USE_LCD": "1", "N": 2 },
      "soc": "rockchip,rk3326",   // 省略可
    },
  },
  "default": "DM1000",
  "topByDtsi": { "rk3326.dtsi": "DM1000" }
}`;

describe('config', () => {
  it('UT-CFG-01 JSONC（コメント・末尾カンマ）', () => {
    const r = parseProfiles('/ws/.dtviewer/profiles.jsonc', PROFILES);
    expect(r.errors).toEqual([]);
    expect(r.profiles.default).toBe('DM1000');
    expect(r.profiles.profiles.get('DM1000')).toEqual({
      name: 'DM1000',
      top: 'arch/arm64/boot/dts/rockchip/rk3326-dm1000.dts',
      include: ['include', 'arch/arm64/boot/dts'],
      defines: { USE_LCD: '1', N: '2' },
      soc: 'rockchip,rk3326',
    });
    expect(r.profiles.topByDtsi).toEqual({ 'rk3326.dtsi': 'DM1000' });
  });

  it('UT-CFG-02 ユーザー優先の合成', () => {
    const ws = workspace({
      '.dtviewer/categories.jsonc': '{ "categories": [ { "id": "uart", "label": "私のUART", "group": "通信", "match": { "compatible": ["*"] } } ] }',
      '.dtviewer/profiles.jsonc': PROFILES,
    });
    const cfg = loadConfig(RES, ws);
    expect(cfg.errors).toEqual([]);
    expect(cfg.categories[0]).toMatchObject({ id: 'uart', label: '私のUART' });
    expect(cfg.categories.filter((c) => c.id === 'uart')).toHaveLength(1);
    expect(cfg.categories.some((c) => c.id === 'i2c')).toBe(true);
    expect(cfg.profiles.profiles.has('DM1000')).toBe(true);
    // ユーザー設定が無ければ内蔵だけ
    const plain = loadConfig(RES, workspace({}));
    expect(plain.categories.find((c) => c.id === 'uart')!.label).toBe('UART');
    expect(plain.profiles.profiles.size).toBe(0);
  });

  it('UT-CFG-03 書式ミスは内蔵で動き続け、ファイルと行を返す', () => {
    const ws = workspace({
      '.dtviewer/categories.jsonc': '{\n  "categories": [\n    { "id": "x", }\n    { "id": "y" }\n  ]\n}',
      '.dtviewer/profiles.jsonc': '{\n  "profiles": {\n    "A": { "include": [] }\n  }\n}',
    });
    const cfg = loadConfig(RES, ws);
    expect(cfg.categories.find((c) => c.id === 'uart')!.label).toBe('UART');
    expect(cfg.categories.some((c) => c.id === 'x')).toBe(false);
    expect(cfg.profiles.profiles.size).toBe(0);
    const cat = cfg.errors.find((e) => e.file.endsWith('categories.jsonc'))!;
    expect(cat.line).toBe(4);
    expect(cat.message).toContain('JSONC の書式ミス');
    const prof = cfg.errors.find((e) => e.file.endsWith('profiles.jsonc'))!;
    expect(prof).toMatchObject({ line: 3, message: 'プロファイル A に文字列の "top" がありません' });
    // 形の間違い
    expect(parseCategories('c', '{ "categories": 1 }').errors[0].message).toContain('"categories" の配列がありません');
    expect(parseCategories('c', '{ "categories": [ { "label": "x" } ] }').errors[0].message).toContain('"id"');
    expect(parseCategories('c', '{ "categories": [ { "id": "a", "match": { "compatible": "x" } } ] }').errors[0].message).toContain('match.compatible');
    expect(parseProfiles('p', '{ "profiles": [] }').errors[0].message).toContain('"profiles"');
    expect(parseProfiles('p', '{ "profiles": { "A": 1 } }').errors[0].message).toContain('オブジェクト');
    expect(parseProfiles('p', '{ "profiles": { "A": { "top": "a", "defines": { "X": [] } } } }').errors[0].message).toContain('defines.X');
    expect(parseProfiles('p', '{ "profiles": {}, "default": "B" }').errors[0].message).toContain('default');
  });

  it('UT-CFG-04 SoC 判定', async () => {
    const { model } = await loadModel({ cpp: 'cpp', top: fx('classify/classify.dts') });
    expect(model.soc).toBe('rockchip,rk3328');
    expect(resolveSoc(undefined, model.soc)).toBe('rockchip,rk3328');
    const prof = parseProfiles('p', PROFILES).profiles.profiles.get('DM1000');
    expect(resolveSoc(prof, model.soc)).toBe('rockchip,rk3326');
    const forced = await loadModel({ cpp: 'cpp', top: fx('classify/classify.dts'), soc: 'x,y' });
    expect(forced.model.soc).toBe('x,y');
  });

  it('topByDtsi に記憶する（コメントは残す）', () => {
    const ws = workspace({ '.dtviewer/profiles.jsonc': PROFILES });
    rememberTopByDtsi(ws, 'px30.dtsi', 'board/a.dts');
    const text = fs.readFileSync(path.join(ws, '.dtviewer/profiles.jsonc'), 'utf8');
    expect(text).toContain('// コメント OK');
    expect(parseProfiles('p', text).profiles.topByDtsi).toEqual({ 'rk3326.dtsi': 'DM1000', 'px30.dtsi': 'board/a.dts' });
    const empty = workspace({});
    rememberTopByDtsi(empty, 'a.dtsi', 'b.dts');
    expect(loadConfig(RES, empty).profiles.topByDtsi).toEqual({ 'a.dtsi': 'b.dts' });
  });
});
