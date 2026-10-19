import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyCity } from '../src/city/verify'
import { createApp } from '../src/app'
import { ConfigError, loadConfig, type AppMode } from '../src/config'
import { migrate } from '../src/db/migrations'
import type { PlayCityResponse, RehearsalActivationResponse, RehearsalAssetsResponse } from '../src/engine'
import { silentLogger } from '../src/log'
import { createPlayLaunchService } from '../src/play/launch'
import { createPlaySessionService, createPlaySessionStore } from '../src/play/session'
import { createWorldPropertyStore } from '../src/world/properties'
import { createLocalPropertyRehearsal, parseRehearsalGrants, REHEARSAL_FILE_KIND } from '../src/world/rehearsal'
import { createWorldStore } from '../src/world/store'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'
import { ADA, BEA, DOC_A, DOC_B, fakePlay, GUILD_A, GUILD_B, INSTALLATION_A, INSTALLATION_B } from './fakePlay'
import { TEST_ORIGIN, testConfig } from './testConfig'

const MAX_UINT256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
const KEEPERS = 'eip155:8453/erc721:0x000000000000000000000000000000000000a001'
const OTHER = 'eip155:1/erc721:0x000000000000000000000000000000000000beef'
const keeper = (id: string | number) => `${KEEPERS}/${id}`
/** Ada and Bea are both listed for keeper #7 (so both can try to place it); each has some of their own. */
const GRANTS = {
  kind: REHEARSAL_FILE_KIND,
  players: {
    [ADA.discordUserId]: [keeper(1), keeper(2), keeper(7), keeper(MAX_UINT256), keeper('9007199254740993'), OTHER + '/5', ...Array.from({ length: 12 }, (_, i) => keeper(100 + i))],
    [BEA.discordUserId]: [keeper(7), keeper(3)],
  },
}
const ACTIVATIONS = '/v1/play/rehearsal/activations'
const ASSETS = '/v1/play/rehearsal/assets'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

describe.skipIf(NO_TEST_DATABASE)('local property rehearsal routes against a disposable Postgres', () => {
  const t = useTestSchema()

  /** Play with installations A and B, the real launch path, world, session and property stores, and the HTTP app. */
  async function boot(options: { mode?: AppMode; rehearsal?: boolean; rateLimits?: boolean } = {}) {
    await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })
    const p = fakePlay()
    p.install(INSTALLATION_A, GUILD_A)
    p.install(INSTALLATION_B, GUILD_B)
    p.publish(INSTALLATION_A, DOC_A)
    p.publish(INSTALLATION_B, DOC_B)
    const worlds = createWorldStore(t.db, { mode: 'local', log: silentLogger })
    const launch = createPlayLaunchService({ play: p.play, environment: 'dev', gameKey: 'rare-city', worlds })
    const sessions = createPlaySessionService({ store: createPlaySessionStore(t.db), worlds, play: p.play, environment: 'dev', gameKey: 'rare-city', log: silentLogger, installationCacheMs: 0 })
    const rehearsal =
      options.rehearsal === false ? null : createLocalPropertyRehearsal({ mode: 'local', grants: parseRehearsalGrants(GRANTS), sessions, store: createWorldPropertyStore(t.db, { mode: 'local', log: silentLogger }) })
    const server = createServer(createApp({ config: testConfig({ mode: options.mode ?? 'local', rateLimits: options.rateLimits ?? false }), db: t.db, migrationsDir: MIGRATIONS_DIR, log: silentLogger, playLaunch: launch, playSessions: sessions, rehearsal }))
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    let runs = 0

    /** A browser launched into `installation` as `player`: its cookie, and the actor its page would name. */
    async function launchAs(installation: string, player = ADA, cookie?: string) {
      const res = await fetch(`${base}/v1/play/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: TEST_ORIGIN, ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ runToken: p.launch(installation, `rehearsal-${++runs}`, { player }) }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as PlayCityResponse
      return { cookie: res.headers.get('set-cookie')!.split(';')[0], actor: { sessionRef: body.viewer.session.ref, worldId: body.world.id, discordUserId: body.viewer.player.discordUserId }, body }
    }
    type Browser = Awaited<ReturnType<typeof launchAs>>
    /** `headers` override the browser's; a null header is not sent at all. */
    const activate = (b: Pick<Browser, 'cookie' | 'actor'>, asset: string, plotId: string, init: { headers?: Record<string, string | null>; body?: unknown } = {}) =>
      fetch(`${base}${ACTIVATIONS}`, {
        method: 'POST',
        headers: Object.fromEntries(Object.entries({ 'content-type': 'application/json', origin: TEST_ORIGIN, cookie: b.cookie, ...init.headers }).filter((e): e is [string, string] => e[1] !== null)),
        body: JSON.stringify(init.body ?? { ...b.actor, asset, plotId }),
      })
    const city = async (b: Pick<Browser, 'cookie'>) => (await (await fetch(`${base}/v1/play/city`, { headers: { cookie: b.cookie } })).json()) as PlayCityResponse
    const properties = async () => (await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM world_properties')).rows[0].n
    return { p, base, launchAs, activate, city, properties }
  }

  it('places a listed test NFT on the exact plot chosen, permanently, and every player of the city sees it', async () => {
    const { base, launchAs, activate, city } = await boot()
    const ada = await launchAs(INSTALLATION_A, ADA)
    const assets = await fetch(`${base}${ASSETS}`, { headers: { cookie: ada.cookie } })
    expect(assets.status).toBe(200)
    const listed = (await assets.json()) as RehearsalAssetsResponse
    // Marked as rehearsal data in the answer itself, and exactly the file's list for this player.
    expect(listed.rehearsal).toEqual({ kind: 'local-test-assets', verified: false })
    expect(listed.assets.map((a) => a.asset)).toEqual(GRANTS.players[ADA.discordUserId])
    expect(listed.assets[3]).toEqual({ asset: keeper(MAX_UINT256), chain: 'eip155:8453', contract: '0x000000000000000000000000000000000000a001', tokenId: MAX_UINT256 })

    const res = await activate(ada, keeper(1), 'tidewater-w0-p3')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as RehearsalActivationResponse
    expect(body).toMatchObject({ rehearsal: { kind: 'local-test-assets', verified: false }, fresh: true, sequence: 2, property: { asset: keeper(1), collection: 'harbor-keepers', plotId: 'tidewater-w0-p3', districtKey: 'tidewater', ward: 0, plot: 3, sequence: 2, configVersion: 1 } })
    // No session reference or player in the answer: provenance stays on the server.
    expect(JSON.stringify(body)).not.toContain(ada.actor.sessionRef)
    expect(JSON.stringify(body)).not.toContain(ADA.discordUserId)

    // Another player of the same server sees the same city, with exactly that building.
    const bea = await launchAs(INSTALLATION_A, BEA)
    for (const b of [ada, bea]) {
      const c = await city(b)
      expect(c.world.sequence).toBe(2)
      expect(c.world.state.buildings).toEqual({ [body.property.buildingId]: { propertyId: body.property.id, asset: keeper(1), collection: 'harbor-keepers', districtKey: 'tidewater', ward: 0, plot: 3, sequence: 2 } })
      expect(c.world.districts.find((d) => d.key === 'tidewater')!.candidates.plotIds).not.toContain('tidewater-w0-p3')
    }
    expect(await verifyCity(t.db)).toMatchObject({ ok: true, worlds: [{ sequence: 2, properties: 1 }] })
  })

  it('keeps uint256 token ids exact, beyond 2^53, from the file to the stored city', async () => {
    const { launchAs, activate, city } = await boot()
    const ada = await launchAs(INSTALLATION_A)
    for (const [token, plot] of [[MAX_UINT256, 'lantern-quay-w0-p0'], ['9007199254740993', 'lantern-quay-w0-p1']] as const) {
      const body = (await (await activate(ada, keeper(token), plot)).json()) as RehearsalActivationResponse
      expect(body.property.asset).toBe(keeper(token))
    }
    const assets = Object.values((await city(ada)).world.state.buildings).map((b) => b.asset)
    expect(assets).toEqual([keeper(MAX_UINT256), keeper('9007199254740993')])
  })

  it('a repeat is the same property for the same player; nobody else gets a success, a session or a second property', async () => {
    const { launchAs, activate, properties } = await boot()
    const ada = await launchAs(INSTALLATION_A, ADA)
    const bea = await launchAs(INSTALLATION_A, BEA)
    const first = (await (await activate(ada, keeper(7), 'tidewater-w0-p0')).json()) as RehearsalActivationResponse
    const again = await activate(ada, keeper(7), 'tidewater-w0-p0')
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ ...first, fresh: false })
    // Bea is listed for #7 too: the same NFT on the same plot is not hers to repeat.
    const theirs = await activate(bea, keeper(7), 'tidewater-w0-p0')
    expect(theirs.status).toBe(409)
    expect(await theirs.json()).toEqual({ error: 'asset_already_placed' })
    // The same NFT elsewhere, and another NFT on the taken plot.
    expect(await (await activate(ada, keeper(7), 'tidewater-w0-p1')).json()).toEqual({ error: 'asset_already_placed' })
    expect(await (await activate(bea, keeper(3), 'tidewater-w0-p0')).json()).toEqual({ error: 'plot_unavailable' })
    expect(await properties()).toBe(1)
  })

  it('believes nothing the browser says about an NFT: only those the file lists for the session\'s player', async () => {
    const { launchAs, activate, properties } = await boot()
    const ada = await launchAs(INSTALLATION_A, ADA)
    const bea = await launchAs(INSTALLATION_A, BEA)
    // Bea's NFT, from Ada's session.
    const res = await activate(ada, keeper(3), 'tidewater-w0-p0')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'rehearsal_asset_not_granted' })
    // Ada claiming to be Bea (who is listed for #3): the session is Ada's, so nothing is done as Bea.
    expect(await (await activate(ada, keeper(3), 'tidewater-w0-p0', { body: { ...ada.actor, discordUserId: BEA.discordUserId, asset: keeper(3), plotId: 'tidewater-w0-p0' } })).json()).toEqual({ error: 'play_actor_mismatch' })
    // Bea naming Ada's session and player, with her own cookie.
    expect(await (await activate(bea, keeper(1), 'tidewater-w0-p0', { body: { ...ada.actor, asset: keeper(1), plotId: 'tidewater-w0-p0' } })).json()).toEqual({ error: 'play_actor_mismatch' })
    // A listed NFT from no collection of this city, a non-canonical id, an unknown plot, a district with a Proofy rule.
    expect(await (await activate(ada, `${OTHER}/5`, 'tidewater-w0-p0')).json()).toEqual({ error: 'asset_not_in_world' })
    expect(await (await activate(ada, `${KEEPERS}/01`, 'tidewater-w0-p0')).json()).toEqual({ error: 'invalid_asset' })
    expect(await (await activate(ada, keeper(1), 'harbor-w0-p0')).json()).toEqual({ error: 'unknown_plot' })
    expect(await (await activate(ada, keeper(1), 'tidewater-w1-p0')).json()).toEqual({ error: 'plot_unavailable' })
    const gated = await activate(ada, keeper(1), 'compass-row-w0-p0')
    expect(gated.status).toBe(403)
    expect(await gated.json()).toEqual({ error: 'district_rule_unverified' })
    expect(await properties()).toBe(0)
  })

  it('needs exactly the session the page drew, a session at all, and Play active now', async () => {
    const { p, launchAs, activate, properties } = await boot()
    const ada = await launchAs(INSTALLATION_A, ADA)
    // The same browser launched again: the page that drew the first session is stale.
    const relaunched = await launchAs(INSTALLATION_A, ADA, ada.cookie)
    expect(await (await activate({ cookie: relaunched.cookie, actor: ada.actor }, keeper(1), 'tidewater-w0-p0')).json()).toEqual({ error: 'play_actor_mismatch' })
    // The old cookie is no session at all: refused, and cleared.
    const old = await activate(ada, keeper(1), 'tidewater-w0-p0')
    expect(old.status).toBe(401)
    expect(await old.json()).toEqual({ error: 'play_session_required' })
    expect(old.headers.get('set-cookie')).toMatch(/^rc_play=;/)
    // Play does not answer: not now (503), the session kept.
    p.tamper.fail = { method: 'getInstallation', status: 503, code: 'unavailable' }
    const silent = await activate(relaunched, keeper(1), 'tidewater-w0-p0')
    expect(silent.status).toBe(503)
    expect(await silent.json()).toEqual({ error: 'installation_unverified' })
    expect(silent.headers.get('set-cookie')).toBeNull()
    // Play refuses Rare City: the session is over.
    p.tamper.fail = { method: 'getInstallation', status: 401, code: 'unauthorized' }
    const refused = await activate(relaunched, keeper(1), 'tidewater-w0-p0')
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'play_authorization_refused' })
    expect(refused.headers.get('set-cookie')).toMatch(/^rc_play=;/)
    p.tamper.fail = undefined
    expect(await (await activate(relaunched, keeper(1), 'tidewater-w0-p0')).json()).toEqual({ error: 'play_session_required' })
    expect(await properties()).toBe(0)
  })

  it('keeps communities apart: a session acts only in its own city', async () => {
    const { launchAs, activate, city } = await boot()
    const inA = await launchAs(INSTALLATION_A, ADA)
    const inB = await launchAs(INSTALLATION_B, BEA)
    // Ada names city B with her city A session.
    expect(await (await activate(inA, keeper(1), 'plum-w0-p0', { body: { ...inA.actor, worldId: inB.actor.worldId, asset: keeper(1), plotId: 'plum-w0-p0' } })).json()).toEqual({ error: 'play_actor_mismatch' })
    // A plot of city B from city A is not a plot of city A.
    expect(await (await activate(inA, keeper(1), 'plum-w0-p0')).json()).toEqual({ error: 'unknown_plot' })
    // The same collection in both cities: the same NFT is a separate property in each.
    const a = (await (await activate(inA, keeper(7), 'tidewater-w0-p0')).json()) as RehearsalActivationResponse
    const b = (await (await activate(inB, keeper(7), 'citrus-w0-p0')).json()) as RehearsalActivationResponse
    expect(a.property.id).not.toBe(b.property.id)
    expect(Object.keys((await city(inA)).world.state.buildings)).toEqual([a.property.buildingId])
    expect(Object.keys((await city(inB)).world.state.buildings)).toEqual([b.property.buildingId])
  })

  it('stays atomic under concurrent claims: one plot, one property; one NFT, one plot', async () => {
    const { launchAs, activate, properties } = await boot()
    const ada = await launchAs(INSTALLATION_A, ADA)
    const samePlot = await Promise.all(Array.from({ length: 10 }, (_, i) => activate(ada, keeper(100 + i), 'lantern-quay-w0-p2')))
    expect(samePlot.filter((r) => r.status === 200)).toHaveLength(1)
    expect(new Set(await Promise.all(samePlot.filter((r) => r.status !== 200).map(async (r) => `${r.status} ${JSON.stringify(await r.json())}`)))).toEqual(new Set(['409 {"error":"plot_unavailable"}']))
    const sameNft = await Promise.all(Array.from({ length: 8 }, (_, i) => activate(ada, keeper(2), `tidewater-w0-p${i}`)))
    expect(sameNft.filter((r) => r.status === 200)).toHaveLength(1)
    expect(new Set(sameNft.filter((r) => r.status !== 200).map((r) => r.status))).toEqual(new Set([409]))
    const sameBoth = await Promise.all(Array.from({ length: 6 }, () => activate(ada, keeper(1), 'lantern-quay-w0-p5')))
    const answers = (await Promise.all(sameBoth.map((r) => r.json()))) as RehearsalActivationResponse[]
    expect(answers.filter((a) => a.fresh)).toHaveLength(1)
    expect(new Set(answers.map((a) => a.property.id)).size).toBe(1)
    expect(await properties()).toBe(3)
    expect(await verifyCity(t.db)).toMatchObject({ ok: true, worlds: [{ sequence: 4, properties: 3 }] })
  })

  it('limits each session\'s attempts, by its credential, whatever the body names', async () => {
    const { launchAs, activate } = await boot({ rateLimits: true })
    const ada = await launchAs(INSTALLATION_A, ADA)
    const bea = await launchAs(INSTALLATION_A, BEA)
    const statuses: number[] = []
    for (let i = 0; i < 13; i++) statuses.push((await activate(ada, keeper(3), 'tidewater-w0-p0', { body: { ...ada.actor, discordUserId: BEA.discordUserId, asset: keeper(3), plotId: 'tidewater-w0-p0' } })).status)
    expect(statuses.slice(0, 12)).toEqual(Array(12).fill(409))
    expect(statuses[12]).toBe(429)
    // Naming Bea did not use up Bea's attempts.
    expect((await activate(bea, keeper(3), 'tidewater-w0-p0')).status).toBe(200)
  })

  it('refuses at the boundary: same origin, an Origin header, JSON, exactly the request keys', async () => {
    const { launchAs, activate, properties } = await boot()
    const ada = await launchAs(INSTALLATION_A)
    // No Origin at all passes the common boundary (a request no browser sent for someone else), but not this route.
    const without = await activate(ada, keeper(1), 'tidewater-w0-p0', { headers: { origin: null } })
    expect(without.status).toBe(403)
    expect(await without.json()).toEqual({ error: 'origin_mismatch' })
    expect((await activate(ada, keeper(1), 'tidewater-w0-p0', { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect((await activate(ada, keeper(1), 'tidewater-w0-p0', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await activate(ada, keeper(1), 'tidewater-w0-p0', { headers: { 'content-type': 'text/plain' } })).status).toBe(415)
    expect(await (await activate(ada, keeper(1), 'tidewater-w0-p0', { body: { ...ada.actor, asset: keeper(1), plotId: 'tidewater-w0-p0', owner: 'me' } })).json()).toEqual({ error: 'invalid_request' })
    expect(await (await activate(ada, keeper(1), 'tidewater-w0-p0', { body: { asset: keeper(1), plotId: 'tidewater-w0-p0' } })).json()).toEqual({ error: 'invalid_request' })
    expect(await properties()).toBe(0)
  })

  it('does not exist without the rehearsal, or outside local mode', async () => {
    for (const options of [{ rehearsal: false }, { mode: 'staging' as const }]) {
      const { base, launchAs } = await boot(options)
      const ada = options.mode ? null : await launchAs(INSTALLATION_A)
      const cookie = ada?.cookie ?? ''
      const get = await fetch(`${base}${ASSETS}`, { headers: { cookie } })
      expect(get.status).toBe(404)
      const post = await fetch(`${base}${ACTIVATIONS}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: TEST_ORIGIN, cookie }, body: '{}' })
      // Not a route: only GET and HEAD exist at an unknown path.
      expect(post.status).toBe(405)
      expect(await post.json()).toEqual({ error: 'method_not_allowed' })
    }
    // Nor can one be built or configured outside local mode.
    const store = createWorldPropertyStore(t.db, { mode: 'staging', log: silentLogger })
    expect(() => createLocalPropertyRehearsal({ mode: 'staging', grants: new Map(), sessions: { session: async () => never(), requireActor: async () => never() }, store })).toThrow(/only with APP_MODE=local/)
    const play = { PLAY_API_URL: 'https://play.example', PLAY_SERVICE_CREDENTIAL: `ppk_staging_${'a'.repeat(24)}.${'b'.repeat(64)}`, DATABASE_URL: 'postgres://db/x', PUBLIC_ORIGIN: 'https://rc.example', TRUSTED_PROXY: 'railway' }
    expect(loadConfig({ APP_MODE: 'staging', ...play }).localRehearsalFile).toBeNull()
    expect(() => loadConfig({ APP_MODE: 'staging', ...play, LOCAL_PROPERTY_REHEARSAL_FILE: '/tmp/r.json' })).toThrow(ConfigError)
    expect(() => loadConfig({ APP_MODE: 'staging', ...play, LOCAL_PROPERTY_REHEARSAL_FILE: '/tmp/r.json' })).toThrow(/only allowed when APP_MODE=local, not staging/)
    expect(() => loadConfig({ APP_MODE: 'local', LOCAL_PROPERTY_REHEARSAL_FILE: '/tmp/r.json' })).toThrow(/needs PLAY_API_URL/)
  })

  it('reads its file strictly', () => {
    expect(parseRehearsalGrants(GRANTS).get(BEA.discordUserId)!.map((a) => a.tokenId)).toEqual(['7', '3'])
    const bad = [
      {},
      { kind: 'other', players: {} },
      { kind: REHEARSAL_FILE_KIND, players: {}, extra: 1 },
      { kind: REHEARSAL_FILE_KIND, players: { ada: [] } },
      { kind: REHEARSAL_FILE_KIND, players: { [ADA.discordUserId]: [`${KEEPERS}/007`] } },
      { kind: REHEARSAL_FILE_KIND, players: { [ADA.discordUserId]: [keeper(1), keeper(1)] } },
      { kind: REHEARSAL_FILE_KIND, players: { [ADA.discordUserId]: [`${KEEPERS.toUpperCase()}/1`] } },
      { kind: REHEARSAL_FILE_KIND, players: { [ADA.discordUserId]: [`${KEEPERS}/${MAX_UINT256}0`] } },
    ]
    for (const raw of bad) expect(() => parseRehearsalGrants(raw)).toThrow()
  })
})

function never(): never {
  throw new Error('not called')
}
