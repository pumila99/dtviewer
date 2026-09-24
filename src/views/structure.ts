import * as path from 'node:path';
import * as vscode from 'vscode';
import { OTHER_ID, OTHER_REASON, type CategoryRule } from '../core/classify';
import type { DtModel, DtNode, SourceLoc } from '../core/model';

export type ViewMode = 'category' | 'address';

interface ElemBase {
  id: string;
  parent?: Elem;
  children: Elem[];
}

export interface GroupElem extends ElemBase {
  kind: 'group';
  label: string;
}

export interface CategoryElem extends ElemBase {
  kind: 'category';
  categoryId: string;
  label: string;
}

export interface NodeElem extends ElemBase {
  kind: 'node';
  node: DtNode;
  /** 別カテゴリにも属するノードのリンク項目（本体はバスの下などにある） */
  link: boolean;
}

export type Elem = GroupElem | CategoryElem | NodeElem;

export const OTHER_GROUP = 'その他';

/** ユニットアドレス（"ff130000"、"0,1000" など）を並べ替え用の数値列にする */
export function addressKey(name: string): bigint[] | undefined {
  const at = name.indexOf('@');
  if (at < 0) return undefined;
  const parts = name.slice(at + 1).split(',');
  try {
    return parts.map((p) => BigInt(`0x${p}`));
  } catch {
    return undefined;
  }
}

export function compareByAddress(a: DtNode, b: DtNode): number {
  const ka = addressKey(a.name);
  const kb = addressKey(b.name);
  if (!ka && !kb) return 0;
  if (!ka) return -1;
  if (!kb) return 1;
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const x = ka[i] ?? -1n;
    const y = kb[i] ?? -1n;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

const catOf = (n: DtNode): string => n.category?.id ?? OTHER_ID;

export function statusMark(n: DtNode): string {
  return n.status === 'okay' ? '●' : n.status === 'disabled' ? '○' : '◌';
}

function locText(d: SourceLoc, root?: string): string {
  const f = root && !path.relative(root, d.file).startsWith('..') ? path.relative(root, d.file) : d.file;
  const range = d.endLine > d.line ? `${d.line}-${d.endLine}` : `${d.line}`;
  return `${f}:${range}${d.shared ? '（共通）' : ''}`;
}

/** ツリーの中身（VSCode に依存しない組み立て部分） */
export function buildTree(model: DtModel, rules: CategoryRule[], mode: ViewMode, hideDisabled: boolean): { roots: Elem[]; primary: Map<DtNode, NodeElem> } {
  const primary = new Map<DtNode, NodeElem>();
  const hidden = (n: DtNode): boolean => hideDisabled && n.status === 'disabled';

  const nodeElem = (node: DtNode, parent: Elem, idPrefix: string, filterChildren?: (c: DtNode) => boolean): NodeElem => {
    const e: NodeElem = { kind: 'node', id: `${idPrefix}/${node.name}`, node, link: false, parent, children: [] };
    primary.set(node, e);
    let kids = node.children.filter((c) => !hidden(c));
    if (filterChildren) kids = kids.filter(filterChildren);
    if (mode === 'address') kids = [...kids].sort(compareByAddress);
    e.children = kids.map((c) => nodeElem(c, e, e.id, filterChildren));
    return e;
  };

  if (mode === 'address') {
    const top: NodeElem = { kind: 'node', id: 'a:', node: model.root, link: false, children: [] };
    const kids = model.root.children.filter((c) => !hidden(c)).sort(compareByAddress);
    const roots = kids.map((c) => nodeElem(c, top, 'a:'));
    for (const r of roots) r.parent = undefined;
    return { roots, primary };
  }

  // カテゴリ別
  const groups = new Map<string, GroupElem>();
  const cats = new Map<string, CategoryElem>();
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const groupOrder = [...new Set([...rules.map((r) => r.group), OTHER_GROUP])];
  const catElem = (id: string): CategoryElem => {
    let c = cats.get(id);
    if (!c) {
      const rule = ruleById.get(id);
      const gname = rule?.group ?? OTHER_GROUP;
      let g = groups.get(gname);
      if (!g) {
        g = { kind: 'group', id: `g:${gname}`, label: gname, children: [] };
        groups.set(gname, g);
      }
      c = { kind: 'category', id: `c:${id}`, categoryId: id, label: rule?.label ?? (id === OTHER_ID ? 'その他' : id), parent: g, children: [] };
      g.children.push(c);
      cats.set(id, c);
    }
    return c;
  };

  // バス配下のデバイスはそのまま子として出すので、分類済みの祖先があるかを見る
  const categorizedAncestor = (n: DtNode): DtNode | undefined => {
    for (let p = n.parent; p && p !== model.root; p = p.parent) if (catOf(p) !== OTHER_ID) return p;
    return undefined;
  };
  const visible = (n: DtNode): boolean => {
    for (let p: DtNode | undefined = n; p && p !== model.root; p = p.parent) if (hidden(p)) return false;
    return true;
  };

  const links: { node: DtNode; cat: string }[] = [];
  const walk = (n: DtNode): void => {
    for (const c of n.children) {
      if (!visible(c)) continue;
      const cat = catOf(c);
      const anc = categorizedAncestor(c);
      if (cat !== OTHER_ID) {
        if (!anc) {
          const ce = catElem(cat);
          ce.children.push(nodeElem(c, ce, ce.id));
        } else links.push({ node: c, cat });
      } else if (!anc && n === model.root) {
        const ce = catElem(OTHER_ID);
        // 「その他」の入れ物の下には、分類済みでないものだけを出す（分類済みはそれぞれのカテゴリに出る）
        ce.children.push(nodeElem(c, ce, ce.id, (k) => catOf(k) === OTHER_ID || !!categorizedAncestor(k)));
      }
      walk(c);
    }
  };
  walk(model.root);
  for (const { node, cat } of links) {
    const ce = catElem(cat);
    ce.children.push({ kind: 'node', id: `${ce.id}/→${node.path}`, node, link: true, parent: ce, children: [] });
  }
  const roots = groupOrder.flatMap((g) => (groups.has(g) ? [groups.get(g)!] : []));
  for (const g of roots) {
    const order = new Map(rules.map((r, i) => [r.id, i]));
    g.children.sort((a, b) => (order.get((a as CategoryElem).categoryId) ?? 1e9) - (order.get((b as CategoryElem).categoryId) ?? 1e9));
  }
  return { roots, primary };
}

export function nodeTooltip(n: DtNode, root?: string): string {
  const lines = [`**${n.path}**`, ''];
  if (n.labels.length) lines.push(`ラベル: ${n.labels.map((l) => `\`${l}\``).join(', ')}`, '');
  lines.push(`状態: ${n.status}`, '');
  const cat = n.category;
  lines.push(`分類: ${cat ? `${cat.id} — ${cat.reason}` : OTHER_REASON}`);
  if (cat?.ruleSource) lines.push(`（ルール: ${locText(cat.ruleSource, root)}）`);
  lines.push('', '書かれた場所:');
  n.defs.forEach((d, i) => lines.push(`- ${locText(d, root)}${i === n.defs.length - 1 ? ' ← 効いている' : ''}`));
  return lines.join('\n');
}

export class StructureProvider implements vscode.TreeDataProvider<Elem> {
  private readonly emitter = new vscode.EventEmitter<Elem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  mode: ViewMode = 'category';
  hideDisabled = false;
  private model: DtModel | undefined;
  private rules: CategoryRule[] = [];
  private roots: Elem[] = [];
  private primary = new Map<DtNode, NodeElem>();

  constructor(private readonly root: () => string | undefined) {}

  setModel(model: DtModel | undefined, rules: CategoryRule[]): void {
    this.model = model;
    this.rules = rules;
    this.rebuild();
  }

  setMode(mode: ViewMode): void {
    this.mode = mode;
    void vscode.commands.executeCommand('setContext', 'dtviewer.viewMode', mode);
    this.rebuild();
  }

  setHideDisabled(hide: boolean): void {
    this.hideDisabled = hide;
    void vscode.commands.executeCommand('setContext', 'dtviewer.hideDisabled', hide);
    this.rebuild();
  }

  private rebuild(): void {
    if (this.model) {
      const t = buildTree(this.model, this.rules, this.mode, this.hideDisabled);
      this.roots = t.roots;
      this.primary = t.primary;
    } else {
      this.roots = [];
      this.primary = new Map();
    }
    this.emitter.fire();
  }

  /** そのノードの本体の項目（リンクではない方） */
  elemFor(node: DtNode): NodeElem | undefined {
    return this.primary.get(node);
  }

  getRoots(): Elem[] {
    return this.roots;
  }

  getChildren(e?: Elem): Elem[] {
    return e ? e.children : this.roots;
  }

  getParent(e: Elem): Elem | undefined {
    return e.parent;
  }

  getTreeItem(e: Elem): vscode.TreeItem {
    if (e.kind === 'group') {
      const item = new vscode.TreeItem(e.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = e.id;
      item.contextValue = 'group';
      return item;
    }
    if (e.kind === 'category') {
      const item = new vscode.TreeItem(e.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = e.id;
      item.description = `${e.children.length}`;
      item.contextValue = 'category';
      if (e.categoryId === OTHER_ID) item.tooltip = OTHER_REASON;
      return item;
    }
    const n = e.node;
    const state = e.children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(`${statusMark(n)} ${e.link ? '→ ' : ''}${n.name}`, state);
    item.id = e.id;
    const desc = [...n.labels];
    if (e.link && n.parent) desc.push(`${n.parent.path} の下`);
    item.description = desc.join(' · ');
    const md = new vscode.MarkdownString(nodeTooltip(n, this.root()));
    item.tooltip = md;
    item.contextValue = e.link ? 'dtnode.link' : 'dtnode';
    item.command = { command: 'dtviewer.openInEditor', title: 'エディタで開く', arguments: [n.path, { direct: true }] };
    return item;
  }

  /** file:line（1 始まり）を含む一番内側のノード */
  nodeAt(file: string, line: number): DtNode | undefined {
    if (!this.model) return undefined;
    let best: DtNode | undefined;
    let bestSpan = Infinity;
    for (const n of this.model.byPath.values()) {
      if (n === this.model.root) continue;
      for (const d of n.defs) {
        if (d.file !== file || line < d.line || line > d.endLine) continue;
        const span = d.endLine - d.line;
        if (span < bestSpan || (span === bestSpan && best && n.path.length > best.path.length)) {
          best = n;
          bestSpan = span;
        }
      }
    }
    return best;
  }
}
