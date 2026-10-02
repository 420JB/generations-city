import { resolve } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

// Server-mode browser tests: the built Rare City app served by the built server, reading
// one shared city from a disposable Postgres. `npm run test:e2e:server`.
const PORT = 4319

if (!process.env.TEST_DATABASE_URL)
  throw new Error('npm run test:e2e:server needs TEST_DATABASE_URL: a disposable Postgres database whose name ends in "_test". See server/README.md.')

export default defineConfig({
  testDir: '.',
  outputDir: '../test-artifacts/playwright-server-results',
  // One shared city: the tests read it, and one changes it, so they run in order.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  reporter: [['list'], ['html', { outputFolder: '../test-artifacts/playwright-server-report', open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'npm run build:app && npx tsx e2e-server/serve.ts',
    cwd: resolve(import.meta.dirname, '..'),
    url: `http://127.0.0.1:${PORT}/ready`,
    env: { E2E_PORT: String(PORT) },
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    timeout: 180_000,
  },
})
