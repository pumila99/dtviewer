import * as path from 'node:path';
import { initParser } from '../src/core/parser';

export const ROOT = path.resolve(__dirname, '..');
export const FIX = path.join(ROOT, 'test', 'fixtures');
export const fx = (...p: string[]): string => path.join(FIX, ...p);

export const WASM = {
  runtime: require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
  grammar: path.join(path.dirname(require.resolve('tree-sitter-devicetree/package.json')), 'tree-sitter-devicetree.wasm'),
};

export function setupParser(): Promise<unknown> {
  return initParser(WASM);
}
