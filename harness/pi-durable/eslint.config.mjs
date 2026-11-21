import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['node_modules/**', 'scratch*/**', 'fixture/**', 'example-replay.html'],
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node },
    rules: js.configs.recommended.rules,
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
];
