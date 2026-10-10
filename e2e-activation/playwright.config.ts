import { resolve } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

// Browser tests of the Friend activation UX: the SERVER-MODE client bundle, with the Rare
// City API and the wallet both played by the test (see world.ts). No server, no database,
// no chain and no real wallet, so it runs anywhere. `npm run test:e2e:activation`.
const PORT = 4325
const OUT = 'test-artifacts/activation-app'

export default defineConfig({
  testDir: '.',
  outputDir: '../test-artifacts/playwright-activation-results',
  fullyParallel: true,
  workers: 2,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  reporter: [['list'], ['html', { outputFolder: '../test-artifacts/playwright-activation-report', open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `npx tsc -b && VITE_APP_MODE=server npx vite build --outDir ${OUT} --emptyOutDir && npx vite preview --outDir ${OUT} --port ${PORT} --strictPort`,
    cwd: resolve(import.meta.dirname, '..'),
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
