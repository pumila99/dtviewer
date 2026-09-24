import * as fs from 'node:fs';
import * as path from 'node:path';

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Buildroot の output/host/bin 候補（ルート直下と 1 段下）。 */
function buildrootBins(root: string): string[] {
  const dirs = [path.join(root, 'output', 'host', 'bin')];
  for (const sub of listDir(root)) dirs.push(path.join(root, sub, 'output', 'host', 'bin'));
  return dirs.filter((d) => fs.existsSync(d));
}

/** カーネルの scripts/dtc 候補（ルート直下と Buildroot の output/build/linux-*）。 */
function kernelDtcDirs(root: string): string[] {
  const dirs = [path.join(root, 'scripts', 'dtc')];
  for (const b of [path.join(root, 'output', 'build'), ...listDir(root).map((s) => path.join(root, s, 'output', 'build'))]) {
    for (const sub of listDir(b)) if (sub.startsWith('linux-')) dirs.push(path.join(b, sub, 'scripts', 'dtc'));
  }
  return dirs.filter((d) => fs.existsSync(d));
}

/**
 * 外部コマンド（cpp / dtc）を探す。PATH → Buildroot の output/host/bin → カーネルの scripts/dtc の順。
 * Buildroot ではクロス用の `<triplet>-cpp` も候補にする。
 */
export function findTool(name: 'cpp' | 'dtc', roots: string[], envPath = process.env.PATH ?? ''): string | undefined {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    if (isExecutable(p)) return p;
  }
  for (const root of roots) {
    for (const bin of buildrootBins(root)) {
      const p = path.join(bin, name);
      if (isExecutable(p)) return p;
      const cross = listDir(bin)
        .filter((f) => f.endsWith(`-${name}`))
        .sort()
        .map((f) => path.join(bin, f))
        .find(isExecutable);
      if (cross) return cross;
    }
    if (name === 'dtc') {
      for (const d of kernelDtcDirs(root)) {
        const p = path.join(d, 'dtc');
        if (isExecutable(p)) return p;
      }
    }
  }
  return undefined;
}
