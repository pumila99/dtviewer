import { beforeAll, describe, expect, it } from 'vitest';
import { loadModel } from '../../src/core/load';
import { resolveRef } from '../../src/core/merge';
import type { DtModel, DtNode, DtProp } from '../../src/core/model';
import { fx, setupParser } from '../helpers';
import { parseReference, referenceDts, type RefTree } from './dtcRef';

beforeAll(setupParser);

const SKIP_NODES = new Set(['/__symbols__', '/__fixups__', '/__local_fixups__']);
const SKIP_PROPS = new Set(['phandle', 'linux,phandle']);

/** DtProp をバイト列にする。ref の位置（バイトオフセット → 参照先）も返す */
function encode(model: DtModel, prop: DtProp): { bytes: number[]; refs: Map<number, string> } {
  const bytes: number[] = [];
  const refs = new Map<number, string>();
  for (const v of prop.value) {
    switch (v.kind) {
      case 'string':
        bytes.push(...Buffer.from(v.value, 'utf8'), 0);
        break;
      case 'bytes':
        bytes.push(...v.bytes);
        break;
      case 'empty':
        break;
      case 'cells': {
        const w = (v.bits ?? 32) / 8;
        for (const c of v.cells) {
          if (typeof c !== 'number') {
            refs.set(bytes.length, resolveRef(model, c.ref)?.path ?? `?${c.ref}`);
            bytes.push(0, 0, 0, 0);
            continue;
          }
          let n = BigInt(c);
          const b: number[] = [];
          for (let k = 0; k < w; k++) {
            b.unshift(Number(n & 0xffn));
            n >>= 8n;
          }
          bytes.push(...b);
        }
        break;
      }
    }
  }
  return { bytes, refs };
}

function compare(model: DtModel, ref: RefTree): void {
  const refPaths = [...ref.byPath.keys()].filter((p) => ![...SKIP_NODES].some((s) => p === s || p.startsWith(`${s}/`)));
  // ノード一覧
  expect([...model.byPath.keys()].sort()).toEqual(refPaths.sort());
  for (const p of refPaths) {
    const r = ref.byPath.get(p)!;
    const n = model.byPath.get(p)!;
    // プロパティ名
    const refProps = [...r.props.keys()].filter((k) => !SKIP_PROPS.has(k)).sort();
    expect([...n.props.keys()].filter((k) => !SKIP_PROPS.has(k)).sort(), `props of ${p}`).toEqual(refProps);
    // 値（バイト列）。phandle は「同じノードを指すか」で比べる
    for (const k of refProps) {
      const want = r.props.get(k)!;
      const { bytes, refs } = encode(model, n.props.get(k)!);
      expect(bytes.length, `${p}:${k} length`).toBe(want.length);
      for (const [off, target] of refs) {
        const ph = Buffer.from(want).readUInt32BE(off);
        expect(ref.phandles.get(ph), `${p}:${k} ref@${off}`).toBe(target);
        want.set([0, 0, 0, 0], off);
      }
      expect(bytes, `${p}:${k}`).toEqual([...want]);
    }
    // status
    const st = r.props.get('status');
    const s = st ? Buffer.from(st.subarray(0, st.length - 1)).toString() : 'okay';
    expect(n.status, `status of ${p}`).toBe(s === 'okay' || s === 'ok' ? 'okay' : s === 'disabled' ? 'disabled' : 'unknown');
  }
  // ラベル（dtc -@ の __symbols__）
  const labels = new Map<string, string>();
  for (const [l, node] of model.byLabel) labels.set(l, node.path);
  expect(labels).toEqual(ref.symbols);
}

interface Case {
  id: string;
  top: string;
  includes?: string[];
  defines?: Record<string, string>;
}

const K = fx('kernel');
const KINC = [`${K}/include`, `${K}/arch/arm64/boot/dts`];

const cases: Case[] = [
  { id: 'GT-01 basic', top: fx('basic/basic.dts') },
  { id: 'GT-02 override', top: fx('override/board.dts') },
  { id: 'GT-02 delete', top: fx('delete/delete.dts') },
  { id: 'GT-03 include', top: fx('include/top.dts') },
  { id: 'GT-03 macro', top: fx('macro/macro.dts'), includes: [fx('macro/include')] },
  { id: 'GT-03 ifdef (無し)', top: fx('ifdef/ifdef.dts') },
  { id: 'GT-03 ifdef (USE_LCD=2)', top: fx('ifdef/ifdef.dts'), defines: { USE_LCD: '2' } },
  { id: 'GT-04 refs', top: fx('refs/refs.dts') },
  { id: 'GT-05 kernel rk3326-odroid-go2', top: `${K}/arch/arm64/boot/dts/rockchip/rk3326-odroid-go2.dts`, includes: KINC },
  { id: 'GT-05 kernel rk3328-rock64', top: `${K}/arch/arm64/boot/dts/rockchip/rk3328-rock64.dts`, includes: KINC },
];

describe('正解比較（cpp → dtc → dtc -I dtb -O dts）', () => {
  for (const c of cases) {
    it(c.id, async () => {
      const ref = parseReference(referenceDts(c.top, c.includes ?? [], c.defines));
      const { model, problems } = await loadModel({ cpp: 'cpp', top: c.top, includes: c.includes, defines: c.defines });
      expect(problems).toEqual([]);
      compare(model, ref);
    });
  }
});

// 使っていない import を消さないように（DtNode 型は compare の中で間接的に使う）
export type { DtNode };
