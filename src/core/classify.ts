import type { CategoryResult, DtModel, DtNode, SourceLoc } from './model';

export interface CategoryRule {
  id: string;
  label: string;
  group: string;
  match: { compatible?: string[]; nodeName?: string[] };
  /** ルールが書かれた場所（設定ファイル） */
  source?: SourceLoc;
}

export const OTHER_ID = 'other';
export const OTHER_REASON = 'どのルールにも一致しません';

const cache = new Map<string, RegExp>();

/** `*` と `?` だけのワイルドカード（大文字小文字は区別しない） */
export function globMatch(pattern: string, text: string): boolean {
  let re = cache.get(pattern);
  if (!re) {
    const body = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    re = new RegExp(`^${body}$`, 'i');
    cache.set(pattern, re);
  }
  return re.test(text);
}

function compatibles(node: DtNode): string[] {
  return (node.props.get('compatible')?.value ?? []).flatMap((v) => (v.kind === 'string' ? [v.value] : []));
}

/**
 * ノードを分類する。まず全ルールを上から compatible で試し、どれにも当たらなければ
 * 全ルールを上からノード名で試す。どちらも外れたら other。
 */
export function classify(node: DtNode, rules: CategoryRule[]): CategoryResult {
  const compat = compatibles(node);
  for (const rule of rules) {
    for (const pat of rule.match.compatible ?? []) {
      const hit = compat.find((c) => globMatch(pat, c));
      if (hit) return { id: rule.id, reason: `compatible ${hit} が ${pat} に一致`, ruleSource: rule.source };
    }
  }
  for (const rule of rules) {
    for (const pat of rule.match.nodeName ?? []) {
      if (globMatch(pat, node.name)) return { id: rule.id, reason: `ノード名 ${node.name} が ${pat} に一致`, ruleSource: rule.source };
    }
  }
  return { id: OTHER_ID, reason: OTHER_REASON };
}

/** モデルの全ノード（ルート以外）に category を付ける */
export function classifyModel(model: DtModel, rules: CategoryRule[]): void {
  for (const n of model.byPath.values()) {
    if (n === model.root) continue;
    n.category = classify(n, rules);
  }
}
