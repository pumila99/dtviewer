import * as path from 'node:path';
import type { Profile, ProfilesConfig } from '../config/config';
import type { IncludeGraph } from './includeGraph';
import { resolveIn } from './paths';

/** 読み込む対象 */
export interface Target {
  top: string;
  profile?: Profile;
  /** dtsi 単体での部分表示 */
  partial?: boolean;
}

export type Decision =
  | { kind: 'target'; target: Target; reason: string }
  /** 複数の dts が include しているので選ばせる */
  | { kind: 'choose'; dtsi: string; candidates: string[] }
  | { kind: 'none' };

export function isDtsFile(file: string): boolean {
  return /\.dtsi?$/.test(file);
}

function profileForTop(root: string, profiles: ProfilesConfig, top: string): Profile | undefined {
  for (const p of profiles.profiles.values()) if (path.resolve(resolveIn(root, p.top)) === path.resolve(top)) return p;
  return undefined;
}

export function targetFor(root: string, profiles: ProfilesConfig, top: string): Target {
  const profile = profileForTop(root, profiles, top);
  return { top: path.resolve(top), profile };
}

/** プロファイル（default）でトップが決まるか */
export function decideByProfile(root: string, profiles: ProfilesConfig, name = profiles.default): Decision {
  const p = name ? profiles.profiles.get(name) : undefined;
  if (!p) return { kind: 'none' };
  return { kind: 'target', target: { top: path.resolve(resolveIn(root, p.top)), profile: p }, reason: `プロファイル ${p.name}` };
}

/**
 * 開いたファイルからトップ dts を決める（6.3 の 2・3）。
 * .dts ならそれ、.dtsi なら topByDtsi の記憶 → include している dts の逆引き（1 つ / 複数 / 無し）。
 */
export function decideForFile(root: string, profiles: ProfilesConfig, graph: IncludeGraph, file: string): Decision {
  const abs = path.resolve(file);
  if (abs.endsWith('.dts')) return { kind: 'target', target: targetFor(root, profiles, abs), reason: '開いた dts' };
  if (!abs.endsWith('.dtsi')) return { kind: 'none' };
  const remembered = profiles.topByDtsi[path.basename(abs)];
  const tops = graph.topsIncluding(abs);
  if (remembered) {
    const prof = profiles.profiles.get(remembered);
    if (prof) return { kind: 'target', target: { top: path.resolve(resolveIn(root, prof.top)), profile: prof }, reason: '記憶した選択' };
    const top = path.resolve(resolveIn(root, remembered));
    if (tops.includes(top) || tops.length === 0) return { kind: 'target', target: targetFor(root, profiles, top), reason: '記憶した選択' };
  }
  if (tops.length === 1) return { kind: 'target', target: targetFor(root, profiles, tops[0]), reason: 'include している dts' };
  if (tops.length > 1) return { kind: 'choose', dtsi: abs, candidates: tops };
  return { kind: 'target', target: { top: abs, partial: true }, reason: 'dtsi 単体（部分表示）' };
}

/** topByDtsi に残す値（プロファイルがあればその名前、無ければワークスペースからの相対パス） */
export function rememberValue(root: string, target: Target): string {
  return target.profile?.name ?? path.relative(root, target.top).split(path.sep).join('/');
}
