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
    // Cycle was lifted out of worker.mjs with durable shapes preserved;
    // phase generics and unsafe-* cleanup follow remaining adapter typing.
    files: ['tasks/cycle.ts'],
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
    },
  },
];
