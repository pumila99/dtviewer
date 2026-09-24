import type { DtModel, DtNode, DtProp, DtValue, MacroDef, Problem, SourceLoc } from './model';
import { getParser, type SyntaxNode } from './parser';
import type { LineOrigin, PreprocessResult } from './preprocess';
import { findRaw, type SourceFile } from './source';

export interface MergeInput {
  pre: PreprocessResult;
  topFile: string;
  /** cpp 前の CST（file → SourceFile）。raw を取るのに使う */
  sources?: Map<string, SourceFile>;
  macros?: Map<string, MacroDef>;
  /** SoC 共通ファイルか（soc はルート compatible から判定したもの） */
  isShared?: (file: string, soc: string | undefined) => boolean;
  /** 設定で決まっている SoC（あればルート compatible より優先） */
  soc?: string;
}

export interface MergeResult {
  model: DtModel;
  problems: Problem[];
}

interface PendingPathRef {
  prop: DtProp;
  index: number;
  ref: string;
  loc?: SourceLoc;
}

function newNode(name: string, parent?: DtNode): DtNode {
  const path = !parent ? '/' : parent.path === '/' ? `/${name}` : `${parent.path}/${name}`;
  return { path, name, labels: [], props: new Map(), children: [], parent, defs: [], status: 'okay' };
}

/** ノード名 `name@addr` の `name` 部分 */
export function baseName(name: string): string {
  const at = name.indexOf('@');
  return at < 0 ? name : name.slice(0, at);
}

/** ルート compatible から SoC を判定する（最後の要素が SoC 共通のもの、という慣習に従う）。 */
export function detectSoc(root: DtNode): string | undefined {
  const compat = root.props.get('compatible');
  const strings = compat?.value.filter((v): v is { kind: 'string'; value: string } => v.kind === 'string').map((v) => v.value);
  return strings && strings.length > 0 ? strings[strings.length - 1] : undefined;
}

function unescapeString(lit: string): string {
  const body = lit.slice(1, -1);
  return body.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_, e: string) => {
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return ({ n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v' } as Record<string, string>)[e] ?? e;
  });
}

function parseInteger(text: string): bigint {
  const t = text.replace(/[uUlL]+$/, '');
  if (/^'.*'$/.test(t)) return BigInt(unescapeString(t).charCodeAt(0));
  if (/^0[0-7]+$/.test(t)) return BigInt(`0o${t.slice(1)}`);
  try {
    return BigInt(t);
  } catch {
    return 0n;
  }
}

/** 式の被演算子（括弧やコメントを除いた名前付きの子） */
function operands(n: SyntaxNode): SyntaxNode[] {
  return n.namedChildren.filter((c): c is SyntaxNode => !!c && c.type !== 'comment');
}

/** 演算子（括弧以外の名前なしの子） */
function operatorOf(n: SyntaxNode): string | undefined {
  return n.children.find((c) => c && !c.isNamed && c.type !== '(' && c.type !== ')')?.type;
}

const U64 = (v: bigint): bigint => BigInt.asUintN(64, v);
const B = (v: boolean): bigint => (v ? 1n : 0n);

/** セル内の式を評価する（dtc と同じく 64 bit 符号なしで計算） */
function evalExpr(n: SyntaxNode): bigint {
  switch (n.type) {
    case 'integer_literal':
      return U64(parseInteger(n.text));
    case 'parenthesized_expression': {
      const inner = operands(n)[0];
      return inner ? evalExpr(inner) : 0n;
    }
    case 'unary_expression': {
      const [arg] = operands(n);
      const v = arg ? evalExpr(arg) : 0n;
      switch (operatorOf(n)) {
        case '-':
          return U64(-v);
        case '~':
          return U64(~v);
        case '!':
          return B(v === 0n);
        default:
          return v;
      }
    }
    case 'binary_expression': {
      const [l, r] = operands(n);
      const a = l ? evalExpr(l) : 0n;
      const b = r ? evalExpr(r) : 0n;
      switch (operatorOf(n)) {
        case '+': return U64(a + b);
        case '-': return U64(a - b);
        case '*': return U64(a * b);
        case '/': return b ? a / b : 0n;
        case '%': return b ? a % b : 0n;
        case '<<': return U64(a << b);
        case '>>': return a >> b;
        case '&': return a & b;
        case '|': return a | b;
        case '^': return a ^ b;
        case '<': return B(a < b);
        case '>': return B(a > b);
        case '<=': return B(a <= b);
        case '>=': return B(a >= b);
        case '==': return B(a === b);
        case '!=': return B(a !== b);
        case '&&': return B(a !== 0n && b !== 0n);
        case '||': return B(a !== 0n || b !== 0n);
        default: return 0n;
      }
    }
    case 'conditional_expression': {
      const [c, t, f] = operands(n);
      return c && evalExpr(c) !== 0n ? (t ? evalExpr(t) : 0n) : f ? evalExpr(f) : 0n;
    }
    default:
      // 未定義マクロなどは 0 扱い（dtc ならエラー）
      return 0n;
  }
}

/** 計算結果をセル幅に丸める（負数は 2 の補数） */
function toCell(v: bigint, bits: number): number {
  return Number(BigInt.asUintN(bits, v));
}

/** reference ノード（&label / &{/path}）の参照先文字列。label はそのまま、パスは "/" 始まり */
function refTarget(ref: SyntaxNode): string {
  const label = ref.childForFieldName('label');
  if (label) return label.text;
  return ref.text.replace(/^&\{/, '').replace(/\}$/, '');
}

class Merger {
  readonly root = newNode('/');
  readonly byLabel = new Map<string, DtNode>();
  readonly problems: Problem[] = [];
  private readonly pathRefs: PendingPathRef[] = [];
  readonly omitIfNoRef = new Set<DtNode>();

  constructor(private readonly input: MergeInput) {}

  origin(row: number): LineOrigin | undefined {
    const map = this.input.pre.lineMap;
    for (let r = Math.min(row, map.length - 1); r >= 0; r--) {
      const o = map[r];
      if (o) return r === row ? o : { file: o.file, line: o.line + (row - r) };
    }
    return undefined;
  }

  loc(n: SyntaxNode): SourceLoc | undefined {
    const s = this.origin(n.startPosition.row);
    if (!s) return undefined;
    const e = this.origin(n.endPosition.row);
    const endLine = e && e.file === s.file && e.line >= s.line ? e.line : s.line;
    return { file: s.file, line: s.line, endLine, shared: false };
  }

  findByPath(p: string): DtNode | undefined {
    if (p === '/') return this.root;
    let cur: DtNode | undefined = this.root;
    for (const part of p.split('/').filter(Boolean)) {
      if (!cur) return undefined;
      const hasAddr = part.includes('@');
      cur = cur.children.find((c) => c.name === part) ?? (hasAddr ? undefined : cur.children.find((c) => baseName(c.name) === part));
    }
    return cur;
  }

  resolve(ref: SyntaxNode, what: string): DtNode | undefined {
    const target = refTarget(ref);
    const node = target.startsWith('/') ? this.findByPath(target) : this.byLabel.get(target);
    if (!node) {
      this.problems.push({
        kind: target.startsWith('/') ? 'undefined-path' : 'undefined-label',
        message: `${what}: 未定義の参照 &${target.startsWith('/') ? `{${target}}` : target}`,
        loc: this.loc(ref),
      });
    }
    return node;
  }

  addLabel(node: DtNode, label: string): void {
    if (!node.labels.includes(label)) node.labels.push(label);
    this.byLabel.set(label, node);
  }

  removeNode(node: DtNode): void {
    const parent = node.parent;
    if (!parent) {
      // ルートの削除はできないので中身だけ消す
      node.children = [];
      node.props.clear();
      return;
    }
    parent.children = parent.children.filter((c) => c !== node);
  }

  run(docRoot: SyntaxNode): void {
    this.syntaxErrors(docRoot);
    for (const c of docRoot.namedChildren) {
      if (!c) continue;
      this.top(c);
    }
    this.finish();
  }

  top(c: SyntaxNode): void {
    switch (c.type) {
      case 'node': {
        const name = c.childForFieldName('name');
        if (!name) return;
        let target: DtNode | undefined;
        if (name.type === 'reference') target = this.resolve(name, 'ノード上書き');
        else if (name.text === '/') target = this.root;
        else {
          this.problems.push({ kind: 'syntax', message: `トップレベルのノード ${name.text} は無視しました`, loc: this.loc(c) });
          return;
        }
        if (target) this.body(target, c);
        return;
      }
      case 'omit_if_no_ref': {
        const inner = c.namedChildren.find((x) => x?.type === 'node' || x?.type === 'reference');
        if (inner?.type === 'reference') {
          const n = this.resolve(inner, '/omit-if-no-ref/');
          if (n) this.omitIfNoRef.add(n);
        } else if (inner) this.top(inner);
        return;
      }
      case 'delete_node': {
        const name = c.childForFieldName('name');
        if (name?.type === 'reference') {
          const n = this.resolve(name, '/delete-node/');
          if (n) this.removeNode(n);
        }
        return;
      }
      case 'ERROR':
        // 読める部分は読む（エラー自体は syntaxErrors() で拾う）
        for (const x of c.namedChildren) if (x && (x.type === 'node' || x.type === 'delete_node')) this.top(x);
        return;
      default:
        return;
    }
  }

  /** ノード本体（{ ... }）を node に適用する */
  body(node: DtNode, n: SyntaxNode): void {
    for (const l of n.childrenForFieldName('label')) this.addLabel(node, l.text);
    const loc = this.loc(n);
    if (loc) node.defs.push(loc);
    for (const c of n.namedChildren) {
      if (!c) continue;
      switch (c.type) {
        case 'property':
          this.property(node, c);
          break;
        case 'node':
          this.child(node, c);
          break;
        case 'omit_if_no_ref': {
          const inner = c.namedChildren.find((x) => x?.type === 'node');
          if (inner) this.omitIfNoRef.add(this.child(node, inner));
          break;
        }
        case 'delete_property': {
          const name = c.childForFieldName('name')?.text;
          if (name) node.props.delete(name);
          break;
        }
        case 'delete_node': {
          const name = c.childForFieldName('name');
          const addr = c.childrenForFieldName('address').find((a) => a.type === 'unit_address');
          if (name?.type === 'reference') {
            const t = this.resolve(name, '/delete-node/');
            if (t) this.removeNode(t);
          } else if (name) {
            const full = addr ? `${name.text}@${addr.text}` : name.text;
            const t = node.children.find((x) => x.name === full);
            if (t) this.removeNode(t);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  /** 構文エラー（ERROR / MISSING）を外側のものだけ拾う */
  syntaxErrors(n: SyntaxNode): void {
    if (!n.hasError) return;
    if (n.isError || n.isMissing) {
      const what = n.isMissing ? `${n.type} がありません` : `構文エラー: ${n.text.slice(0, 40)}`;
      this.problems.push({ kind: 'syntax', message: what, loc: this.loc(n) });
      return;
    }
    for (const c of n.children) if (c) this.syntaxErrors(c);
  }

  child(parent: DtNode, n: SyntaxNode): DtNode {
    const nameNode = n.childForFieldName('name');
    const addr = n.childrenForFieldName('address').find((a) => a.type === 'unit_address');
    const name = (nameNode?.text ?? '') + (addr ? `@${addr.text}` : '');
    let node = parent.children.find((c) => c.name === name);
    if (!node) {
      node = newNode(name, parent);
      parent.children.push(node);
    }
    this.body(node, n);
    return node;
  }

  property(node: DtNode, n: SyntaxNode): void {
    const name = n.childForFieldName('name')?.text;
    if (!name) return;
    const loc = this.loc(n);
    const prev = node.props.get(name);
    const prop: DtProp = { name, value: [], raw: '', defs: prev ? [...prev.defs] : [], refs: [] };
    if (loc) prop.defs.push(loc);
    const bitsNodes = n.childrenForFieldName('bits');
    const bitsLit = bitsNodes.find((b) => b.type === 'integer_literal');
    const bits = bitsLit ? (Number(parseInteger(bitsLit.text)) as 8 | 16 | 32 | 64) : undefined;
    for (const v of n.childrenForFieldName('value')) {
      switch (v.type) {
        case 'string_literal':
          prop.value.push({ kind: 'string', value: unescapeString(v.text) });
          break;
        case 'byte_string_literal': {
          const hex = v.text.replace(/^\[|\]$/g, '').replace(/[^0-9a-fA-F]/g, '');
          const bytes: number[] = [];
          for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
          prop.value.push({ kind: 'bytes', bytes });
          break;
        }
        case 'integer_cells': {
          const cells: (number | { ref: string })[] = [];
          for (const c of v.namedChildren) {
            if (!c || c.type === 'comment') continue;
            if (c.type === 'reference') {
              const t = refTarget(c);
              cells.push({ ref: t });
              prop.refs.push(t);
              this.checkRefLater(c, name);
            } else {
              cells.push(toCell(evalExpr(c), bits ?? 32));
            }
          }
          const val: DtValue = bits && bits !== 32 ? { kind: 'cells', cells, bits } : { kind: 'cells', cells };
          prop.value.push(val);
          break;
        }
        case 'reference': {
          // 値としての &label はパス文字列になる（dtc と同じ）。最後に解決する
          const t = refTarget(v);
          prop.refs.push(t);
          this.pathRefs.push({ prop, index: prop.value.length, ref: t, loc: this.loc(v) });
          prop.value.push({ kind: 'string', value: '' });
          break;
        }
        default:
          break;
      }
    }
    if (prop.value.length === 0) prop.value.push({ kind: 'empty' });
    const src = loc && this.input.sources?.get(loc.file);
    prop.raw = (src && loc && findRaw(src, loc.line, name)) ?? rawFromCpp(n);
    node.props.set(name, prop);
  }

  private readonly cellRefs: { ref: SyntaxNode; prop: string }[] = [];

  checkRefLater(ref: SyntaxNode, prop: string): void {
    this.cellRefs.push({ ref, prop });
  }

  finish(): void {
    // phandle 参照は全部読み終わってから確認する（前方参照を許す）
    for (const { ref, prop } of this.cellRefs) this.resolve(ref, prop);
    for (const p of this.pathRefs) {
      const target = p.ref.startsWith('/') ? this.findByPath(p.ref) : this.byLabel.get(p.ref);
      if (target) p.prop.value[p.index] = { kind: 'string', value: target.path };
      else
        this.problems.push({
          kind: p.ref.startsWith('/') ? 'undefined-path' : 'undefined-label',
          message: `${p.prop.name}: 未定義の参照 &${p.ref}`,
          loc: p.loc,
        });
    }
  }
}

function rawFromCpp(n: SyntaxNode): string {
  const values = n.childrenForFieldName('value');
  if (values.length === 0) return '';
  const bits = n.childrenForFieldName('bits');
  const text = n.text;
  const start = (bits[0] ?? values[0]).startIndex - n.startIndex;
  return text.slice(start, values[values.length - 1].endIndex - n.startIndex);
}

function statusOf(node: DtNode): DtNode['status'] {
  const s = node.props.get('status')?.value[0];
  if (!s) return 'okay';
  if (s.kind !== 'string') return 'unknown';
  if (s.value === 'okay' || s.value === 'ok') return 'okay';
  if (s.value === 'disabled') return 'disabled';
  return 'unknown';
}

function* allNodes(n: DtNode): Generator<DtNode> {
  yield n;
  for (const c of n.children) yield* allNodes(c);
}

/** 参照が 1 つも無いノードを消す（/omit-if-no-ref/） */
function applyOmitIfNoRef(root: DtNode, marked: Set<DtNode>, byLabel: Map<string, DtNode>): void {
  if (marked.size === 0) return;
  const referenced = new Set<DtNode>();
  for (const n of allNodes(root)) {
    for (const p of n.props.values()) {
      for (const r of p.refs) {
        const t = r.startsWith('/') ? undefined : byLabel.get(r);
        if (t) referenced.add(t);
      }
    }
  }
  for (const n of marked) {
    if (!referenced.has(n) && n.parent) n.parent.children = n.parent.children.filter((c) => c !== n);
  }
}

/** cpp 後のテキストを 1 本のツリーにまとめる。 */
export async function merge(input: MergeInput): Promise<MergeResult> {
  const parser = await getParser();
  const tree = parser.parse(input.pre.text);
  if (!tree) throw new Error('parse に失敗しました');
  const m = new Merger(input);
  try {
    m.run(tree.rootNode);
  } finally {
    tree.delete();
  }
  applyOmitIfNoRef(m.root, m.omitIfNoRef, m.byLabel);

  const byPath = new Map<string, DtNode>();
  const byLabel = new Map<string, DtNode>();
  // パスを付け直し（削除・並び替え後でもずれないように）、索引を作り直す
  const fix = (n: DtNode, parent?: DtNode): void => {
    n.path = !parent ? '/' : parent.path === '/' ? `/${n.name}` : `${parent.path}/${n.name}`;
    n.parent = parent;
    n.status = statusOf(n);
    byPath.set(n.path, n);
    for (const l of n.labels) byLabel.set(l, n);
    for (const c of n.children) fix(c, n);
  };
  fix(m.root);

  const soc = input.soc ?? detectSoc(m.root);
  const isShared = input.isShared;
  if (isShared) {
    const cache = new Map<string, boolean>();
    const shared = (f: string): boolean => {
      let v = cache.get(f);
      if (v === undefined) cache.set(f, (v = isShared(f, soc)));
      return v;
    };
    for (const n of byPath.values()) {
      for (const d of n.defs) d.shared = shared(d.file);
      for (const p of n.props.values()) for (const d of p.defs) d.shared = shared(d.file);
    }
    for (const mac of input.macros?.values() ?? []) {
      mac.def.shared = shared(mac.def.file);
      for (const u of mac.uses) u.shared = shared(u.file);
    }
    for (const p of m.problems) if (p.loc) p.loc.shared = shared(p.loc.file);
  }

  return {
    model: {
      root: m.root,
      byLabel,
      byPath,
      macros: input.macros ?? new Map(),
      topFile: input.topFile,
      files: input.pre.files,
      soc,
    },
    problems: m.problems,
  };
}

/** 参照（label 名 or パス）が指すノード */
export function resolveRef(model: DtModel, ref: string): DtNode | undefined {
  if (ref.startsWith('/')) {
    return model.byPath.get(ref) ?? [...model.byPath.values()].find((n) => n.path.replace(/@[^/]*/g, '') === ref);
  }
  return model.byLabel.get(ref);
}

export interface RefEdge {
  from: DtNode;
  prop: DtProp;
  to: DtNode;
}

/** 「使う（node が参照している先）」と「使われる（node を参照している元）」の索引 */
export function buildRefIndex(model: DtModel): { uses: Map<DtNode, RefEdge[]>; usedBy: Map<DtNode, RefEdge[]> } {
  const uses = new Map<DtNode, RefEdge[]>();
  const usedBy = new Map<DtNode, RefEdge[]>();
  for (const from of model.byPath.values()) {
    for (const prop of from.props.values()) {
      for (const r of new Set(prop.refs)) {
        const to = resolveRef(model, r);
        if (!to) continue;
        const e = { from, prop, to };
        (uses.get(from) ?? uses.set(from, []).get(from)!).push(e);
        (usedBy.get(to) ?? usedBy.set(to, []).get(to)!).push(e);
      }
    }
  }
  return { uses, usedBy };
}
