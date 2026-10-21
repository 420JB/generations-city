import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyCity } from '../src/city/verify'
import { createApp } from '../src/app'
import { ConfigError, loadConfig, type AppMode } from '../src/config'
import { migrate } from '../src/db/migrations'
import { parseAssetKey, type PlayCityResponse, type RehearsalActivationResponse, type RehearsalAssetsResponse, type RehearsalTicket, type RehearsalTicketResponse } from '../src/engine'
import { silentLogger } from '../src/log'
import { PlayApiError } from '../src/play/client'
import { createPlayLaunchService } from '../src/play/launch'
import { createPlaySessionService, createPlaySessionStore } from '../src/play/session'
import { createWorldPropertyStore } from '../src/world/properties'
import { createLocalPropertyRehearsal, matchingRules, parseRehearsalFile, parseRehearsalGrants, REHEARSAL_FILE_KIND, REHEARSAL_FILE_KIND_V2 } from '../src/world/rehearsal'
import { createWorldStore } from '../src/world/store'
import { createDistrictTicketStore, type TicketStep } from '../src/world/tickets'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'
import { ADA, BEA, DOC_A, DOC_B, fakePlay, GUILD_A, GUILD_B, INSTALLATION_A, INSTALLATION_B } from './fakePlay'
import { TEST_ORIGIN, testConfig } from './testConfig'

const MAX_UINT256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
const KEEPERS = 'eip155:8453/erc721:0x000000000000000000000000000000000000a001'
const OTHER = 'eip155:1/erc721:0x000000000000000000000000000000000000beef'
const keeper = (id: string | number) => `${KEEPERS}/${id}`
const player = (n: number, name: string) => ({ discordUserId: `93${String(n).padStart(16, '0')}`, coreUserId: `core-${name.toLowerCase()}`, displayName: name })
const CY = player(3, 'Cy')
const DEE = player(4, 'Dee')
/** Players 10..17, one keeper each, for concurrent entry. */
const CROWD = Array.from({ length: 8 }, (_, i) => player(10 + i, `Crowd${i}`))
/**
 * The LOCAL FIXTURE (rehearsal file v2): who may place which test NFTs, their traits, and explicit district rules. Ada and
 * Bea are both listed for keeper #7 (so both can try to place it). Keeper #40 carries a Captain trait, which a rule assigns
 * to Tidewater; #41 matches two rules that name different districts.
 */
const GRANTS = {
  kind: REHEARSAL_FILE_KIND_V2,
  players: {
    [ADA.discordUserId]: [
      keeper(1),
      keeper(2),
      keeper(7),
      keeper(MAX_UINT256),
      keeper('9007199254740993'),
      OTHER + '/5',
      ...Array.from({ length: 12 }, (_, i) => keeper(100 + i)),
      { asset: keeper(40), traits: { Role: 'Captain' } },
      { asset: keeper(41), traits: { Role: 'Captain', Crew: 'Night' } },
    ],
    [BEA.discordUserId]: [keeper(7), keeper(3)],
    [CY.discordUserId]: [keeper(30), keeper(31)],
    [DEE.discordUserId]: [{ asset: keeper(42), traits: { Rank: 'Admiral' } }],
    ...Object.fromEntries(CROWD.map((c, i) => [c.discordUserId, [keeper(200 + i)]])),
  },
  districtRules: [
    { id: 'captains-to-tidewater', collection: { chain: 'eip155:8453', contract: '0x000000000000000000000000000000000000a001' }, traits: { Role: 'Captain' }, district: 'tidewater' },
    { id: 'night-crew-to-lantern', collection: { chain: 'eip155:8453', contract: '0x000000000000000000000000000000000000a001' }, traits: { Crew: 'Night' }, district: 'lantern-quay' },
    { id: 'admirals-to-compass', collection: { chain: 'eip155:8453', contract: '0x000000000000000000000000000000000000a001' }, traits: { Rank: 'Admiral' }, district: 'compass-row' },
  ],
}
/** The same fixture, and keeper #43 of Ada's, which four rules with 64-character ids all assign to Tidewater: 259 characters of ids. */
const LONG_RULE_IDS = ['a', 'b', 'c', 'd'].map((c) => c.repeat(64))
const GRANTS_LONG_RULES = {
  ...GRANTS,
  players: { ...GRANTS.players, [ADA.discordUserId]: [...GRANTS.players[ADA.discordUserId], { asset: keeper(43), traits: { Ledger: 'Long' } }] },
  districtRules: [
    ...GRANTS.districtRules,
    ...LONG_RULE_IDS.map((id) => ({ id, collection: { chain: 'eip155:8453', contract: '0x000000000000000000000000000000000000a001' }, traits: { Ledger: 'Long' }, district: 'tidewater' })),
  ],
}
const ACTIVATIONS = '/v1/play/rehearsal/activations'
const ASSETS = '/v1/play/rehearsal/assets'
const TICKET = '/v1/play/rehearsal/ticket'
const ENTRY = '/v1/play/rehearsal/entry'
const ASSIGNMENT = '/v1/play/rehearsal/assignment'
const RELEASE = '/v1/play/rehearsal/release'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

describe.skipIf(NO_TEST_DATABASE)('local property rehearsal routes against a disposable Postgres', () => {
  const t = useTestSchema()

  /** Play with installations A and B, the real launch path, world, session, ticket and property stores, and the HTTP app. */
  async function boot(options: { mode?: AppMode; rehearsal?: boolean; rateLimits?: boolean; ttlSeconds?: number; fixture?: unknown; onTicketStep?: (step: TicketStep) => void | Promise<void> } = {}) {
    await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })
    const p = fakePlay()
    p.install(INSTALLATION_A, GUILD_A)
    p.install(INSTALLATION_B, GUILD_B)
    p.publish(INSTALLATION_A, DOC_A)
    p.publish(INSTALLATION_B, DOC_B)
    const worlds = createWorldStore(t.db, { mode: 'local', log: silentLogger })
    const launch = createPlayLaunchService({ play: p.play, environment: 'dev', gameKey: 'rare-city', worlds })
    const sessions = createPlaySessionService({ store: createPlaySessionStore(t.db), worlds, play: p.play, environment: 'dev', gameKey: 'rare-city', log: silentLogger, installationCacheMs: 0 })
    const tickets = createDistrictTicketStore(t.db, { mode: 'local', log: silentLogger, ttlSeconds: options.ttlSeconds ?? 600, onStep: options.onTicketStep })
    const rehearsal =
      options.rehearsal === false
        ? null
        : createLocalPropertyRehearsal({ mode: 'local', fixture: parseRehearsalFile(options.fixture ?? GRANTS), sessions, store: createWorldPropertyStore(t.db, { mode: 'local', log: silentLogger }), tickets })
    const server = createServer(createApp({ config: testConfig({ mode: options.mode ?? 'local', rateLimits: options.rateLimits ?? false }), db: t.db, migrationsDir: MIGRATIONS_DIR, log: silentLogger, playLaunch: launch, playSessions: sessions, rehearsal }))
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    let runs = 0

    /** A browser launched into `installation` as `player`: its cookie, and the actor its page would name. */
    async function launchAs(installation: string, who = ADA, cookie?: string) {
      const res = await fetch(`${base}/v1/play/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: TEST_ORIGIN, ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ runToken: p.launch(installation, `rehearsal-${++runs}-${randomUUID()}`, { player: who }) }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as PlayCityResponse
      return {
        cookie: res.headers.get('set-cookie')!.split(';')[0],
        actor: { sessionRef: body.viewer.session.ref, worldId: body.world.id, discordUserId: body.viewer.player.discordUserId },
        geometryFingerprint: body.world.definition.geometryFingerprint,
        body,
        ticket: null as RehearsalTicket | null,
      }
    }
    type Browser = Awaited<ReturnType<typeof launchAs>>
    /** `headers` override the browser's; a null header is not sent at all. */
    const post = (path: string, b: Pick<Browser, 'cookie'>, body: unknown, headers: Record<string, string | null> = {}) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: Object.fromEntries(Object.entries({ 'content-type': 'application/json', origin: TEST_ORIGIN, cookie: b.cookie, ...headers }).filter((e): e is [string, string] => e[1] !== null)),
        body: JSON.stringify(body),
      })
    /** City entry, as the page sends it on a launch: the browser's ticket afterwards (kept on `b`). */
    async function enter(b: Browser): Promise<RehearsalTicketResponse> {
      const res = await post(ENTRY, b, b.actor)
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
      const body = (await res.json()) as RehearsalTicketResponse
      b.ticket = body.ticket
      return body
    }
    const current = async (b: Pick<Browser, 'cookie'>) => (await (await fetch(`${base}${TICKET}`, { headers: { cookie: b.cookie } })).json()) as RehearsalTicketResponse
    const activate = (b: Browser, asset: string, plotId: string, init: { headers?: Record<string, string | null>; body?: unknown } = {}) =>
      post(ACTIVATIONS, b, init.body ?? { ...b.actor, asset, plotId, geometryFingerprint: b.geometryFingerprint, ticketId: b.ticket?.id ?? randomUUID() }, init.headers)
    const assign = (b: Browser, asset: string) => post(ASSIGNMENT, b, { ...b.actor, ticketId: b.ticket?.id ?? randomUUID(), asset })
    const release = (b: Browser) => post(RELEASE, b, { ...b.actor, ticketId: b.ticket?.id ?? randomUUID() })
    const city = async (b: Pick<Browser, 'cookie'>) => (await (await fetch(`${base}/v1/play/city`, { headers: { cookie: b.cookie } })).json()) as PlayCityResponse
    const properties = async () => (await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM world_properties')).rows[0].n
    return { p, base, launchAs, post, enter, current, activate, assign, release, city, properties }
  }

  it('enters the claim flow: the server assigns districts 1, 2 and 1 again round the rotation; a reload only reads; a relaunch keeps the ticket', async () => {
    const { launchAs, post, enter, current, properties } = await boot()
    const ada = await launchAs(INSTALLATION_A, ADA)
    // Nothing is issued by launching or reading: only by entering.
    expect(await current(ada)).toEqual({ rehearsal: { kind: 'local-test-assets', verified: false }, ticket: null, fresh: false })
    const entered = await enter(ada)
    expect(entered).toMatchObject({ rehearsal: { kind: 'local-test-assets', verified: false }, fresh: true, ticket: { kind: 'fallback', districtKey: 'lantern-quay', slot: { ordinal: 0, generation: 1, epoch: 1 }, rule: null, configVersion: 1, layoutGeometryFingerprint: ada.geometryFingerprint } })
    // The answer names no session, player or Core id.
    for (const secret of [ada.actor.sessionRef, ADA.discordUserId, ADA.coreUserId]) expect(JSON.stringify(entered)).not.toContain(secret)
    expect(await current(ada)).toEqual({ ...entered, fresh: false })
    // Bea is next: District 2. Cy after her: round again (the gated Compass Row is nobody's default).
    const bea = await launchAs(INSTALLATION_A, BEA)
    const cy = await launchAs(INSTALLATION_A, CY)
    expect((await enter(bea)).ticket).toMatchObject({ districtKey: 'tidewater', slot: { ordinal: 1 } })
    expect((await enter(cy)).ticket).toMatchObject({ districtKey: 'lantern-quay', slot: { ordinal: 2 } })
    // A relaunch in the same browser, and entering again: the same ticket, nothing skipped.
    const relaunched = await launchAs(INSTALLATION_A, ADA, ada.cookie)
    expect(await current(relaunched)).toMatchObject({ ticket: { id: entered.ticket!.id } })
    expect(await enter(relaunched)).toMatchObject({ fresh: false, ticket: { id: entered.ticket!.id } })
    expect(await properties()).toBe(0)
    // A player the file lists nothing for, and one whose only NFT is of no collection of this city: no ticket.
    for (const who of [player(99, 'Nobody')]) {
      const nobody = await launchAs(INSTALLATION_A, who)
      const refused = await post(ENTRY, nobody, nobody.actor)
      expect([refused.status, await refused.json()]).toEqual([403, { error: 'not_eligible' }])
      expect((await current(nobody)).ticket).toBeNull()
    }
    expect(await properties()).toBe(0)
  })

  it('answers a stale page, or a configuration Play has active that the city has not adopted, with 409 config_superseded; Play silent under the lock is 503; nothing is written', async () => {
    const { p, launchAs, enter, current, activate, properties } = await boot()
    const ada = await launchAs(INSTALLATION_A, ADA)
    await enter(ada)
    const answer = async (res: Response) => [res.status, await res.json(), res.headers.get('set-cookie')]
    // An admin publishes a fourth district; nobody has launched with it. Ada's page is not stale, but the city's first
    // property would freeze three districts Play no longer has active.
    p.publish(INSTALLATION_A, { ...DOC_A, districts: [...DOC_A.districts, { key: 'saltmarsh', name: 'Saltmarsh', accent: '#2a9d8f', monument: null, proofyRule: null }] })
    expect(await answer(await activate(ada, keeper(1), 'lantern-quay-w0-p0'))).toEqual([409, { error: 'config_superseded' }, null])
    // Bea launches with it, so four districts govern: Ada's page, drawn on three, is stale, and her ticket was superseded
    // and reissued on the new rotation in the same transaction.
    await launchAs(INSTALLATION_A, BEA)
    expect(await answer(await activate(ada, keeper(1), 'lantern-quay-w0-p0'))).toEqual([409, { error: 'config_superseded' }, null])
    expect(await properties()).toBe(0)
    // Relaunched on four districts: the old ticket is superseded; the page reads the reissued one.
    const again = await launchAs(INSTALLATION_A, ADA, ada.cookie)
    again.ticket = ada.ticket
    expect(await answer(await activate(again, keeper(1), 'lantern-quay-w0-p0'))).toEqual([409, { error: 'ticket_superseded' }, null])
    again.ticket = (await current(again)).ticket
    expect(again.ticket).toMatchObject({ slot: { epoch: 2, ordinal: 1 }, districtKey: 'lantern-quay' })
    // Play answers requireActor, then not the question under the lock: refused, still signed in.
    const ask = p.play.getInstallation.bind(p.play)
    let asked = 0
    p.play.getInstallation = (id, o) => (++asked === 2 ? Promise.reject(new PlayApiError(503, 'transport_error', 'unreachable')) : ask(id, o))
    const silent = await activate(again, keeper(1), 'lantern-quay-w0-p0')
    expect([silent.status, await silent.json(), silent.headers.get('set-cookie'), silent.headers.get('retry-after')]).toEqual([503, { error: 'installation_unverified' }, null, '5'])
    expect(await properties()).toBe(0)
    p.play.getInstallation = ask
    expect((await activate(again, keeper(1), 'lantern-quay-w0-p0')).status).toBe(200)
    expect(await properties()).toBe(1)
  })

  it('places a listed test NFT on the exact plot chosen in the assigned district, consuming the ticket; every player of the city sees it', async () => {
    const { base, launchAs, enter, current, activate, city } = await boot()
    const ada = await launchAs(INSTALLATION_A, ADA)
    const assets = await fetch(`${base}${ASSETS}`, { headers: { cookie: ada.cookie } })
    expect(assets.status).toBe(200)
    const listed = (await assets.json()) as RehearsalAssetsResponse
    // Marked as rehearsal data in the answer itself, and exactly the file's list for this player.
    expect(listed.rehearsal).toEqual({ kind: 'local-test-assets', verified: false })
    expect(listed.assets.map((a) => a.asset)).toEqual(GRANTS.players[ADA.discordUserId].map((a) => (typeof a === 'string' ? a : a.asset)))
    expect(listed.assets[3]).toEqual({ asset: keeper(MAX_UINT256), chain: 'eip155:8453', contract: '0x000000000000000000000000000000000000a001', tokenId: MAX_UINT256 })

    const ticket = (await enter(ada)).ticket!
    const res = await activate(ada, keeper(1), 'lantern-quay-w0-p3')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as RehearsalActivationResponse
    expect(body).toMatchObject({ rehearsal: { kind: 'local-test-assets', verified: false }, fresh: true, sequence: 2, consumedTicket: ticket.id, property: { asset: keeper(1), collection: 'harbor-keepers', plotId: 'lantern-quay-w0-p3', districtKey: 'lantern-quay', ward: 0, plot: 3, sequence: 2, configVersion: 1 } })
    // No session reference or player in the answer: provenance stays on the server.
    for (const secret of [ada.actor.sessionRef, ADA.discordUserId, ADA.coreUserId]) expect(JSON.stringify(body)).not.toContain(secret)
    // The ticket is spent.
    expect((await current(ada)).ticket).toBeNull()

    // Another player of the same server sees the same city, with exactly that building.
    const bea = await launchAs(INSTALLATION_A, BEA)
    for (const b of [ada, bea]) {
      const c = await city(b)
      expect(c.world.sequence).toBe(2)
      expect(c.world.state.buildings).toEqual({ [body.property.buildingId]: { propertyId: body.property.id, asset: keeper(1), collection: 'harbor-keepers', districtKey: 'lantern-quay', ward: 0, plot: 3, sequence: 2 } })
      expect(c.world.districts.find((d) => d.key === 'lantern-quay')!.candidates.plotIds).not.toContain('lantern-quay-w0-p3')
      expect(c.viewer.originalActivations).toEqual(b === ada ? [body.property.id] : [])
      if (b === bea) for (const secret of [ada.actor.sessionRef, ADA.discordUserId, ADA.coreUserId]) expect(JSON.stringify(c)).not.toContain(secret)
      expect(c.world.definition.districtGeometry).toEqual({ frozen: true, atSequence: 2, configVersion: 1 })
    }
    expect(await verifyCity(t.db)).toMatchObject({ ok: true, worlds: [{ sequence: 2, properties: 1, districtTickets: { committed: 1, active: 0 } }] })
  })

  it('claims a second NFT without signing out, on a newly issued ticket; uint256 token ids stay exact beyond 2^53', async () => {
    const { launchAs, enter, activate, city } = await boot()
    const ada = await launchAs(INSTALLATION_A)
    const plots: string[] = []
    for (const token of [MAX_UINT256, '9007199254740993']) {
      const ticket = (await enter(ada)).ticket!
      plots.push(ticket.districtKey)
      const body = (await (await activate(ada, keeper(token), `${ticket.districtKey}-w0-p0`)).json()) as RehearsalActivationResponse
      expect([body.property.asset, body.consumedTicket]).toEqual([keeper(token), ticket.id])
    }
    // Each claim took the next slot of the rotation: no gap, nothing reused.
    expect(plots).toEqual(['lantern-quay', 'tidewater'])
    const assets = Object.values((await city(ada)).world.state.buildings).map((b) => b.asset)
    expect(assets).toEqual([keeper(MAX_UINT256), keeper('9007199254740993')])
  })

  it('a repeat is the same property for the same player and consumes nothing; nobody else gets a success, a session or a second property', async () => {
    const { launchAs, enter, activate, properties } = await boot()
    const ada = await launchAs(INSTALLATION_A, ADA)
    const bea = await launchAs(INSTALLATION_A, BEA)
    await enter(ada)
    await enter(bea)
    const first = (await (await activate(ada, keeper(7), 'lantern-quay-w0-p0')).json()) as RehearsalActivationResponse
    const again = await activate(ada, keeper(7), 'lantern-quay-w0-p0')
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ ...first, fresh: false, consumedTicket: null })
    // Bea is listed for #7 too: the same NFT on the same plot is not hers to repeat.
    const theirs = await activate(bea, keeper(7), 'lantern-quay-w0-p0')
    expect(theirs.status).toBe(409)
    expect(await theirs.json()).toEqual({ error: 'asset_already_placed' })
    // The same NFT elsewhere, and another NFT on the taken plot.
    expect(await (await activate(ada, keeper(7), 'lantern-quay-w0-p1')).json()).toEqual({ error: 'asset_already_placed' })
    expect(await (await activate(bea, keeper(3), 'lantern-quay-w0-p0')).json()).toEqual({ error: 'plot_unavailable' })
    expect(await properties()).toBe(1)
  })

  it('believes nothing the browser says about an NFT or a district: only what the file lists and the server assigned', async () => {
    const { launchAs, enter, activate, properties } = await boot()
    const ada = await launchAs(INSTALLATION_A, ADA)
    const bea = await launchAs(INSTALLATION_A, BEA)
    await enter(ada)
    await enter(bea)
    // Bea's NFT, from Ada's session.
    const res = await activate(ada, keeper(3), 'lantern-quay-w0-p0')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'rehearsal_asset_not_granted' })
    // Ada claiming to be Bea (who is listed for #3): the session is Ada's, so nothing is done as Bea.
    expect(await (await activate(ada, keeper(3), 'tidewater-w0-p0', { body: { ...ada.actor, discordUserId: BEA.discordUserId, asset: keeper(3), plotId: 'tidewater-w0-p0', geometryFingerprint: ada.geometryFingerprint, ticketId: bea.ticket!.id } })).json()).toEqual({ error: 'play_actor_mismatch' })
    // Bea naming Ada's session and player, with her own cookie.
    expect(await (await activate(bea, keeper(1), 'lantern-quay-w0-p0', { body: { ...ada.actor, asset: keeper(1), plotId: 'lantern-quay-w0-p0', geometryFingerprint: ada.geometryFingerprint, ticketId: ada.ticket!.id } })).json()).toEqual({ error: 'play_actor_mismatch' })
    // Bea using Ada's ticket id as herself: not her ticket.
    expect(await (await activate(bea, keeper(3), 'lantern-quay-w0-p0', { body: { ...bea.actor, asset: keeper(3), plotId: 'lantern-quay-w0-p0', geometryFingerprint: bea.geometryFingerprint, ticketId: ada.ticket!.id } })).json()).toEqual({ error: 'ticket_not_live' })
    // A listed NFT from no collection of this city, a non-canonical id, an unknown plot, a closed ward.
    expect(await (await activate(ada, `${OTHER}/5`, 'lantern-quay-w0-p0')).json()).toEqual({ error: 'asset_not_in_world' })
    expect(await (await activate(ada, `${KEEPERS}/01`, 'lantern-quay-w0-p0')).json()).toEqual({ error: 'invalid_asset' })
    expect(await (await activate(ada, keeper(1), 'harbor-w0-p0')).json()).toEqual({ error: 'unknown_plot' })
    expect(await (await activate(ada, keeper(1), 'lantern-quay-w1-p0')).json()).toEqual({ error: 'plot_unavailable' })
    // Another district than the one assigned, including the gated one: the player chooses only the plot.
    for (const plot of ['tidewater-w0-p0', 'compass-row-w0-p0']) {
      const outside = await activate(ada, keeper(1), plot)
      expect([outside.status, await outside.json()]).toEqual([422, { error: 'plot_outside_assignment' }])
    }
    // An unknown ticket id.
    expect(await (await activate(ada, keeper(1), 'lantern-quay-w0-p0', { body: { ...ada.actor, asset: keeper(1), plotId: 'lantern-quay-w0-p0', geometryFingerprint: ada.geometryFingerprint, ticketId: randomUUID() } })).json()).toEqual({ error: 'ticket_not_live' })
    expect(await properties()).toBe(0)
  })

  it('an explicit fixture rule assigns its NFT\'s district and frees the fallback slot; conflicting rules and gated districts are refused', async () => {
    const { launchAs, enter, assign, activate, current, properties } = await boot()
    const ada = await launchAs(INSTALLATION_A, ADA)
    const fallback = (await enter(ada)).ticket!
    expect(fallback.districtKey).toBe('lantern-quay')
    // The Captain NFT, on the fallback ticket: the rule applies, so it must be selected first.
    expect(await (await activate(ada, keeper(40), 'lantern-quay-w0-p0')).json()).toEqual({ error: 'district_rule_applies' })
    const res = await assign(ada, keeper(40))
    expect(res.status).toBe(200)
    const assigned = (await res.json()) as RehearsalTicketResponse
    expect(assigned).toMatchObject({ fresh: true, ticket: { kind: 'rule', districtKey: 'tidewater', slot: null, rule: { ref: 'captains-to-tidewater', asset: keeper(40) }, expiresAt: fallback.expiresAt } })
    ada.ticket = assigned.ticket
    // The freed slot goes to the next entrant.
    const bea = await launchAs(INSTALLATION_A, BEA)
    expect((await enter(bea)).ticket).toMatchObject({ districtKey: 'lantern-quay', slot: { ordinal: 0, generation: 2 } })
    // Rules matching #41 name two districts: refused at selection, and the ticket stays as it was.
    const ambiguous = await assign(ada, keeper(41))
    expect([ambiguous.status, await ambiguous.json()]).toEqual([409, { error: 'district_rule_ambiguous' }])
    expect((await current(ada)).ticket!.id).toBe(assigned.ticket!.id)
    // Placed in the rule's district.
    expect((await activate(ada, keeper(40), 'tidewater-w0-p4')).status).toBe(200)
    // A rule into a gated district is refused: nothing can check the Proofy rule.
    const dee = await launchAs(INSTALLATION_A, DEE)
    await enter(dee)
    const gated = await assign(dee, keeper(42))
    expect([gated.status, await gated.json()]).toEqual([403, { error: 'district_rule_unverified' }])
    // Selecting an NFT that is not listed for the player, or of no collection of the city.
    expect((await assign(dee, keeper(1))).status).toBe(403)
    expect(await properties()).toBe(1)
    expect(await verifyCity(t.db)).toMatchObject({ ok: true })
  })

  it('leaving the claim flow releases the ticket for the next entrant; a released or expired ticket places nothing', async () => {
    const { launchAs, enter, release, activate, current, properties } = await boot({ ttlSeconds: 1 })
    const ada = await launchAs(INSTALLATION_A, ADA)
    const bea = await launchAs(INSTALLATION_A, BEA)
    const left = (await enter(ada)).ticket!
    const res = await release(ada)
    expect([res.status, await res.json()]).toEqual([200, { rehearsal: { kind: 'local-test-assets', verified: false }, ticket: null, fresh: false }])
    expect(await (await activate(ada, keeper(1), 'lantern-quay-w0-p0')).json()).toEqual({ error: 'ticket_not_live' })
    expect(await (await release(ada)).json()).toEqual({ error: 'ticket_not_live' })
    // Bea takes Ada's released District 1 slot, at its next generation.
    expect((await enter(bea)).ticket).toMatchObject({ districtKey: left.districtKey, slot: { ordinal: 0, generation: 2 } })
    // Her lease runs out: refused, and the next entry finds the slot free again.
    await new Promise((r) => setTimeout(r, 1_300))
    expect(await (await activate(bea, keeper(3), 'lantern-quay-w0-p0')).json()).toEqual({ error: 'ticket_expired' })
    expect((await current(bea)).ticket).toBeNull()
    expect((await enter(ada)).ticket).toMatchObject({ slot: { ordinal: 0, generation: 3 } })
    expect(await properties()).toBe(0)
  })

  it('selecting an NFT as the lease runs out answers 409 ticket_expired, not a session error; the ticket and its slot stay as they were', async () => {
    let armed = false
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const { launchAs, enter, assign, properties } = await boot({ ttlSeconds: 1, onTicketStep: async (step) => { if (step === 'reassigning' && armed) await sleep(1_200) } })
    const ada = await launchAs(INSTALLATION_A, ADA)
    const fallback = (await enter(ada)).ticket!
    const slot = async () => (await t.db.query<{ state: string; generation: number }>('SELECT state, generation FROM world_assignment_slots WHERE world_id = $1 AND ordinal = 0', [ada.actor.worldId])).rows[0]
    armed = true
    // The Captain NFT: a rule assigns Tidewater, and the lease is over before the rule ticket is written.
    const res = await assign(ada, keeper(40))
    expect([res.status, await res.json()]).toEqual([409, { error: 'ticket_expired' }])
    expect((await t.db.query<{ status: string }>('SELECT status FROM world_district_tickets WHERE id = $1', [fallback.id])).rows[0].status).toBe('active')
    expect((await t.db.query<{ n: number }>("SELECT count(*)::int AS n FROM world_district_tickets WHERE kind = 'rule'")).rows[0].n).toBe(0)
    expect(await slot()).toEqual({ state: 'held', generation: 1 })
    expect(await properties()).toBe(0)
    expect(await verifyCity(t.db)).toMatchObject({ ok: true })
  })

  it('rules whose ids together are longer than a ticket records answer 409 district_rule_ref_too_long; the ticket stays as it was', async () => {
    const { launchAs, enter, assign, activate, current, properties } = await boot({ fixture: GRANTS_LONG_RULES })
    const ada = await launchAs(INSTALLATION_A, ADA)
    const fallback = (await enter(ada)).ticket!
    const res = await assign(ada, keeper(43))
    expect([res.status, await res.json()]).toEqual([409, { error: 'district_rule_ref_too_long' }])
    expect((await current(ada)).ticket).toMatchObject({ id: fallback.id, kind: 'fallback', slot: { ordinal: 0, generation: 1 } })
    // Nor can the fallback ticket place it.
    const placed = await activate(ada, keeper(43), 'lantern-quay-w0-p0')
    expect([placed.status, await placed.json()]).toEqual([409, { error: 'district_rule_ref_too_long' }])
    expect(await properties()).toBe(0)
  })

  it('needs exactly the session the page drew, a session at all, and Play active now', async () => {
    const { p, launchAs, enter, activate, properties } = await boot()
    const ada = await launchAs(INSTALLATION_A, ADA)
    await enter(ada)
    // The same browser launched again: the page that drew the first session is stale.
    const relaunched = await launchAs(INSTALLATION_A, ADA, ada.cookie)
    relaunched.ticket = ada.ticket
    expect(await (await activate({ ...relaunched, actor: ada.actor }, keeper(1), 'lantern-quay-w0-p0')).json()).toEqual({ error: 'play_actor_mismatch' })
    // The old cookie is no session at all: refused, and cleared.
    const old = await activate(ada, keeper(1), 'lantern-quay-w0-p0')
    expect(old.status).toBe(401)
    expect(await old.json()).toEqual({ error: 'play_session_required' })
    expect(old.headers.get('set-cookie')).toMatch(/^rc_play=;/)
    // Play does not answer: not now (503), the session kept.
    p.tamper.fail = { method: 'getInstallation', status: 503, code: 'unavailable' }
    const silent = await activate(relaunched, keeper(1), 'lantern-quay-w0-p0')
    expect(silent.status).toBe(503)
    expect(await silent.json()).toEqual({ error: 'installation_unverified' })
    expect(silent.headers.get('set-cookie')).toBeNull()
    // Play refuses Rare City: the session is over.
    p.tamper.fail = { method: 'getInstallation', status: 401, code: 'unauthorized' }
    const refused = await activate(relaunched, keeper(1), 'lantern-quay-w0-p0')
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'play_authorization_refused' })
    expect(refused.headers.get('set-cookie')).toMatch(/^rc_play=;/)
    p.tamper.fail = undefined
    expect(await (await activate(relaunched, keeper(1), 'lantern-quay-w0-p0')).json()).toEqual({ error: 'play_session_required' })
    expect(await properties()).toBe(0)
  })

  it('keeps communities apart: a session and a ticket act only in their own city', async () => {
    const { launchAs, enter, activate, city } = await boot()
    const inA = await launchAs(INSTALLATION_A, ADA)
    const inB = await launchAs(INSTALLATION_B, BEA)
    await enter(inA)
    await enter(inB)
    // Separate rotations: each is District 1 of its own city.
    expect([inA.ticket!.districtKey, inB.ticket!.districtKey, inA.ticket!.slot!.ordinal, inB.ticket!.slot!.ordinal]).toEqual(['lantern-quay', 'plum', 0, 0])
    // Ada names city B with her city A session.
    expect(await (await activate(inA, keeper(1), 'plum-w0-p0', { body: { ...inA.actor, worldId: inB.actor.worldId, asset: keeper(1), plotId: 'plum-w0-p0', geometryFingerprint: inB.geometryFingerprint, ticketId: inB.ticket!.id } })).json()).toEqual({ error: 'play_actor_mismatch' })
    // A plot of city B from city A is not a plot of city A.
    expect(await (await activate(inA, keeper(1), 'plum-w0-p0')).json()).toEqual({ error: 'unknown_plot' })
    // The same collection in both cities: the same NFT is a separate property in each.
    const a = (await (await activate(inA, keeper(7), 'lantern-quay-w0-p0')).json()) as RehearsalActivationResponse
    const b = (await (await activate(inB, keeper(7), 'plum-w0-p0')).json()) as RehearsalActivationResponse
    expect(a.property.id).not.toBe(b.property.id)
    expect(Object.keys((await city(inA)).world.state.buildings)).toEqual([a.property.buildingId])
    expect(Object.keys((await city(inB)).world.state.buildings)).toEqual([b.property.buildingId])
  })

  it('stays atomic under concurrency: distinct slots for simultaneous entrants; one plot, one property; one NFT, one plot; one ticket, one property', async () => {
    const { launchAs, enter, activate, properties } = await boot()
    // Eight players enter at once: eight distinct slots, round the two default districts.
    const crowd = await Promise.all(CROWD.map((c) => launchAs(INSTALLATION_A, c)))
    const entered = await Promise.all(crowd.map((b) => enter(b)))
    expect(entered.map((e) => e.ticket!.slot!.ordinal).sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    for (const e of entered) expect(e.ticket!.districtKey).toBe(['lantern-quay', 'tidewater'][e.ticket!.slot!.ordinal % 2])
    // Everyone holding District 1 goes for the same plot: one property, the rest told the plot is taken (tickets kept).
    const lantern = crowd.filter((b) => b.ticket!.districtKey === 'lantern-quay')
    const samePlot = await Promise.all(lantern.map((b) => activate(b, keeper(200 + CROWD.findIndex((c) => c.discordUserId === b.actor.discordUserId)), 'lantern-quay-w0-p2')))
    expect(samePlot.filter((r) => r.status === 200)).toHaveLength(1)
    expect(new Set(await Promise.all(samePlot.filter((r) => r.status !== 200).map(async (r) => `${r.status} ${JSON.stringify(await r.json())}`)))).toEqual(new Set(['409 {"error":"plot_unavailable"}']))
    // One player, one ticket, one NFT on many plots at once: one property; the others learn the NFT is placed.
    const ada = await launchAs(INSTALLATION_A, ADA)
    await enter(ada)
    const sameNft = await Promise.all(Array.from({ length: 8 }, (_, i) => activate(ada, keeper(2), `${ada.ticket!.districtKey}-w0-p${i + 3}`)))
    expect(sameNft.filter((r) => r.status === 200)).toHaveLength(1)
    expect(new Set(sameNft.filter((r) => r.status !== 200).map((r) => r.status))).toEqual(new Set([409]))
    // One ticket, many NFTs on one plot at once: one property; the ticket is spent for the rest.
    await enter(ada)
    const oneTicket = await Promise.all(Array.from({ length: 6 }, (_, i) => activate(ada, keeper(100 + i), `${ada.ticket!.districtKey}-w0-p1`)))
    expect(oneTicket.filter((r) => r.status === 200)).toHaveLength(1)
    expect(new Set(await Promise.all(oneTicket.filter((r) => r.status !== 200).map(async (r) => `${r.status} ${JSON.stringify(await r.json())}`)))).toEqual(new Set(['409 {"error":"ticket_not_live"}']))
    // The same request many times at once: one property, the rest the same answer.
    await enter(ada)
    const sameBoth = await Promise.all(Array.from({ length: 6 }, () => activate(ada, keeper(1), `${ada.ticket!.districtKey}-w0-p5`)))
    const answers = (await Promise.all(sameBoth.map((r) => r.json()))) as RehearsalActivationResponse[]
    expect(answers.filter((a) => a.fresh)).toHaveLength(1)
    expect(new Set(answers.map((a) => a.property.id)).size).toBe(1)
    expect(await properties()).toBe(4)
    expect(await verifyCity(t.db)).toMatchObject({ ok: true, worlds: [{ properties: 4, districtTickets: { committed: 4, active: 7 } }] })
  })

  it('limits each session\'s attempts, by its credential, whatever the body names', async () => {
    const { launchAs, enter, activate, post } = await boot({ rateLimits: true })
    const ada = await launchAs(INSTALLATION_A, ADA)
    const bea = await launchAs(INSTALLATION_A, BEA)
    await enter(bea)
    const statuses: number[] = []
    for (let i = 0; i < 13; i++)
      statuses.push((await activate(ada, keeper(3), 'tidewater-w0-p0', { body: { ...ada.actor, discordUserId: BEA.discordUserId, asset: keeper(3), plotId: 'tidewater-w0-p0', geometryFingerprint: ada.geometryFingerprint, ticketId: bea.ticket!.id } })).status)
    expect(statuses.slice(0, 12)).toEqual(Array(12).fill(409))
    expect(statuses[12]).toBe(429)
    // Naming Bea did not use up Bea's attempts.
    expect((await activate(bea, keeper(3), `${bea.ticket!.districtKey}-w0-p0`)).status).toBe(200)
    // Entering is limited too, by the session's credential.
    const entries: number[] = []
    for (let i = 0; i < 31; i++) entries.push((await post(ENTRY, ada, ada.actor)).status)
    expect(entries.slice(0, 30).every((s) => s === 200)).toBe(true)
    expect(entries[30]).toBe(429)
  })

  it('refuses at the boundary: same origin, an Origin header, JSON, exactly the request keys', async () => {
    const { launchAs, enter, post, activate, properties } = await boot()
    const ada = await launchAs(INSTALLATION_A)
    await enter(ada)
    for (const [path, body] of [
      [ACTIVATIONS, { ...ada.actor, asset: keeper(1), plotId: 'lantern-quay-w0-p0', geometryFingerprint: ada.geometryFingerprint, ticketId: ada.ticket!.id }],
      [ENTRY, ada.actor],
      [ASSIGNMENT, { ...ada.actor, ticketId: ada.ticket!.id, asset: keeper(1) }],
      [RELEASE, { ...ada.actor, ticketId: ada.ticket!.id }],
    ] as const) {
      // No Origin at all passes the common boundary (a request no browser sent for someone else), but not these routes.
      const without = await post(path, ada, body, { origin: null })
      expect([path, without.status, await without.json()]).toEqual([path, 403, { error: 'origin_mismatch' }])
      expect((await post(path, ada, body, { origin: 'https://evil.example' })).status).toBe(403)
      expect((await post(path, ada, body, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
      expect((await post(path, ada, body, { 'content-type': 'text/plain' })).status).toBe(415)
      expect([path, await (await post(path, ada, { ...body, owner: 'me' })).json()]).toEqual([path, { error: 'invalid_request' }])
    }
    // The geometry the page drew and the ticket are required, in their one shape.
    const full = { ...ada.actor, asset: keeper(1), plotId: 'lantern-quay-w0-p0', geometryFingerprint: ada.geometryFingerprint, ticketId: ada.ticket!.id }
    for (const [key, bad] of [['geometryFingerprint', undefined], ['geometryFingerprint', ada.geometryFingerprint.toUpperCase()], ['geometryFingerprint', `${ada.geometryFingerprint}0`], ['ticketId', undefined], ['ticketId', 'ticket-1'], ['ticketId', 7], ['ticketId', ada.ticket!.id.toUpperCase()]] as const) {
      const body: Record<string, unknown> = { ...full }
      if (bad === undefined) delete body[key]
      else body[key] = bad
      expect(await (await activate(ada, keeper(1), 'lantern-quay-w0-p0', { body })).json()).toEqual({ error: 'invalid_request' })
    }
    expect(await properties()).toBe(0)
  })

  it('does not exist without the rehearsal, or outside local mode', async () => {
    for (const options of [{ rehearsal: false }, { mode: 'staging' as const }]) {
      const { base, launchAs } = await boot(options)
      const ada = options.mode ? null : await launchAs(INSTALLATION_A)
      const cookie = ada?.cookie ?? ''
      for (const path of [ASSETS, TICKET]) expect((await fetch(`${base}${path}`, { headers: { cookie } })).status).toBe(404)
      for (const path of [ACTIVATIONS, ENTRY, ASSIGNMENT, RELEASE]) {
        const post = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: TEST_ORIGIN, cookie }, body: '{}' })
        // Not a route: only GET and HEAD exist at an unknown path.
        expect(post.status).toBe(405)
        expect(await post.json()).toEqual({ error: 'method_not_allowed' })
      }
    }
    // Nor can one be built or configured outside local mode.
    const store = createWorldPropertyStore(t.db, { mode: 'staging', log: silentLogger })
    const tickets = createDistrictTicketStore(t.db, { mode: 'staging', log: silentLogger, ttlSeconds: 60 })
    expect(() => createLocalPropertyRehearsal({ mode: 'staging', fixture: new Map(), sessions: { session: async () => never(), requireActor: async () => never(), activeConfig: () => async () => never() }, store, tickets })).toThrow(/only with APP_MODE=local/)
    const play = { PLAY_API_URL: 'https://play.example', PLAY_SERVICE_CREDENTIAL: `ppk_staging_${'a'.repeat(24)}.${'b'.repeat(64)}`, DATABASE_URL: 'postgres://db/x', PUBLIC_ORIGIN: 'https://rc.example', TRUSTED_PROXY: 'railway' }
    expect(loadConfig({ APP_MODE: 'staging', ...play }).localRehearsalFile).toBeNull()
    expect(() => loadConfig({ APP_MODE: 'staging', ...play, LOCAL_PROPERTY_REHEARSAL_FILE: '/tmp/r.json' })).toThrow(ConfigError)
    expect(() => loadConfig({ APP_MODE: 'staging', ...play, LOCAL_PROPERTY_REHEARSAL_FILE: '/tmp/r.json' })).toThrow(/only allowed when APP_MODE=local, not staging/)
    expect(() => loadConfig({ APP_MODE: 'local', LOCAL_PROPERTY_REHEARSAL_FILE: '/tmp/r.json' })).toThrow(/needs PLAY_API_URL/)
    // The ticket lease: only with the rehearsal, bounded.
    const local = { APP_MODE: 'local', PLAY_API_URL: 'http://127.0.0.1:1', PLAY_SERVICE_CREDENTIAL: `ppk_dev_${'a'.repeat(24)}.${'b'.repeat(64)}`, DATABASE_URL: 'postgres://db/x_test', LOCAL_PROPERTY_REHEARSAL_FILE: '/tmp/r.json' }
    expect(loadConfig(local).localTicketTtlSeconds).toBe(900)
    expect(loadConfig({ ...local, LOCAL_DISTRICT_TICKET_TTL_SECONDS: '30' }).localTicketTtlSeconds).toBe(30)
    for (const bad of ['4', '3601', '1.5', '-10', 'ten']) expect(() => loadConfig({ ...local, LOCAL_DISTRICT_TICKET_TTL_SECONDS: bad })).toThrow(/5 to 3600/)
    expect(() => loadConfig({ APP_MODE: 'staging', ...play, LOCAL_DISTRICT_TICKET_TTL_SECONDS: '30' })).toThrow(/only allowed with LOCAL_PROPERTY_REHEARSAL_FILE/)
  })

  it('reads its file strictly, either version', () => {
    expect(parseRehearsalGrants({ kind: REHEARSAL_FILE_KIND, players: { [BEA.discordUserId]: [keeper(7), keeper(3)] } }).get(BEA.discordUserId)!.map((a) => a.tokenId)).toEqual(['7', '3'])
    const fixture = parseRehearsalFile(GRANTS)
    expect(fixture.rules.map((r) => r.id)).toEqual(['captains-to-tidewater', 'night-crew-to-lantern', 'admirals-to-compass'])
    // Rules match a collection and every trait they list; an NFT without the traits matches none.
    const asset = (id: number) => parseAssetKey(keeper(id))!
    expect(matchingRules(fixture, asset(40))).toEqual([{ id: 'captains-to-tidewater', district: 'tidewater' }])
    expect(matchingRules(fixture, asset(41))).toEqual([{ id: 'captains-to-tidewater', district: 'tidewater' }, { id: 'night-crew-to-lantern', district: 'lantern-quay' }])
    expect(matchingRules(fixture, asset(1))).toEqual([])
    const bad = [
      {},
      { kind: 'other', players: {} },
      { kind: REHEARSAL_FILE_KIND, players: {}, extra: 1 },
      { kind: REHEARSAL_FILE_KIND, players: {}, districtRules: [] },
      { kind: REHEARSAL_FILE_KIND, players: { ada: [] } },
      { kind: REHEARSAL_FILE_KIND, players: { [ADA.discordUserId]: [`${KEEPERS}/007`] } },
      { kind: REHEARSAL_FILE_KIND, players: { [ADA.discordUserId]: [keeper(1), keeper(1)] } },
      { kind: REHEARSAL_FILE_KIND, players: { [ADA.discordUserId]: [`${KEEPERS.toUpperCase()}/1`] } },
      { kind: REHEARSAL_FILE_KIND, players: { [ADA.discordUserId]: [`${KEEPERS}/${MAX_UINT256}0`] } },
      // v1 has no traits; v2 needs its rules list, unique ids, a collection, a district key, traits of strings.
      { kind: REHEARSAL_FILE_KIND, players: { [ADA.discordUserId]: [{ asset: keeper(1), traits: { a: 'b' } }] } },
      { kind: REHEARSAL_FILE_KIND_V2, players: {} },
      { kind: REHEARSAL_FILE_KIND_V2, players: {}, districtRules: [{ id: 'a', collection: { chain: 'eip155:1', contract: '0x000000000000000000000000000000000000a001' }, district: 'x' }, { id: 'a', collection: { chain: 'eip155:1', contract: '0x000000000000000000000000000000000000a001' }, district: 'y' }] },
      { kind: REHEARSAL_FILE_KIND_V2, players: {}, districtRules: [{ id: 'a', collection: { chain: 'eip155:1', contract: '0xA00' }, district: 'x' }] },
      { kind: REHEARSAL_FILE_KIND_V2, players: {}, districtRules: [{ id: 'a', collection: { chain: 'eip155:1', contract: '0x000000000000000000000000000000000000a001' }, district: 'Not A Key' }] },
      { kind: REHEARSAL_FILE_KIND_V2, players: {}, districtRules: [{ id: 'a', collection: { chain: 'eip155:1', contract: '0x000000000000000000000000000000000000a001' }, district: 'x', traits: { a: 1 } }] },
      { kind: REHEARSAL_FILE_KIND_V2, players: { [ADA.discordUserId]: [{ asset: keeper(1), traits: { a: 'b' } }], [BEA.discordUserId]: [{ asset: keeper(1), traits: { a: 'c' } }] }, districtRules: [] },
      { kind: REHEARSAL_FILE_KIND_V2, players: { [ADA.discordUserId]: [{ asset: keeper(1), traits: {} }] }, districtRules: [] },
    ]
    for (const raw of bad) expect(() => parseRehearsalFile(raw), JSON.stringify(raw)).toThrow()
  })
})

function never(): never {
  throw new Error('not called')
}
