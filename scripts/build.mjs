// esbuild で dist/extension.js を 1 ファイルにまとめ、wasm を横に置く。
// --tests を付けると画面テストも out/ にまとめる。
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const tests = process.argv.includes('--tests');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  external: ['vscode'],
  logLevel: 'info',
  // jsonc-parser などの UMD 版は動的 require でまとめられないので ESM 版を優先する
  mainFields: ['module', 'main'],
  // ESM 版は import.meta.url を使うので、cjs にまとめるときは CJS 版を使う
  alias: { 'web-tree-sitter': require.resolve('web-tree-sitter') },
};

await esbuild.build({ ...common, entryPoints: [path.join(root, 'src/extension.ts')], outfile: path.join(root, 'dist/extension.js') });

// wasm（web-tree-sitter 本体と devicetree 文法）
const wasm = [
  require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
  path.join(path.dirname(require.resolve('tree-sitter-devicetree/package.json')), 'tree-sitter-devicetree.wasm'),
];
for (const w of wasm) fs.copyFileSync(w, path.join(root, 'dist', path.basename(w)));

if (tests) {
  const dir = path.join(root, 'test/integration');
  const entries = [path.join(dir, 'runTest.ts'), path.join(dir, 'suite/index.ts'), ...fs.readdirSync(path.join(dir, 'suite')).filter((f) => f.endsWith('.test.ts')).map((f) => path.join(dir, 'suite', f))];
  await esbuild.build({ ...common, entryPoints: entries, outdir: path.join(root, 'out/integration'), outbase: dir, external: ['vscode', 'mocha', '@vscode/test-electron'] });
}
