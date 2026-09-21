import nextPlugin from '@next/eslint-plugin-next';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import { base } from './base.js';

// I18N-002: physical left/right utilities break the Arabic RTL layout.
const PHYSICAL = String.raw`/(^|[\s:])-?(m[lr]|p[lr]|border-[lr]|rounded-[lr]|rounded-[tb][lr]|scroll-[mp][lr]|left|right)-|(^|[\s:])(text-(left|right)|float-(left|right)|border-[lr])(?=\s|$)/`;
const RTL_MSG = 'I18N-002: logical CSS only — ms-/me-/ps-/pe-/start-/end-/text-start, never left/right.';
const TEXT_MSG = 'I18N-001: no user-visible text in code — add a next-intl message in en.json and ar.json.';

export function next({ tsconfigRootDir, restrictedImports = [] }) {
  return defineConfig(
    base({ tsconfigRootDir, restrictedImports }),
    {
      files: ['**/*.{ts,tsx}'],
      plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
      languageOptions: { globals: { ...globals.browser } },
      rules: {
        ...nextPlugin.configs.recommended.rules,
        ...nextPlugin.configs['core-web-vitals'].rules,
        ...reactHooks.configs.recommended.rules,
      },
    },
    {
      // UI rules govern application source — not test titles or tooling configs.
      files: ['src/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-syntax': ['error',
          { selector: `Literal[value=${PHYSICAL}]`, message: RTL_MSG },
          { selector: `TemplateElement[value.raw=${PHYSICAL}]`, message: RTL_MSG },
          { selector: 'JSXText[value=/\\S/]', message: TEXT_MSG },
          { selector: 'JSXAttribute[name.name=/^(aria-label|placeholder|title|alt)$/] > Literal', message: TEXT_MSG },
          { selector: "ExpressionStatement[directive='use server']", message: 'ADR-0007: mutations go through /api/v1 route handlers, never Server Actions.' },
          { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'SECURITY §4: React escapes output. Raw HTML is never rendered.' },
        ],
      },
    },
  );
}
