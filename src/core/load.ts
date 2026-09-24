import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyModel, type CategoryRule } from './classify';
import { merge } from './merge';
import type { DtModel, Problem } from './model';
import { preprocess } from './preprocess';
import { buildMacroIndex, parseSource, type SourceFile } from './source';

export interface LoadOptions {
  cpp: string;
  top: string;
  includes?: string[];
  defines?: Record<string, string>;
  rules?: CategoryRule[];
  soc?: string;
  /** ワークスペースのルート（shared 判定に使う） */
  workspaceRoots?: string[];
  isShared?: (file: string, soc: string | undefined) => boolean;
  signal?: AbortSignal;
}

export interface LoadResult {
  model: DtModel;
  problems: Problem[];
  sources: Map<string, SourceFile>;
}

function isInside(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const SOC_SUFFIXES = new Set(['opp', 'pinctrl', 'clocks', 'power', 'thermal', 'dram-default-timing']);

/**
 * SoC 共通ファイルかどうか。
 * - ワークスペースの外
 * - カーネル共通ディレクトリ（include/dt-bindings、scripts/dtc/include-prefixes）
 * - SoC 名の .dtsi（rockchip,rk3326 なら rk3326.dtsi）と、SoC 名 + 共通っぽい接尾辞（rk3399-opp.dtsi など）
 * - カーネルの arch/<arch>/boot/dts の下にある、ハイフンを含まない .dtsi（px30.dtsi など SoC 名だけのもの）
 */
export function defaultIsShared(workspaceRoots: string[]) {
  return (file: string, soc: string | undefined): boolean => {
    if (workspaceRoots.length > 0 && !workspaceRoots.some((r) => isInside(file, r))) return true;
    const norm = file.split(path.sep).join('/');
    if (/\/include\/dt-bindings\//.test(norm) || /\/scripts\/dtc\/include-prefixes\//.test(norm)) return true;
    const base = path.basename(file);
    if (!base.endsWith('.dtsi')) return false;
    const stem = base.slice(0, -'.dtsi'.length);
    const chip = soc?.split(',').pop();
    if (chip && (stem === chip || (stem.startsWith(`${chip}-`) && SOC_SUFFIXES.has(stem.slice(chip.length + 1))))) return true;
    return /\/arch\/[^/]+\/boot\/dts\//.test(norm) && !stem.includes('-');
  };
}

/** cpp → 各ファイルの CST → #define 索引 → 合算 → 分類 までまとめて行う。 */
export async function loadModel(opts: LoadOptions): Promise<LoadResult> {
  const pre = await preprocess({
    cpp: opts.cpp,
    top: opts.top,
    includes: opts.includes,
    defines: opts.defines,
    signal: opts.signal,
  });
  const sources = new Map<string, SourceFile>();
  for (const f of pre.files) {
    if (opts.signal?.aborted) throw new Error('キャンセルされました');
    let text: string;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    sources.set(f, await parseSource(f, text));
  }
  const isShared = opts.isShared ?? defaultIsShared(opts.workspaceRoots ?? []);
  const macros = buildMacroIndex([...sources.values()]);
  const { model, problems } = await merge({ pre, topFile: opts.top, sources, macros, isShared, soc: opts.soc });
  if (opts.rules) classifyModel(model, opts.rules);
  return { model, problems, sources };
}
