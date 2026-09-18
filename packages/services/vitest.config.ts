import { defineConfig } from 'vitest/config';

// Unit tests only; database tests are *.int.test.ts (TESTING §1).
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], exclude: ['src/**/*.int.test.ts', 'node_modules/**'] },
});
