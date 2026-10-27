import { resolve } from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { EDGE_PORT, ORIGIN } from './preview'

// Browser tests of the HOSTED PREVIEW profile on one machine: the built Districts server with LOCAL_HOSTED_PREVIEW=true,
// serving the built Play client itself, behind a TLS edge stand-in, connected to a LOCAL Proofy Play and a disposable
// database (README.md). Two runs: PREVIEW_PHASE=founding (controller a), then PREVIEW_PHASE=transfer (controller b, after
// the server and database restart). HEADLESS ONLY.
const repo = resolve(import.meta.dirname, '..')
const phase = process.env.PREVIEW_PHASE ?? 'founding'

export default defineConfig({
  testDir: '.',
  outputDir: '../test-artifacts/playwright-hosted-preview-results',
  // One city, written in order: the phases depend on what came before.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: ORIGIN,
    // The edge stand-in's certificate is a throwaway self-signed one.
    ignoreHTTPSErrors: true,
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], headless: true, viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `npm run build:preview && node_modules/.bin/tsx e2e-hosted-preview/serve.ts`,
    cwd: repo,
    env: { PREVIEW_CONTROLLER: phase === 'transfer' ? 'b' : 'a' },
    url: `https://localhost:${EDGE_PORT}/health`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 240_000,
  },
})
