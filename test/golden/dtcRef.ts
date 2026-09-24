import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cppArgs } from '../../src/core/preprocess';

/** dtc -I dtb -O dts の出力を読んだもの */
export interface RefNode {
  path: string;
  props: Map<string, Uint8Array>;
  children: RefNode[];
}

export interface RefTree {
  root: RefNode;
  byPath: Map<string, RefNode>;
  /** __symbols__（dtc -@）: label → パス */
  symbols: Map<string, string>;
  /** phandle 値 → パス */
  phandles: Map<number, string>;
}

/** cpp → dtc(dtb) → dtc -I dtb -O dts で正解を作る */
export function referenceDts(top: string, includes: string[], defines: Record<string, string> = {}): string {
  const pre = execFileSync('cpp', cppArgs({ cpp: 'cpp', top, includes, defines }), { cwd: path.dirname(top) });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtv-gt-'));
  const dtb = path.join(tmp, 'out.dtb');
  execFileSync('dtc', ['-q', '-@', '-I', 'dts', '-O', 'dtb', '-o', dtb, '-'], { input: pre });
  const dts = execFileSync('dtc', ['-q', '-I', 'dtb', '-O', 'dts', dtb]).toString();
  fs.rmSync(tmp, { recursive: true, force: true });
  return dts;
}

type Tok = { t: 'word' | 'str' | 'cells' | 'bytes' | 'punct'; v: string };

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
    } else if (text.startsWith('/*', i)) {
      i = text.indexOf('*/', i) + 2;
    } else if (text.startsWith('//', i)) {
      i = text.indexOf('\n', i);
      if (i < 0) break;
    } else if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out.push({ t: 'str', v: text.slice(i + 1, j) });
      i = j + 1;
    } else if (c === '<') {
      const j = text.indexOf('>', i);
      out.push({ t: 'cells', v: text.slice(i + 1, j) });
      i = j + 1;
    } else if (c === '[') {
      const j = text.indexOf(']', i);
      out.push({ t: 'bytes', v: text.slice(i + 1, j) });
      i = j + 1;
    } else if ('{};=,'.includes(c)) {
      out.push({ t: 'punct', v: c });
      i++;
    } else {
      let j = i;
      while (j < text.length && !/[\s{};="<[]/.test(text[j])) j++;
      out.push({ t: 'word', v: text.slice(i, j) });
      i = j;
    }
  }
  return out;
}

function unescape(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') {
      out.push(...Buffer.from(s[i], 'utf8'));
      continue;
    }
    const e = s[++i];
    if (e === 'x') {
      const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1))![0];
      out.push(parseInt(m, 16));
      i += m.length;
    } else if (/[0-7]/.test(e)) {
      const m = /^[0-7]{1,3}/.exec(s.slice(i))![0];
      out.push(parseInt(m, 8));
      i += m.length - 1;
    } else {
      out.push(({ n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 } as Record<string, number>)[e] ?? e.charCodeAt(0));
    }
  }
  return out;
}

function valueBytes(toks: Tok[]): Uint8Array {
  const out: number[] = [];
  for (const t of toks) {
    if (t.t === 'str') out.push(...unescape(t.v), 0);
    else if (t.t === 'bytes') for (const b of t.v.trim().split(/\s+/).filter(Boolean)) out.push(parseInt(b, 16));
    else if (t.t === 'cells')
      for (const c of t.v.trim().split(/\s+/).filter(Boolean)) {
        const n = Number(BigInt(c)) >>> 0;
        out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
      }
  }
  return Uint8Array.from(out);
}

export function parseReference(dts: string): RefTree {
  const toks = tokenize(dts);
  let i = 0;
  const byPath = new Map<string, RefNode>();
  const parseNode = (p: string): RefNode => {
    const node: RefNode = { path: p, props: new Map(), children: [] };
    byPath.set(p, node);
    // '{' は呼び出し側で読んだ
    while (!(toks[i].t === 'punct' && toks[i].v === '}')) {
      const name = toks[i++].v;
      if (toks[i].v === '{') {
        i++;
        node.children.push(parseNode(p === '/' ? `/${name}` : `${p}/${name}`));
        continue;
      }
      const vals: Tok[] = [];
      if (toks[i].v === '=') {
        i++;
        while (toks[i].v !== ';') {
          if (toks[i].v !== ',') vals.push(toks[i]);
          i++;
        }
      }
      i++; // ;
      node.props.set(name, valueBytes(vals));
    }
    i += 2; // } ;
    return node;
  };
  let root: RefNode | undefined;
  while (i < toks.length) {
    if (toks[i].v === '/' && toks[i + 1]?.v === '{') {
      i += 2;
      root = parseNode('/');
    } else i++;
  }
  if (!root) throw new Error('ルートがありません');
  const symbols = new Map<string, string>();
  const sym = byPath.get('/__symbols__');
  for (const [k, v] of sym?.props ?? []) symbols.set(k, Buffer.from(v.subarray(0, v.length - 1)).toString());
  const phandles = new Map<number, string>();
  for (const n of byPath.values()) {
    const ph = n.props.get('phandle') ?? n.props.get('linux,phandle');
    if (ph) phandles.set(Buffer.from(ph).readUInt32BE(0), n.path);
  }
  return { root, byPath, symbols, phandles };
}
