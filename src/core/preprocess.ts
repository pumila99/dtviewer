import { spawn } from 'node:child_process';
import * as path from 'node:path';

export interface PreprocessOptions {
  /** cpp の実行ファイル */
  cpp: string;
  /** トップの dts（絶対パス推奨） */
  top: string;
  includes?: string[];
  defines?: Record<string, string>;
  cwd?: string;
  signal?: AbortSignal;
}

export interface LineOrigin {
  file: string;
  /** 1 始まり */
  line: number;
}

export interface PreprocessResult {
  /** 行マーカーを空行に置き換えた cpp 出力（行数は cpp 出力と同じ） */
  text: string;
  /** 出力の行（0 始まり）→ 元ファイル・行。行マーカーの行は undefined */
  lineMap: (LineOrigin | undefined)[];
  /** 出てきた元ファイル（出現順） */
  files: string[];
  stderr: string;
}

export class PreprocessError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export function cppArgs(opts: PreprocessOptions): string[] {
  const args = ['-nostdinc', '-undef', '-D__DTS__', '-x', 'assembler-with-cpp'];
  for (const inc of opts.includes ?? []) args.push(`-I${inc}`);
  for (const [k, v] of Object.entries(opts.defines ?? {})) args.push(v === '' ? `-D${k}` : `-D${k}=${v}`);
  args.push(opts.top);
  return args;
}

/** cpp を実行して、出力と行対応表を返す。signal で中断できる。 */
export function preprocess(opts: PreprocessOptions): Promise<PreprocessResult> {
  const cwd = opts.cwd ?? path.dirname(opts.top);
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new PreprocessError('キャンセルされました', ''));
      return;
    }
    const child = spawn(opts.cpp, cppArgs(opts), { cwd, signal: opts.signal });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', (e: Error) => {
      const msg = e.name === 'AbortError' ? 'キャンセルされました' : `cpp を実行できません: ${e.message}`;
      reject(new PreprocessError(msg, Buffer.concat(err).toString()));
    });
    child.on('close', (code) => {
      const stderr = Buffer.concat(err).toString();
      if (opts.signal?.aborted) {
        reject(new PreprocessError('キャンセルされました', stderr));
        return;
      }
      if (code !== 0) {
        reject(new PreprocessError(`cpp が失敗しました (exit ${code})`, stderr));
        return;
      }
      resolve({ ...parseLineMarkers(Buffer.concat(out).toString(), cwd), stderr });
    });
  });
}

const MARKER = /^#\s*(\d+)\s+"((?:[^"\\]|\\.)*)"(?:\s+\d+)*\s*$/;

/** cpp 出力の行マーカー（# 12 "file" 2）を読んで行対応表を作る。 */
export function parseLineMarkers(output: string, cwd: string): Omit<PreprocessResult, 'stderr'> {
  const lines = output.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const lineMap: (LineOrigin | undefined)[] = [];
  const files: string[] = [];
  const seen = new Set<string>();
  let file = '';
  let line = 1;
  for (let i = 0; i < lines.length; i++) {
    const m = MARKER.exec(lines[i]);
    if (m) {
      line = Number(m[1]);
      const name = m[2].replace(/\\(.)/g, '$1');
      file = name.startsWith('<') ? name : path.resolve(cwd, name);
      if (!name.startsWith('<') && !seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
      lines[i] = '';
      lineMap.push(undefined);
      continue;
    }
    lineMap.push(file && !file.startsWith('<') ? { file, line } : undefined);
    line++;
  }
  return { text: lines.join('\n') + '\n', lineMap, files };
}
