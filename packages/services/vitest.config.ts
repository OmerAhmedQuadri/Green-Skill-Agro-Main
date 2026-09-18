import { defineConfig } from 'vitest/config';

// Unit tests only; database tests are *.int.test.ts, R2 contract tests *.r2.test.ts (TESTING §1).
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], exclude: ['src/**/*.int.test.ts', 'src/**/*.r2.test.ts', 'node_modules/**'] },
});
