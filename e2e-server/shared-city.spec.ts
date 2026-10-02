import { expect, test, type Page } from '@playwright/test'
import { drawnCity, openSharedCity, readCity, watchErrors, withDatabase } from './harness.ts'

const LOCAL_KEY = 'generations-city:state:v5'

async function warpTo(page: Page, friendId: number) {
  await page.getByTestId('friend-search').fill(String(friendId))
  await page.getByTestId('friend-search-go').click()
  await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', String(friendId))
}

test.describe('same-origin server app', () => {
  test('one origin serves the app, the API and the diagnostics', async ({ request }) => {
    const index = await request.get('/')
    expect(index.status()).toBe(200)
    expect(index.headers()['content-type']).toBe('text/html; charset=utf-8')
    expect(await index.text()).toContain('<div id="root">')

    const city = await request.get('/v1/city')
    expect(city.status()).toBe(200)
    const body = await city.json()
    expect(body.city).toMatchObject({ id: 'main', sequence: 1, canonical: false, origin: 'demo-fixture' })
    expect(Object.keys(body)).toEqual(['city', 'server', 'state'])
    expect(await (await request.get('/v1/viewer')).json()).toEqual({ authenticated: false })

    expect(await (await request.get('/health')).json()).toEqual({ status: 'ok' })
    expect(await (await request.get('/ready')).json()).toEqual({ status: 'ready', checks: { database: 'ok', migrations: 'ok', environment: 'ok' } })
    expect((await (await request.get('/version')).json()).service).toBe('rare-city-server')

    const route = await request.get('/friend/812')
    expect(route.status()).toBe(200)
    expect(await route.text()).toContain('<div id="root">')
    for (const path of ['/v1/nope', '/health/x', '/missing-asset.js']) {
      const res = await request.get(path)
      expect(res.status(), path).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
    }
    for (const path of ['/v1/city', '/v1/commands', '/']) expect((await request.post(path, { data: { type: 'faucet' } })).status(), path).toBe(405)
  })
})

test.describe('anonymous visitor', () => {
  test('browses the shared city with no player identity and no demo controls', async ({ page }) => {
    const problems = watchErrors(page)
    await openSharedCity(page)

    await expect(page.getByTestId('viewer-anonymous')).toContainText('Visitor')
    await expect(page.getByTestId('viewer-anonymous')).toContainText('NON-CANONICAL TEST CITY')
    for (const id of ['wallet', 'hud-season', 'reset-demo', 'nav-help', 'nav-profile', 'demo-guide', 'guide-reminder', 'player-marker']) await expect(page.getByTestId(id), id).toHaveCount(0)
    await expect(page.getByText('Restored your local demo city')).toHaveCount(0)

    // The city itself is all there: the seeded holders, the map, the perimeter.
    await expect(page.getByTestId('hud-mon-m4')).toHaveAttribute('data-holder', 'd2')
    await expect(page.getByTestId('city-perimeter')).toBeAttached()
    await expect(page.getByTestId('building-812')).toHaveAttribute('data-total', '9962')
    expect(problems).toEqual([])
  })

  test('can explore every panel; nothing offers to spend, build, edit or simulate', async ({ page }) => {
    const problems = watchErrors(page)
    await openSharedCity(page)

    // Build Board and WARP are navigation, and still work.
    await page.getByTestId('nav-board').click()
    await expect(page.getByTestId('impact-0')).toHaveAttribute('data-building', '812')
    await page.getByTestId('impact-0-warp').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '812')
    await expect(page.getByTestId('read-only-note')).toBeVisible()
    for (const id of ['amount-exact', 'amount-100', 'confirm-contribution', 'rally-btn', 'panel-wallet', 'open-architect', 'allegiance-note']) await expect(page.getByTestId(id), id).toHaveCount(0)
    await expect(page.locator('#custom-amt')).toHaveCount(0)

    // The local demo player's own tower is just another building to a visitor.
    await warpTo(page, 4471)
    await expect(page.locator('.own-tag')).toHaveCount(0)
    await expect(page.getByTestId('open-architect')).toHaveCount(0)
    await expect(page.getByTestId('read-only-note')).toBeVisible()
    await page.keyboard.press('Escape')

    await page.getByTestId('nav-standings').click()
    await expect(page.getByTestId('city-growth')).toHaveText('City Growth · Wards')
    await expect(page.getByTestId('growth-d5')).toBeVisible()
    await expect(page.locator('[data-testid^="join-"]')).toHaveCount(0)

    await page.getByTestId('nav-radio').click()
    await expect(page.getByTestId('radio')).toBeVisible()
    await expect(page.getByTestId('radio-list')).toBeVisible()
    for (const id of ['demo-tools', 'rival-turn', 'simulate-growth', 'rally-calls']) await expect(page.getByTestId(id), id).toHaveCount(0)
    await page.keyboard.press('Escape')

    // Camera controls are client-side and unaffected.
    await page.getByTestId('rotate-right').click()
    await page.getByTestId('rotate-reset').click()
    await expect(page.getByTestId('city')).toBeVisible()
    expect(problems).toEqual([])
  })

  test('a local demo city saved in this browser never overrides the server, and is left alone', async ({ context, page }) => {
    const fake = await page.request.get('/v1/city').then(async (r) => (await r.json()).state)
    fake.clock = 999
    fake.monuments.m4.holder = 'd9'
    fake.wallets['demo-player'] = 1
    const saved = JSON.stringify(fake)
    await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [LOCAL_KEY, saved])

    await openSharedCity(page)
    await expect(page.getByTestId('hud-mon-m4')).toHaveAttribute('data-holder', 'd2')
    await expect(page.getByTestId('wallet')).toHaveCount(0)
    await page.getByTestId('nav-board').click()
    await page.getByTestId('impact-0-warp').click()
    await page.keyboard.press('Escape')

    const storage = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])))
    expect(storage).toEqual({ [LOCAL_KEY]: saved })
  })
})

test.describe('one shared city', () => {
  test('two independent browsers receive the same state and sequence, and draw the same city', async ({ browser }) => {
    const [a, b] = await Promise.all([browser.newContext(), browser.newContext()])
    const [pageA, pageB] = await Promise.all([a.newPage(), b.newPage()])
    await Promise.all([openSharedCity(pageA), openSharedCity(pageB)])

    const [readA, readB] = await Promise.all([readCity(pageA), readCity(pageB)])
    expect(readA.status).toBe(200)
    expect(readA.sequence).toBe(1)
    expect(readB).toEqual(readA)
    expect(readA.keys).toEqual(['city', 'server', 'state'])
    expect(await drawnCity(pageB)).toBe(await drawnCity(pageA))

    // A refresh and a brand-new third browser land on the very same city.
    await pageA.reload()
    await openSharedCity(pageA)
    expect(await readCity(pageA)).toEqual(readA)
    const pageC = await (await browser.newContext()).newPage()
    await openSharedCity(pageC)
    expect(await readCity(pageC)).toEqual(readA)
    expect(await drawnCity(pageC)).toBe(await drawnCity(pageB))
    await Promise.all([a.close(), b.close(), pageC.context().close()])
  })

  test('no browser can change it; a change made by the authority reaches every browser', async ({ browser }) => {
    const [a, b] = await Promise.all([browser.newContext(), browser.newContext()])
    const [pageA, pageB] = await Promise.all([a.newPage(), b.newPage()])
    await Promise.all([openSharedCity(pageA), openSharedCity(pageB)])
    const before = await readCity(pageA)

    // Everything a browser could try: write to the API, or drive the UI.
    const attempts = await pageA.evaluate(async () => {
      const out: number[] = []
      for (const [method, path] of [['POST', '/v1/city'], ['PUT', '/v1/city'], ['PATCH', '/v1/city'], ['DELETE', '/v1/city'], ['POST', '/v1/commands'], ['POST', '/v1/city/contribute']])
        out.push((await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: method === 'DELETE' ? undefined : JSON.stringify({ type: 'contribute', buildingId: 'b-812', amount: 38 }) })).status)
      return out
    })
    expect(attempts).toEqual([405, 405, 405, 405, 405, 405])
    await warpTo(pageA, 812)
    await expect(pageA.getByTestId('confirm-contribution')).toHaveCount(0)
    expect(await readCity(pageA)).toEqual(before)
    // Back to the same overview camera as the other browser, so both draw the same level of detail.
    await pageA.reload()
    await openSharedCity(pageA)
    expect(await withDatabase(async (db) => (await db.query('SELECT sequence FROM city')).rows[0].sequence)).toBe('1')
    expect(await withDatabase(async (db) => (await db.query('SELECT count(*)::int AS n FROM city_events')).rows[0].n)).toBe(1)

    // The authority changes the city (as a later slice's command handler will): state and
    // sequence move together, with the event that explains it.
    await withDatabase(async (db) => {
      await db.query('BEGIN')
      const { rows } = await db.query('SELECT state::text AS text FROM city FOR UPDATE')
      const state = JSON.parse(rows[0].text)
      state.clock += 1
      state.buildings['b-812'].patrons['resident-test'] = 38
      state.monuments.m4 = { holder: 'd4', sinceClock: state.clock }
      await db.query(`UPDATE city SET state = $1::json, sequence = sequence + 1, updated_at = now()`, [JSON.stringify(state)])
      await db.query(`INSERT INTO city_events (city_id, sequence, type, payload) SELECT id, sequence, 'test.authority-change', '{}' FROM city`)
      await db.query('COMMIT')
    })

    // Both browsers pick it up by polling, with no reload.
    for (const page of [pageA, pageB]) {
      await expect(page.getByTestId('hud-mon-m4')).toHaveAttribute('data-holder', 'd4', { timeout: 20_000 })
      await expect(page.getByTestId('building-812')).toHaveAttribute('data-total', '10000')
      await expect(page.getByTestId('building-812')).toHaveAttribute('data-tier', '4')
    }
    const [afterA, afterB] = await Promise.all([readCity(pageA), readCity(pageB)])
    expect(afterA.sequence).toBe(2)
    expect(afterA.instance).toBe(before.instance)
    expect(afterA.stateHash).not.toBe(before.stateHash)
    expect(afterB).toEqual(afterA)
    expect(await drawnCity(pageB)).toBe(await drawnCity(pageA))
    await Promise.all([a.close(), b.close()])
  })
})

test.describe('when the server is not answering', () => {
  const NETWORK_NOISE = [/Failed to load resource/, /net::ERR_/]

  test('keeps showing the last city it received, says so, and recovers by itself', async ({ page }) => {
    const problems = watchErrors(page, NETWORK_NOISE)
    await openSharedCity(page)
    const drawn = await drawnCity(page)

    await page.route('**/v1/city', (route) => route.abort('connectionrefused'))
    await expect(page.getByTestId('city-stale')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('city-stale')).toContainText('Showing the last city received')
    await expect(page.getByTestId('building-812')).toBeAttached()
    expect(await drawnCity(page)).toBe(drawn)

    await page.unroute('**/v1/city')
    await expect(page.getByTestId('city-stale')).toHaveCount(0, { timeout: 30_000 })
    expect(await drawnCity(page)).toBe(drawn)
    expect(problems).toEqual([])
  })

  test('rejects a malformed city instead of drawing it', async ({ page }) => {
    const problems = watchErrors(page, NETWORK_NOISE)
    await openSharedCity(page)
    const drawn = await drawnCity(page)
    await page.route('**/v1/city', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { etag: '"evil.9"' }, body: JSON.stringify({ city: { id: 'main', instance: 'evil', sequence: 9, stateVersion: 5, canonical: true, origin: 'genesis', updatedAt: 'now' }, viewer: { userId: 'demo-player', source: 'demo' }, server: { mode: 'production' }, state: { version: 5, buildings: {} } }) }))
    await expect(page.getByTestId('city-stale')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('viewer-anonymous')).toBeVisible()
    await expect(page.getByTestId('wallet')).toHaveCount(0)
    expect(await drawnCity(page)).toBe(drawn)
    expect(problems).toEqual([])
  })

  test('shows a plain message when there is no city yet, then loads once there is', async ({ page }) => {
    const problems = watchErrors(page, NETWORK_NOISE)
    await page.route('**/v1/city', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"city_not_initialized"}' }))
    await page.goto('/')
    await expect(page.getByTestId('city-connecting')).toHaveAttribute('data-status', 'unavailable')
    await expect(page.getByTestId('city-connecting')).toContainText('This city has not been founded yet.')
    await expect(page.getByTestId('city')).toHaveCount(0)

    await page.unroute('**/v1/city')
    await expect(page.getByTestId('city')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('viewer-anonymous')).toBeVisible()
    expect(problems).toEqual([])
  })
})
