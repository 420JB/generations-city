import { resolve } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

// Browser tests of the configurable-city LOCAL PREVIEW: the standard renderer drawing the
// simulated sample brands. No server, database, chain, wallet or Proofy. `npm run test:e2e:city-preview`.
const PORT = 4333
// The dev server (`npm run dev:city-preview`, on its own port here) runs the startup smoke test only.
const DEV_PORT = 4334

export default defineConfig({
  testDir: '.',
  outputDir: '../test-artifacts/playwright-city-preview-results',
  fullyParallel: true,
  workers: 2,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  reporter: [['list'], ['html', { outputFolder: '../test-artifacts/playwright-city-preview-report', open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'dev-server', testMatch: 'startup.spec.ts', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, baseURL: `http://localhost:${DEV_PORT}` } },
  ],
  webServer: [
    {
      command: `npx tsc -b && npx vite build --config proofy-city-preview/vite.config.ts && npx vite preview --config proofy-city-preview/vite.config.ts --port ${PORT} --strictPort`,
      cwd: resolve(import.meta.dirname, '..'),
      url: `http://localhost:${PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: `npx vite --config proofy-city-preview/vite.config.ts --port ${DEV_PORT} --strictPort`,
      cwd: resolve(import.meta.dirname, '..'),
      url: `http://localhost:${DEV_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
})
