import { defineConfig } from 'vitest/config'

// Server tests: `vitest run --config server/vitest.config.ts`, run from the repository root.
export default defineConfig({
  test: {
    include: ['server/tests/**/*.test.ts'],
    environment: 'node',
  },
})
