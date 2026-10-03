import { expect, test } from '@playwright/test'
import { withDatabase } from './harness.ts'

/**
 * The BUILT server, started the way a deploy starts it and with no ACTIVATION_ENABLED:
 * permanent Friend activation is off. Both servers are checked: the demo fixture city, and
 * the empty activation-rehearsal city on the next port, which is exactly the kind of city
 * activation exists for and still does not switch it on.
 */
const EMPTY = `http://127.0.0.1:${Number(process.env.E2E_PORT ?? 4319) + 1}`
const BODIES = {
  '/v1/activation/intents': { tokenId: '812', plotId: 'd4-w0-p7' },
  '/v1/activations': { intentId: 'c'.repeat(64), signature: `0x${'e'.repeat(130)}` },
} as const

test.describe('activation is off unless it is switched on', () => {
  test('both activation routes refuse, on the fixture city and on the rehearsal city alike', async ({ request }) => {
    for (const base of ['', EMPTY])
      for (const [path, data] of Object.entries(BODIES)) {
        const res = await request.post(`${base}${path}`, { data })
        expect([res.status(), await res.json()], `${base}${path}`).toEqual([403, { error: 'activation_disabled' }])
        expect(res.headers()['cache-control']).toBe('no-store')
        expect(res.headers()['access-control-allow-origin']).toBeUndefined()
        // They are POST routes and nothing else: no GET reveals or changes anything.
        const get = await request.get(`${base}${path}`)
        expect([get.status(), get.headers().allow]).toEqual([405, 'POST'])
      }
    // The rehearsal city is untouched: still empty, still at its first sequence.
    const city = await (await request.get(`${EMPTY}/v1/city`)).json()
    expect([city.city.sequence, Object.keys(city.state.buildings)]).toEqual([1, []])
  })

  test('nothing was written, and the app never calls an activation route', async ({ page }) => {
    const called: string[] = []
    page.on('request', (r) => {
      if (r.url().includes('/v1/activation')) called.push(r.url())
    })
    await page.goto('/')
    await expect(page.getByTestId('city')).toBeVisible()
    await expect(page.getByTestId('building-812')).toBeAttached()
    expect(called).toEqual([])
    const counts = await withDatabase(async (db) => (await db.query('SELECT (SELECT count(*)::int FROM activation_intents) AS intents, (SELECT count(*)::int FROM properties) AS properties, (SELECT count(*)::int FROM ownership_eras) AS eras')).rows[0])
    expect(counts).toEqual({ intents: 0, properties: 0, eras: 0 })
  })
})
