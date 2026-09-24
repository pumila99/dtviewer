import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/golden/**/*.test.ts'],
    testTimeout: 60000,
  },
});
