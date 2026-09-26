import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-crazygames/**',
      '**/node_modules/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['apps/client/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Rule 2 in CLAUDE.md: the shared simulation must be deterministic and portable.
    files: ['packages/shared/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'packages/shared must not touch the DOM.' },
        { name: 'document', message: 'packages/shared must not touch the DOM.' },
        { name: 'performance', message: 'No wall-clock time in simulation.' },
        { name: 'process', message: 'No Node-only APIs in simulation.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'No wall-clock time in simulation.' },
        { object: 'Math', property: 'random', message: 'Use a seeded RNG in simulation.' },
      ],
    },
  },
);
