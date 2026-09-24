import * as fs from 'node:fs';
import type { MacroDef } from './model';
import { getParser, type SyntaxNode, type Tree } from './parser';

export interface SourceComment {
  line: number;
  text: string;
}

export interface SourceDefine {
  name: string;
  value: string;
  params?: string[];
  line: number;
  endLine: number;
}

export interface SourceSyntaxError {
  line: number;
  column: number;
  message: string;
}

/** cpp 前の 1 ファイル分の CST と索引。 */
export interface SourceFile {
  file: string;
  text: string;
  tree: Tree;
  comments: SourceComment[];
  defines: SourceDefine[];
  includes: { path: string; line: number }[];
  errors: SourceSyntaxError[];
  /** 行（1 始まり）→ その行で始まる property ノード */
  propsByLine: Map<number, SyntaxNode[]>;
}

/** 深さ優先でたどる。fn が false を返したらその下には入らない。 */
function walk(node: SyntaxNode, fn: (n: SyntaxNode) => boolean | void): void {
  if (fn(node) === false) return;
  for (const c of node.children) if (c) walk(c, fn);
}

function stripQuotes(s: string): string {
  return s.replace(/^["<]|[">]$/g, '');
}

/** 1 ファイルを cpp 前のまま読む。構文エラーがあっても読めた部分は索引に入れる。 */
export async function parseSource(file: string, text?: string): Promise<SourceFile> {
  const body = text ?? fs.readFileSync(file, 'utf8');
  const parser = await getParser();
  const tree = parser.parse(body);
  if (!tree) throw new Error(`parse に失敗しました: ${file}`);
  const src: SourceFile = {
    file,
    text: body,
    tree,
    comments: [],
    defines: [],
    includes: [],
    errors: [],
    propsByLine: new Map(),
  };
  walk(tree.rootNode, (n) => {
    const line = n.startPosition.row + 1;
    switch (n.type) {
      case 'comment':
        src.comments.push({ line, text: n.text });
        return false;
      case 'preproc_def':
      case 'preproc_function_def': {
        const name = n.childForFieldName('name')?.text ?? '';
        const value = (n.childForFieldName('value')?.text ?? '').trim();
        const params = n.childForFieldName('parameters')?.namedChildren.flatMap((p) => (p ? [p.text] : []));
        src.defines.push({ name, value, params, line, endLine: n.endPosition.row + (n.endPosition.column === 0 ? 0 : 1) });
        return false;
      }
      case 'preproc_include':
      case 'dtsi_include': {
        const p = n.childForFieldName('path');
        if (p) src.includes.push({ path: stripQuotes(p.text), line });
        return false;
      }
      case 'property': {
        const list = src.propsByLine.get(line) ?? [];
        list.push(n);
        src.propsByLine.set(line, list);
        return undefined;
      }
    }
    if (n.isError || n.isMissing) {
      src.errors.push({
        line,
        column: n.startPosition.column + 1,
        message: n.isMissing ? `${n.type} がありません` : `構文エラー: ${n.text.slice(0, 40)}`,
      });
      if (n.isMissing) return false;
    }
    return undefined;
  });
  return src;
}

/**
 * property ノードの値部分（= と ; の間）を、書かれたままの文字列で返す。
 * マクロ（BOARD_NAME など）は cpp 前の文法では値として読めないことがあるので、ノードではなく文字で切り出す。
 */
export function propertyRaw(prop: SyntaxNode, text: string): string {
  const name = prop.childForFieldName('name');
  if (!name) return '';
  let end = text.indexOf(';', name.endIndex);
  if (end < 0) end = prop.endIndex;
  const body = text.slice(name.endIndex, end);
  const eq = body.indexOf('=');
  return eq < 0 ? '' : body.slice(eq + 1).trim();
}

/** その行で始まる、名前が name の property を探して、書かれたままの値を返す。 */
export function findRaw(src: SourceFile, line: number, name: string): string | undefined {
  const hit = src.propsByLine.get(line)?.find((p) => p.childForFieldName('name')?.text === name);
  return hit ? propertyRaw(hit, src.text) : undefined;
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;
/** この親の下の identifier はノード名・プロパティ名・ラベルなので、マクロの使用箇所に数えない */
const NAME_PARENTS = new Set(['property', 'node', 'delete_property', 'delete_node', 'reference', 'path_node', 'memory_reservation']);

/**
 * #define の索引を作る。後に書かれた定義が勝つ（cpp と同じく上書き扱い）。
 * 使用箇所は、どこかで #define された名前が識別子として出てくる場所。
 */
export function buildMacroIndex(sources: SourceFile[], isShared: (file: string) => boolean = () => false): Map<string, MacroDef> {
  const macros = new Map<string, MacroDef>();
  for (const src of sources) {
    const shared = isShared(src.file);
    for (const d of src.defines) {
      if (!d.name) continue;
      macros.set(d.name, {
        name: d.name,
        value: d.value,
        def: { file: src.file, line: d.line, endLine: d.endLine, shared },
        uses: [],
      });
    }
  }
  if (macros.size === 0) return macros;
  for (const src of sources) {
    const shared = isShared(src.file);
    walk(src.tree.rootNode, (n) => {
      if (n.type === 'comment' || n.type === 'string_literal' || n.type === 'preproc_include' || n.type === 'dtsi_include') return false;
      if (n.type === 'preproc_def' || n.type === 'preproc_function_def') {
        // 定義の本体に出てくる別マクロも使用箇所に数える
        const v = n.childForFieldName('value');
        if (v) {
          for (const m of v.text.matchAll(IDENT)) {
            const def = macros.get(m[0]);
            if (def) def.uses.push({ file: src.file, line: v.startPosition.row + 1, endLine: v.startPosition.row + 1, shared });
          }
        }
        return false;
      }
      if (n.type === 'identifier') {
        const def = macros.get(n.text);
        if (def && !NAME_PARENTS.has(n.parent?.type ?? '')) {
          const line = n.startPosition.row + 1;
          def.uses.push({ file: src.file, line, endLine: line, shared });
        }
      }
      return undefined;
    });
  }
  return macros;
}
