import * as fs from 'node:fs';
import * as path from 'node:path';

const INCLUDE = /^\s*(?:#\s*include|\/include\/)\s*[<"]([^>"]+)[>"]/gm;

/** ファイルに書かれた include を読む（cpp 前、ifdef は気にしない） */
export function readIncludes(file: string, text?: string): string[] {
  let body = text;
  if (body === undefined) {
    try {
      body = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
  }
  return [...body.matchAll(INCLUDE)].map((m) => m[1]);
}

/**
 * ワークスペースの dts/dtsi の include 関係。
 * include 先は「書いたファイルの場所」→ includeDirs の順で探し、見つからなければファイル名だけで照合する。
 */
export class IncludeGraph {
  /** file → include しているファイル */
  private readonly includedBy = new Map<string, Set<string>>();
  private readonly byBase = new Map<string, string[]>();

  constructor(
    files: string[],
    includeDirs: string[] = [],
    read: (f: string) => string[] = (f) => readIncludes(f),
  ) {
    const set = new Set(files.map((f) => path.resolve(f)));
    for (const f of set) {
      const b = path.basename(f);
      this.byBase.set(b, [...(this.byBase.get(b) ?? []), f]);
    }
    for (const f of set) {
      for (const inc of read(f)) {
        const target = this.resolve(f, inc, includeDirs, set);
        if (!target) continue;
        (this.includedBy.get(target) ?? this.includedBy.set(target, new Set()).get(target)!).add(f);
      }
    }
  }

  private resolve(from: string, inc: string, dirs: string[], set: Set<string>): string | undefined {
    for (const d of [path.dirname(from), ...dirs]) {
      const p = path.resolve(d, inc);
      if (set.has(p)) return p;
    }
    const cands = this.byBase.get(path.basename(inc)) ?? [];
    // ファイル名だけで照合するときは、パスの末尾が一致するものを優先
    const norm = inc.split('/').join(path.sep);
    return cands.find((c) => c.endsWith(path.sep + norm)) ?? cands[0];
  }

  /** file を（多段でも）include している .dts を返す */
  topsIncluding(file: string): string[] {
    const start = path.resolve(file);
    const seen = new Set<string>([start]);
    const queue = [start];
    const tops: string[] = [];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const p of this.includedBy.get(cur) ?? []) {
        if (seen.has(p)) continue;
        seen.add(p);
        if (p.endsWith('.dts')) tops.push(p);
        queue.push(p);
      }
    }
    return tops.sort();
  }
}
