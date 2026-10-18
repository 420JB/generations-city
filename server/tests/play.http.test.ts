import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import type { PlayCityResponse, PlayEnvironment } from '../src/engine'
import { playSessionCookie, sessionCookie } from '../src/http'
import { createLogger } from '../src/log'
import { PlayApiError, type PlayGameReader } from '../src/play/client'
import { createPlayLaunchService, type PlayLaunchService } from '../src/play/launch'
import { createPlaySessionService, MIN_PLAY_SESSION_MS, PLAY_SESSION_MAX_MS, type PlaySessionService, type PlaySessionStore } from '../src/play/session'
import { ADA, BEA, DOC_A, DOC_B, fakePlay, GUILD_A, GUILD_B, INSTALLATION_A, INSTALLATION_B, memorySessions, memoryWorlds } from './fakePlay'
import { TEST_ORIGIN, testConfig } from './testConfig'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

async function start(playLaunch: PlayLaunchService | null, rateLimits = false, playSessions: PlaySessionService | null = null, logs?: string[]) {
  const log = createLogger((line) => logs?.push(line))
  const server = createServer(createApp({ config: testConfig({ rateLimits }), db: null, migrationsDir: '/nonexistent', log, playLaunch, playSessions }))
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** Play with installations A and B (each with one active version), an in-memory world and session store, and a server. */
async function boot(
  options: { rateLimits?: boolean; now?: () => Date; wrapPlay?: (play: PlayGameReader) => PlayGameReader; environment?: PlayEnvironment; store?: PlaySessionStore; installationCheckMs?: number; installationCacheMs?: number; graceMs?: number; clock?: () => number; logs?: string[] } = {},
) {
  const p = fakePlay()
  p.install(INSTALLATION_A, GUILD_A)
  p.install(INSTALLATION_B, GUILD_B)
  p.publish(INSTALLATION_A, DOC_A)
  p.publish(INSTALLATION_B, DOC_B)
  const w = memoryWorlds()
  const s = memorySessions()
  const play = options.wrapPlay ? options.wrapPlay(p.play) : p.play
  const environment = options.environment ?? 'dev'
  const launch = createPlayLaunchService({ play, environment, gameKey: 'rare-city', worlds: w.store, clock: options.clock })
  const log = createLogger((line) => options.logs?.push(line))
  const sessions = createPlaySessionService({
    store: options.store ?? s.store,
    worlds: w.store,
    play,
    environment,
    gameKey: 'rare-city',
    log,
    now: options.now,
    installationCheckMs: options.installationCheckMs,
    installationCacheMs: options.installationCacheMs ?? 0,
    graceMs: options.graceMs,
    clock: options.clock,
  })
  const base = await start(launch, options.rateLimits ?? false, sessions, options.logs)
  return { p, w, s, base, launch, sessions }
}

const post = (base: string, body: unknown, origin = TEST_ORIGIN, cookie?: string) =>
  fetch(`${base}/v1/play/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) })
const readCity = (base: string, cookie?: string, path = '/v1/play/city') => fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} })
const logout = (base: string, cookie?: string, origin = TEST_ORIGIN) => fetch(`${base}/v1/play/logout`, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) }, body: '{}' })

/** A city read's body. */
const cityOf = async (res: Response) => (await res.json()) as PlayCityResponse

/** The `name=value` a Set-Cookie header stores, or null. */
function stored(res: Response): string | null {
  const header = res.headers.get('set-cookie')
  return header ? header.split(';')[0] : null
}

/** Launch into installation `id` as `player`, and return the session cookie it set and the body. */
async function launchAs(env: Awaited<ReturnType<typeof boot>>, id: string, name: string, player = ADA, cookie?: string) {
  const res = await post(env.base, { runToken: env.p.launch(id, name, { player }) }, TEST_ORIGIN, cookie)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { viewer: { player: typeof ADA }; world: { id: string }; play: { installationId: string } }
  return { res, body, cookie: stored(res)! }
}

describe('POST /v1/play/session', () => {
  it('answers play_disabled when the deployment is not connected to Play, or has nowhere to keep sessions', async () => {
    const base = await start(null)
    const res = await post(base, { runToken: 'a.b.c' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'play_disabled' })
    expect([(await readCity(base)).status, (await logout(base)).status]).toEqual([403, 200])
    const p = fakePlay()
    const half = await start(createPlayLaunchService({ play: p.play, environment: 'dev', gameKey: 'rare-city', worlds: memoryWorlds().store }))
    expect([(await post(half, { runToken: 'a.b.c' })).status, p.calls]).toEqual([403, []])
  })

  it('opens the city of the run, privately, from this origin only', async () => {
    const p = fakePlay()
    p.install(INSTALLATION_A, GUILD_A)
    p.publish(INSTALLATION_A, DOC_A)
    const w = memoryWorlds()
    const sessions = createPlaySessionService({ store: memorySessions().store, worlds: w.store, play: p.play, environment: 'dev', gameKey: 'rare-city', log: createLogger(() => undefined) })
    const base = await start(createPlayLaunchService({ play: p.play, environment: 'dev', gameKey: 'rare-city', worlds: w.store }), false, sessions)

    const foreign = await post(base, { runToken: p.launch(INSTALLATION_A, 'x') }, 'https://evil.example')
    expect([foreign.status, await foreign.json()]).toEqual([403, { error: 'origin_mismatch' }])
    expect(p.calls).toEqual([])

    const res = await post(base, { runToken: p.launch(INSTALLATION_A, 'a') })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as { play: { installationId: string }; world: { provisioned: boolean; created: boolean }; config: unknown }
    expect(body.play.installationId).toBe(INSTALLATION_A)
    expect(body.world).toMatchObject({ provisioned: true, created: true })
    expect(body.config).toEqual(DOC_A)

    const get = await fetch(`${base}/v1/play/session`)
    expect([get.status, get.headers.get('allow')]).toEqual([405, 'POST'])
  })

  it('sends refusals as { error } and configuration problems as { error, problems }', async () => {
    const p = fakePlay()
    p.install(INSTALLATION_A, GUILD_A)
    p.publish(INSTALLATION_A, { ...DOC_A, roads: 'gold' })
    const w = memoryWorlds()
    const sessions = createPlaySessionService({ store: memorySessions().store, worlds: w.store, play: p.play, environment: 'dev', gameKey: 'rare-city', log: createLogger(() => undefined) })
    const base = await start(createPlayLaunchService({ play: p.play, environment: 'dev', gameKey: 'rare-city', worlds: w.store }), false, sessions)
    const named = await post(base, { runToken: 'a.b.c', installationId: INSTALLATION_A })
    expect([named.status, await named.json()]).toEqual([422, { error: 'invalid_request' }])
    const invalid = await post(base, { runToken: p.launch(INSTALLATION_A, 'bad') })
    expect(invalid.status).toBe(422)
    expect(await invalid.json()).toEqual({ error: 'config_invalid', problems: [{ path: 'roads', detail: 'is not a configurable field' }] })
    p.tamper.fail = { method: 'redeemRun', status: 503, code: 'transport_error' }
    const down = await post(base, { runToken: p.launch(INSTALLATION_A, 'down') })
    expect([down.status, down.headers.get('retry-after'), await down.json()]).toEqual([503, '10', { error: 'play_unavailable' }])
  })

  it('is limited per client network before Play is asked', async () => {
    const p = fakePlay()
    p.install(INSTALLATION_A, GUILD_A)
    p.publish(INSTALLATION_A, DOC_A)
    const base = await start(createPlayLaunchService({ play: p.play, environment: 'dev', gameKey: 'rare-city', worlds: memoryWorlds().store }), true)
    for (let i = 0; i < 20; i++) expect((await post(base, { runToken: 'eyJhbGciOiJFZERTQSJ9.dW5rbm93bi10b2tlbg.c2lnbmF0dXJlLXNpZ25hdHVyZQ' })).status).toBe(403)
    const calls = p.calls.length
    const limited = await post(base, { runToken: p.launch(INSTALLATION_A, 'late') })
    expect([limited.status, await limited.json()]).toEqual([429, { error: 'rate_limited' }])
    expect(p.calls.length).toBe(calls)
  })
})

describe('play sessions over HTTP', () => {
  it('opens a session only after an accepted launch: an HttpOnly, SameSite=Strict, host-only cookie, and no credential in the body', async () => {
    const env = await boot()
    const runToken = env.p.launch(INSTALLATION_A, 'a')
    const res = await post(env.base, { runToken })
    expect(res.status).toBe(200)
    const header = res.headers.get('set-cookie')!
    expect(header).toMatch(/^rc_play=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/)
    expect(header).not.toMatch(/Domain=/i)
    const maxAge = Number(/Max-Age=(\d+)/.exec(header)![1])
    // Two hours: Play's run, which is shorter than PLAY_SESSION_MAX_MS.
    expect(maxAge).toBeGreaterThan(7_190)
    expect(maxAge).toBeLessThanOrEqual(7_200)
    expect([res.headers.get('cache-control'), res.headers.get('vary')]).toEqual(['no-store', 'Cookie'])
    const text = await res.text()
    const credential = header.split(';')[0].split('=')[1]
    expect(text).not.toContain(credential)
    expect(text).not.toContain(runToken)
    const body = JSON.parse(text)
    expect(body.viewer).toEqual({
      authenticated: true,
      player: ADA,
      session: { ref: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), expiresAt: expect.any(String), renewal: 'relaunch' },
      status: {
        guildMember: { status: 'verified', value: true, source: 'proofy-core', basis: 'launch', at: expect.any(String) },
        playEntitled: { status: 'verified', value: true, source: 'proofy-core', basis: 'launch', at: expect.any(String) },
        installationActive: { status: 'verified', value: true, source: 'proofy-play', basis: 'launch', at: expect.any(String) },
        brandAdmin: { status: 'unknown', reason: 'not-in-contract' },
        districtRules: { status: 'unknown', reason: 'not-checked' },
      },
      permissions: { viewCity: true, claim: false, build: false },
    })
    expect(env.s.rows).toHaveLength(1)
    // Only a hash is kept.
    expect(env.s.rows[0].tokenHash).toHaveLength(32)
    expect(JSON.stringify(env.s.rows)).not.toContain(credential)

    // A refused launch opens nothing.
    const refused = await post(env.base, { runToken })
    expect([refused.status, refused.headers.get('set-cookie'), env.s.rows.length]).toEqual([409, null, 1])
  })

  it('reads the same city again on a reload and in a new tab, without another launch', async () => {
    const env = await boot()
    const { body: launched, cookie } = await launchAs(env, INSTALLATION_A, 'a')
    const redeems = env.p.calls.filter((c) => c === 'redeemRun').length
    for (let tab = 0; tab < 3; tab++) {
      const res = await readCity(env.base, cookie)
      expect(res.status).toBe(200)
      expect([res.headers.get('cache-control'), res.headers.get('vary'), res.headers.get('set-cookie')]).toEqual(['no-store', 'Cookie', null])
      const body = await cityOf(res)
      expect(body.world).toMatchObject({ id: launched.world.id, provisioned: true, created: false, sequence: 1, state: { version: 1, buildings: {}, openWards: {} } })
      expect(body.play).toEqual({ environment: 'dev', gameKey: 'rare-city', installationId: INSTALLATION_A, discordGuildId: GUILD_A, configVersion: 1, configHash: expect.stringMatching(/^[0-9a-f]{64}$/), schemaVersion: 1 })
      expect(body.config).toEqual(DOC_A)
      expect(body.viewer.player).toEqual(ADA)
      expect(body.viewer.status.installationActive).toEqual({ status: 'verified', value: true, source: 'proofy-play', basis: 'live', at: expect.any(String) })
    }
    // Play was asked whether the installation is active; no run was redeemed.
    expect(env.p.calls.filter((c) => c === 'redeemRun').length).toBe(redeems)
  })

  it('refuses a read without a live session, and clears a cookie that is not one', async () => {
    const env = await boot()
    const none = await readCity(env.base)
    expect([none.status, none.headers.get('set-cookie'), await none.json()]).toEqual([401, null, { error: 'play_session_required' }])
    for (const value of ['garbage', 'A'.repeat(43), '']) {
      const res = await readCity(env.base, `rc_play=${value}`)
      expect(res.status).toBe(401)
      if (value) expect(res.headers.get('set-cookie')).toBe('rc_play=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
    }
    expect(env.w.read).toEqual([])
    expect(env.p.calls).toEqual([])
  })

  it('takes which city from the session alone: nothing in the request can name another', async () => {
    const env = await boot()
    const a = await launchAs(env, INSTALLATION_A, 'a')
    const b = await launchAs(env, INSTALLATION_B, 'b')
    expect(a.body.world.id).not.toBe(b.body.world.id)
    const tries = [
      `/v1/play/city?world=${b.body.world.id}`,
      `/v1/play/city?installationId=${INSTALLATION_B}&discordGuildId=${GUILD_B}`,
      `/v1/play/city/${b.body.world.id}`,
    ]
    const first = await readCity(env.base, a.cookie, tries[0])
    expect((await cityOf(first)).world.id).toBe(a.body.world.id)
    expect((await cityOf(await readCity(env.base, a.cookie, tries[1]))).play.installationId).toBe(INSTALLATION_A)
    expect((await readCity(env.base, a.cookie, tries[2])).status).toBe(404)
    const headers = await fetch(`${env.base}/v1/play/city`, { headers: { cookie: a.cookie, 'x-world-id': b.body.world.id, 'x-installation-id': INSTALLATION_B } })
    expect((await cityOf(headers)).world.id).toBe(a.body.world.id)
    // Each session reads its own installation's city, never the other's.
    expect((await cityOf(await readCity(env.base, b.cookie))).world.id).toBe(b.body.world.id)
    expect(env.w.read.map((r) => r.installationId)).toEqual([INSTALLATION_A, INSTALLATION_A, INSTALLATION_A, INSTALLATION_B])
    // A POST body naming a city is not a request the launch route takes.
    expect((await post(env.base, { runToken: env.p.launch(INSTALLATION_A, 'x'), worldId: b.body.world.id })).status).toBe(422)
  })

  it('keeps two Discord users in the same city distinct', async () => {
    const env = await boot()
    const ada = await launchAs(env, INSTALLATION_A, 'ada', ADA)
    const bea = await launchAs(env, INSTALLATION_A, 'bea', BEA)
    expect(ada.cookie).not.toBe(bea.cookie)
    expect(ada.body.world.id).toBe(bea.body.world.id)
    expect((await cityOf(await readCity(env.base, ada.cookie))).viewer.player).toEqual(ADA)
    expect((await cityOf(await readCity(env.base, bea.cookie))).viewer.player).toEqual(BEA)
    // One signing out does not sign the other out.
    await logout(env.base, ada.cookie)
    expect((await readCity(env.base, ada.cookie)).status).toBe(401)
    expect((await cityOf(await readCity(env.base, bea.cookie))).viewer.player).toEqual(BEA)
  })

  it('ends the session on logout, and the credential cannot be replayed after it', async () => {
    const env = await boot()
    const { cookie } = await launchAs(env, INSTALLATION_A, 'a')
    // Another site cannot sign the player out (or in): the same-origin rule runs first.
    for (const origin of ['https://evil.example', 'null']) {
      const forged = await logout(env.base, cookie, origin)
      expect([forged.status, await forged.json()]).toEqual([403, { error: 'origin_mismatch' }])
    }
    const crossSite = await fetch(`${env.base}/v1/play/logout`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site', cookie }, body: '{}' })
    expect(crossSite.status).toBe(403)
    const form = await fetch(`${env.base}/v1/play/logout`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: TEST_ORIGIN, cookie }, body: 'x=1' })
    expect(form.status).toBe(415)
    expect((await readCity(env.base, cookie)).status).toBe(200)

    const out = await logout(env.base, cookie)
    expect([out.status, out.headers.get('set-cookie'), out.headers.get('cache-control'), await out.json()]).toEqual([200, 'rc_play=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0', 'no-store', { authenticated: false }])
    expect(env.s.rows[0].revokedAt).toBeInstanceOf(Date)
    // Replaying the old credential: refused, every time.
    for (let i = 0; i < 2; i++) expect([(await readCity(env.base, cookie)).status]).toEqual([401])
    // Logging out again, or without a session, is harmless.
    expect((await logout(env.base, cookie)).status).toBe(200)
    expect((await logout(env.base)).status).toBe(200)
    expect((await fetch(`${env.base}/v1/play/logout`)).status).toBe(405)
  })

  it('retires the session a browser arrives with when it launches again (no fixation)', async () => {
    const env = await boot()
    const first = await launchAs(env, INSTALLATION_A, 'a')
    const second = await launchAs(env, INSTALLATION_B, 'b', ADA, first.cookie)
    expect(second.cookie).not.toBe(first.cookie)
    expect((await readCity(env.base, first.cookie)).status).toBe(401)
    expect((await cityOf(await readCity(env.base, second.cookie))).play.installationId).toBe(INSTALLATION_B)
    // A value the browser (or someone planting a cookie) chose never becomes a session: the server mints its own.
    const planted = 'rc_play=' + 'P'.repeat(43)
    const third = await launchAs(env, INSTALLATION_A, 'c', ADA, planted)
    expect(third.cookie).not.toBe(planted)
    expect((await readCity(env.base, planted)).status).toBe(401)
    expect((await readCity(env.base, third.cookie)).status).toBe(200)
  })

  it('never outlives Play\'s run, opens none for a run about to end, and refuses an expired session', async () => {
    let at = Date.now()
    const env = await boot({ now: () => new Date(at) })
    const short = await post(env.base, { runToken: env.p.launch(INSTALLATION_A, 'short', { runExpiresAt: new Date(at + MIN_PLAY_SESSION_MS - 1_000).toISOString() }) })
    expect([short.status, short.headers.get('set-cookie'), await short.json()]).toEqual([409, null, { error: 'run_expired' }])

    const ends = new Date(at + 10 * 60_000)
    const res = await post(env.base, { runToken: env.p.launch(INSTALLATION_A, 'ten', { runExpiresAt: ends.toISOString() }) })
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=600$/)
    expect((await cityOf(res)).viewer.session.expiresAt).toBe(ends.toISOString())
    const cookie = stored(res)!
    at += 9 * 60_000
    expect((await readCity(env.base, cookie)).status).toBe(200)
    at += 60_000
    const expired = await readCity(env.base, cookie)
    expect([expired.status, expired.headers.get('set-cookie'), await expired.json()]).toEqual([401, 'rc_play=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0', { error: 'play_session_required' }])

    // A very long run is capped.
    const long = await post(env.base, { runToken: env.p.launch(INSTALLATION_A, 'long', { runExpiresAt: new Date(at + 24 * 60 * 60_000).toISOString() }) })
    expect(long.headers.get('set-cookie')).toMatch(new RegExp(`Max-Age=${PLAY_SESSION_MAX_MS / 1000}$`))
  })

  it('ends the session when Play says the installation is no longer active, and does not revive it', async () => {
    const env = await boot()
    const a = await launchAs(env, INSTALLATION_A, 'a')
    const b = await launchAs(env, INSTALLATION_B, 'b')
    env.p.setStatus(INSTALLATION_A, 'suspended')
    const res = await readCity(env.base, a.cookie)
    expect([res.status, res.headers.get('set-cookie'), await res.json()]).toEqual([403, 'rc_play=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0', { error: 'installation_not_active' }])
    // Revoked, not merely refused: reactivating the installation does not bring the old session back.
    env.p.setStatus(INSTALLATION_A, 'active')
    expect((await readCity(env.base, a.cookie)).status).toBe(401)
    // The other installation's players are unaffected.
    expect((await readCity(env.base, b.cookie)).status).toBe(200)
    // An installation Play no longer shows to Rare City, or shows on another server, ends it too.
    const c = await launchAs(env, INSTALLATION_B, 'c')
    env.p.tamper.installation = { discordGuildId: GUILD_A }
    expect((await readCity(env.base, c.cookie)).status).toBe(403)
    env.p.tamper.installation = undefined
    const d = await launchAs(env, INSTALLATION_B, 'd')
    env.p.tamper.fail = { method: 'getInstallation', status: 404, code: 'installation_not_found' }
    expect([(await readCity(env.base, d.cookie)).status]).toEqual([403])
    env.p.tamper.fail = undefined
    expect((await readCity(env.base, d.cookie)).status).toBe(401)
  })

  it('serves the city when Play cannot be asked, and says the installation\'s status is unknown', async () => {
    let down: 'refuse' | 'hang' | null = null
    const env = await boot({
      installationCheckMs: 200,
      wrapPlay: (play) => ({
        ...play,
        getInstallation: (id) => (down === 'refuse' ? Promise.reject(new Error('unreachable')) : down === 'hang' ? new Promise(() => undefined) : play.getInstallation(id)),
      }),
    })
    const { cookie, body } = await launchAs(env, INSTALLATION_A, 'a')
    for (const mode of ['refuse', 'hang'] as const) {
      down = mode
      const started = performance.now()
      const res = await readCity(env.base, cookie)
      expect(res.status).toBe(200)
      expect(performance.now() - started).toBeLessThan(2_000)
      const read = await cityOf(res)
      expect(read.world.id).toBe(body.world.id)
      expect(read.viewer.status.installationActive).toEqual({ status: 'unknown', reason: 'authority-unavailable' })
      // Known at launch stays known at launch; unknown is never reported as verified.
      expect(read.viewer.status.guildMember).toMatchObject({ status: 'verified', basis: 'launch' })
    }
    // And no new session can be opened while Play is down: a launch needs Play.
    env.p.tamper.fail = { method: 'redeemRun', status: 503, code: 'transport_error' }
    const launch = await post(env.base, { runToken: env.p.launch(INSTALLATION_A, 'b') })
    expect([launch.status, launch.headers.get('set-cookie')]).toEqual([503, null])
  })

  it('answers unavailable, not anonymous, when the session store cannot be read', async () => {
    const env = await boot()
    const { cookie } = await launchAs(env, INSTALLATION_A, 'a')
    env.s.store.fail = new Error('connection refused')
    const read = await readCity(env.base, cookie)
    expect([read.status, read.headers.get('retry-after'), read.headers.get('set-cookie'), await read.json()]).toEqual([503, '5', null, { error: 'play_session_unavailable' }])
    const launch = await post(env.base, { runToken: env.p.launch(INSTALLATION_A, 'b') })
    expect([launch.status, launch.headers.get('set-cookie'), await launch.json()]).toEqual([503, null, { error: 'play_session_unavailable' }])
  })

  it('never reads a session of another Play environment', async () => {
    const shared = memorySessions()
    const dev = await boot({ store: shared.store })
    const { cookie } = await launchAs(dev, INSTALLATION_A, 'a')
    // A deployment for another Play environment, even one sharing the store, does not know this session.
    const test = await boot({ store: shared.store, environment: 'test' })
    expect((await readCity(test.base, cookie)).status).toBe(401)
    expect((await readCity(dev.base, cookie)).status).toBe(200)
  })

  it('leaves a wallet session cookie alone, and is not opened by one', async () => {
    const env = await boot()
    const { cookie } = await launchAs(env, INSTALLATION_A, 'a')
    const wallet = 'rc_session=' + 'W'.repeat(43)
    // The wallet cookie is not a play session, even carrying a play session's value.
    expect((await readCity(env.base, wallet)).status).toBe(401)
    expect((await readCity(env.base, `rc_session=${cookie.split('=')[1]}`)).status).toBe(401)
    const out = await logout(env.base, `${wallet}; ${cookie}`)
    expect(out.headers.get('set-cookie')).toBe('rc_play=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
    expect(sessionCookie('local').name).toBe('rc_session')
  })

  it('uses a __Host- Secure cookie outside local mode', () => {
    for (const mode of ['staging', 'production'] as const) {
      const c = playSessionCookie(mode)
      expect(c.set('t'.repeat(43), 60)).toBe(`__Host-rc_play=${'t'.repeat(43)}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=60`)
      expect(c.name).not.toBe(sessionCookie(mode).name)
    }
  })

  it('logs no credential, run token or cookie', async () => {
    const logs: string[] = []
    const env = await boot({ logs })
    const runToken = env.p.launch(INSTALLATION_A, 'a')
    const res = await post(env.base, { runToken })
    const credential = stored(res)!.split('=')[1]
    await readCity(env.base, `rc_play=${credential}`)
    await logout(env.base, `rc_play=${credential}`)
    await readCity(env.base, `rc_play=${credential}`)
    expect(logs.length).toBeGreaterThan(3)
    for (const line of logs) {
      expect(line).not.toContain(credential)
      expect(line).not.toContain(runToken)
      expect(line).not.toContain('rc_play')
    }
  })

  it('limits city reads per client network before the session is looked up', async () => {
    const env = await boot({ rateLimits: true })
    const { cookie } = await launchAs(env, INSTALLATION_A, 'a')
    let last = 0
    for (let i = 0; i < 31; i++) last = (await readCity(env.base, cookie)).status
    // Per player: 30 a minute.
    expect(last).toBe(429)
    for (let i = 0; i < 29; i++) await readCity(env.base)
    const limited = await readCity(env.base)
    expect([limited.status, await limited.json()]).toEqual([429, { error: 'rate_limited' }])
  })
})

describe('Play\'s authority on every session read (F1, F2, F4)', () => {
  const CLEARED = 'rc_play=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'

  it('ends every session when Play refuses Rare City itself (credential revoked, game retired): never "unknown"', async () => {
    const env = await boot()
    const a = await launchAs(env, INSTALLATION_A, 'a')
    const b = await launchAs(env, INSTALLATION_B, 'b', BEA)
    for (const [status, code] of [
      [401, 'unauthorized'],
      [403, 'play_not_entitled'],
    ] as const) {
      env.p.tamper.fail = { method: 'getInstallation', status, code }
      const res = await readCity(env.base, a.cookie)
      expect([res.status, res.headers.get('set-cookie'), await res.json()], code).toEqual([403, CLEARED, { error: 'play_authorization_refused' }])
      env.p.tamper.fail = undefined
      // Revoked, not refused once: Play answering again does not bring it back.
      expect((await readCity(env.base, a.cookie)).status).toBe(401)
      a.cookie = (await launchAs(env, INSTALLATION_A, `a-${code}`)).cookie
    }
    // The other installation's session ends on its own next read too: Play refused Rare City, not one installation.
    env.p.tamper.fail = { method: 'getInstallation', status: 401, code: 'unauthorized' }
    expect((await readCity(env.base, b.cookie)).status).toBe(403)
    expect(env.s.rows.filter((r) => !r.revokedAt).length).toBe(1)
    // A new launch cannot open anything while Play refuses Rare City.
    env.p.tamper.fail = { method: 'redeemRun', status: 401, code: 'unauthorized' }
    expect((await post(env.base, { runToken: env.p.launch(INSTALLATION_B, 'b2') })).status).toBe(503)
  })

  it('ends the session for a suspended, uninstalled or removed installation, and for one shown on another server', async () => {
    const env = await boot()
    for (const change of [
      () => env.p.setStatus(INSTALLATION_A, 'suspended'),
      () => env.p.setStatus(INSTALLATION_A, 'uninstalled'),
      () => (env.p.tamper.fail = { method: 'getInstallation', status: 404, code: 'installation_not_found' }),
      () => (env.p.tamper.fail = { method: 'getInstallation', status: 403, code: 'installation_not_active' }),
      () => (env.p.tamper.installation = { discordGuildId: GUILD_B }),
    ]) {
      env.p.setStatus(INSTALLATION_A, 'active')
      env.p.tamper.fail = undefined
      env.p.tamper.installation = undefined
      const a = await launchAs(env, INSTALLATION_A, `a${env.s.rows.length}`)
      change()
      const res = await readCity(env.base, a.cookie)
      expect([res.status, res.headers.get('set-cookie'), await res.json()]).toEqual([403, CLEARED, { error: 'installation_not_active' }])
    }
  })

  it('serves an outage read-only only within the grace period after Play\'s last active, then refuses for now and recovers', async () => {
    let t = 0
    let down: 'refuse' | 'malformed' | 'hang' | null = null
    const env = await boot({
      clock: () => t,
      installationCheckMs: 100,
      graceMs: 60_000,
      wrapPlay: (play) => ({
        ...play,
        getInstallation: (id, o) =>
          down === 'refuse'
            ? Promise.reject(new PlayApiError(503, 'transport_error', 'down'))
            : down === 'malformed'
              ? Promise.reject(new PlayApiError(502, 'invalid_response', 'garbled'))
              : down === 'hang'
                ? new Promise((_, reject) => o?.signal?.addEventListener('abort', () => reject(new PlayApiError(503, 'transport_error', 'aborted'))))
                : play.getInstallation(id, o),
      }),
    })
    const { cookie } = await launchAs(env, INSTALLATION_A, 'a')
    // Within the grace period: viewing continues, and says the status is unknown.
    for (const mode of ['refuse', 'malformed', 'hang'] as const) {
      down = mode
      t += 15_000
      const res = await readCity(env.base, cookie)
      expect(res.status, mode).toBe(200)
      expect((await cityOf(res)).viewer.status.installationActive, mode).toEqual({ status: 'unknown', reason: 'authority-unavailable' })
    }
    // Past it: refused FOR NOW. The session and its cookie are kept.
    t += 15_001
    const refused = await readCity(env.base, cookie)
    expect([refused.status, refused.headers.get('retry-after'), refused.headers.get('set-cookie'), await refused.json()]).toEqual([503, '5', null, { error: 'installation_unverified' }])
    expect(env.s.rows[0].revokedAt).toBeNull()
    // Play answers again: the same session serves, verified.
    down = null
    const back = await readCity(env.base, cookie)
    expect(back.status).toBe(200)
    expect((await cityOf(back)).viewer.status.installationActive).toMatchObject({ status: 'verified', basis: 'live' })
  })

  it('asks Play once for 25 simultaneous reads of one installation, and cancels a hung request at the deadline', async () => {
    let inFlight = 0
    let peak = 0
    let calls = 0
    let hang = false
    let aborted = 0
    const env = await boot({
      installationCheckMs: 150,
      wrapPlay: (play) => ({
        ...play,
        getInstallation: async (id, o) => {
          calls++
          inFlight++
          peak = Math.max(peak, inFlight)
          try {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, hang ? 60_000 : 50)
              o?.signal?.addEventListener('abort', () => (clearTimeout(timer), aborted++, reject(new PlayApiError(503, 'transport_error', 'aborted'))))
            })
            return await play.getInstallation(id)
          } finally {
            inFlight--
          }
        },
      }),
    })
    const players = Array.from({ length: 25 }, (_, i) => ({ discordUserId: String(300000000000000000n + BigInt(i)), coreUserId: `core-${i}`, displayName: `P${i}` }))
    const cookies = []
    for (const [i, player] of players.entries()) cookies.push((await launchAs(env, INSTALLATION_A, `p${String(i).padStart(3, '0')}`, player)).cookie)
    calls = 0
    peak = 0
    const reads = await Promise.all(cookies.map((c) => readCity(env.base, c)))
    expect(reads.map((r) => r.status)).toEqual(cookies.map(() => 200))
    expect([calls, peak]).toEqual([1, 1])
    const seen = new Set(await Promise.all(reads.map(async (r) => (await cityOf(r)).viewer.player.discordUserId)))
    expect(seen.size).toBe(25)
    // Play hangs: one request, aborted at the deadline, nothing left running; the reads are answered within grace.
    hang = true
    calls = 0
    const started = performance.now()
    const hung = await Promise.all(cookies.map((c) => readCity(env.base, c)))
    expect(performance.now() - started).toBeLessThan(3_000)
    expect(hung.map((r) => r.status)).toEqual(cookies.map(() => 200))
    expect([calls, aborted, inFlight]).toEqual([1, 1, 0])
  })
})

describe('a launch never changes who a signed-in browser is (F5)', () => {
  it('opens nothing for a run minted for another player, keeps the session, and spends the link', async () => {
    const env = await boot()
    const victim = await launchAs(env, INSTALLATION_A, 'victim', ADA)
    // An attacker launches as themselves and hands the victim the link.
    const attackerToken = env.p.launch(INSTALLATION_B, 'attacker', { player: BEA })
    const res = await post(env.base, { runToken: attackerToken }, TEST_ORIGIN, victim.cookie)
    expect([res.status, res.headers.get('set-cookie'), res.headers.get('cache-control'), await res.json()]).toEqual([409, null, 'no-store', { error: 'play_session_other_player', session: { displayName: ADA.displayName } }])
    // The victim is still themselves, in their own city, and no session was opened for the attacker.
    expect((await cityOf(await readCity(env.base, victim.cookie))).viewer.player).toEqual(ADA)
    expect(env.s.rows.filter((r) => r.player.discordUserId === BEA.discordUserId)).toEqual([])
    // Play redeems once: the link is dead, in this browser or any other.
    expect([(await post(env.base, { runToken: attackerToken })).status]).toEqual([409])
    expect(env.s.rows.filter((r) => r.player.discordUserId === BEA.discordUserId)).toEqual([])
  })

  it('lets the same player launch again (their own session is replaced), and asks nothing of a browser without a live session', async () => {
    const env = await boot()
    const first = await launchAs(env, INSTALLATION_A, 'first', ADA)
    const again = await launchAs(env, INSTALLATION_B, 'again', ADA, first.cookie)
    expect((await readCity(env.base, first.cookie)).status).toBe(401)
    expect((await cityOf(await readCity(env.base, again.cookie))).play.installationId).toBe(INSTALLATION_B)
    // A signed-out browser, a planted value, an expired or revoked session: there is no player to keep, so any launch opens.
    await logout(env.base, again.cookie)
    expect((await post(env.base, { runToken: env.p.launch(INSTALLATION_A, 'bea') }, TEST_ORIGIN, again.cookie)).status).toBe(200)
    expect((await post(env.base, { runToken: env.p.launch(INSTALLATION_A, 'planted', { player: BEA }) }, TEST_ORIGIN, 'rc_play=' + 'P'.repeat(43))).status).toBe(200)
    // The body is still exactly { runToken }.
    expect((await post(env.base, { runToken: env.p.launch(INSTALLATION_A, 'extra'), replaceSession: true })).status).toBe(422)
  })

  it('answers unavailable, not a launch, when the session the browser holds cannot be read', async () => {
    const s = memorySessions()
    const env = await boot({ store: s.store })
    const a = await launchAs(env, INSTALLATION_A, 'a')
    s.store.fail = new Error('database down')
    const before = env.p.calls.length
    const res = await post(env.base, { runToken: env.p.launch(INSTALLATION_A, 'b', { player: BEA }) }, TEST_ORIGIN, a.cookie)
    expect([res.status, await res.json()]).toEqual([503, { error: 'play_session_unavailable' }])
    // Play was not asked: the token is not spent.
    expect(env.p.calls.slice(before)).toEqual([])
  })
})
