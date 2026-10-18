import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test'
import pg from 'pg'
import { BRAND_A, BRAND_B } from './brands'
import { install, launch, launchHref, publish, snowflake, type Launch } from './play'

/**
 * PLAY SESSIONS, end to end, against a REAL local Proofy Play: a launch redeems its run token
 * once and leaves the browser signed in to that installation's persistent city, so a reload or
 * a new tab reads the city again without another launch, until the player signs out or the
 * session ends. Only Proofy Core is stood in for (its token issuer key): the player's Discord
 * id is the one Play pins to the run from that Core-signed context.
 */
const ORIGIN = 'http://localhost:4352'
const SHOTS = resolve(import.meta.dirname, '../test-artifacts/city-play-evidence')
mkdirSync(SHOTS, { recursive: true })

async function installed(config: unknown) {
  const guild = snowflake()
  const installation = await install(guild)
  const published = await publish(guild, installation, config)
  return { guild, installation, ...published }
}

/** Every request the page makes to the Rare City server, by method and path. */
function recordApi(context: BrowserContext): string[] {
  const seen: string[] = []
  context.on('request', (r: Request) => {
    const url = new URL(r.url())
    if (url.pathname.startsWith('/v1/')) seen.push(`${r.method()} ${url.pathname}${url.search}`)
  })
  return seen
}

async function arrive(page: Page, href: string) {
  await page.goto('about:blank')
  await page.goto(href)
}

async function cityOn(page: Page) {
  await expect(page.getByTestId('play-city')).toBeAttached()
  await expect(page.getByTestId('city-svg')).toBeVisible()
  return page.getByTestId('play-city')
}

const playCookie = async (context: BrowserContext) => (await context.cookies(ORIGIN)).find((c) => c.name === 'rc_play')

/** What the browser keeps where script can read it: nothing of the session or the launch. */
async function scriptVisible(page: Page) {
  return page.evaluate(() => ({ cookie: document.cookie, local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }), url: location.href, history: history.length }))
}

test.describe('a launch leaves the browser signed in to its city', () => {
  test('launch once, reload, open a new tab, sign out: the run token is redeemed once and the session ends with sign-out', async ({ browser }) => {
    const a = await installed(BRAND_A)
    const user = snowflake()
    const context = await browser.newContext()
    const api = recordApi(context)
    const page = await context.newPage()
    const l = await launch(a.guild, 'rare-city', 'Ada', user)

    // 1-4. Play launches the player; the page redeems the run token once; the server opens a session; the city is drawn.
    await arrive(page, launchHref(l))
    const city = await cityOn(page)
    await expect(city).toHaveAttribute('data-source', 'launch')
    await expect(city).toHaveAttribute('data-installation', a.installation)
    await expect(city).toHaveAttribute('data-player', user)
    await expect(page.getByTestId('play-player')).toHaveText('Ada')
    await expect(page.getByTestId('city-name')).toHaveText('HARBORLIGHT')
    const world = (await city.getAttribute('data-world'))!
    const cookie = await playCookie(context)
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/', domain: 'localhost' })
    expect(cookie!.value).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // Expires with Play's run (Rare City is registered with Play's default 7200 s), never later.
    expect(cookie!.expires * 1000).toBeLessThanOrEqual(Date.now() + 7_200_000 + 5_000)
    expect(cookie!.expires * 1000).toBeGreaterThan(Date.now() + 7_000_000)
    let visible = await scriptVisible(page)
    expect(visible.cookie).not.toContain('rc_play')
    expect(visible.cookie).not.toContain(cookie!.value)
    expect([visible.local, visible.session]).toEqual(['{}', '{}'])
    expect(visible.url).toBe(`${ORIGIN}/`)
    expect(visible.url).not.toContain(l.runToken)
    await page.screenshot({ path: `${SHOTS}/session-1-launched.png` })

    // 5. A reload keeps the player and the city: no run token, no launch, the session alone.
    await page.reload()
    await cityOn(page)
    await expect(city).toHaveAttribute('data-source', 'session')
    await expect(city).toHaveAttribute('data-world', world)
    await expect(city).toHaveAttribute('data-world-created', 'false')
    await expect(city).toHaveAttribute('data-player', user)
    await expect(city).toHaveAttribute('data-installation-status', 'verified')
    await expect(page.getByTestId('play-installation-status')).toHaveText('verified now')
    await expect(page.getByTestId('city-name')).toHaveText('HARBORLIGHT')
    await page.screenshot({ path: `${SHOTS}/session-2-reloaded.png` })

    // 6. A new tab reads the same session.
    const tab = await context.newPage()
    await tab.goto('/')
    const tabCity = await cityOn(tab)
    await expect(tabCity).toHaveAttribute('data-source', 'session')
    await expect(tabCity).toHaveAttribute('data-world', world)
    await expect(tabCity).toHaveAttribute('data-player', user)
    visible = await scriptVisible(tab)
    expect([visible.local, visible.session, visible.cookie.includes(cookie!.value)]).toEqual(['{}', '{}', false])

    // The run token was posted exactly once; everything after it is the session read.
    expect(api.filter((r) => r === 'POST /v1/play/session')).toHaveLength(1)
    expect(api.filter((r) => r === 'GET /v1/play/city')).toHaveLength(2)
    // And it stays spent: Play refuses to redeem it again.
    const replay = await context.request.post('/v1/play/session', { data: { runToken: l.runToken }, headers: { origin: ORIGIN } })
    expect([replay.status(), await replay.json()]).toEqual([409, { error: 'run_already_used' }])
    // A refused replay does not end the session it was sent with.
    expect((await context.request.get('/v1/play/city')).status()).toBe(200)

    // 7. Sign out ends the session for every tab of this browser.
    await tab.getByTestId('play-signout').click()
    await expect(tab.getByTestId('play-gate')).toHaveAttribute('data-phase', 'signed-out')
    await tab.screenshot({ path: `${SHOTS}/session-3-signed-out.png` })
    expect(await playCookie(context)).toBeUndefined()
    await page.reload()
    await expect(page.getByTestId('play-gate')).toHaveAttribute('data-phase', 'no-token')
    await expect(page.getByTestId('city-svg')).toHaveCount(0)

    // 8. The revoked credential, presented again from anywhere, reads nothing.
    const replayed = await browser.newContext({ storageState: { cookies: [{ ...cookie!, expires: cookie!.expires }], origins: [] } })
    const r = await replayed.request.get(`${ORIGIN}/v1/play/city`)
    expect([r.status(), await r.json()]).toEqual([401, { error: 'play_session_required' }])
    await replayed.close()
    await context.close()
  })

  test('an expired session reads nothing, and the page asks for a new launch', async ({ browser }) => {
    const a = await installed(BRAND_A)
    const context = await browser.newContext()
    const page = await context.newPage()
    const user = snowflake()
    await arrive(page, launchHref(await launch(a.guild, 'rare-city', 'Ada', user)))
    await cityOn(page)
    // The passage of two hours, on the disposable database: the session's lifetime is moved into the past. (The
    // table refuses that change, so its guard is set aside for this one statement; nothing else is touched.)
    const db = new pg.Client({ connectionString: process.env.CITY_PLAY_DATABASE_URL })
    await db.connect()
    try {
      await db.query('BEGIN')
      await db.query('ALTER TABLE play_sessions DISABLE TRIGGER play_sessions_guard')
      const moved = await db.query(`UPDATE play_sessions SET created_at = now() - interval '3 hours', expires_at = now() - interval '1 second' WHERE discord_user_id = $1 AND revoked_at IS NULL`, [user])
      expect(moved.rowCount).toBe(1)
      await db.query('ALTER TABLE play_sessions ENABLE TRIGGER play_sessions_guard')
      await db.query('COMMIT')
    } finally {
      await db.end()
    }
    const r = await context.request.get('/v1/play/city')
    expect([r.status(), await r.json()]).toEqual([401, { error: 'play_session_required' }])
    // The server cleared the cookie with that answer.
    expect(r.headers()['set-cookie']).toMatch(/^rc_play=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0/)
    await page.reload()
    await expect(page.getByTestId('play-gate')).toHaveAttribute('data-phase', 'no-token')
    await expect(page.getByTestId('city-svg')).toHaveCount(0)
    await context.close()
  })
})

test.describe('isolation', () => {
  test('two installations\' players each read their own city, and a session never reads another', async ({ browser }) => {
    const a = await installed(BRAND_A)
    const b = await installed(BRAND_B)
    const ca = await browser.newContext()
    const cb = await browser.newContext()
    const pa = await ca.newPage()
    const pb = await cb.newPage()
    await arrive(pa, launchHref(await launch(a.guild, 'rare-city', 'Ada')))
    await arrive(pb, launchHref(await launch(b.guild, 'rare-city', 'Bea')))
    const worldA = await (await cityOn(pa)).getAttribute('data-world')
    const worldB = await (await cityOn(pb)).getAttribute('data-world')
    expect(worldA).not.toBe(worldB)

    // Reloads stay in their own city.
    await pa.reload()
    await pb.reload()
    await expect(await cityOn(pa)).toHaveAttribute('data-world', worldA!)
    await expect(await cityOn(pb)).toHaveAttribute('data-world', worldB!)
    await expect(pa.getByTestId('city-name')).toHaveText('HARBORLIGHT')
    await expect(pb.getByTestId('city-name')).toHaveText('NEON ORCHARD')

    // A's session, however the request is dressed, reads A's city only.
    for (const path of [`/v1/play/city?world=${worldB}`, `/v1/play/city?installationId=${b.installation}&discordGuildId=${b.guild}`]) {
      const r = await ca.request.get(path, { headers: { 'x-world-id': worldB!, 'x-installation-id': b.installation } })
      const body = await r.json()
      expect([body.world.id, body.play.installationId, body.play.discordGuildId]).toEqual([worldA, a.installation, a.guild])
    }
    // And the server answers privately: never cached, varying on the cookie.
    const head = await ca.request.get('/v1/play/city')
    expect([head.headers()['cache-control'], head.headers()['vary']]).toEqual(['no-store', 'Cookie'])
    expect(await head.text()).not.toContain((await playCookie(ca))!.value)
    await ca.close()
    await cb.close()
  })

  test('two Discord users in the same city stay distinct, and one signing out does not sign out the other', async ({ browser }) => {
    const a = await installed(BRAND_A)
    const ada = snowflake()
    const bea = snowflake()
    const c1 = await browser.newContext()
    const c2 = await browser.newContext()
    const p1 = await c1.newPage()
    const p2 = await c2.newPage()
    await arrive(p1, launchHref(await launch(a.guild, 'rare-city', 'Ada', ada)))
    await arrive(p2, launchHref(await launch(a.guild, 'rare-city', 'Bea', bea)))
    const w1 = await (await cityOn(p1)).getAttribute('data-world')
    const w2 = await (await cityOn(p2)).getAttribute('data-world')
    expect(w1).toBe(w2)
    const v1 = (await (await c1.request.get('/v1/play/city')).json()).viewer
    const v2 = (await (await c2.request.get('/v1/play/city')).json()).viewer
    // Exactly as Play's redeemed run names them, from the Core-signed context: Discord id and Core's opaque id.
    expect(v1.player).toEqual({ discordUserId: ada, coreUserId: `u${ada.slice(-8)}`, displayName: 'Ada' })
    expect(v2.player).toEqual({ discordUserId: bea, coreUserId: `u${bea.slice(-8)}`, displayName: 'Bea' })
    // What the city knows about each viewer, and how: membership verified at launch, admin and rules unknown.
    expect(v1.status.guildMember).toMatchObject({ status: 'verified', source: 'proofy-core', basis: 'launch' })
    expect(v1.status.installationActive).toMatchObject({ status: 'verified', source: 'proofy-play', basis: 'live' })
    expect(v1.status.brandAdmin).toEqual({ status: 'unknown', reason: 'not-in-contract' })
    expect(v1.permissions).toEqual({ viewCity: true, claim: false, build: false })

    await p1.getByTestId('play-signout').click()
    await expect(p1.getByTestId('play-gate')).toHaveAttribute('data-phase', 'signed-out')
    await p2.reload()
    await expect(await cityOn(p2)).toHaveAttribute('data-player', bea)
    await p2.screenshot({ path: `${SHOTS}/session-4-second-user-still-in.png` })
    await c1.close()
    await c2.close()
  })

  test('launching into another server from the same browser replaces the session; the old one is over', async ({ browser }) => {
    const a = await installed(BRAND_A)
    const b = await installed(BRAND_B)
    const user = snowflake()
    const context = await browser.newContext()
    const page = await context.newPage()
    await arrive(page, launchHref(await launch(a.guild, 'rare-city', 'Ada', user)))
    await cityOn(page)
    const first = (await playCookie(context))!
    await arrive(page, launchHref(await launch(b.guild, 'rare-city', 'Ada', user)))
    await expect(await cityOn(page)).toHaveAttribute('data-installation', b.installation)
    const second = (await playCookie(context))!
    expect(second.value).not.toBe(first.value)
    await page.reload()
    await expect(await cityOn(page)).toHaveAttribute('data-installation', b.installation)
    const old = await browser.newContext({ storageState: { cookies: [first], origins: [] } })
    expect((await old.request.get(`${ORIGIN}/v1/play/city`)).status()).toBe(401)
    await old.close()
    await context.close()
  })

  test('another site cannot sign a player out, and a cookie the browser did not get from a launch is no session', async ({ browser }) => {
    const a = await installed(BRAND_A)
    const context = await browser.newContext()
    const page = await context.newPage()
    await arrive(page, launchHref(await launch(a.guild)))
    await cityOn(page)
    const forged = await context.request.post('/v1/play/logout', { data: {}, headers: { origin: 'https://evil.example' } })
    expect([forged.status(), await forged.json()]).toEqual([403, { error: 'origin_mismatch' }])
    expect((await context.request.get('/v1/play/city')).status()).toBe(200)
    const planted = await browser.newContext({ storageState: { cookies: [{ name: 'rc_play', value: 'P'.repeat(43), domain: 'localhost', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Strict' }], origins: [] } })
    const p = await planted.newPage()
    await p.goto('/')
    await expect(p.getByTestId('play-gate')).toHaveAttribute('data-phase', 'no-token')
    await planted.close()
    await context.close()
  })
})

test('a launch that Play refuses opens no session', async ({ browser }) => {
  const a = await installed(BRAND_A)
  const context = await browser.newContext()
  const page = await context.newPage()
  const l: Launch = await launch(a.guild)
  const [header, payload, signature] = l.runToken.split('.')
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
  const forged = Buffer.from(JSON.stringify({ ...claims, sub: snowflake() })).toString('base64url')
  await arrive(page, `${l.launchUrl}#runToken=${header}.${forged}.${signature}`)
  await expect(page.getByTestId('play-gate')).toHaveAttribute('data-code', 'run_token_refused')
  expect(await playCookie(context)).toBeUndefined()
  expect((await context.request.get('/v1/play/city')).status()).toBe(401)
  await context.close()
})
