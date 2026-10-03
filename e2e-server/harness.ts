import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, type BrowserContext, type Page } from '@playwright/test'
import pg from 'pg'

/** Written by serve.ts so the tests can reach the same throwaway schema the server uses. */
export const E2E_STATE_FILE = 'test-artifacts/e2e-server.json'

export interface E2EState {
  databaseUrl: string
  schema: string
}

export async function withDatabase<T>(work: (db: pg.Client) => Promise<T>): Promise<T> {
  const state = JSON.parse(readFileSync(E2E_STATE_FILE, 'utf8')) as E2EState
  const db = new pg.Client({ connectionString: state.databaseUrl })
  await db.connect()
  try {
    return await work(db)
  } finally {
    await db.end()
  }
}

export interface CityRead {
  status: number
  etag: string | null
  sequence: number
  instance: string
  /** Top-level keys of the body: the city says nothing about who is looking. */
  keys: string[]
  /** SHA-256 of the state exactly as served. */
  stateHash: string
}

/** Read /v1/city from inside the page, the way the app does. */
export async function readCity(page: Page): Promise<CityRead> {
  const raw = await page.evaluate(async () => {
    const res = await fetch('/v1/city', { cache: 'no-store' })
    const body = await res.json()
    return { status: res.status, etag: res.headers.get('etag'), sequence: body.city.sequence, instance: body.city.instance, keys: Object.keys(body), state: JSON.stringify(body.state) }
  })
  const { state, ...rest } = raw
  return { ...rest, stateHash: createHash('sha256').update(state).digest('hex') }
}

/** What the page actually drew: every building on the map plus the civic holders. */
export async function drawnCity(page: Page): Promise<string> {
  const parts = await page.evaluate(() => {
    const out: string[] = []
    for (const el of document.querySelectorAll('[data-testid^="building-"][data-total]')) out.push(`${el.getAttribute('data-testid')}:${el.getAttribute('data-tier')}:${el.getAttribute('data-total')}`)
    for (const el of document.querySelectorAll('[data-testid^="hud-mon-"]')) out.push(`${el.getAttribute('data-testid')}:${el.getAttribute('data-holder')}`)
    return out.sort()
  })
  expect(parts.length).toBeGreaterThan(20)
  return createHash('sha256').update(parts.join('|')).digest('hex')
}

export async function openSharedCity(page: Page) {
  await page.goto('/')
  await expect(page.getByTestId('city')).toBeVisible()
  await expect(page.getByTestId('building-812')).toBeAttached()
  await expect(page.getByTestId('viewer-anonymous')).toBeVisible()
}

/** Collect page errors and console errors; `allow` lists console texts a test expects. */
export function watchErrors(page: Page, allow: RegExp[] = []) {
  const problems: string[] = []
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' && !allow.some((re) => re.test(m.text()))) problems.push(`console.error: ${m.text()}`)
  })
  return problems
}

/** Every Content-Security-Policy violation the browser reports in any page of this context, from before the app's first script. */
export async function watchCsp(context: BrowserContext): Promise<string[]> {
  const violations: string[] = []
  await context.exposeFunction('__rcCspViolation', (violation: string) => violations.push(violation))
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      void (window as unknown as { __rcCspViolation(v: string): Promise<void> }).__rcCspViolation(`${e.effectiveDirective} blocked ${e.blockedURI || 'inline'} at ${e.sourceFile ?? ''}:${e.lineNumber}`)
    })
  })
  return violations
}
