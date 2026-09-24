import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { vscode: fileURLToPath(new URL('./test/unit/vscode-stub.ts', import.meta.url)) } },
  test: {
    include: ['test/unit/**/*.test.ts'],
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/config/**', 'src/license/**', 'src/workspace/includeGraph.ts', 'src/workspace/paths.ts', 'src/workspace/decide.ts'],
      reporter: ['text', 'text-summary'],
      thresholds: { 'src/core/**': { lines: 80, statements: 80 } },
    },
  },
});
