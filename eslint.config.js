import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import globals from 'globals'

export default tseslint.config(
  {
    // Build output and agent-harness tooling; only app source is linted.
    ignores: ['dist', '.agents', '.claude', '.codex', '.playwright-mcp', '.tmp'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  jsxA11y.flatConfigs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      // Rest-sibling destructuring ({ feasible: _feasible, ...rest }) and
      // deliberately ignored bindings keep the underscore convention.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    // The compute worker runs in a worker scope (self, postMessage).
    files: ['src/engine/worker.ts'],
    languageOptions: {
      globals: { ...globals.worker },
    },
  },
  {
    files: ['**/*.test.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
)
