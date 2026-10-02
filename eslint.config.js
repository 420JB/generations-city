import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'dist-server', 'test-artifacts', 'playwright-report', 'test-results']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // The deterministic engine is shared with the server: it must stay free of browser and UI code.
    files: ['src/game/**/*.ts', 'src/config/**/*.ts', 'src/protocol/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['react', 'react-dom', 'react-dom/*', '**/ui/**', '**/transport/**', 'node:*', 'pg'], message: 'src/game, src/config and src/protocol are shared with the server and must stay portable.' }] }],
      'no-restricted-globals': ['error', 'window', 'document', 'localStorage', 'sessionStorage', 'navigator', 'fetch'],
    },
  },
  {
    files: ['server/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // The service reuses the engine only; demo fixtures and client code stay out of it.
    files: ['server/src/**/*.ts'],
    ignores: ['server/src/fixtures/**', 'server/src/seed-demo-cli.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['react', 'react-dom', '**/src/ui/**', '**/src/transport/**', '**/src/game/seed', '**/src/game/demo', '**/src/game/demoCommands', '**/src/game/persistence', '**/src/game/growth', '**/fixtures/**'], message: 'The server may import the deterministic engine only, never demo fixtures or client code.' }] }],
    },
  },
  {
    // The explicit NON-CANONICAL staging fixture: the one place the demo seed is allowed, and only the fixture command may load it.
    files: ['server/src/fixtures/**/*.ts', 'server/src/seed-demo-cli.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['react', 'react-dom', '**/src/ui/**', '**/src/transport/**'], message: 'Server code never imports client code.' }] }],
    },
  },
])
