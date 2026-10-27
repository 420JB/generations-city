import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { persistedBrandCityState } from '../../src/brand/core/persisted'
import { parsePlayCityConfig } from '../../src/brand/core/playConfig'
import { verifyCity } from '../src/city/verify'
import { migrate } from '../src/db/migrations'
import { createPool } from '../src/db/pool'
import { appearanceOf, assetKey, type NftAsset } from '../src/engine'
import { silentLogger } from '../src/log'
import { PlaySessionError, type OpenedPlaySession } from '../src/play/session'
import { createConstructionService, createWorldConstructionStore, type ConstructionAuthority, type TestCreditGrant } from '../src/world/construction'
import { createDesignService, createWorldDesignStore, WorldDesignRefusal, type DesignStep, type WorldDesignStore } from '../src/world/designs'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'
import { ADA, BEA, GUILD_A, GUILD_B, INSTALLATION_A, INSTALLATION_B } from './fakePlay'
import { keeper, player, ticketWorld } from './ticketHarness'

/**
 * ARCHITECT PROPERTY DESIGN (P1-C2-E4A, migration 0015; saved from catalog v2 since P1-C2-E4B, migration 0016, and from catalog
 * v3 since P1-C2-E4C, migration 0017) against a
 * disposable Postgres, through the real launch path, session service, ticket, property, construction and design stores.
 * Catalog v1 history, legacy replays and the 0016 upgrade are in `propertyDesignDetails.db.test.ts`; catalog v2 history and the
 * 0017 upgrade in `propertyDesignStreet.db.test.ts`.
 *
 *   SAVE        the NFT's current (local fixture) controller saves a catalog facade and roof: one append-only revision,
 *               nothing else in the database changes (no city sequence, event, credit, construction, tier or founder);
 *   WHO         founding, patronage, an earlier control, another world or installation authorize nothing;
 *   CHOICES     only identifiers of the catalog, refused by the service and by the database otherwise;
 *   SAFETY      a repeated or lost save is the same save, an id never saves another design, concurrent saves serialize
 *               (one wins, the rest are stale), a failure part way leaves nothing;
 *   TRANSFER    a design stays with the property when the fixture names another controller, who may then change it;
 *   VERIFY      city:verify counts designs and finds tampered ones; 0015 leaves a populated 0014 database as it was.
 */

function testAuthority() {
  const controllers = new Map<string, string>()
  const grants = new Map<string, TestCreditGrant[]>()
  const closed = new Set<string>()
  const authority: ConstructionAuthority = {
    source: 'local-fixture',
    opensIn: (where) => !closed.has(where.guildId),
    controllerOf: (where, asset) => controllers.get(`${where.guildId}|${assetKey(asset)}`) ?? null,
    grantsFor: (where) => grants.get(`${where.guildId}|${where.discordUserId}`) ?? [],
  }
  return {
    authority,
    control: (guild: string, asset: NftAsset, who: { discordUserId: string } | null) => (who ? controllers.set(`${guild}|${assetKey(asset)}`, who.discordUserId) : controllers.delete(`${guild}|${assetKey(asset)}`)),
    grant: (guild: string, who: { discordUserId: string }, list: TestCreditGrant[]) => grants.set(`${guild}|${who.discordUserId}`, list),
    close: (guild: string) => closed.add(guild),
  }
}

async function refusalOf(work: Promise<unknown>): Promise<string> {
  const err = await work.then(
    () => null,
    (e: unknown) => e,
  )
  if (err instanceof WorldDesignRefusal || err instanceof PlaySessionError) return err.code
  throw err ?? new Error('expected a refusal, got success')
}

const CATALOG = 'architect-design-v4'
/** Whole designs of the current catalog: one with the standard treatments and natural color, one with chosen windows, lighting, entrance, landscaping and color. */
const COPPER_DOME = { facade: 'copper', roof: 'dome', windows: 'grid', lighting: 'standard', entrance: 'standard', landscaping: 'standard', color: 'natural' }
const BRICK_SPIRE = { facade: 'brick', roof: 'spire', windows: 'ribbon', lighting: 'warm', entrance: 'canopy', landscaping: 'garden', color: 'ocean-blue' }
type Choice = { facade: string; roof: string; windows?: string; lighting?: string; entrance?: string; landscaping?: string; color?: string }
/** A design without a treatment choice is saved with the catalog's standard ones (and its material's own color). */
const whole = (d: Choice) => ({ windows: 'grid', lighting: 'standard', entrance: 'standard', landscaping: 'standard', color: 'natural', ...d })
/** The renderer's architecture for a design: its lighting drawn as the window glow it uses. */
const drawnAs = (d: { facade: string; roof: string; windows: string; lighting: string }) => ({ facade: d.facade, roof: d.roof, windows: d.windows, lighting: d.lighting === 'cool' ? 'cool' : 'warm' })
/** Every table a design must leave exactly as it was. */
const UNTOUCHED = ['city', 'city_events', 'worlds', 'world_properties', 'world_property_constructions', 'world_property_control_eras', 'world_test_credit_entries', 'world_geometry_freezes', 'world_district_tickets', 'world_config_adoptions']

describe.skipIf(NO_TEST_DATABASE)('Architect property design (migration 0015) against a disposable Postgres', () => {
  const t = useTestSchema()
  const { setup, one, sequenceOf } = ticketWorld(t)

  async function world(options: { migrated?: boolean; onStep?: (step: DesignStep) => void | Promise<void>; db?: pg.Pool } = {}) {
    const env = await setup({ migrated: options.migrated })
    const source = testAuthority()
    const designs = createWorldDesignStore(options.db ?? t.db, { mode: 'local', log: silentLogger, onStep: options.onStep })
    const designer = createDesignService({ sessions: env.sessions, store: designs, authority: source.authority })
    const construction = createConstructionService({ sessions: env.sessions, store: createWorldConstructionStore(t.db, { mode: 'local', log: silentLogger }), authority: source.authority })
    const place = async (o: OpenedPlaySession, asset: NftAsset) => {
      const ticket = await env.ticketOf(o, [asset])
      const city = await env.sessions.city(await env.sessions.session(o.token))
      const plot = city.world.districts.find((d) => d.key === ticket.districtKey)!.candidates.plotIds[0]
      return (await env.activate(o, ticket, asset, plot)).property
    }
    const save = (o: OpenedPlaySession, propertyId: string, design: Choice, baseRevision: number, actionId: string = randomUUID(), catalog: string = CATALOG) =>
      designer.save(o.token, env.actorOf(o), { propertyId, actionId, baseRevision, catalog, ...whole(design) })
    const build = (o: OpenedPlaySession, propertyId: string, role: 'owner' | 'patron') => construction.construct(o.token, env.actorOf(o), { propertyId, role, actionId: randomUUID() })
    const overview = async (o: OpenedPlaySession, propertyId: string, store: WorldDesignStore = designs) => store.overview(await env.sessions.session(o.token), propertyId, source.authority)
    const cityDesigns = async (o: OpenedPlaySession, store: WorldDesignStore = designs) => store.city(await env.sessions.session(o.token))
    const revisions = (propertyId: string) =>
      t.db
        .query<{ revision: number; facade: string; roof: string; windows: string | null; lighting: string | null; entrance: string | null; landscaping: string | null; designer_discord_user_id: string; at_city_sequence: string; action_id: string }>(
          'SELECT revision, facade, roof, windows, lighting, entrance, landscaping, designer_discord_user_id, at_city_sequence, action_id FROM world_property_designs WHERE property_id = $1 ORDER BY revision',
          [propertyId],
        )
        .then((r) => r.rows)
    /** Every row of every table a design must not touch, exactly. */
    const snapshot = async () => {
      const out: Record<string, string[]> = {}
      for (const table of UNTOUCHED) out[table] = (await t.db.query<{ r: string }>(`SELECT to_jsonb(x)::text AS r FROM ${table} x ORDER BY 1`)).rows.map((r) => r.r)
      return out
    }
    const drawn = async (o: OpenedPlaySession, buildingId: string) => {
      const city = await env.sessions.city(await env.sessions.session(o.token))
      const parsed = parsePlayCityConfig(city.config, o.response.world.id)
      if (!parsed.ok) throw new Error('config')
      const mine = Object.fromEntries((await cityDesigns(o)).map((d) => [d.buildingId, appearanceOf(d)]))
      return persistedBrandCityState(parsed.config, city.world.state, mine).buildings[buildingId].architecture
    }
    const violations = async () => (await verifyCity(t.db)).violations
    return { env, source, designs, place, save, build, overview, cityDesigns, revisions, snapshot, drawn, violations }
  }

  it('8, 20-22. the controller saves a facade, roof, windows, lighting, entrance and landscaping as one revision; nothing else in the database moves: no sequence, event, credit, construction, tier or founder', async () => {
    const w = await world()
    const a = await w.env.open(INSTALLATION_A, ADA)
    const p = await w.place(a, keeper(1))
    const worldId = a.response.world.id
    w.source.control(GUILD_A, keeper(1), ADA)
    w.source.grant(GUILD_A, ADA, [{ key: 'starter', units: 200 }])
    // Tier 1 first, so there is a tier, a ledger, an era and Architect progress that must not move.
    await w.build(a, p.id, 'owner')
    await w.build(a, p.id, 'owner')
    const before = await w.snapshot()
    const sequence = await sequenceOf(worldId)
    const construction = createWorldConstructionStore(t.db, { mode: 'local', log: silentLogger })
    const session = await w.env.sessions.session(a.token)
    const architectBefore = await construction.architect(session, w.source.authority)
    const overviewBefore = await construction.overview(session, p.id, w.source.authority)

    // A never-designed property is drawn with the catalog's default.
    const o0 = await w.overview(a, p.id)
    expect(o0).toMatchObject({ saved: null, control: 'viewer', open: true, history: [], historyCount: 0, property: { propertyId: p.id, buildingId: p.buildingId } })
    expect(o0.catalog).toMatchObject({
      key: CATALOG,
      facades: ['slate', 'limestone', 'brick', 'copper', 'jade'],
      roofs: ['flat', 'terrace', 'dome', 'spire'],
      windows: ['grid', 'arched', 'ribbon', 'lattice'],
      lighting: ['standard', 'warm', 'cool'],
      entrances: ['standard', 'canopy', 'arched', 'portico'],
      landscaping: ['standard', 'garden', 'courtyard'],
      default: { facade: 'slate', roof: 'flat', windows: 'grid', lighting: 'standard', entrance: 'standard', landscaping: 'standard' },
    })
    expect(await w.drawn(a, p.buildingId)).toMatchObject({ facade: 'slate', roof: 'flat', windows: 'grid', lighting: 'warm' })

    const action = randomUUID()
    const saved = await w.save(a, p.id, COPPER_DOME, 0, action)
    expect(saved.fresh).toBe(true)
    expect(saved.design).toEqual(expect.objectContaining({ windows: 'grid', lighting: 'standard', entrance: 'standard', landscaping: 'standard' }))
    expect(saved.design).toMatchObject({ propertyId: p.id, buildingId: p.buildingId, revision: 1, actionId: action, catalog: CATALOG, ...COPPER_DOME, designer: { discordUserId: ADA.discordUserId, coreUserId: ADA.coreUserId }, atCitySequence: sequence })

    // 20-22: every other table exactly as it was, the city at the same sequence, the same credits, tier and Architect record.
    expect(await w.snapshot()).toEqual(before)
    expect(await sequenceOf(worldId)).toBe(sequence)
    expect(await construction.architect(session, w.source.authority)).toEqual(architectBefore)
    expect(await construction.overview(session, p.id, w.source.authority)).toEqual(overviewBefore)

    // Saved, read back and drawn: by everyone in the city, and only the designed building differs.
    const o1 = await w.overview(a, p.id)
    expect(o1).toMatchObject({ saved: { revision: 1, catalog: CATALOG, ...COPPER_DOME, atCitySequence: sequence }, historyCount: 1, history: [{ revision: 1, ...COPPER_DOME, by: 'viewer' }] })

    // 11, 24. A second revision of all six categories at once: one row, and still nothing else moves.
    const detailed = await w.save(a, p.id, { facade: 'jade', roof: 'terrace', windows: 'lattice', lighting: 'cool', entrance: 'portico', landscaping: 'courtyard' }, 1)
    expect(detailed.design).toMatchObject({ revision: 2, catalog: CATALOG, facade: 'jade', roof: 'terrace', windows: 'lattice', lighting: 'cool', entrance: 'portico', landscaping: 'courtyard' })
    expect(await w.drawn(a, p.buildingId)).toMatchObject({ facade: 'jade', roof: 'terrace', windows: 'lattice', lighting: 'cool' })
    expect(await w.snapshot()).toEqual(before)
    expect(await sequenceOf(worldId)).toBe(sequence)
    expect(await construction.architect(session, w.source.authority)).toEqual(architectBefore)
    // Back to revision 1's design, as revision 3: the rest of this test reads a design equal to COPPER_DOME.
    await w.save(a, p.id, COPPER_DOME, 2)
    expect((await w.revisions(p.id)).map((r) => [r.revision, r.facade, r.windows, r.lighting, r.entrance, r.landscaping])).toEqual([
      [1, 'copper', 'grid', 'standard', 'standard', 'standard'],
      [2, 'jade', 'lattice', 'cool', 'portico', 'courtyard'],
      [3, 'copper', 'grid', 'standard', 'standard', 'standard'],
    ])
    expect(await w.cityDesigns(a)).toEqual([{ propertyId: p.id, buildingId: p.buildingId, revision: 3, catalog: CATALOG, ...COPPER_DOME }])
    expect(await w.drawn(a, p.buildingId)).toMatchObject(drawnAs(COPPER_DOME))
    const b = await w.env.open(INSTALLATION_A, BEA)
    expect(await w.overview(b, p.id)).toMatchObject({ saved: { revision: 3, ...COPPER_DOME }, control: 'other', history: [{ by: 'other' }, { by: 'other' }, { by: 'other' }] })
    expect(await w.drawn(b, p.buildingId)).toMatchObject(drawnAs(COPPER_DOME))

    // 9-10 at the store: a new pool and a new store (an application relaunch) read the same.
    const relaunched = createPool(process.env.TEST_DATABASE_URL!, silentLogger, { searchPath: (await one<{ s: string }>('SELECT current_schema() AS s')).s })
    try {
      const store = createWorldDesignStore(relaunched, { mode: 'local', log: silentLogger })
      expect(await w.cityDesigns(a, store)).toEqual([{ propertyId: p.id, buildingId: p.buildingId, revision: 3, catalog: CATALOG, ...COPPER_DOME }])
    } finally {
      await relaunched.end()
    }
    expect(await w.violations()).toEqual([])
    const report = (await verifyCity(t.db)).worlds!.find((x) => x.id === worldId)!
    expect(report).toMatchObject({ designs: 3, designedProperties: 1, constructions: 2 })
  })

  it('11-15. only the current controller saves: founding, patronage, an earlier control, nobody named, another world or player change nothing; a new controller inherits the design and may change it', async () => {
    const w = await world()
    const ada = await w.env.open(INSTALLATION_A, ADA)
    const bea = await w.env.open(INSTALLATION_A, BEA)
    const cy = await w.env.open(INSTALLATION_A, player(3, 'Cy'))
    const p = await w.place(ada, keeper(1))
    w.source.grant(GUILD_A, BEA, [{ key: 'starter', units: 100 }])

    // 13. Ada founded it, and nobody is named its controller: nobody may change it.
    expect(await refusalOf(w.save(ada, p.id, COPPER_DOME, 0))).toBe('control_unverified')
    expect(await w.overview(ada, p.id)).toMatchObject({ control: 'unknown', saved: null })
    // Bea is named; the founder alone still may not.
    w.source.control(GUILD_A, keeper(1), BEA)
    expect(await refusalOf(w.save(ada, p.id, COPPER_DOME, 0))).toBe('not_current_controller')
    // 14. Cy built on it as a patron: still not the controller.
    w.source.grant(GUILD_A, player(3), [{ key: 'starter', units: 50 }])
    await w.build(cy, p.id, 'patron')
    expect(await refusalOf(w.save(cy, p.id, COPPER_DOME, 0))).toBe('not_current_controller')
    expect(await w.revisions(p.id)).toEqual([])

    // The controller saves.
    const first = await w.save(bea, p.id, COPPER_DOME, 0)
    expect(first.design).toMatchObject({ revision: 1, ...COPPER_DOME })
    const founder = await one<{ activator_discord_user_id: string }>('SELECT activator_discord_user_id FROM world_properties WHERE id = $1', [p.id])
    expect(founder.activator_discord_user_id).toBe(ADA.discordUserId)

    // 11-12. The fixture names Ada now (a local stand-in for a transfer): the design stays, Bea can no longer change it, Ada can.
    w.source.control(GUILD_A, keeper(1), ADA)
    expect(await w.overview(ada, p.id)).toMatchObject({ control: 'viewer', saved: { revision: 1, ...COPPER_DOME }, history: [{ revision: 1, by: 'other' }] })
    // Still a Tier 0 foundation (one patron step): its facade is drawn, its saved roof from Tier 1.
    expect(await w.drawn(ada, p.buildingId)).toMatchObject({ facade: 'copper', roof: 'flat' })
    // 16-17. The founder alone, a patron, and a former controller may not change it: not even its windows, lighting, entrance or landscaping.
    expect(await refusalOf(w.save(bea, p.id, { ...COPPER_DOME, lighting: 'cool' }, 1))).toBe('not_current_controller')
    expect(await refusalOf(w.save(cy, p.id, { ...COPPER_DOME, windows: 'arched' }, 1))).toBe('not_current_controller')
    expect(await refusalOf(w.save(bea, p.id, { ...COPPER_DOME, entrance: 'portico' }, 1))).toBe('not_current_controller')
    expect(await refusalOf(w.save(cy, p.id, { ...COPPER_DOME, landscaping: 'garden' }, 1))).toBe('not_current_controller')
    expect(await refusalOf(w.save(bea, p.id, BRICK_SPIRE, 1))).toBe('not_current_controller')
    const second = await w.save(ada, p.id, BRICK_SPIRE, 1)
    expect(second.design).toMatchObject({ revision: 2, ...BRICK_SPIRE, designer: { discordUserId: ADA.discordUserId } })
    // The previous design can be restored by a later save: a new revision, history kept.
    const third = await w.save(ada, p.id, COPPER_DOME, 2)
    expect(third.design).toMatchObject({ revision: 3, ...COPPER_DOME })
    expect((await w.revisions(p.id)).map((r) => [r.revision, r.facade, r.roof, r.windows, r.lighting, r.entrance, r.landscaping, r.designer_discord_user_id])).toEqual([
      [1, 'copper', 'dome', 'grid', 'standard', 'standard', 'standard', BEA.discordUserId],
      [2, 'brick', 'spire', 'ribbon', 'warm', 'canopy', 'garden', ADA.discordUserId],
      [3, 'copper', 'dome', 'grid', 'standard', 'standard', 'standard', ADA.discordUserId],
    ])
    expect((await w.overview(bea, p.id)).history.map((h) => [h.revision, h.by])).toEqual([
      [3, 'other'],
      [2, 'other'],
      [1, 'viewer'],
    ])
    // The founder, the construction's attribution and the patron's record never moved.
    expect((await one<{ activator_discord_user_id: string }>('SELECT activator_discord_user_id FROM world_properties WHERE id = $1', [p.id])).activator_discord_user_id).toBe(ADA.discordUserId)
    expect((await t.db.query('SELECT role, contributor_discord_user_id FROM world_property_constructions WHERE property_id = $1', [p.id])).rows).toEqual([{ role: 'patron', contributor_discord_user_id: player(3).discordUserId }])

    // 15. Another world: the same NFT's property in installation B is another property; A's id is unknown there.
    const adaB = await w.env.open(INSTALLATION_B, ADA)
    w.source.control(GUILD_B, keeper(1), ADA)
    expect(await refusalOf(w.save(adaB, p.id, BRICK_SPIRE, 3))).toBe('unknown_property')
    const pB = await w.place(adaB, keeper(1))
    expect(pB.id).not.toBe(p.id)
    expect(await w.cityDesigns(adaB)).toEqual([])
    await w.save(adaB, pB.id, BRICK_SPIRE, 0)
    expect((await w.cityDesigns(ada)).map((d) => [d.propertyId, d.revision, d.facade])).toEqual([[p.id, 3, 'copper']])
    expect((await w.cityDesigns(adaB)).map((d) => [d.propertyId, d.revision, d.facade])).toEqual([[pB.id, 1, 'brick']])
    // A page naming another session (another player, or a stale tab) is refused before anything is read.
    expect(await refusalOf(w.env.sessions.requireActor(bea.token, w.env.actorOf(ada)).then(() => null))).toBe('play_actor_mismatch')
    await expect(createDesignService({ sessions: w.env.sessions, store: w.designs, authority: w.source.authority }).save(bea.token, w.env.actorOf(ada), { propertyId: p.id, actionId: randomUUID(), baseRevision: 3, catalog: CATALOG, ...BRICK_SPIRE })).rejects.toMatchObject({ code: 'play_actor_mismatch' })
    // A city the fixture has no data for saves nothing; its designs are still read.
    w.source.close(GUILD_A)
    expect(await refusalOf(w.save(ada, p.id, BRICK_SPIRE, 3))).toBe('design_not_open')
    expect(await w.overview(ada, p.id)).toMatchObject({ open: false, saved: { revision: 3 } })
    expect(await w.violations()).toEqual([])
  })

  it('an action id names a save in ONE world: the same id in another world is that world\'s own save, a replay answers only its own world\'s receipt, and nothing crosses (audit L5)', async () => {
    const w = await world()
    const ada = await w.env.open(INSTALLATION_A, ADA)
    const bea = await w.env.open(INSTALLATION_B, BEA)
    const pA = await w.place(ada, keeper(1))
    const pB = await w.place(bea, keeper(1))
    const worldA = ada.response.world.id
    const worldB = bea.response.world.id
    expect(worldA).not.toBe(worldB)
    expect(pA.id).not.toBe(pB.id)
    // A. Each world's own authorized player: Ada controls the keeper in A's Discord server, Bea in B's.
    w.source.control(GUILD_A, keeper(1), ADA)
    w.source.control(GUILD_B, keeper(1), BEA)

    // B, C. The same id, valid in each world on its own: each world records and answers its own revision.
    const action = randomUUID()
    const inA = await w.save(ada, pA.id, COPPER_DOME, 0, action)
    const inB = await w.save(bea, pB.id, BRICK_SPIRE, 0, action)
    expect(inA).toMatchObject({ fresh: true, design: { propertyId: pA.id, revision: 1, actionId: action, ...COPPER_DOME, designer: { discordUserId: ADA.discordUserId } } })
    expect(inB).toMatchObject({ fresh: true, design: { propertyId: pB.id, revision: 1, actionId: action, ...BRICK_SPIRE, designer: { discordUserId: BEA.discordUserId } } })
    const stored = async () =>
      (await t.db.query<{ world_id: string; property_id: string; revision: number; facade: string; designer_discord_user_id: string }>('SELECT world_id, property_id, revision, facade, designer_discord_user_id FROM world_property_designs WHERE action_id = $1 ORDER BY facade', [action])).rows
    expect(await stored()).toEqual([
      { world_id: worldB, property_id: pB.id, revision: 1, facade: 'brick', designer_discord_user_id: BEA.discordUserId },
      { world_id: worldA, property_id: pA.id, revision: 1, facade: 'copper', designer_discord_user_id: ADA.discordUserId },
    ])

    // E. A replay in its own world is that world's receipt, exactly, and writes nothing.
    expect(await w.save(ada, pA.id, COPPER_DOME, 0, action)).toEqual({ ...inA, fresh: false })
    expect(await w.save(bea, pB.id, BRICK_SPIRE, 0, action)).toEqual({ ...inB, fresh: false })
    expect(await stored()).toHaveLength(2)

    // D. Neither world answers the other's receipt or design: Ada in B naming A's property and request finds nothing there,
    // and Ada in B under the same id is judged as B's own save (here: not B's controller), never answered with A's receipt.
    const adaInB = await w.env.open(INSTALLATION_B, ADA)
    expect(await refusalOf(w.save(adaInB, pA.id, COPPER_DOME, 0, action))).toBe('action_conflict')
    expect(await refusalOf(w.save(adaInB, pB.id, BRICK_SPIRE, 0, action))).toBe('action_conflict')
    expect(await refusalOf(w.save(adaInB, pA.id, COPPER_DOME, 0, randomUUID()))).toBe('unknown_property')
    const beaInA = await w.env.open(INSTALLATION_A, BEA)
    expect(await refusalOf(w.save(beaInA, pB.id, BRICK_SPIRE, 0, action))).toBe('action_conflict')
    expect(await refusalOf(w.save(beaInA, pA.id, COPPER_DOME, 0, action))).toBe('action_conflict')
    // A fresh id in the other world, valid there, is that world's next save, never touching the first world.
    const second = randomUUID()
    expect((await w.save(bea, pB.id, COPPER_DOME, 1, second)).design).toMatchObject({ propertyId: pB.id, revision: 2 })
    expect(await refusalOf(w.save(ada, pB.id, COPPER_DOME, 1, second))).toBe('unknown_property')
    expect(await refusalOf(w.save(ada, pA.id, COPPER_DOME, 1, second))).toBe('design_unchanged')

    // F. A page naming another player's session, or another world, is refused before anything is read.
    const forged = (o: OpenedPlaySession, actor: ReturnType<typeof w.env.actorOf>) =>
      createDesignService({ sessions: w.env.sessions, store: w.designs, authority: w.source.authority }).save(o.token, actor, { propertyId: pA.id, actionId: action, baseRevision: 0, catalog: CATALOG, ...COPPER_DOME })
    expect(await refusalOf(forged(ada, { ...w.env.actorOf(ada), worldId: worldB }))).toBe('play_actor_mismatch')
    expect(await refusalOf(forged(ada, w.env.actorOf(bea)))).toBe('play_actor_mismatch')
    expect(await refusalOf(forged(bea, w.env.actorOf(ada)))).toBe('play_actor_mismatch')
    expect(await refusalOf(forged(ada, { ...w.env.actorOf(ada), discordUserId: BEA.discordUserId }))).toBe('play_actor_mismatch')

    // G. Each property's history, and each city's drawing, is its own.
    expect((await w.revisions(pA.id)).map((r) => [r.revision, r.facade, r.roof])).toEqual([[1, 'copper', 'dome']])
    expect((await w.revisions(pB.id)).map((r) => [r.revision, r.facade, r.roof])).toEqual([
      [1, 'brick', 'spire'],
      [2, 'copper', 'dome'],
    ])
    expect((await w.overview(ada, pA.id)).history.map((h) => [h.revision, h.facade, h.by])).toEqual([[1, 'copper', 'viewer']])
    expect((await w.overview(bea, pB.id)).history.map((h) => [h.revision, h.facade, h.by])).toEqual([
      [2, 'copper', 'viewer'],
      [1, 'brick', 'viewer'],
    ])
    expect(await refusalOf(w.overview(bea, pA.id))).toBe('unknown_property')
    expect((await w.cityDesigns(ada)).map((d) => [d.propertyId, d.revision])).toEqual([[pA.id, 1]])
    expect((await w.cityDesigns(bea)).map((d) => [d.propertyId, d.revision])).toEqual([[pB.id, 2]])
    expect(await w.violations()).toEqual([])
  })

  it('16. only catalog identifiers are saved: the service refuses anything else, and so does the database', async () => {
    const w = await world()
    const a = await w.env.open(INSTALLATION_A, ADA)
    const p = await w.place(a, keeper(1))
    w.source.control(GUILD_A, keeper(1), ADA)
    for (const [design, catalog] of [
      [{ facade: 'aurora', roof: 'flat' }, CATALOG],
      [{ facade: 'slate', roof: 'halo' }, CATALOG],
      [{ facade: 'obsidian', roof: 'crown-deck' }, CATALOG],
      [{ facade: '#ff0000', roof: 'flat' }, CATALOG],
      [{ facade: '<script>alert(1)</script>', roof: 'dome' }, CATALOG],
      [{ facade: 'url(https://example.com/x.png)', roof: 'dome' }, CATALOG],
      [{ ...COPPER_DOME, windows: 'panoramic' }, CATALOG],
      [{ ...COPPER_DOME, lighting: 'neon' }, CATALOG],
      [{ ...COPPER_DOME, lighting: 'gold' }, CATALOG],
      [{ ...COPPER_DOME, windows: '#fff' }, CATALOG],
      [{ ...COPPER_DOME, lighting: 'url(x)' }, CATALOG],
      [{ ...COPPER_DOME, entrance: 'awning' }, CATALOG],
      [{ ...COPPER_DOME, entrance: 'grand-portico' }, CATALOG],
      [{ ...COPPER_DOME, landscaping: 'none' }, CATALOG],
      [{ ...COPPER_DOME, landscaping: 'pond' }, CATALOG],
      [{ ...COPPER_DOME, landscaping: 'url(https://example.com/tree.png)' }, CATALOG],
      [{ ...COPPER_DOME, color: 'aurora' }, CATALOG],
      [{ ...COPPER_DOME, color: 'Ocean-Blue' }, CATALOG],
      [{ ...COPPER_DOME, color: '#1c466c' }, CATALOG],
      [COPPER_DOME, 'architect-design-v5'],
      // A v4 design named as v3 (v3 has no color), v2 (no entrance, landscaping or color), or as v1 (no treatment at all).
      [COPPER_DOME, 'architect-design-v3'],
      [COPPER_DOME, 'architect-design-v2'],
      [COPPER_DOME, 'architect-design-v1'],
    ] as const)
      expect(await refusalOf(w.save(a, p.id, design, 0, randomUUID(), catalog)), JSON.stringify([design, catalog])).toBe('design_unsupported')
    // Not strings at all.
    const service = createDesignService({ sessions: w.env.sessions, store: w.designs, authority: w.source.authority })
    for (const bad of [
      { facade: 1, roof: 'dome' },
      { facade: 'copper', roof: { kind: 'dome' } },
      { facade: null, roof: null },
      { facade: 'copper', roof: 'dome' },
      { ...COPPER_DOME, windows: null },
      { ...COPPER_DOME, lighting: 7 },
      { ...COPPER_DOME, windows: ['grid'] },
      { ...COPPER_DOME, entrance: null },
      { ...COPPER_DOME, landscaping: { pieces: [{ x: 0, y: 0 }] } },
      { facade: 'copper', roof: 'dome', windows: 'grid', lighting: 'standard' },
      // An exterior color is a name the catalog lists: never a color value, CSS or markup, and never missing from a v4 design.
      { ...COPPER_DOME, color: '#ff0000' },
      { ...COPPER_DOME, color: 'rgb(255, 0, 0)' },
      { ...COPPER_DOME, color: 'url(https://example.com/x.png)' },
      { ...COPPER_DOME, color: 'teal' },
      { ...COPPER_DOME, color: null },
      { ...COPPER_DOME, color: { name: 'navy' } },
      { facade: 'copper', roof: 'dome', windows: 'grid', lighting: 'standard', entrance: 'standard', landscaping: 'standard' },
    ])
      expect(await refusalOf(service.save(a.token, w.env.actorOf(a), { propertyId: p.id, actionId: randomUUID(), baseRevision: 0, catalog: CATALOG, ...bad }))).toBe('design_unsupported')
    expect(await refusalOf(w.save(a, p.id, COPPER_DOME, -1))).toBe('design_stale')
    expect(await refusalOf(w.save(a, p.id, COPPER_DOME, 1.5))).toBe('design_stale')
    expect(await refusalOf(w.save(a, randomUUID(), COPPER_DOME, 0))).toBe('unknown_property')
    // The default itself, on a property never designed, is already its design.
    expect(await refusalOf(w.save(a, p.id, { facade: 'slate', roof: 'flat' }, 0))).toBe('design_unchanged')
    expect(await w.revisions(p.id)).toEqual([])

    // The database: a direct write of a choice no catalog has, of an unknown catalog, out of order, or changing a revision.
    await w.save(a, p.id, COPPER_DOME, 0)
    const row = await one<Record<string, unknown>>('SELECT * FROM world_property_designs WHERE property_id = $1', [p.id])
    const session = row.designed_in_play_session
    const insert = (over: Record<string, unknown>) => {
      const r: Record<string, unknown> = { ...row, revision: 2, action_id: randomUUID(), ...over }
      return t.db.query(
        `INSERT INTO world_property_designs (world_id, city_id, city_instance_id, property_id, revision, action_id, catalog, facade, roof, windows, lighting, entrance, landscaping, color, designer_core_user_id, designer_discord_user_id, designed_in_play_session, authority, at_city_sequence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [r.world_id, r.city_id, r.city_instance_id, r.property_id, r.revision, r.action_id, r.catalog, r.facade, r.roof, r.windows, r.lighting, r.entrance, r.landscaping, r.color, r.designer_core_user_id, r.designer_discord_user_id, r.designed_in_play_session, r.authority, r.at_city_sequence],
      )
    }
    const KNOWN = /a facade, roof, windows, lighting, entrance, landscaping and color of a catalog this database knows/
    await expect(insert({ facade: 'aurora' })).rejects.toThrow(KNOWN)
    await expect(insert({ roof: 'halo' })).rejects.toThrow(KNOWN)
    await expect(insert({ windows: 'panoramic' })).rejects.toThrow(KNOWN)
    await expect(insert({ lighting: 'neon' })).rejects.toThrow(KNOWN)
    await expect(insert({ windows: null, lighting: null })).rejects.toThrow(KNOWN)
    await expect(insert({ entrance: 'awning' })).rejects.toThrow(KNOWN)
    await expect(insert({ landscaping: 'pond' })).rejects.toThrow(KNOWN)
    await expect(insert({ entrance: null, landscaping: null, color: null })).rejects.toThrow(KNOWN)
    await expect(insert({ entrance: null, landscaping: null })).rejects.toThrow(KNOWN)
    // An exterior color is one of the catalog's names: a color the catalog lacks, none at all, or a value that is no name.
    await expect(insert({ color: 'teal' })).rejects.toThrow(KNOWN)
    await expect(insert({ color: null })).rejects.toThrow(KNOWN)
    await expect(insert({ color: '#ff0000' })).rejects.toThrow(KNOWN)
    await expect(insert({ color: 'url(x)' })).rejects.toThrow(KNOWN)
    await expect(insert({ catalog: 'architect-design-v9' })).rejects.toThrow(/chosen from the current catalog, architect-design-v4: architect-design-v9 is read only/)
    // v1, v2 and v3 are read only: not even a choice exactly as 0015, 0016 or 0017 recorded them.
    await expect(insert({ catalog: 'architect-design-v1', windows: null, lighting: null, entrance: null, landscaping: null, color: null })).rejects.toThrow(/architect-design-v1 is read only/)
    await expect(insert({ catalog: 'architect-design-v2', entrance: null, landscaping: null, color: null })).rejects.toThrow(/architect-design-v2 is read only/)
    await expect(insert({ catalog: 'architect-design-v3', color: null })).rejects.toThrow(/architect-design-v3 is read only/)
    await expect(insert({ facade: '<b>' })).rejects.toThrow(KNOWN)
    await expect(insert({ revision: 3 })).rejects.toThrow(/numbered consecutively/)
    await expect(insert({ revision: 1 })).rejects.toThrow(/numbered consecutively/)
    await expect(insert({ authority: 'proofy-core' })).rejects.toThrow(/wpd_authority_known/)
    await expect(insert({ at_city_sequence: Number(row.at_city_sequence) + 1 })).rejects.toThrow(/the sequence its city is at/)
    await expect(insert({ designer_discord_user_id: BEA.discordUserId })).rejects.toThrow(/designer is the player of the play session/)
    await expect(insert({ designed_in_play_session: randomUUID() })).rejects.toThrow(/live play session of its world/)
    await expect(t.db.query("UPDATE world_property_designs SET facade = 'jade' WHERE property_id = $1", [p.id])).rejects.toThrow(/a saved design is permanent: it cannot be changed/)
    await expect(t.db.query('DELETE FROM world_property_designs WHERE property_id = $1', [p.id])).rejects.toThrow(/a saved design is permanent: it cannot be removed/)
    // Past the guard (replica role), the table's own shape still refuses markup and other authorities.
    for (const [sql, shape] of [
      ["UPDATE world_property_designs SET facade = '<b>x</b>' WHERE property_id = $1", /wpd_choice_shape/],
      ["UPDATE world_property_designs SET windows = 'url(x)' WHERE property_id = $1", /wpd_detail_shape/],
      // (Each with no color, so 0018's color shape, checked first by name, is not what refuses it.)
      ['UPDATE world_property_designs SET lighting = NULL, color = NULL WHERE property_id = $1', /wpd_detail_shape/],
      ["UPDATE world_property_designs SET entrance = 'url(x)' WHERE property_id = $1", /wpd_street_shape/],
      ['UPDATE world_property_designs SET landscaping = NULL, color = NULL WHERE property_id = $1', /wpd_street_shape/],
      // A v3 design is a whole one: an entrance and landscaping never stand without windows and lighting.
      ['UPDATE world_property_designs SET windows = NULL, lighting = NULL, color = NULL WHERE property_id = $1', /wpd_street_shape/],
      // An exterior color is an identifier, never a color value or CSS (0018), and a v4 design is a whole one: a color never
      // stands without the four treatments.
      ["UPDATE world_property_designs SET color = '#ff0000' WHERE property_id = $1", /wpd_color_shape/],
      ["UPDATE world_property_designs SET color = 'url(x)' WHERE property_id = $1", /wpd_color_shape/],
      ["UPDATE world_property_designs SET color = 'Navy' WHERE property_id = $1", /wpd_color_shape/],
      ["UPDATE world_property_designs SET color = 'ocean-blue-ocean-blue-ocean-blue-x' WHERE property_id = $1", /wpd_color_shape/],
      ['UPDATE world_property_designs SET entrance = NULL, landscaping = NULL WHERE property_id = $1', /wpd_color_shape/],
      ['UPDATE world_property_designs SET windows = NULL, lighting = NULL, entrance = NULL, landscaping = NULL WHERE property_id = $1', /wpd_color_shape/],
    ] as const) {
      const replica = await t.db.connect()
      try {
        await replica.query('BEGIN')
        await replica.query(`SET LOCAL session_replication_role = 'replica'`)
        await expect(replica.query(sql, [p.id])).rejects.toThrow(shape)
      } finally {
        await replica.query('ROLLBACK')
        replica.release()
      }
    }
    // A valid next revision, as the guard reads it, is accepted.
    await insert({ facade: 'jade', roof: 'terrace', windows: 'arched', lighting: 'cool', entrance: 'arched', landscaping: 'garden', color: 'lavender' })
    expect((await w.revisions(p.id)).map((r) => r.facade)).toEqual(['copper', 'jade'])
    expect(session).toBeTruthy()
  })

  it('17-19. repeated and lost saves are the same save, an id never saves another design, concurrent saves serialize, a failure part way leaves nothing', async () => {
    let fail: DesignStep | null = null
    const w = await world({
      onStep: (step) => {
        if (step === fail) throw new Error(`injected failure at ${step}`)
      },
    })
    const a = await w.env.open(INSTALLATION_A, ADA)
    const b = await w.env.open(INSTALLATION_A, BEA)
    const p = await w.place(a, keeper(1))
    w.source.control(GUILD_A, keeper(1), ADA)

    // A failure after the row is written but before commit: nothing is saved; the same id then saves exactly once.
    const action = randomUUID()
    fail = 'designed'
    await expect(w.save(a, p.id, COPPER_DOME, 0, action)).rejects.toThrow('injected failure at designed')
    fail = 'checked'
    await expect(w.save(a, p.id, COPPER_DOME, 0, action)).rejects.toThrow('injected failure at checked')
    fail = null
    expect(await w.revisions(p.id)).toEqual([])
    const saved = await w.save(a, p.id, COPPER_DOME, 0, action)
    expect(saved.fresh).toBe(true)

    // 18-19. The answer was lost: the same request again is answered with what it saved, and saves nothing more.
    const again = await w.save(a, p.id, COPPER_DOME, 0, action)
    expect(again).toEqual({ ...saved, fresh: false })
    expect(await w.revisions(p.id)).toHaveLength(1)
    // The id can never save another design, another revision, another property's, or another player's.
    expect(await refusalOf(w.save(a, p.id, BRICK_SPIRE, 0, action))).toBe('action_conflict')
    expect(await refusalOf(w.save(a, p.id, BRICK_SPIRE, 1, action))).toBe('action_conflict')
    expect(await refusalOf(w.save(a, p.id, COPPER_DOME, 1, action))).toBe('action_conflict')
    // Nor the same facade and roof with other windows, lighting, entrance or landscaping: a lost answer never applies a different design.
    expect(await refusalOf(w.save(a, p.id, { ...COPPER_DOME, windows: 'ribbon' }, 0, action))).toBe('action_conflict')
    expect(await refusalOf(w.save(a, p.id, { ...COPPER_DOME, lighting: 'warm' }, 0, action))).toBe('action_conflict')
    expect(await refusalOf(w.save(a, p.id, { ...COPPER_DOME, entrance: 'canopy' }, 0, action))).toBe('action_conflict')
    expect(await refusalOf(w.save(a, p.id, { ...COPPER_DOME, landscaping: 'courtyard' }, 0, action))).toBe('action_conflict')
    w.source.control(GUILD_A, keeper(1), BEA)
    expect(await refusalOf(w.save(b, p.id, COPPER_DOME, 0, action))).toBe('action_conflict')
    w.source.control(GUILD_A, keeper(1), ADA)
    // A stale base, or the design already saved, writes nothing.
    expect(await refusalOf(w.save(a, p.id, BRICK_SPIRE, 0))).toBe('design_stale')
    expect(await refusalOf(w.save(a, p.id, COPPER_DOME, 1))).toBe('design_unchanged')
    expect(await w.revisions(p.id)).toHaveLength(1)

    // 17. Seven different saves on the same revision at once: exactly one is written, the others are stale.
    const choices = [
      BRICK_SPIRE,
      { ...COPPER_DOME, windows: 'arched' },
      { ...COPPER_DOME, lighting: 'cool' },
      { facade: 'slate', roof: 'spire' },
      { facade: 'brick', roof: 'flat', windows: 'lattice', lighting: 'warm' },
      { ...COPPER_DOME, entrance: 'portico' },
      { ...COPPER_DOME, landscaping: 'courtyard' },
    ]
    const settled = await Promise.allSettled(choices.map((c) => w.save(a, p.id, c, 1)))
    const won = settled.filter((s) => s.status === 'fulfilled')
    expect(won).toHaveLength(1)
    expect(settled.filter((s) => s.status === 'rejected').map((s) => ((s as PromiseRejectedResult).reason as WorldDesignRefusal).code)).toEqual(Array(6).fill('design_stale'))
    const revisions = await w.revisions(p.id)
    expect(revisions.map((r) => r.revision)).toEqual([1, 2])
    // The same press sent twice at once: one write, one repeat.
    const twin = randomUUID()
    const pair = await Promise.all([w.save(a, p.id, COPPER_DOME, 2, twin), w.save(a, p.id, COPPER_DOME, 2, twin)])
    expect(pair.map((r) => r.fresh).sort()).toEqual([false, true])
    expect(pair[0].design).toEqual(pair[1].design)
    expect(await w.revisions(p.id)).toHaveLength(3)

    // 19. A session that ended writes nothing.
    await t.db.query('UPDATE play_sessions SET revoked_at = now() WHERE id = (SELECT designed_in_play_session FROM world_property_designs WHERE property_id = $1 AND revision = 1)', [p.id])
    expect(await refusalOf(w.save(a, p.id, BRICK_SPIRE, 3))).toMatch(/play_session_required|session_ended/)
    expect(await w.revisions(p.id)).toHaveLength(3)
    expect(await w.violations()).toEqual([])
  })

  it('designs are held outside a local deployment or database', async () => {
    const w = await world()
    const a = await w.env.open(INSTALLATION_A, ADA)
    const p = await w.place(a, keeper(1))
    w.source.control(GUILD_A, keeper(1), ADA)
    const staging = createDesignService({ sessions: w.env.sessions, store: createWorldDesignStore(t.db, { mode: 'staging', log: silentLogger }), authority: w.source.authority })
    expect(await refusalOf(staging.save(a.token, w.env.actorOf(a), { propertyId: p.id, actionId: randomUUID(), baseRevision: 0, catalog: CATALOG, ...COPPER_DOME }))).toBe('mutations_held')
    await w.save(a, p.id, COPPER_DOME, 0)
    // A database stamped for staging (the stamp is itself guarded once worlds exist, so it is changed past that guard here).
    const stampAs = async (value: string) => {
      const c = await t.db.connect()
      try {
        await c.query('BEGIN')
        await c.query(`SET LOCAL session_replication_role = 'replica'`)
        await c.query("UPDATE app_meta SET value = $1 WHERE key = 'environment'", [value])
        await c.query('COMMIT')
      } finally {
        c.release()
      }
    }
    await stampAs('staging')
    expect(await refusalOf(w.save(a, p.id, BRICK_SPIRE, 1))).toBe('mutations_held')
    // The database holds the same line on its own.
    const row = await one<Record<string, unknown>>('SELECT * FROM world_property_designs WHERE property_id = $1', [p.id])
    await expect(
      t.db.query(
        `INSERT INTO world_property_designs (world_id, city_id, city_instance_id, property_id, revision, action_id, catalog, facade, roof, windows, lighting, entrance, landscaping, designer_core_user_id, designer_discord_user_id, designed_in_play_session, authority, at_city_sequence)
         VALUES ($1, $2, $3, $4, 2, $5, $6, 'brick', 'spire', 'ribbon', 'warm', 'canopy', 'garden', $7, $8, $9, $10, $11)`,
        [row.world_id, row.city_id, row.city_instance_id, row.property_id, randomUUID(), row.catalog, row.designer_core_user_id, row.designer_discord_user_id, row.designed_in_play_session, row.authority, row.at_city_sequence],
      ),
    ).rejects.toThrow(/only a local database may record it/)
    await stampAs('local')
    expect((await w.save(a, p.id, BRICK_SPIRE, 1)).design.revision).toBe(2)
  })

  it('city:verify counts designs and finds tampered ones: an unknown choice or catalog, a revision gap, another world\'s property, a sequence out of order', async () => {
    const w = await world()
    const a = await w.env.open(INSTALLATION_A, ADA)
    const p = await w.place(a, keeper(1))
    const q = await w.place(a, keeper(2))
    w.source.control(GUILD_A, keeper(1), ADA)
    w.source.control(GUILD_A, keeper(2), ADA)
    await w.save(a, p.id, COPPER_DOME, 0)
    await w.save(a, p.id, BRICK_SPIRE, 1)
    await w.save(a, q.id, COPPER_DOME, 0)
    expect(await w.violations()).toEqual([])
    const adaB = await w.env.open(INSTALLATION_B, ADA)
    const other = await w.place(adaB, keeper(9))

    const tamper = async (sql: string, params: unknown[]) => {
      const c = await t.db.connect()
      try {
        await c.query('BEGIN')
        await c.query(`SET LOCAL session_replication_role = 'replica'`)
        await c.query(sql, params)
        await c.query('COMMIT')
      } finally {
        c.release()
      }
    }
    const cases: { label: string; do: [string, unknown[]]; undo: [string, unknown[]]; expect: RegExp }[] = [
      { label: 'a facade no catalog has', do: ["UPDATE world_property_designs SET facade = 'aurora' WHERE property_id = $1 AND revision = 2", [p.id]], undo: ["UPDATE world_property_designs SET facade = 'brick' WHERE property_id = $1 AND revision = 2", [p.id]], expect: /is aurora \/ spire \/ ribbon \/ warm \/ canopy \/ garden \/ ocean-blue, which catalog architect-design-v4 does not offer/ },
      { label: 'an entrance no catalog has', do: ["UPDATE world_property_designs SET entrance = 'awning' WHERE property_id = $1 AND revision = 2", [p.id]], undo: ["UPDATE world_property_designs SET entrance = 'canopy' WHERE property_id = $1 AND revision = 2", [p.id]], expect: /is brick \/ spire \/ ribbon \/ warm \/ awning \/ garden \/ ocean-blue, which catalog architect-design-v4 does not offer/ },
      { label: 'landscaping no catalog has', do: ["UPDATE world_property_designs SET landscaping = 'pond' WHERE property_id = $1 AND revision = 2", [p.id]], undo: ["UPDATE world_property_designs SET landscaping = 'garden' WHERE property_id = $1 AND revision = 2", [p.id]], expect: /\/ canopy \/ pond \/ ocean-blue, which catalog architect-design-v4 does not offer/ },
      { label: 'a color no catalog has', do: ["UPDATE world_property_designs SET color = 'teal' WHERE property_id = $1 AND revision = 2", [p.id]], undo: ["UPDATE world_property_designs SET color = 'ocean-blue' WHERE property_id = $1 AND revision = 2", [p.id]], expect: /\/ garden \/ teal, which catalog architect-design-v4 does not offer/ },
      {
        label: 'a v4 design naming no treatment',
        do: ['UPDATE world_property_designs SET windows = NULL, lighting = NULL, entrance = NULL, landscaping = NULL, color = NULL WHERE property_id = $1 AND revision = 2', [p.id]],
        undo: ["UPDATE world_property_designs SET windows = 'ribbon', lighting = 'warm', entrance = 'canopy', landscaping = 'garden', color = 'ocean-blue' WHERE property_id = $1 AND revision = 2", [p.id]],
        expect: /is brick \/ spire \/ null \/ null \/ null \/ null \/ null, which catalog architect-design-v4 does not offer/,
      },
      { label: 'a v1 design naming a treatment', do: ["UPDATE world_property_designs SET catalog = 'architect-design-v1' WHERE property_id = $1 AND revision = 1", [p.id]], undo: ["UPDATE world_property_designs SET catalog = 'architect-design-v4' WHERE property_id = $1 AND revision = 1", [p.id]], expect: /is copper \/ dome \/ grid \/ standard \/ standard \/ standard \/ natural, which catalog architect-design-v1 does not offer/ },
      { label: 'a v2 design naming an entrance and landscaping', do: ["UPDATE world_property_designs SET catalog = 'architect-design-v2' WHERE property_id = $1 AND revision = 1", [p.id]], undo: ["UPDATE world_property_designs SET catalog = 'architect-design-v4' WHERE property_id = $1 AND revision = 1", [p.id]], expect: /is copper \/ dome \/ grid \/ standard \/ standard \/ standard \/ natural, which catalog architect-design-v2 does not offer/ },
      { label: 'a v3 design naming a color', do: ["UPDATE world_property_designs SET catalog = 'architect-design-v3' WHERE property_id = $1 AND revision = 1", [p.id]], undo: ["UPDATE world_property_designs SET catalog = 'architect-design-v4' WHERE property_id = $1 AND revision = 1", [p.id]], expect: /is copper \/ dome \/ grid \/ standard \/ standard \/ standard \/ natural, which catalog architect-design-v3 does not offer/ },
      {
        label: 'a later revision of an older catalog (v1)',
        do: ["UPDATE world_property_designs SET catalog = 'architect-design-v1', windows = NULL, lighting = NULL, entrance = NULL, landscaping = NULL, color = NULL WHERE property_id = $1 AND revision = 2", [p.id]],
        undo: ["UPDATE world_property_designs SET catalog = 'architect-design-v4', windows = 'ribbon', lighting = 'warm', entrance = 'canopy', landscaping = 'garden', color = 'ocean-blue' WHERE property_id = $1 AND revision = 2", [p.id]],
        expect: /design 2 is of catalog architect-design-v1, older than the revision before it/,
      },
      {
        label: 'a later revision of an older catalog (v2)',
        do: ["UPDATE world_property_designs SET catalog = 'architect-design-v2', entrance = NULL, landscaping = NULL, color = NULL WHERE property_id = $1 AND revision = 2", [p.id]],
        undo: ["UPDATE world_property_designs SET catalog = 'architect-design-v4', entrance = 'canopy', landscaping = 'garden', color = 'ocean-blue' WHERE property_id = $1 AND revision = 2", [p.id]],
        expect: /design 2 is of catalog architect-design-v2, older than the revision before it/,
      },
      {
        label: 'a later revision of an older catalog (v3)',
        do: ["UPDATE world_property_designs SET catalog = 'architect-design-v3', color = NULL WHERE property_id = $1 AND revision = 2", [p.id]],
        undo: ["UPDATE world_property_designs SET catalog = 'architect-design-v4', color = 'ocean-blue' WHERE property_id = $1 AND revision = 2", [p.id]],
        expect: /design 2 is of catalog architect-design-v3, older than the revision before it/,
      },
      { label: 'an unknown catalog', do: ["UPDATE world_property_designs SET catalog = 'architect-design-v9' WHERE property_id = $1 AND revision = 1", [q.id]], undo: ["UPDATE world_property_designs SET catalog = 'architect-design-v4' WHERE property_id = $1 AND revision = 1", [q.id]], expect: /names catalog architect-design-v9, which this build does not have/ },
      { label: 'a revision gap', do: ['UPDATE world_property_designs SET revision = 3 WHERE property_id = $1 AND revision = 2', [p.id]], undo: ['UPDATE world_property_designs SET revision = 2 WHERE property_id = $1 AND revision = 3', [p.id]], expect: /designs are not numbered 1, 2, 3/ },
      { label: 'saved before its property existed', do: ['UPDATE world_property_designs SET at_city_sequence = 2 WHERE property_id = $1', [q.id]], undo: ['UPDATE world_property_designs SET at_city_sequence = (SELECT c.sequence FROM city c JOIN worlds w ON w.city_id = c.id WHERE w.id = world_property_designs.world_id) WHERE property_id = $1', [q.id]], expect: /outside its property's life in the city/ },
      { label: 'saved after its city\'s sequence', do: ['UPDATE world_property_designs SET at_city_sequence = 999 WHERE property_id = $1 AND revision = 2', [p.id]], undo: ['UPDATE world_property_designs SET at_city_sequence = 3 WHERE property_id = $1 AND revision = 2', [p.id]], expect: /saved at city sequence 999, outside its property's life/ },
      { label: 'a revision saved before the one before it', do: ['UPDATE world_property_designs SET at_city_sequence = 2 WHERE property_id = $1 AND revision = 2', [p.id]], undo: ['UPDATE world_property_designs SET at_city_sequence = 3 WHERE property_id = $1 AND revision = 2', [p.id]], expect: /before the revision before it/ },
      { label: 'another world\'s property', do: ['UPDATE world_property_designs SET property_id = $2 WHERE property_id = $1', [q.id, other.id]], undo: ['UPDATE world_property_designs SET property_id = $1 WHERE property_id = $2', [q.id, other.id]], expect: /is not a property of this world/ },
    ]
    for (const c of cases) {
      await tamper(...c.do)
      const found = (await w.violations()).map((v) => `${v.rule}: ${v.detail}`)
      expect(found.some((v) => c.expect.test(v)), `${c.label}: ${JSON.stringify(found)}`).toBe(true)
      await tamper(...c.undo)
      expect(await w.violations(), `${c.label} undone`).toEqual([])
    }
  })

  it('0015 is additive and forward only: on a populated 0014 database it changes no row, rolls back whole when it cannot finish, and cannot be edited once applied', async () => {
    const dir = await t.migrationsPlus([])
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql'))
    const upTo14 = await mkdtemp(join(tmpdir(), 'rc-0014-'))
    for (const f of files.filter((f) => Number(f.slice(0, 4)) <= 14)) await copyFile(join(dir, f), join(upTo14, f))
    await migrate(t.db, { dir: upTo14, environment: 'local' })
    // A database as E3B left it: properties, constructions, eras, ledger, tickets.
    const env = await setup({ migrated: true })
    const source = testAuthority()
    const builder = createConstructionService({ sessions: env.sessions, store: createWorldConstructionStore(t.db, { mode: 'local', log: silentLogger }), authority: source.authority })
    const a = await env.open(INSTALLATION_A, ADA)
    const ticket = await env.ticketOf(a, [keeper(1)])
    const city = await env.sessions.city(await env.sessions.session(a.token))
    const property = (await env.activate(a, ticket, keeper(1), city.world.districts.find((d) => d.key === ticket.districtKey)!.candidates.plotIds[0])).property
    source.control(GUILD_A, keeper(1), ADA)
    source.grant(GUILD_A, ADA, [{ key: 'starter', units: 300 }])
    for (let i = 0; i < 5; i++) await builder.construct(a.token, env.actorOf(a), { propertyId: property.id, role: 'owner', actionId: randomUUID() })
    const tables = async () => (await t.db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> 'schema_migrations' ORDER BY 1")).rows.map((r) => r.tablename)
    const dump = async (names: string[]) => {
      const out: Record<string, string[]> = {}
      for (const n of names) out[n] = (await t.db.query<{ r: string }>(`SELECT to_jsonb(x)::text AS r FROM ${n} x ORDER BY 1`)).rows.map((r) => r.r)
      return out
    }
    const names = await tables()
    const before = await dump(names)

    // Someone holds world_properties: 0015 cannot take its foreign-key lock in time, and leaves nothing behind.
    const holder = await t.db.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE world_properties IN ACCESS EXCLUSIVE MODE')
      const name = files.find((f) => f.startsWith('0015'))!
      const short = await mkdtemp(join(tmpdir(), 'rc-0015-'))
      for (const f of files.filter((f) => Number(f.slice(0, 4)) <= 14)) await copyFile(join(dir, f), join(short, f))
      await writeFile(join(short, name), (await readFile(join(dir, name), 'utf8')).replace("SET LOCAL lock_timeout = '10s';", "SET LOCAL lock_timeout = '200ms';"))
      await expect(migrate(t.db, { dir: short, environment: 'local' })).rejects.toThrow(/Migration 15 \(property_designs\) failed and was rolled back/)
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
    }
    expect(await tables()).toEqual(names)
    expect((await one<{ n: number }>('SELECT max(version)::int AS n FROM schema_migrations')).n).toBe(14)

    expect((await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })).applied).toEqual([15, 16, 17, 18])
    // Exactly one new table, and every row of every other table as it was.
    expect(await tables()).toEqual([...names, 'world_property_designs'].sort())
    expect(await dump(names)).toEqual(before)
    const pinned = (
      await t.db.query<{ proname: string; proconfig: string[] | null }>(
        "SELECT proname, proconfig FROM pg_proc WHERE proname IN ('world_design_choice_known', 'world_design_details_known', 'world_design_known', 'world_property_designs_guard') AND pronamespace = current_schema()::regnamespace ORDER BY proname",
      )
    ).rows
    expect(pinned.map((r) => [r.proname, r.proconfig?.some((c) => c.startsWith('search_path=') && c.includes('pg_temp'))])).toEqual([
      ['world_design_choice_known', true],
      ['world_design_details_known', true],
      ['world_design_known', true],
      ['world_property_designs_guard', true],
    ])
    // The E3B city still verifies, now with no designs, and its property can be designed.
    expect((await verifyCity(t.db)).violations).toEqual([])
    const designs = createDesignService({ sessions: env.sessions, store: createWorldDesignStore(t.db, { mode: 'local', log: silentLogger }), authority: source.authority })
    const saved = await designs.save(a.token, env.actorOf(a), { propertyId: property.id, actionId: randomUUID(), baseRevision: 0, catalog: CATALOG, ...COPPER_DOME })
    expect(saved.design.revision).toBe(1)
    expect(await dump(names.filter((n) => n !== 'play_sessions'))).toEqual(Object.fromEntries(Object.entries(before).filter(([n]) => n !== 'play_sessions')))

    // Edited after it was applied: refused.
    const edited = await t.migrationsPlus([])
    const name = (await readdir(edited)).find((f) => f.startsWith('0015'))!
    await writeFile(join(edited, name), `${await readFile(join(edited, name), 'utf8')}\n-- edited\n`)
    await expect(migrate(t.db, { dir: edited, environment: 'local' })).rejects.toThrow('Migration 15 (property_designs) was edited after it was applied')
  })
})
