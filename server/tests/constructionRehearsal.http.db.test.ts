import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { verifyCity } from '../src/city/verify'
import type { AppMode } from '../src/config'
import { migrate } from '../src/db/migrations'
import { parseWorldCityState, type PlayCityResponse, type RehearsalTicketResponse } from '../src/engine'
import { silentLogger } from '../src/log'
import { createPlayLaunchService } from '../src/play/launch'
import { createPlaySessionService, createPlaySessionStore } from '../src/play/session'
import { createWorldConstructionStore, type WorldConstructionStore } from '../src/world/construction'
import { createWorldPropertyStore } from '../src/world/properties'
import { createLocalPropertyRehearsal, parseRehearsalFile, REHEARSAL_FILE_KIND_V3, REHEARSAL_FILE_KIND_V4, rehearsalConstructionAuthority, rehearsalEligibility } from '../src/world/rehearsal'
import { createWorldStore } from '../src/world/store'
import { createDistrictTicketStore } from '../src/world/tickets'
import { parseRehearsalArchitectView, parseRehearsalConstructionResponse, parseRehearsalConstructionView } from '../../src/protocol/playRehearsal'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'
import { ADA, BEA, DOC_A, DOC_B, fakePlay, GUILD_A, GUILD_B, INSTALLATION_A, INSTALLATION_B } from './fakePlay'
import { TEST_ORIGIN, testConfig } from './testConfig'

/**
 * LOCAL TEST CONSTRUCTION over the rehearsal routes (P1-C2-E3A, file version 4): `GET /v1/play/rehearsal/construction` and
 * `POST /v1/play/rehearsal/constructions`, against the real app, session, world, ticket, property and construction stores.
 * The browser names a property, a role and a press id; never an amount, a tier or a state. The file names who controls an
 * NFT now and which test credits a player has, per Discord server: test data, never verified ownership or a currency.
 */
const KEEPERS = 'eip155:8453/erc721:0x000000000000000000000000000000000000a001'
const keeper = (id: string | number) => `${KEEPERS}/${id}`
const CONSTRUCTION = '/v1/play/rehearsal/construction'
const CONSTRUCTIONS = '/v1/play/rehearsal/constructions'
const ARCHITECT = '/v1/play/rehearsal/architect'
const FILE_V4 = {
  kind: REHEARSAL_FILE_KIND_V4,
  players: { [ADA.discordUserId]: [keeper(1), keeper(2)], [BEA.discordUserId]: [keeper(3)] },
  districtRules: [],
  ruleResults: [],
  controllers: [
    { guild: GUILD_A, asset: keeper(1), discordUserId: ADA.discordUserId },
    // Bea controls keeper #2, though Ada is the one listed to place it: founding is not owning.
    { guild: GUILD_A, asset: keeper(2), discordUserId: BEA.discordUserId },
    { guild: GUILD_B, asset: keeper(1), discordUserId: BEA.discordUserId },
  ],
  testCredits: [
    { id: 'starter', guild: GUILD_A, discordUserId: ADA.discordUserId, units: 120 },
    { id: 'starter', guild: GUILD_A, discordUserId: BEA.discordUserId, units: 50 },
  ],
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

describe.skipIf(NO_TEST_DATABASE)('local test construction routes against a disposable Postgres', () => {
  const t = useTestSchema()

  /** `wrap`: the construction store as the rehearsal is given it (a test that makes one of its calls fail around the real one). */
  async function boot(options: { mode?: AppMode; rehearsal?: boolean; construction?: boolean; fixture?: unknown; wrap?: (store: WorldConstructionStore) => WorldConstructionStore } = {}) {
    await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })
    const p = fakePlay()
    p.install(INSTALLATION_A, GUILD_A)
    p.install(INSTALLATION_B, GUILD_B)
    p.publish(INSTALLATION_A, DOC_A)
    p.publish(INSTALLATION_B, DOC_B)
    const worlds = createWorldStore(t.db, { mode: 'local', log: silentLogger })
    const launch = createPlayLaunchService({ play: p.play, environment: 'dev', gameKey: 'rare-city', worlds })
    const sessions = createPlaySessionService({ store: createPlaySessionStore(t.db), worlds, play: p.play, environment: 'dev', gameKey: 'rare-city', log: silentLogger, installationCacheMs: 0 })
    const fixture = parseRehearsalFile(options.fixture ?? FILE_V4)
    const tickets = createDistrictTicketStore(t.db, { mode: 'local', log: silentLogger, eligibility: rehearsalEligibility(fixture) })
    const rehearsal =
      options.rehearsal === false
        ? null
        : createLocalPropertyRehearsal({
            mode: 'local',
            fixture,
            sessions,
            store: createWorldPropertyStore(t.db, { mode: 'local', log: silentLogger }),
            tickets,
            construction: options.construction === false ? null : (options.wrap ?? ((c) => c))(createWorldConstructionStore(t.db, { mode: 'local', log: silentLogger })),
          })
    const server = createServer(createApp({ config: testConfig({ mode: options.mode ?? 'local', rateLimits: false }), db: t.db, migrationsDir: MIGRATIONS_DIR, log: silentLogger, playLaunch: launch, playSessions: sessions, rehearsal }))
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    let runs = 0
    async function launchAs(installation: string, who = ADA) {
      const res = await fetch(`${base}/v1/play/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: TEST_ORIGIN },
        body: JSON.stringify({ runToken: p.launch(installation, `construction-${++runs}-${randomUUID()}`, { player: who }) }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as PlayCityResponse
      return { cookie: res.headers.get('set-cookie')!.split(';')[0], actor: { sessionRef: body.viewer.session.ref, worldId: body.world.id, discordUserId: body.viewer.player.discordUserId }, body }
    }
    type Browser = Awaited<ReturnType<typeof launchAs>>
    const post = (path: string, b: Pick<Browser, 'cookie'>, body: unknown, headers: Record<string, string | null> = {}) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: Object.fromEntries(Object.entries({ 'content-type': 'application/json', origin: TEST_ORIGIN, cookie: b.cookie, ...headers }).filter((e): e is [string, string] => e[1] !== null)),
        body: JSON.stringify(body),
      })
    const city = async (b: Pick<Browser, 'cookie'>) => (await (await fetch(`${base}/v1/play/city`, { headers: { cookie: b.cookie } })).json()) as PlayCityResponse
    /** Place `asset` for `b` through the real claim routes: entry, then the first free plot of the assigned district. */
    async function place(b: Browser, asset: string) {
      const entered = (await (await post('/v1/play/rehearsal/entry', b, b.actor)).json()) as RehearsalTicketResponse
      const drawn = await city(b)
      const plotId = drawn.world.districts.find((d) => d.key === entered.ticket!.districtKey)!.candidates.plotIds[0]
      const res = await post('/v1/play/rehearsal/activations', b, { ...b.actor, asset, plotId, geometryFingerprint: drawn.world.definition.geometryFingerprint, ticketId: entered.ticket!.id })
      expect([res.status, await res.clone().json()]).toMatchObject([200, {}])
      return ((await res.json()) as { property: { id: string; buildingId: string } }).property
    }
    const view = (b: Pick<Browser, 'cookie'>, propertyId: string | null) => fetch(`${base}${CONSTRUCTION}${propertyId === null ? '' : `?property=${propertyId}`}`, { headers: { cookie: b.cookie } })
    const build = (b: Browser, propertyId: string, role: string, actionId: string = randomUUID(), extra: Record<string, unknown> = {}) => post(CONSTRUCTIONS, b, { ...b.actor, propertyId, role, actionId, ...extra })
    const sequence = async (worldId: string) => Number((await t.db.query<{ sequence: string }>('SELECT c.sequence FROM city c JOIN worlds w ON w.city_id = c.id WHERE w.id = $1', [worldId])).rows[0].sequence)
    return { base, launchAs, post, city, place, view, build, sequence }
  }

  it('a controller builds Tier 0 to Tier 1 over the routes, a patron contributes, every answer is the server\'s and parses strictly; a repeat pays nothing', async () => {
    const { launchAs, place, view, build, city, sequence } = await boot()
    const ada = await launchAs(INSTALLATION_A, ADA)
    const bea = await launchAs(INSTALLATION_A, BEA)
    const p = await place(ada, keeper(1))

    const first = await view(ada, p.id)
    expect(first.status).toBe(200)
    const v0 = parseRehearsalConstructionView(await first.json())!
    expect(v0).toMatchObject({ rehearsal: { kind: 'local-test-assets', verified: false }, resource: 'local-test-credit', control: 'viewer', standing: { kind: 'ready', role: 'owner', units: 50 }, credits: { available: 120, recorded: 0, pending: 120 } })
    expect(v0.recipe).toEqual({ key: 'local-test-tier2-v1', unitsPerAction: 50, tierThresholds: [100, 250], provisional: true })
    // Bea sees the same property read only as to ownership: another player controls it.
    const vb = parseRehearsalConstructionView(await (await view(bea, p.id)).json())!
    expect(vb).toMatchObject({ control: 'other', standing: { kind: 'ready', role: 'patron', units: 50 }, credits: { available: 50 } })

    const action = randomUUID()
    const res = await build(ada, p.id, 'owner', action)
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
    const built = parseRehearsalConstructionResponse(await res.json())!
    expect(built).toMatchObject({ fresh: true, balance: 70, construction: { role: 'owner', units: 50, builtAfter: 50, tierAfter: 0, era: 1 }, view: { property: { tier: 0, built: 50 }, credits: { available: 70, recorded: 70, pending: 0 } } })
    const at = await sequence(ada.actor.worldId)
    const again = parseRehearsalConstructionResponse(await (await build(ada, p.id, 'owner', action)).json())!
    expect(again).toMatchObject({ fresh: false, balance: 70, construction: built.construction })
    expect(await sequence(ada.actor.worldId)).toBe(at)

    // Bea, a patron, takes it to Tier 1; as an owner she is refused.
    expect(await (await build(bea, p.id, 'owner')).json()).toEqual({ error: 'not_current_controller' })
    const patron = parseRehearsalConstructionResponse(await (await build(bea, p.id, 'patron')).json())!
    // Tier 1 is reached; its next goal is Tier 2 (C2-E3B), which Bea's spent credits do not pay a step toward.
    expect(patron).toMatchObject({ fresh: true, balance: 0, construction: { role: 'patron', tierAfter: 1, recipe: 'local-test-tier2-v1' }, view: { property: { tier: 1, built: 100, nextTierAt: 250, maxTier: 2 }, standing: { kind: 'insufficient', role: 'patron', units: 50 } } })
    expect(patron.view!.investment).toEqual({ currentOwner: 50, previousOwners: 0, community: 50, total: 100 })
    expect(patron.view!.viewer).toEqual({ ownerUnits: 0, patronUnits: 50 })
    expect(patron.view!.history.map((h) => [h.role, h.by])).toEqual([
      ['patron', 'viewer'],
      ['owner', 'other'],
    ])
    expect(patron.view!.contributors).toEqual({ owners: 1, patrons: 1 })

    // Every player of the city reads the building at Tier 1 from the stored city.
    for (const b of [ada, bea]) {
      const state = parseWorldCityState((await city(b)).world.state)
      expect(state?.version === 3 && state.development[p.buildingId]).toEqual({ tier: 1, built: 100, sequence: at + 1 })
    }
    // And its owner continues toward Tier 2: progress inside Tier 1.
    const onward = parseRehearsalConstructionResponse(await (await build(ada, p.id, 'owner')).json())!
    expect(onward).toMatchObject({ fresh: true, balance: 20, construction: { builtBefore: 100, builtAfter: 150, tierBefore: 1, tierAfter: 1 }, view: { property: { tier: 1, built: 150, nextTierAt: 250 } } })
  })

  it('founding is not owning, and controlling the NFT elsewhere is not controlling it here', async () => {
    const { launchAs, place, view, build } = await boot()
    const ada = await launchAs(INSTALLATION_A, ADA)
    const bea = await launchAs(INSTALLATION_A, BEA)
    // Ada founds keeper #2; the file names Bea as its controller.
    const p = await place(ada, keeper(2))
    expect(parseRehearsalConstructionView(await (await view(ada, p.id)).json())).toMatchObject({ control: 'other', standing: { role: 'patron' } })
    expect(await (await build(ada, p.id, 'owner')).json()).toEqual({ error: 'not_current_controller' })
    expect(await (await build(bea, p.id, 'patron')).json()).toEqual({ error: 'controller_builds_as_owner' })
    expect((await build(bea, p.id, 'owner')).status).toBe(200)
    // Guild B: Bea controls keeper #1 there, nobody has credits there, and Guild A's control means nothing there.
    const adaB = await launchAs(INSTALLATION_B, ADA)
    const pb = await place(adaB, keeper(1))
    const vb = parseRehearsalConstructionView(await (await view(adaB, pb.id)).json())!
    expect(vb).toMatchObject({ control: 'other', credits: { available: 0 }, standing: { kind: 'insufficient', role: 'patron' } })
    expect(await (await build(adaB, pb.id, 'owner')).json()).toEqual({ error: 'not_current_controller' })
    expect(await (await build(adaB, pb.id, 'patron')).json()).toEqual({ error: 'insufficient_test_credits' })
    // A property of another world is no property of this one, read or built.
    expect(await (await view(adaB, p.id)).json()).toEqual({ error: 'unknown_property' })
    expect(await (await build(adaB, p.id, 'patron')).json()).toEqual({ error: 'unknown_property' })
  })

  it('believes nothing else from the browser: exactly the request keys, a role, a UUID press; no amount, tier or state; the session and Origin rules hold', async () => {
    const { launchAs, place, view, build, post, sequence } = await boot()
    const ada = await launchAs(INSTALLATION_A, ADA)
    const bea = await launchAs(INSTALLATION_A, BEA)
    const p = await place(ada, keeper(1))
    const at = await sequence(ada.actor.worldId)
    for (const extra of [{ units: 100 }, { tier: 1 }, { tierAfter: 1 }, { state: {} }, { cost: 0 }, { ticketId: randomUUID() }, { controller: ADA.discordUserId }])
      expect([extra, await (await build(ada, p.id, 'owner', randomUUID(), extra)).json()]).toEqual([extra, { error: 'invalid_request' }])
    for (const [role, action] of [
      ['admin', randomUUID()],
      ['OWNER', randomUUID()],
      ['owner', 'press-1'],
      ['owner', randomUUID().toUpperCase()],
    ])
      expect(await (await build(ada, p.id, role, action)).json()).toEqual({ error: 'invalid_request' })
    expect(await (await build(ada, 'not-a-property', 'owner')).json()).toEqual({ error: 'invalid_request' })
    const body = { ...ada.actor, propertyId: p.id, role: 'owner', actionId: randomUUID() }
    expect(await (await post(CONSTRUCTIONS, ada, body, { origin: null })).json()).toEqual({ error: 'origin_mismatch' })
    expect((await post(CONSTRUCTIONS, ada, body, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await post(CONSTRUCTIONS, ada, body, { 'content-type': 'text/plain' })).status).toBe(415)
    // Another browser's cookie, this page's actor; no cookie at all.
    expect(await (await post(CONSTRUCTIONS, bea, body)).json()).toEqual({ error: 'play_actor_mismatch' })
    expect((await post(CONSTRUCTIONS, { cookie: '' }, body)).status).toBe(401)
    expect((await view({ cookie: '' }, p.id)).status).toBe(401)
    expect(await (await view(ada, null)).json()).toEqual({ error: 'invalid_request' })
    expect(await (await view(ada, 'x')).json()).toEqual({ error: 'invalid_request' })
    expect(await sequence(ada.actor.worldId)).toBe(at)
  })

  it('a city whose Discord server the file has no construction data for reads and builds nothing; its claim flow is as before', async () => {
    const { launchAs, place, view, build, sequence } = await boot({ fixture: { ...FILE_V4, controllers: FILE_V4.controllers.filter((c) => c.guild !== GUILD_B) } })
    const ada = await launchAs(INSTALLATION_B, ADA)
    const p = await place(ada, keeper(1))
    const at = await sequence(ada.actor.worldId)
    expect([(await view(ada, p.id)).status, await (await view(ada, p.id)).json()]).toEqual([403, { error: 'construction_not_open' }])
    expect(await (await build(ada, p.id, 'patron')).json()).toEqual({ error: 'construction_not_open' })
    expect(await (await build(ada, p.id, 'owner')).json()).toEqual({ error: 'construction_not_open' })
    expect(await sequence(ada.actor.worldId)).toBe(at)
  })

  it('does not exist without the rehearsal, or outside local mode', async () => {
    for (const options of [{ rehearsal: false }, { mode: 'staging' as const }]) {
      const { base, launchAs } = await boot(options)
      const cookie = options.mode ? '' : (await launchAs(INSTALLATION_A)).cookie
      expect((await fetch(`${base}${CONSTRUCTION}?property=${randomUUID()}`, { headers: { cookie } })).status).toBe(404)
      const res = await fetch(`${base}${CONSTRUCTIONS}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: TEST_ORIGIN, cookie }, body: '{}' })
      expect([res.status, await res.json()]).toEqual([405, { error: 'method_not_allowed' }])
    }
  })

  it('a rehearsal built without the construction store holds construction, read and write', async () => {
    const { launchAs, place, view, build } = await boot({ construction: false })
    const ada = await launchAs(INSTALLATION_A)
    const p = await place(ada, keeper(1))
    expect(await (await view(ada, p.id)).json()).toEqual({ error: 'mutations_held' })
    expect(await (await build(ada, p.id, 'owner')).json()).toEqual({ error: 'mutations_held' })
  })

  it('reads its file strictly (v4): one controller per NFT and server, bounded grants, nothing else; earlier versions give no controller and no credit', () => {
    const fixture = parseRehearsalFile(FILE_V4)
    const authority = rehearsalConstructionAuthority(fixture)
    const asset = { chain: 'eip155:8453', standard: 'erc721' as const, contract: '0x000000000000000000000000000000000000a001' as const, tokenId: '1' }
    expect(authority.controllerOf({ guildId: GUILD_A }, asset)).toBe(ADA.discordUserId)
    expect(authority.controllerOf({ guildId: GUILD_B }, asset)).toBe(BEA.discordUserId)
    expect(authority.controllerOf({ guildId: '900000000000000099' }, asset)).toBeNull()
    expect(authority.grantsFor({ guildId: GUILD_A, discordUserId: ADA.discordUserId })).toEqual([{ key: 'starter', units: 120 }])
    expect(authority.grantsFor({ guildId: GUILD_B, discordUserId: ADA.discordUserId })).toEqual([])
    expect([GUILD_A, GUILD_B, '900000000000000099'].map((guildId) => authority.opensIn({ guildId }))).toEqual([true, true, false])
    const v3 = rehearsalConstructionAuthority(parseRehearsalFile({ kind: REHEARSAL_FILE_KIND_V3, players: {}, districtRules: [], ruleResults: [] }))
    expect(v3.controllerOf({ guildId: GUILD_A }, asset)).toBeNull()
    expect(v3.grantsFor({ guildId: GUILD_A, discordUserId: ADA.discordUserId })).toEqual([])
    expect(v3.opensIn({ guildId: GUILD_A })).toBe(false)
    const bad = (patch: Record<string, unknown>) => () => parseRehearsalFile({ ...FILE_V4, ...patch })
    const v3keys = Object.fromEntries(Object.entries(FILE_V4).filter(([k]) => k !== 'controllers' && k !== 'testCredits'))
    expect(() => parseRehearsalFile(v3keys)).toThrow(/exactly/)
    expect(() => parseRehearsalFile({ ...v3keys, controllers: [] })).toThrow(/exactly/)
    expect(bad({ controllers: {} })).toThrow(/controllers is a list/)
    expect(bad({ controllers: [{ guild: GUILD_A, asset: keeper(1), discordUserId: ADA.discordUserId, verified: true }] })).toThrow(/exactly \{ "guild", "asset", "discordUserId" \}/)
    expect(bad({ controllers: [FILE_V4.controllers[0], { ...FILE_V4.controllers[0], discordUserId: BEA.discordUserId }] })).toThrow(/two controllers/)
    expect(bad({ controllers: [{ ...FILE_V4.controllers[0], asset: `${KEEPERS}/01` }] })).toThrow(/canonical/)
    expect(bad({ controllers: [{ ...FILE_V4.controllers[0], guild: 'guild-a' }] })).toThrow(/Discord server id/)
    for (const units of [0, -5, 1001, 1.5, '50']) expect(bad({ testCredits: [{ ...FILE_V4.testCredits[0], units }] }), String(units)).toThrow(/units are a whole number from 1 to 1000/)
    expect(bad({ testCredits: [FILE_V4.testCredits[0], FILE_V4.testCredits[0]] })).toThrow(/listed twice/)
    expect(bad({ testCredits: Array.from({ length: 21 }, (_, i) => ({ ...FILE_V4.testCredits[0], id: `g${i}` })) })).toThrow(/at most 20 test credit grants/)
    expect(bad({ testCredits: [{ ...FILE_V4.testCredits[0], faucet: true }] })).toThrow(/exactly \{ "id", "guild", "discordUserId", "units" \}/)
  })

  it('nothing outside the construction store writes construction, eras or test credits, and only the local rehearsal reaches it', async () => {
    const root = resolve(import.meta.dirname, '../src')
    const files: string[] = []
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) await walk(path)
        else if (entry.name.endsWith('.ts')) files.push(path)
      }
    }
    await walk(root)
    const writers: string[] = []
    const reaching: string[] = []
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      if (/INSERT INTO (world_property_constructions|world_property_control_eras|world_test_credit_entries)/.test(text)) writers.push(file.slice(root.length + 1))
      if (/createWorldConstructionStore|createConstructionService/.test(text) && !file.endsWith(join('world', 'construction.ts'))) reaching.push(file.slice(root.length + 1))
    }
    expect(writers).toEqual([join('world', 'construction.ts')])
    expect(reaching.sort()).toEqual(['main.ts', join('world', 'rehearsal.ts')])
    // main builds it once, inside the block that runs only with the local rehearsal file (refused outside local mode).
    const main = await readFile(join(root, 'main.ts'), 'utf8')
    expect(main.match(/createWorldConstructionStore\(/g)).toHaveLength(1)
    const block = main.slice(main.indexOf('if (config.localRehearsalFile && playSessions && db) {'))
    expect(block.indexOf('createWorldConstructionStore(')).toBeGreaterThan(0)
    expect(block.indexOf('createWorldConstructionStore(')).toBeLessThan(block.indexOf('\n  }\n'))
    // The store holds the local line itself, before anything is read, and again on the database stamp.
    const store = await readFile(join(root, 'world', 'construction.ts'), 'utf8')
    expect(store).toMatch(/if \(mode !== 'local'\) throw new WorldConstructionRefusal\('mutations_held'/)
    expect(store).toMatch(/if \(stamp !== 'local'\) throw new WorldConstructionRefusal\('mutations_held'/)
    // No economy, wallet or chain: the store imports and calls nothing but its database and the engine.
    expect(store).not.toMatch(/fetch\(|from 'viem'|from '\.\.\/ownership|from '\.\.\/play\/client'/)
    expect([...store.matchAll(/^(?:import .*|\}) from '([^']+)'$/gm)].map((m) => m[1]).sort()).toEqual(['../city/store', '../config', '../db/pool', '../db/transaction', '../engine', '../log', '../play/session', './store', 'pg'])
  })
  /*
   * AN ANSWER THAT FAILS AFTER, OR AROUND, THE WRITE (independent audit M1). A construction that was committed is never
   * answered as if nothing was built, and the page asking again with the SAME press id never builds or pays twice; only a
   * new press id is a new construction. The failures are made in the construction store the real routes are given.
   */
  /** The real store, whose read of the property fails once right after it wrote a construction (the route's read after the commit). */
  const viewFailsAfterBuild = (store: WorldConstructionStore): WorldConstructionStore => {
    let armed = false
    return {
      ...store,
      construct: async (...a) => {
        const done = await store.construct(...a)
        armed = done.fresh
        return done
      },
      overview: async (...a) => {
        if (!armed) return store.overview(...a)
        armed = false
        throw new Error('simulated: connection terminated during the read after the commit')
      },
    }
  }
  /** The real store, whose answer is lost once after it wrote and committed the construction (a COMMIT whose reply never came). */
  const answerLostAfterBuild = (store: WorldConstructionStore): WorldConstructionStore => {
    let armed = true
    return {
      ...store,
      construct: async (...a) => {
        const done = await store.construct(...a)
        if (!armed) return done
        armed = false
        throw new Error('simulated: connection lost after COMMIT')
      },
    }
  }
  /** The real store, failing once before it writes anything. */
  const failsBeforeBuild = (store: WorldConstructionStore): WorldConstructionStore => {
    let armed = true
    return {
      ...store,
      construct: async (...a) => {
        if (!armed) return store.construct(...a)
        armed = false
        throw new Error('simulated: connection refused before BEGIN')
      },
    }
  }
  const constructionsOf = async (worldId: string) =>
    (await t.db.query<{ action_id: string; role: string; units: number; tier_after: number }>('SELECT action_id, role, units, tier_after FROM world_property_constructions WHERE world_id = $1 ORDER BY sequence', [worldId])).rows
  const ledgerOf = async (worldId: string) =>
    (
      await t.db.query<{ who: string; kind: string; delta: number; balance_after: number }>(
        'SELECT account_discord_user_id AS who, kind, delta, balance_after FROM world_test_credit_entries WHERE world_id = $1 ORDER BY account_discord_user_id, entry_seq',
        [worldId],
      )
    ).rows
  const eventsOf = async (worldId: string) =>
    (await t.db.query<{ sequence: string; type: string }>('SELECT e.sequence, e.type FROM city_events e JOIN worlds w ON w.city_id = e.city_id WHERE w.id = $1 ORDER BY e.sequence', [worldId])).rows.map((e) => [Number(e.sequence), e.type])
  const grant = (units: number) => ({ who: ADA.discordUserId, kind: 'fixture-grant', delta: units, balance_after: units })
  const debit = (after: number) => ({ who: ADA.discordUserId, kind: 'construction-debit', delta: -50, balance_after: after })

  it('M1: a construction whose view cannot be read again is answered as built, with no view; the same press again, from a new session, pays nothing; a new press is a second construction (120 -> 70, never 20 by accident)', async () => {
    const { launchAs, place, view, build, sequence } = await boot({ wrap: viewFailsAfterBuild })
    const ada = await launchAs(INSTALLATION_A, ADA)
    const p = await place(ada, keeper(1))
    const worldId = ada.actor.worldId
    const placed = await sequence(worldId)

    const action = randomUUID()
    const res = await build(ada, p.id, 'owner', action)
    // Before the fix: 503 play_session_unavailable, and the page took that for "nothing was placed".
    expect(res.status).toBe(200)
    const built = parseRehearsalConstructionResponse(await res.json())!
    expect(built).toMatchObject({ fresh: true, balance: 70, sequence: placed + 1, view: null, construction: { actionId: action, propertyId: p.id, role: 'owner', units: 50, tierBefore: 0, tierAfter: 0 } })
    // The page reads the view itself: what was built is what the server stores.
    expect(parseRehearsalConstructionView(await (await view(ada, p.id)).json())).toMatchObject({ property: { built: 50, tier: 0 }, credits: { available: 70, recorded: 70, pending: 0 } })

    // The same press, again, through a NEW session of the same player (a relaunch from Proofy Play).
    const relaunched = await launchAs(INSTALLATION_A, ADA)
    expect(relaunched.actor.sessionRef).not.toBe(ada.actor.sessionRef)
    const again = parseRehearsalConstructionResponse(await (await build(relaunched, p.id, 'owner', action)).json())!
    expect(again).toMatchObject({ fresh: false, balance: 70, construction: built.construction, view: { property: { built: 50 }, credits: { available: 70 } } })
    expect(await constructionsOf(worldId)).toEqual([{ action_id: action, role: 'owner', units: 50, tier_after: 0 }])
    expect(await ledgerOf(worldId)).toEqual([grant(120), debit(70)])
    expect((await eventsOf(worldId)).slice(-2)).toEqual([
      [placed, 'world.property.activated'],
      [placed + 1, 'world.property.constructed'],
    ])

    // A NEW press is a new, deliberate construction: what the page used to send after that answer (120 -> 70 -> 20).
    const next = parseRehearsalConstructionResponse(await (await build(relaunched, p.id, 'owner')).json())!
    expect(next).toMatchObject({ fresh: true, balance: 20, construction: { tierAfter: 1 } })
    expect(await ledgerOf(worldId)).toEqual([grant(120), debit(70), debit(20)])
    expect((await eventsOf(worldId)).map(([seq]) => seq)).toEqual(Array.from({ length: placed + 2 }, (_, i) => i + 1))
    expect((await verifyCity(t.db)).violations).toEqual([])
  })

  it('M1: a construction committed whose answer was lost is answered as unconfirmed (503, never "nothing was built"); the same press then returns it, once', async () => {
    const { launchAs, place, build } = await boot({ wrap: answerLostAfterBuild })
    const ada = await launchAs(INSTALLATION_A, ADA)
    const p = await place(ada, keeper(1))
    const worldId = ada.actor.worldId
    const action = randomUUID()

    const res = await build(ada, p.id, 'owner', action)
    expect([res.status, res.headers.get('retry-after'), await res.json()]).toEqual([503, '5', { error: 'construction_unconfirmed' }])
    expect(await constructionsOf(worldId)).toHaveLength(1)

    const again = parseRehearsalConstructionResponse(await (await build(ada, p.id, 'owner', action)).json())!
    expect(again).toMatchObject({ fresh: false, balance: 70, construction: { actionId: action, units: 50 } })
    expect(await constructionsOf(worldId)).toEqual([{ action_id: action, role: 'owner', units: 50, tier_after: 0 }])
    expect(await ledgerOf(worldId)).toEqual([grant(120), debit(70)])
    expect((await verifyCity(t.db)).violations).toEqual([])
  })

  it('M1: a failure before anything is written is answered as unconfirmed too, spends nothing, and the same press then builds exactly once', async () => {
    const { launchAs, place, build } = await boot({ wrap: failsBeforeBuild })
    const ada = await launchAs(INSTALLATION_A, ADA)
    const p = await place(ada, keeper(1))
    const worldId = ada.actor.worldId
    const action = randomUUID()

    expect(await (await build(ada, p.id, 'owner', action)).json()).toEqual({ error: 'construction_unconfirmed' })
    expect(await constructionsOf(worldId)).toEqual([])
    expect(await ledgerOf(worldId)).toEqual([])

    const built = parseRehearsalConstructionResponse(await (await build(ada, p.id, 'owner', action)).json())!
    expect(built).toMatchObject({ fresh: true, balance: 70, construction: { actionId: action } })
    expect(await ledgerOf(worldId)).toEqual([grant(120), debit(70)])
  })

  it('M1: the same press id for any other request is action_conflict and builds nothing; it never confirms or replays the other construction', async () => {
    const { launchAs, place, build } = await boot()
    const ada = await launchAs(INSTALLATION_A, ADA)
    const bea = await launchAs(INSTALLATION_A, BEA)
    const p1 = await place(ada, keeper(1))
    const p2 = await place(ada, keeper(2))
    const worldId = ada.actor.worldId
    const action = randomUUID()
    expect((await build(ada, p1.id, 'owner', action)).status).toBe(200)

    // Another property, another role, another player: each refused, and the answer names no construction.
    for (const [who, property, role] of [
      [ada, p2.id, 'patron'],
      [ada, p1.id, 'patron'],
      [bea, p1.id, 'patron'],
    ] as const) {
      const res = await build(who, property, role, action)
      expect([res.status, await res.json()]).toEqual([409, { error: 'action_conflict' }])
    }
    expect(await constructionsOf(worldId)).toEqual([{ action_id: action, role: 'owner', units: 50, tier_after: 0 }])
    expect((await ledgerOf(worldId)).filter((e) => e.kind === 'construction-debit')).toEqual([debit(70)])
  })

  /*
   * TIER 2 AND ARCHITECT ACTIVITY OVER THE ROUTES (P1-C2-E3B). Enough credits for Ada to reach Tier 2 on her own.
   */
  const FILE_TIER2 = { ...FILE_V4, testCredits: [{ ...FILE_V4.testCredits[0], units: 300 }, { ...FILE_V4.testCredits[1], units: 100 }] }
  const architectOf = async (base: string, b: { cookie: string }, query = '') => fetch(`${base}${ARCHITECT}${query}`, { headers: { cookie: b.cookie } })

  it('18, 6. Tier 2 cannot be asked for: no tier, recipe or goal is read from the browser; a Tier 2 press whose answer was lost is the same press, once', async () => {
    const { launchAs, place, build, view, sequence } = await boot({ fixture: FILE_TIER2, wrap: answerLostAfterBuild })
    const ada = await launchAs(INSTALLATION_A, ADA)
    const p = await place(ada, keeper(1))
    const worldId = ada.actor.worldId
    // The first press's answer is lost (the wrapper's one failure): it is checked again with the same id, as the page does.
    const first = randomUUID()
    expect((await build(ada, p.id, 'owner', first)).status).toBe(503)
    expect((await build(ada, p.id, 'owner', first)).status).toBe(200)
    expect((await build(ada, p.id, 'owner')).status).toBe(200)
    const at = await sequence(worldId)
    for (const extra of [{ tier: 2 }, { tierAfter: 2 }, { targetTier: 2 }, { recipe: 'local-test-tier1-v1' }, { recipe: 'local-test-tier2-v1' }, { builtAfter: 250 }, { units: 150 }])
      expect([extra, await (await build(ada, p.id, 'owner', randomUUID(), extra)).json()]).toEqual([extra, { error: 'invalid_request' }])
    expect(await sequence(worldId)).toBe(at)
    expect(parseRehearsalConstructionView(await (await view(ada, p.id)).json())).toMatchObject({ property: { tier: 1, built: 100, nextTierAt: 250 } })
    // Honest presses only, one step each: three to Tier 2.
    const steps = []
    for (let i = 0; i < 3; i++) steps.push(parseRehearsalConstructionResponse(await (await build(ada, p.id, 'owner')).json())!)
    expect(steps.map((r) => [r.construction.builtAfter, r.construction.tierAfter, r.construction.recipe])).toEqual([
      [150, 1, 'local-test-tier2-v1'],
      [200, 1, 'local-test-tier2-v1'],
      [250, 2, 'local-test-tier2-v1'],
    ])
    expect(steps[2].view).toMatchObject({ property: { tier: 2, built: 250, nextTierAt: null }, standing: { kind: 'complete' } })
    const again = parseRehearsalConstructionResponse(await (await build(ada, p.id, 'owner', steps[2].construction.actionId)).json())!
    expect(again).toMatchObject({ fresh: false, balance: steps[2].balance, construction: steps[2].construction })
    expect(await (await build(ada, p.id, 'owner')).json()).toEqual({ error: 'construction_complete' })
    expect(await constructionsOf(worldId)).toHaveLength(5)
    expect((await ledgerOf(worldId)).filter((e) => e.kind === 'construction-debit').map((e) => e.balance_after)).toEqual([250, 200, 150, 100, 50])
    expect((await verifyCity(t.db)).violations).toEqual([])
  })

  it('Architect activity over its route: the cookie\'s player\'s own record only, read only, nothing the browser names believed; held where construction is', async () => {
    const { base, launchAs, place, build, post, sequence } = await boot({ fixture: FILE_TIER2 })
    const ada = await launchAs(INSTALLATION_A, ADA)
    const bea = await launchAs(INSTALLATION_A, BEA)
    const p1 = await place(ada, keeper(1))
    const p2 = await place(ada, keeper(2))
    for (let i = 0; i < 2; i++) expect((await build(ada, p1.id, 'owner')).status).toBe(200)
    expect((await build(bea, p1.id, 'patron')).status).toBe(200)
    // Bea controls keeper #2, which Ada founded: Bea builds there as its owner.
    expect((await build(bea, p2.id, 'owner')).status).toBe(200)
    const at = await sequence(ada.actor.worldId)

    const res = await architectOf(base, ada)
    expect([res.status, res.headers.get('cache-control')]).toEqual([200, expect.stringMatching(/private|no-store/)])
    const mine = parseRehearsalArchitectView(await res.json())!
    expect(mine).toMatchObject({ rehearsal: { kind: 'local-test-assets', verified: false }, resource: 'local-test-credit', recipe: { key: 'local-test-tier2-v1', provisional: true } })
    expect(mine.totals).toEqual({ ownerUnits: 100, currentEraOwnerUnits: 100, earlierEraOwnerUnits: 0, patronUnits: 0, ownerActions: 2, patronActions: 0, tiersCompleted: 1, propertiesDeveloped: 1, propertiesDevelopedAsOwner: 1 })
    expect(mine.properties.map((x) => [x.propertyId, x.founded, x.control, x.yours.ownerUnits])).toEqual([
      [p1.id, true, 'viewer', 100],
      [p2.id, true, 'other', 0],
    ])
    const hers = parseRehearsalArchitectView(await (await architectOf(base, bea)).json())!
    expect(hers.totals).toMatchObject({ ownerUnits: 50, patronUnits: 50, propertiesDeveloped: 2, propertiesDevelopedAsOwner: 1 })
    expect(hers.properties.map((x) => [x.propertyId, x.founded, x.control])).toEqual([
      [p2.id, false, 'viewer'],
      [p1.id, false, 'other'],
    ])
    // Nothing the browser names changes whose record it is: a query naming Bea still reads Ada's.
    expect(parseRehearsalArchitectView(await (await architectOf(base, ada, `?discordUserId=${BEA.discordUserId}&player=${BEA.coreUserId}`)).json())).toEqual(mine)
    // Read only, a GET only, and nothing was written by any of it.
    expect((await post(ARCHITECT, ada, {})).status).toBe(405)
    expect(await sequence(ada.actor.worldId)).toBe(at)
    // No session: 401. Another world's player reads only their own (empty) record there.
    expect((await architectOf(base, { cookie: '' })).status).toBe(401)
    const adaB = await launchAs(INSTALLATION_B, ADA)
    const inB = parseRehearsalArchitectView(await (await architectOf(base, adaB)).json())!
    expect(inB).toMatchObject({ totals: { ownerUnits: 0, patronUnits: 0 }, properties: [], propertyCount: 0, credits: { available: 0 } })
  })

  it('the Architect route does not exist without the rehearsal, or outside local mode', async () => {
    for (const options of [{ rehearsal: false }, { mode: 'staging' as const }]) {
      const { base, launchAs } = await boot(options)
      const cookie = options.mode ? '' : (await launchAs(INSTALLATION_A)).cookie
      expect((await architectOf(base, { cookie })).status).toBe(404)
    }
  })

  it('a rehearsal built without the construction store holds Architect activity too', async () => {
    const { base, launchAs } = await boot({ construction: false })
    expect(await (await architectOf(base, await launchAs(INSTALLATION_A))).json()).toEqual({ error: 'mutations_held' })
  })

  it('a city whose Discord server the file has no construction data for has no Architect activity either', async () => {
    const { base, launchAs } = await boot({ fixture: { ...FILE_V4, controllers: FILE_V4.controllers.filter((c) => c.guild !== GUILD_B) } })
    const res = await architectOf(base, await launchAs(INSTALLATION_B, ADA))
    expect([res.status, await res.json()]).toEqual([403, { error: 'construction_not_open' }])
  })
})
