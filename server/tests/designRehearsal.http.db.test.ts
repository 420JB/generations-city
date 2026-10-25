import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { verifyCity } from '../src/city/verify'
import type { AppMode } from '../src/config'
import { migrate } from '../src/db/migrations'
import type { PlayCityResponse, RehearsalTicketResponse } from '../src/engine'
import { silentLogger } from '../src/log'
import { createPlayLaunchService } from '../src/play/launch'
import { createPlaySessionService, createPlaySessionStore } from '../src/play/session'
import { createWorldConstructionStore } from '../src/world/construction'
import { createWorldDesignStore, type WorldDesignStore } from '../src/world/designs'
import { createWorldPropertyStore } from '../src/world/properties'
import { createLocalPropertyRehearsal, parseRehearsalFile, REHEARSAL_FILE_KIND_V4, rehearsalEligibility } from '../src/world/rehearsal'
import { createWorldStore } from '../src/world/store'
import { createDistrictTicketStore } from '../src/world/tickets'
import { parseRehearsalAppearanceResponse, parseRehearsalDesignResponse, parseRehearsalDesignView } from '../../src/protocol/playRehearsal'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'
import { ADA, BEA, DOC_A, DOC_B, fakePlay, GUILD_A, GUILD_B, INSTALLATION_A, INSTALLATION_B } from './fakePlay'
import { TEST_ORIGIN, testConfig } from './testConfig'

/**
 * ARCHITECT DESIGN over the rehearsal routes (P1-C2-E4A): `GET /v1/play/rehearsal/appearance`, `GET …/design` and
 * `POST …/designs`, against the real app, session, world, ticket, property, construction and design stores. The browser
 * names a property, two catalog identifiers, the revision it chose on and a press id; nothing else is read. The file's
 * controllers are the only ones who may save: test data, never verified ownership.
 */
const KEEPERS = 'eip155:8453/erc721:0x000000000000000000000000000000000000a001'
const keeper = (id: string | number) => `${KEEPERS}/${id}`
const APPEARANCE = '/v1/play/rehearsal/appearance'
const DESIGN = '/v1/play/rehearsal/design'
const DESIGNS = '/v1/play/rehearsal/designs'
const CATALOG = 'architect-design-v1'
const FILE_V4 = {
  kind: REHEARSAL_FILE_KIND_V4,
  players: { [ADA.discordUserId]: [keeper(1), keeper(2)], [BEA.discordUserId]: [keeper(3)] },
  districtRules: [],
  ruleResults: [],
  controllers: [
    { guild: GUILD_A, asset: keeper(1), discordUserId: ADA.discordUserId },
    // Bea controls keeper #2, though Ada is the one listed to place it: founding is not owning.
    { guild: GUILD_A, asset: keeper(2), discordUserId: BEA.discordUserId },
  ],
  testCredits: [{ id: 'starter', guild: GUILD_A, discordUserId: BEA.discordUserId, units: 50 }],
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

describe.skipIf(NO_TEST_DATABASE)('Architect design routes against a disposable Postgres', () => {
  const t = useTestSchema()

  async function boot(options: { mode?: AppMode; rehearsal?: boolean; designs?: boolean; fixture?: unknown; wrap?: (store: WorldDesignStore) => WorldDesignStore } = {}) {
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
            construction: createWorldConstructionStore(t.db, { mode: 'local', log: silentLogger }),
            designs: options.designs === false ? null : (options.wrap ?? ((d) => d))(createWorldDesignStore(t.db, { mode: 'local', log: silentLogger })),
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
        body: JSON.stringify({ runToken: p.launch(installation, `design-${++runs}-${randomUUID()}`, { player: who }) }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as PlayCityResponse
      return { cookie: res.headers.get('set-cookie')!.split(';')[0], actor: { sessionRef: body.viewer.session.ref, worldId: body.world.id, discordUserId: body.viewer.player.discordUserId } }
    }
    type Browser = Awaited<ReturnType<typeof launchAs>>
    const post = (path: string, b: Pick<Browser, 'cookie'>, body: unknown, headers: Record<string, string | null> = {}) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: Object.fromEntries(Object.entries({ 'content-type': 'application/json', origin: TEST_ORIGIN, cookie: b.cookie, ...headers }).filter((e): e is [string, string] => e[1] !== null)),
        body: JSON.stringify(body),
      })
    const city = async (b: Pick<Browser, 'cookie'>) => (await (await fetch(`${base}/v1/play/city`, { headers: { cookie: b.cookie } })).json()) as PlayCityResponse
    async function place(b: Browser, asset: string) {
      const entered = (await (await post('/v1/play/rehearsal/entry', b, b.actor)).json()) as RehearsalTicketResponse
      const drawn = await city(b)
      const plotId = drawn.world.districts.find((d) => d.key === entered.ticket!.districtKey)!.candidates.plotIds[0]
      const res = await post('/v1/play/rehearsal/activations', b, { ...b.actor, asset, plotId, geometryFingerprint: drawn.world.definition.geometryFingerprint, ticketId: entered.ticket!.id })
      expect(res.status).toBe(200)
      return ((await res.json()) as { property: { id: string; buildingId: string } }).property
    }
    const view = (b: Pick<Browser, 'cookie'>, propertyId: string | null) => fetch(`${base}${DESIGN}${propertyId === null ? '' : `?property=${propertyId}`}`, { headers: { cookie: b.cookie } })
    const appearance = (b: Pick<Browser, 'cookie'>) => fetch(`${base}${APPEARANCE}`, { headers: { cookie: b.cookie } })
    const save = (b: Browser, propertyId: string, design: { facade: string; roof: string }, baseRevision: number, actionId: string = randomUUID(), extra: Record<string, unknown> = {}) =>
      post(DESIGNS, b, { ...b.actor, propertyId, actionId, baseRevision, catalog: CATALOG, ...design, ...extra })
    const designsOf = async (worldId: string) => (await t.db.query<{ revision: number; facade: string; roof: string; action_id: string }>('SELECT revision, facade, roof, action_id FROM world_property_designs WHERE world_id = $1 ORDER BY property_id, revision', [worldId])).rows
    return { base, launchAs, post, city, place, view, appearance, save, designsOf }
  }

  it('the controller saves over the routes and every answer parses strictly; the city reads it back; the city itself does not move', async () => {
    const { launchAs, place, view, appearance, save, city, designsOf } = await boot()
    const ada = await launchAs(INSTALLATION_A, ADA)
    const bea = await launchAs(INSTALLATION_A, BEA)
    const p = await place(ada, keeper(1))
    const empty = parseRehearsalAppearanceResponse(await (await appearance(ada)).json())!
    expect(empty).toEqual({ rehearsal: { kind: 'local-test-assets', verified: false }, catalog: { key: CATALOG, facades: ['slate', 'limestone', 'brick', 'copper', 'jade'], roofs: ['flat', 'terrace', 'dome', 'spire'], default: { facade: 'slate', roof: 'flat' } }, designs: [] })
    expect(parseRehearsalDesignView(await (await view(ada, p.id)).json())).toMatchObject({ control: 'viewer', open: true, saved: null, historyCount: 0 })
    expect(parseRehearsalDesignView(await (await view(bea, p.id)).json())).toMatchObject({ control: 'other', saved: null })
    const before = await city(ada)

    const action = randomUUID()
    const res = await save(ada, p.id, { facade: 'jade', roof: 'spire' }, 0, action)
    expect(res.status).toBe(200)
    const saved = parseRehearsalDesignResponse(await res.json())!
    expect(saved).toMatchObject({ fresh: true, design: { propertyId: p.id, buildingId: p.buildingId, revision: 1, actionId: action, catalog: CATALOG, facade: 'jade', roof: 'spire', atCitySequence: before.world.sequence }, view: { saved: { revision: 1, facade: 'jade', roof: 'spire' }, history: [{ by: 'viewer' }] } })
    // Everyone in the city reads it, and nothing in the stored city changed.
    expect(parseRehearsalAppearanceResponse(await (await appearance(bea)).json())!.designs).toEqual([{ propertyId: p.id, buildingId: p.buildingId, revision: 1, catalog: CATALOG, facade: 'jade', roof: 'spire' }])
    const after = await city(ada)
    expect(after.world.sequence).toBe(before.world.sequence)
    expect(after.world.state).toEqual(before.world.state)
    // The same press again: the same design, nothing more.
    expect(parseRehearsalDesignResponse(await (await save(ada, p.id, { facade: 'jade', roof: 'spire' }, 0, action)).json())).toMatchObject({ fresh: false, design: saved.design })
    expect(await designsOf(ada.actor.worldId)).toEqual([{ revision: 1, facade: 'jade', roof: 'spire', action_id: action }])
    expect((await verifyCity(t.db)).violations).toEqual([])
  })

  it('refuses everyone but the current controller, anything but catalog identifiers, and any body but exactly its keys', async () => {
    const { launchAs, place, view, save, post, designsOf } = await boot()
    const ada = await launchAs(INSTALLATION_A, ADA)
    const bea = await launchAs(INSTALLATION_A, BEA)
    const p = await place(ada, keeper(1))
    // Ada founded #2; the file names Bea its controller.
    const q = await place(ada, keeper(2))
    const refused = async (res: Response) => [res.status, await res.json()]
    expect(await refused(await save(ada, q.id, { facade: 'copper', roof: 'dome' }, 0))).toEqual([403, { error: 'not_current_controller' }])
    expect(parseRehearsalDesignView(await (await view(ada, q.id)).json())).toMatchObject({ control: 'other' })
    expect(await refused(await save(bea, p.id, { facade: 'copper', roof: 'dome' }, 0))).toEqual([403, { error: 'not_current_controller' }])
    expect((await save(bea, q.id, { facade: 'copper', roof: 'dome' }, 0)).status).toBe(200)

    // Not identifiers of the catalog, or not identifiers at all.
    expect(await refused(await save(ada, p.id, { facade: 'aurora', roof: 'dome' }, 0))).toEqual([422, { error: 'design_unsupported' }])
    expect(await refused(await save(ada, p.id, { facade: 'copper', roof: 'halo' }, 0))).toEqual([422, { error: 'design_unsupported' }])
    expect(await refused(await save(ada, p.id, { facade: 'copper', roof: 'dome' }, 0, randomUUID(), { catalog: 'architect-design-v2' }))).toEqual([422, { error: 'design_unsupported' }])
    for (const facade of ['<img src=x onerror=alert(1)>', '#ff0000', 'url(https://example.com/a.png)', 'Copper', '', 'a'.repeat(65)])
      expect(await refused(await save(ada, p.id, { facade, roof: 'dome' }, 0)), facade).toEqual([400, { error: 'invalid_request' }])
    for (const extra of [{ color: '#ff0000' }, { svg: '<svg/>' }, { tier: 2 }, { units: 0 }])
      expect(await refused(await save(ada, p.id, { facade: 'copper', roof: 'dome' }, 0, randomUUID(), extra)), JSON.stringify(extra)).toEqual([400, { error: 'invalid_request' }])
    expect(await refused(await post(DESIGNS, ada, { ...ada.actor, propertyId: p.id, actionId: randomUUID(), catalog: CATALOG, facade: 'copper', roof: 'dome' }))).toEqual([400, { error: 'invalid_request' }])
    expect(await refused(await save(ada, p.id, { facade: 'copper', roof: 'dome' }, 0, 'not-a-uuid'))).toEqual([400, { error: 'invalid_request' }])
    expect(await refused(await save(ada, p.id, { facade: 'copper', roof: 'dome' }, -1))).toEqual([400, { error: 'invalid_request' }])
    expect(await refused(await save(ada, randomUUID(), { facade: 'copper', roof: 'dome' }, 0))).toEqual([422, { error: 'unknown_property' }])
    expect(await refused(await save(ada, p.id, { facade: 'slate', roof: 'flat' }, 0))).toEqual([409, { error: 'design_unchanged' }])
    expect((await save(ada, p.id, { facade: 'copper', roof: 'dome' }, 0)).status).toBe(200)
    expect(await refused(await save(ada, p.id, { facade: 'brick', roof: 'dome' }, 0))).toEqual([409, { error: 'design_stale' }])
    expect((await save(ada, p.id, { facade: 'brick', roof: 'dome' }, 1)).status).toBe(200)
    // A save from another page (another player's session named) and one with no Origin are refused before anything is read.
    expect(await refused(await post(DESIGNS, bea, { ...ada.actor, propertyId: p.id, actionId: randomUUID(), baseRevision: 2, catalog: CATALOG, facade: 'jade', roof: 'dome' }))).toEqual([409, { error: 'play_actor_mismatch' }])
    expect(await refused(await save(ada, p.id, { facade: 'jade', roof: 'dome' }, 2, randomUUID(), {}, ).then(async (r) => (await r.json(), post(DESIGNS, ada, { ...ada.actor, propertyId: p.id, actionId: randomUUID(), baseRevision: 3, catalog: CATALOG, facade: 'slate', roof: 'dome' }, { origin: null }))))).toEqual([403, { error: 'origin_mismatch' }])
    const revisionsOf = async (propertyId: string) => (await t.db.query<{ revision: number; facade: string; roof: string }>('SELECT revision, facade, roof FROM world_property_designs WHERE property_id = $1 ORDER BY revision', [propertyId])).rows
    expect(await revisionsOf(p.id)).toEqual([
      { revision: 1, facade: 'copper', roof: 'dome' },
      { revision: 2, facade: 'brick', roof: 'dome' },
      { revision: 3, facade: 'jade', roof: 'dome' },
    ])
    expect(await revisionsOf(q.id)).toEqual([{ revision: 1, facade: 'copper', roof: 'dome' }])
    expect((await designsOf(ada.actor.worldId)).length).toBe(4)
    // Another world reads none of these, and its own properties' ids are not this world's.
    const adaB = await launchAs(INSTALLATION_B, ADA)
    expect(await refused(await view(adaB, p.id))).toEqual([422, { error: 'unknown_property' }])
    expect(await refused(await save(adaB, p.id, { facade: 'jade', roof: 'spire' }, 3))).toEqual([403, { error: 'design_not_open' }])
  })

  it('a save committed whose answer was lost is answered as unconfirmed (503, never "nothing was saved"); the same press then returns it, once, and never as another design', async () => {
    let lose = true
    const answerLost = (store: WorldDesignStore): WorldDesignStore => ({
      ...store,
      async save(actor, input, authority) {
        const done = await store.save(actor, input, authority)
        if (lose) throw new Error('the answer was lost after the commit')
        return done
      },
    })
    const { launchAs, place, save, designsOf } = await boot({ wrap: answerLost })
    const ada = await launchAs(INSTALLATION_A, ADA)
    const p = await place(ada, keeper(1))
    const action = randomUUID()
    const res = await save(ada, p.id, { facade: 'copper', roof: 'terrace' }, 0, action)
    expect([res.status, res.headers.get('retry-after'), await res.json()]).toEqual([503, '5', { error: 'design_unconfirmed' }])
    expect(await designsOf(ada.actor.worldId)).toHaveLength(1)
    // Anything else under that id is refused, whatever was previewed since; the page resends exactly what it sent.
    expect(await (await save(ada, p.id, { facade: 'jade', roof: 'terrace' }, 0, action)).json()).toEqual({ error: 'action_conflict' })
    lose = false
    expect(parseRehearsalDesignResponse(await (await save(ada, p.id, { facade: 'copper', roof: 'terrace' }, 0, action)).json())).toMatchObject({ fresh: false, design: { revision: 1, actionId: action, facade: 'copper', roof: 'terrace' } })
    expect(await designsOf(ada.actor.worldId)).toEqual([{ revision: 1, facade: 'copper', roof: 'terrace', action_id: action }])
  })

  it('a view that cannot be read after the save is answered as saved, with no view; the same press from a new session saves nothing more', async () => {
    let failViews = false
    const viewFails = (store: WorldDesignStore): WorldDesignStore => ({
      ...store,
      async overview(viewer, propertyId, authority) {
        if (failViews) throw new Error('the database answer was lost')
        return store.overview(viewer, propertyId, authority)
      },
    })
    const { launchAs, place, save, view, designsOf } = await boot({ wrap: viewFails })
    const ada = await launchAs(INSTALLATION_A, ADA)
    const p = await place(ada, keeper(1))
    const action = randomUUID()
    failViews = true
    const res = await save(ada, p.id, { facade: 'limestone', roof: 'dome' }, 0, action)
    expect(res.status).toBe(200)
    expect(parseRehearsalDesignResponse(await res.json())).toMatchObject({ fresh: true, view: null, design: { revision: 1, facade: 'limestone', roof: 'dome' } })
    failViews = false
    const relaunched = await launchAs(INSTALLATION_A, ADA)
    expect(parseRehearsalDesignResponse(await (await save(relaunched, p.id, { facade: 'limestone', roof: 'dome' }, 0, action)).json())).toMatchObject({ fresh: false, design: { revision: 1 } })
    expect(parseRehearsalDesignView(await (await view(relaunched, p.id)).json())).toMatchObject({ saved: { revision: 1, facade: 'limestone' } })
    expect(await designsOf(ada.actor.worldId)).toHaveLength(1)
  })

  it('does not exist without the rehearsal, or outside local mode', async () => {
    for (const options of [{ rehearsal: false }, { mode: 'staging' as const }]) {
      const { base, launchAs } = await boot(options)
      const cookie = options.mode ? '' : (await launchAs(INSTALLATION_A)).cookie
      for (const path of [APPEARANCE, `${DESIGN}?property=${randomUUID()}`]) expect((await fetch(`${base}${path}`, { headers: { cookie } })).status).toBe(404)
      const res = await fetch(`${base}${DESIGNS}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: TEST_ORIGIN, cookie }, body: '{}' })
      expect([res.status, await res.json()]).toEqual([405, { error: 'method_not_allowed' }])
    }
  })

  it('a rehearsal built without the design store holds design, read and write', async () => {
    const { launchAs, place, appearance, save } = await boot({ designs: false })
    const ada = await launchAs(INSTALLATION_A, ADA)
    const p = await place(ada, keeper(1))
    expect([(await appearance(ada)).status, await (await appearance(ada)).json()]).toEqual([403, { error: 'mutations_held' }])
    expect(await (await save(ada, p.id, { facade: 'copper', roof: 'dome' }, 0)).json()).toEqual({ error: 'mutations_held' })
  })
})
