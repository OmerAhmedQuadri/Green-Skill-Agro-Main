import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { crossContext } from './layers.js';

/**
 * Shared rules for every package (CONVENTIONS §1). Rules cite the decision
 * they enforce so a failing lint explains itself.
 */
export function base({ tsconfigRootDir, restrictedImports = [] }) {
  return defineConfig(
    { ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/migrations/**', '**/next-env.d.ts'] },
    js.configs.recommended,
    tseslint.configs.recommendedTypeChecked,
    {
      languageOptions: {
        globals: { ...globals.node },
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      rules: {
        'no-restricted-globals': ['error',
          { name: 'parseFloat', message: 'ADR-0003: money and quantities are Decimal — never floats.' }],
        'no-restricted-properties': ['error',
          { object: 'Number', property: 'parseFloat', message: 'ADR-0003: money and quantities are Decimal — never floats.' }],
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/switch-exhaustiveness-check': 'error',
        eqeqeq: ['error', 'always'],
      },
    },
    // The layer rule governs application code, not tooling files (eslint/next/drizzle configs).
    { files: ['src/**/*.{ts,tsx}'], rules: { 'no-restricted-imports': ['error', { patterns: restrictedImports }] } },
    // Tests may reach shared test helpers and context internals; the package layering still applies.
    {
      files: ['src/**/*.test.{ts,tsx}'],
      rules: { 'no-restricted-imports': ['error', { patterns: restrictedImports.filter((p) => p !== crossContext) }] },
    },
    { files: ['**/*.js', '**/*.mjs'], extends: [tseslint.configs.disableTypeChecked] },
  );
}
