import { defineConfig } from 'vitest/config'

// Server tests: `vitest run --config server/vitest.config.ts`, run from the repository root.
export default defineConfig({
  test: {
    include: ['server/tests/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['server/tests/globalSetup.ts'],
    // Database tests migrate a fresh schema each; on a busy machine that can take longer than the default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
