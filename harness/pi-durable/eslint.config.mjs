import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      'node_modules/**',
      'scratch*/**',
      'reviews/**',
      'fixture/**',
      'example-replay.html',
      // Thin re-export shims for digest-stable import paths.
      'grading-room.mjs',
      'score-receipt.mjs',
      'gate-adapter.mjs',
      'grader-shards.mjs',
      'panel-selection.mjs',
      'audit-rows.mjs',
      'allure-results.mjs',
      'replay-evidence.mjs',
      'panel-adapter.mjs',
      'builder-adapter.mjs',
      'blind-review.mjs',
      'panel-compile.mjs',
      'panel-vm-run.mjs',
    ],
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node },
    rules: {
      ...js.configs.recommended.rules,
      // Remaining .mjs adapters still catch-and-rethrow without cause;
      // convert them before tightening this rule.
      'preserve-caught-error': 'off',
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true },
      globals: globals.node,
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      ...js.configs.recommended.rules,
      ...tseslint.configs.recommendedTypeChecked[1].rules,
      ...tseslint.configs.recommendedTypeChecked[2].rules,
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Historical execution receipts hash these files byte for byte.
    files: [
      'blind-agent-adapter.mjs',
      'panel-browser.mjs',
      'panel-protocol.mjs',
      'panel-telemetry.mjs',
    ],
    rules: { 'no-unused-vars': 'off' },
  },
  {
    // Lifted adapters preserve durable shapes; phase generics / null narrowing follow.
    files: ['tasks/cycle.ts', 'blind-review.ts', 'panel-compile.ts', 'panel-vm-run.ts'],
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      'preserve-caught-error': 'off',
    },
  },
];
