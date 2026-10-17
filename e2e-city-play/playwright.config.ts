import { resolve } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

// Browser tests of the Proofy Play launch page against a LOCAL Proofy Play (see README.md for the
// environment it needs). Three servers: the Rare City server connected to that Play (serve.ts),
// the built launch page (its registered launch URL), and the built sample preview, for the
// side-by-side renderer comparison. `npm run test:e2e:city-play`.
const SERVER_PORT = 4351
const PAGE_PORT = 4352
const SAMPLE_PORT = 4353
const repo = resolve(import.meta.dirname, '..')

export default defineConfig({
  testDir: '.',
  outputDir: '../test-artifacts/playwright-city-play-results',
  // One Play, shared state per test (installations are per-test, on fresh Discord servers), so tests may run together.
  fullyParallel: true,
  workers: 2,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: '../test-artifacts/playwright-city-play-report', open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PAGE_PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: `node_modules/.bin/tsx e2e-city-play/serve.ts`,
      cwd: repo,
      env: { CITY_PLAY_SERVER_PORT: String(SERVER_PORT), CITY_PLAY_PAGE_PORT: String(PAGE_PORT) },
      url: `http://127.0.0.1:${SERVER_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npx tsc -b && npx vite build --config proofy-city-play/vite.config.ts && npx vite preview --config proofy-city-play/vite.config.ts --port ${PAGE_PORT} --strictPort`,
      cwd: repo,
      env: { RARE_CITY_SERVER: `http://127.0.0.1:${SERVER_PORT}` },
      url: `http://localhost:${PAGE_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: `npx vite build --config proofy-city-preview/vite.config.ts && npx vite preview --config proofy-city-preview/vite.config.ts --port ${SAMPLE_PORT} --strictPort`,
      cwd: repo,
      url: `http://localhost:${SAMPLE_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})
