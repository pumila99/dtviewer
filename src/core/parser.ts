import { Language, Parser } from 'web-tree-sitter';

export type { Node as SyntaxNode, Tree } from 'web-tree-sitter';

export interface WasmPaths {
  /** web-tree-sitter.wasm */
  runtime: string;
  /** tree-sitter-devicetree.wasm */
  grammar: string;
}

let ready: Promise<Parser> | undefined;

/** devicetree 文法のパーサを用意する（2 回目以降は同じものを返す）。 */
export function initParser(wasm: WasmPaths): Promise<Parser> {
  ready ??= (async () => {
    await Parser.init({ locateFile: () => wasm.runtime });
    const lang = await Language.load(wasm.grammar);
    const parser = new Parser();
    parser.setLanguage(lang);
    return parser;
  })();
  return ready;
}

export function getParser(): Promise<Parser> {
  if (!ready) return Promise.reject(new Error('initParser() が呼ばれていません'));
  return ready;
}
