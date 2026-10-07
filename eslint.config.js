import js from '@eslint/js';
import globals from 'globals';

// Warnings are errors: the build runs eslint with --max-warnings 0, and every rule here is an error.
export default [
  { ignores: ['dist/', 'out/', 'node_modules/'] },
  js.configs.recommended,
  {
    rules: {
      complexity: ['error', 12],
      eqeqeq: 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'no-unused-vars': ['error', { caughtErrors: 'none' }],
    },
  },
  { files: ['src/**/*.js'], languageOptions: { globals: globals.browser } },
  { files: ['test/**/*.js', 'tools/**/*.js', 'eslint.config.js'], languageOptions: { globals: globals.node } },
  // The browser tests hand functions to the page, which run there.
  { files: ['test/integration/**/*.js', 'test/acceptance/**/*.js'], languageOptions: { globals: { ...globals.node, document: 'readonly' } } },
];
