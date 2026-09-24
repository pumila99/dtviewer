import * as fs from 'node:fs';
import * as path from 'node:path';

/** 上にたどって、カーネルのソースツリー（arch/ と include/ がある所）を探す */
export function findKernelRoot(from: string): string | undefined {
  let dir = path.dirname(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'arch')) && fs.existsSync(path.join(dir, 'include'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** プロファイルが無いときの include パス: dts の場所、カーネルの include と arch/<arch>/boot/dts */
export function defaultIncludes(top: string): string[] {
  const out = [path.dirname(top)];
  const root = findKernelRoot(top);
  if (root) {
    out.push(path.join(root, 'include'));
    const rel = path.relative(root, top).split(path.sep);
    // arch/<arch>/boot/dts/...
    if (rel[0] === 'arch' && rel[2] === 'boot' && rel[3] === 'dts') out.push(path.join(root, 'arch', rel[1], 'boot', 'dts'));
    const prefixes = path.join(root, 'scripts', 'dtc', 'include-prefixes');
    if (fs.existsSync(prefixes)) out.push(prefixes);
  }
  return [...new Set(out)];
}

export function resolveIn(root: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(root, p);
}
