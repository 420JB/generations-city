import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ARCHITECTURE } from '../../src/config/architecture'
import { persistedBrandCityState } from '../../src/brand/core/persisted'
import { parsePlayCityConfig } from '../../src/brand/core/playConfig'
import { verifyCity } from '../src/city/verify'
import { loadMigrations, migrate } from '../src/db/migrations'
import { createPool } from '../src/db/pool'
import { appearanceOf, assetKey, type NftAsset } from '../src/engine'
import { silentLogger } from '../src/log'
import { PlaySessionError, type OpenedPlaySession } from '../src/play/session'
import { createConstructionService, createWorldConstructionStore, type ConstructionAuthority, type TestCreditGrant } from '../src/world/construction'
import { createDesignService, createWorldDesignStore, WorldDesignRefusal } from '../src/world/designs'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'
import { ADA, BEA, GUILD_A, GUILD_B, INSTALLATION_A, INSTALLATION_B } from './fakePlay'
import { keeper, player, ticketWorld } from './ticketHarness'

/**
 * ARCHITECT DESIGN DETAILS (P1-C2-E4B, migration 0016) against a disposable Postgres: a database an E4A build wrote (0015,
 * catalog v1 designs, written here exactly as that build's store wrote them, through 0015's own guard) takes 0016 and keeps
 * every design's meaning.
 *
 *   A  a property never designed                    B  a Tier 0 property with a saved facade only
 *   C  a Tier 1 property with a saved facade and roof  D  a Tier 2 property with two v1 revisions, then a new controller
 *
 * 0016 rewrites no row and rolls back whole when it cannot finish; v1 designs read and draw exactly as before; a v1 save
 * already recorded replays its original receipt, one never recorded is refused (`design_retired`), and the database takes
 * no new v1 row; a save of the current catalog (v2 when E4B shipped; v3, after 0017, since P1-C2-E4C) inherits the
 * retained choices, the new controller may make it and the former one may not; the standard treatments are no redesign;
 * nothing else moves; installations stay apart; a restart and city:verify agree. The 0017 upgrade of v2 designs is in
 * `propertyDesignStreet.db.test.ts`.
 */

function testAuthority() {
  const controllers = new Map<string, string>()
  const grants = new Map<string, TestCreditGrant[]>()
  const authority: ConstructionAuthority = {
    source: 'local-fixture',
    opensIn: () => true,
    controllerOf: (where, asset) => controllers.get(`${where.guildId}|${assetKey(asset)}`) ?? null,
    grantsFor: (where) => grants.get(`${where.guildId}|${where.discordUserId}`) ?? [],
  }
  return {
    authority,
    control: (guild: string, asset: NftAsset, who: { discordUserId: string }) => controllers.set(`${guild}|${assetKey(asset)}`, who.discordUserId),
    grant: (guild: string, who: { discordUserId: string }, list: TestCreditGrant[]) => grants.set(`${guild}|${who.discordUserId}`, list),
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

const V1 = 'architect-design-v1'
const V2 = 'architect-design-v2'
const V3 = 'architect-design-v3'
/** Every table a design must leave exactly as it was. */
const UNTOUCHED = ['city', 'city_events', 'worlds', 'world_properties', 'world_property_constructions', 'world_property_control_eras', 'world_test_credit_entries', 'world_geometry_freezes', 'world_district_tickets', 'world_config_adoptions']

describe.skipIf(NO_TEST_DATABASE)('Architect design details (migration 0016) against a disposable Postgres', () => {
  const t = useTestSchema()
  const { setup, one } = ticketWorld(t)

  it('8. 0016 upgrades a populated 0015 database without changing a design: v1 history is kept, replayed and drawn as before; later saves build on it', async () => {
    // A. A database as E4A left it: everything up to 0015.
    const dir = await t.migrationsPlus([])
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql'))
    const upTo15 = await mkdtemp(join(tmpdir(), 'rc-0015-'))
    for (const f of files.filter((f) => Number(f.slice(0, 4)) <= 15)) await copyFile(join(dir, f), join(upTo15, f))
    expect((await migrate(t.db, { dir: upTo15, environment: 'local' })).current).toBe(15)
    const env = await setup({ migrated: true })
    const source = testAuthority()
    const builder = createConstructionService({ sessions: env.sessions, store: createWorldConstructionStore(t.db, { mode: 'local', log: silentLogger }), authority: source.authority })
    const place = async (o: OpenedPlaySession, asset: NftAsset) => {
      const ticket = await env.ticketOf(o, [asset])
      const city = await env.sessions.city(await env.sessions.session(o.token))
      return (await env.activate(o, ticket, asset, city.world.districts.find((d) => d.key === ticket.districtKey)!.candidates.plotIds[0])).property
    }
    /** A v1 design exactly as the E4A store wrote it (0015's columns, one READ COMMITTED transaction, the city row locked), through 0015's guard. */
    const legacy = async (o: OpenedPlaySession, propertyId: string, facade: string, roof: string, revision: number, actionId = randomUUID()) => {
      const session = await env.sessions.session(o.token)
      const c = await t.db.connect()
      try {
        await c.query('BEGIN')
        const w = await c.query<{ city_id: string; city_instance_id: string; sequence: string }>(
          'SELECT w.city_id, w.city_instance_id, c.sequence FROM worlds w JOIN city c ON c.id = w.city_id AND c.instance_id = w.city_instance_id WHERE w.id = $1 FOR UPDATE OF c',
          [session.scope.worldId],
        )
        const { city_id, city_instance_id, sequence } = w.rows[0]
        await c.query(
          `INSERT INTO world_property_designs (world_id, city_id, city_instance_id, property_id, revision, action_id, catalog, facade, roof, designer_core_user_id, designer_discord_user_id,
                                              designed_in_play_session, authority, at_city_sequence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'local-fixture-controller', $13)`,
          [session.scope.worldId, city_id, city_instance_id, propertyId, revision, actionId, V1, facade, roof, session.player.coreUserId, session.player.discordUserId, session.id, sequence],
        )
        await c.query('COMMIT')
      } catch (err) {
        await c.query('ROLLBACK')
        throw err
      } finally {
        c.release()
      }
      return actionId
    }

    const ada = await env.open(INSTALLATION_A, ADA)
    const pA = await place(ada, keeper(1))
    const pB = await place(ada, keeper(2))
    const pC = await place(ada, keeper(3))
    const pD = await place(ada, keeper(4))
    for (const n of [1, 2, 3, 4]) source.control(GUILD_A, keeper(n), ADA)
    source.grant(GUILD_A, ADA, [{ key: 'starter', units: 400 }])
    for (let i = 0; i < 2; i++) await builder.construct(ada.token, env.actorOf(ada), { propertyId: pC.id, role: 'owner', actionId: randomUUID() })
    for (let i = 0; i < 5; i++) await builder.construct(ada.token, env.actorOf(ada), { propertyId: pD.id, role: 'owner', actionId: randomUUID() })
    const bFacade = await legacy(ada, pB.id, 'brick', 'flat', 1)
    const cDesign = await legacy(ada, pC.id, 'copper', 'dome', 1)
    await legacy(ada, pD.id, 'jade', 'terrace', 1)
    const dSecond = await legacy(ada, pD.id, 'limestone', 'spire', 2)
    // Another installation's city, with a v1 design of its own.
    const beaB = await env.open(INSTALLATION_B, BEA)
    const pOther = await place(beaB, keeper(1))
    source.control(GUILD_B, keeper(1), BEA)
    await legacy(beaB, pOther.id, 'jade', 'dome', 1)
    // F. The fixture names Bea D's controller after its designs were saved (a local stand-in for a transfer).
    source.control(GUILD_A, keeper(4), BEA)

    const tables = async () => (await t.db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> 'schema_migrations' ORDER BY 1")).rows.map((r) => r.tablename)
    const dump = async (names: string[], designsAs = 'x') => {
      const out: Record<string, string[]> = {}
      for (const n of names) out[n] = (await t.db.query<{ r: string }>(`SELECT (${n === 'world_property_designs' ? designsAs : 'to_jsonb(x)'})::text AS r FROM ${n} x ORDER BY 1`)).rows.map((r) => r.r)
      return out
    }
    const names = await tables()
    const before = await dump(names, 'to_jsonb(x)')
    const columns = async () => (await t.db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'world_property_designs' ORDER BY ordinal_position")).rows.map((r) => r.column_name)
    const columns15 = await columns()

    // Someone holds world_property_designs: 0016 cannot take its lock in time, and leaves nothing behind.
    const holder = await t.db.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE world_property_designs IN ACCESS SHARE MODE')
      const name = files.find((f) => f.startsWith('0016'))!
      const short = await mkdtemp(join(tmpdir(), 'rc-0016-'))
      for (const f of files.filter((f) => Number(f.slice(0, 4)) <= 15)) await copyFile(join(dir, f), join(short, f))
      await writeFile(join(short, name), (await readFile(join(dir, name), 'utf8')).replace("SET LOCAL lock_timeout = '10s';", "SET LOCAL lock_timeout = '200ms';"))
      await expect(migrate(t.db, { dir: short, environment: 'local' })).rejects.toThrow(/Migration 16 \(architect_design_details\) failed and was rolled back/)
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
    }
    // A failure part way through (after the columns were added) leaves nothing either.
    const broken = await mkdtemp(join(tmpdir(), 'rc-0016-'))
    for (const f of files.filter((f) => Number(f.slice(0, 4)) <= 15)) await copyFile(join(dir, f), join(broken, f))
    await writeFile(join(broken, files.find((f) => f.startsWith('0016'))!), `${await readFile(join(dir, files.find((f) => f.startsWith('0016'))!), 'utf8')}\nSELECT 1 / 0;\n`)
    await expect(migrate(t.db, { dir: broken, environment: 'local' })).rejects.toThrow(/Migration 16 \(architect_design_details\) failed and was rolled back/)
    expect((await one<{ n: number }>('SELECT max(version)::int AS n FROM schema_migrations')).n).toBe(15)
    expect(await columns()).toEqual(columns15)
    expect(await dump(names, 'to_jsonb(x)')).toEqual(before)
    expect((await t.db.query("SELECT 1 FROM pg_proc WHERE proname = 'world_design_details_known' AND pronamespace = current_schema()::regnamespace")).rows).toEqual([])

    // B. 0016 applies, once, as checked in (and nothing after it yet: this is the database E4B left).
    const upTo16 = await mkdtemp(join(tmpdir(), 'rc-0016-'))
    for (const f of files.filter((f) => Number(f.slice(0, 4)) <= 16)) await copyFile(join(dir, f), join(upTo16, f))
    expect((await migrate(t.db, { dir: upTo16, environment: 'local' })).applied).toEqual([16])
    const shipped = (await loadMigrations(MIGRATIONS_DIR)).find((m) => m.version === 16)!
    expect(await one<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations WHERE version = 16')).toEqual({ name: 'architect_design_details', checksum: shipped.checksum })
    expect(await columns()).toEqual([...columns15, 'windows', 'lighting'])
    expect(await tables()).toEqual(names)
    // Every row of every table as it was; each design row byte for byte, and naming no treatment.
    expect(await dump(names, "to_jsonb(x) - 'windows' - 'lighting'")).toEqual(before)
    expect((await t.db.query('SELECT DISTINCT catalog, windows, lighting FROM world_property_designs')).rows).toEqual([{ catalog: V1, windows: null, lighting: null }])
    const pinned = (await t.db.query<{ proname: string; proconfig: string[] | null }>("SELECT proname, proconfig FROM pg_proc WHERE proname IN ('world_design_details_known', 'world_property_designs_guard') AND pronamespace = current_schema()::regnamespace ORDER BY proname")).rows
    expect(pinned.map((r) => [r.proname, r.proconfig?.some((c) => c.startsWith('search_path=') && c.includes('pg_temp'))])).toEqual([
      ['world_design_details_known', true],
      ['world_property_designs_guard', true],
    ])
    expect((await verifyCity(t.db)).violations).toEqual([])
    // Edited after it was applied: refused.
    const edited = await t.migrationsPlus([])
    const name16 = (await readdir(edited)).find((f) => f.startsWith('0016'))!
    await writeFile(join(edited, name16), `${await readFile(join(edited, name16), 'utf8')}\n-- edited\n`)
    await expect(migrate(t.db, { dir: edited, environment: 'local' })).rejects.toThrow('Migration 16 (architect_design_details) was edited after it was applied')
    // The guard 0016 installed takes no new v1 row (the v1 receipts are answered below, by this build's store).
    await expect(legacy(ada, pC.id, 'brick', 'spire', 2)).rejects.toThrow(/architect-design-v2: architect-design-v1 is read only/)

    // This build's store reads the columns 0017 adds (a deployment migrates before it serves), so the database takes 0017
    // next, and every row is still exactly as E4A wrote it.
    expect((await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })).applied).toEqual([17])
    expect(await dump(names, "to_jsonb(x) - 'windows' - 'lighting' - 'entrance' - 'landscaping'")).toEqual(before)

    // C. Read as v1, exactly, and drawn exactly as E4A drew them: the facade and roof over the default architecture, no floodlights.
    const designs = createWorldDesignStore(t.db, { mode: 'local', log: silentLogger })
    const designer = createDesignService({ sessions: env.sessions, store: designs, authority: source.authority })
    const overview = async (o: OpenedPlaySession, id: string) => designs.overview(await env.sessions.session(o.token), id, source.authority)
    const cityDesigns = async (o: OpenedPlaySession, store = designs) => store.city(await env.sessions.session(o.token))
    expect(await overview(ada, pA.id)).toMatchObject({ saved: null, historyCount: 0 })
    expect(await overview(ada, pB.id)).toMatchObject({ saved: { revision: 1, catalog: V1, facade: 'brick', roof: 'flat', windows: null, lighting: null } })
    expect((await overview(ada, pD.id)).history.map((h) => [h.revision, h.catalog, h.facade, h.roof, h.windows, h.lighting])).toEqual([
      [2, V1, 'limestone', 'spire', null, null],
      [1, V1, 'jade', 'terrace', null, null],
    ])
    const drawn = async (o: OpenedPlaySession) => {
      const city = await env.sessions.city(await env.sessions.session(o.token))
      const parsed = parsePlayCityConfig(city.config, o.response.world.id)
      if (!parsed.ok) throw new Error('config')
      const mine = Object.fromEntries((await cityDesigns(o)).map((d) => [d.buildingId, appearanceOf(d)]))
      return persistedBrandCityState(parsed.config, city.world.state, mine).buildings
    }
    const drawnBefore = await drawn(ada)
    expect(drawnBefore[pA.buildingId].architecture).toEqual(DEFAULT_ARCHITECTURE)
    // Tier 0: the facade now, the roof from Tier 1 (as E4A drew it).
    expect(drawnBefore[pB.buildingId].architecture).toEqual({ ...DEFAULT_ARCHITECTURE, facade: 'brick' })
    expect(drawnBefore[pC.buildingId].architecture).toEqual({ ...DEFAULT_ARCHITECTURE, facade: 'copper', roof: 'dome' })
    expect(drawnBefore[pD.buildingId].architecture).toEqual({ ...DEFAULT_ARCHITECTURE, facade: 'limestone', roof: 'spire' })
    for (const p of [pA, pB, pC, pD]) expect(drawnBefore[p.buildingId]).not.toHaveProperty('floodlights')
    const tiers = await t.db.query<{ id: string; tier: number }>(
      "SELECT p.id, COALESCE((SELECT max(c.tier_after) FROM world_property_constructions c WHERE c.property_id = p.id), 0) AS tier FROM world_properties p WHERE p.id = ANY($1) ORDER BY p.activated_sequence",
      [[pB.id, pC.id, pD.id]],
    )
    expect(tiers.rows.map((r) => r.tier)).toEqual([0, 1, 2])

    // D. The legacy save already recorded replays its original receipt, exactly, and writes nothing.
    const legacySave = (o: OpenedPlaySession, propertyId: string, facade: string, roof: string, baseRevision: number, actionId = randomUUID()) =>
      designer.save(o.token, env.actorOf(o), { propertyId, actionId, baseRevision, catalog: V1, facade, roof })
    const recorded = await one<{ designed_at: Date }>('SELECT designed_at FROM world_property_designs WHERE action_id = $1', [dSecond])
    const replay = await legacySave(ada, pD.id, 'limestone', 'spire', 1, dSecond)
    expect(replay).toEqual({
      fresh: false,
      design: expect.objectContaining({ propertyId: pD.id, revision: 2, actionId: dSecond, catalog: V1, facade: 'limestone', roof: 'spire', windows: null, lighting: null, designedAt: recorded.designed_at.toISOString(), designer: { coreUserId: ADA.coreUserId, discordUserId: ADA.discordUserId } }),
    })
    expect((await legacySave(ada, pB.id, 'brick', 'flat', 0, bFacade)).design).toMatchObject({ revision: 1, catalog: V1 })
    // Under a recorded id, nothing else: another choice, the same as v2, or another player.
    const bea = await env.open(INSTALLATION_A, BEA)
    expect(await refusalOf(legacySave(ada, pC.id, 'jade', 'dome', 0, cDesign))).toBe('action_conflict')
    expect(await refusalOf(designer.save(ada.token, env.actorOf(ada), { propertyId: pC.id, actionId: cDesign, baseRevision: 0, catalog: V2, facade: 'copper', roof: 'dome', windows: 'grid', lighting: 'standard' }))).toBe('action_conflict')
    expect(
      await refusalOf(designer.save(ada.token, env.actorOf(ada), { propertyId: pC.id, actionId: cDesign, baseRevision: 0, catalog: V3, facade: 'copper', roof: 'dome', windows: 'grid', lighting: 'standard', entrance: 'standard', landscaping: 'standard' })),
    ).toBe('action_conflict')
    expect(await refusalOf(legacySave(bea, pD.id, 'limestone', 'spire', 1, dSecond))).toBe('action_conflict')
    // A v1 save that was never recorded is refused, never applied as a later catalog's design; and the database takes no new v1 row.
    expect(await refusalOf(legacySave(ada, pC.id, 'brick', 'spire', 1))).toBe('design_retired')
    await expect(legacy(ada, pC.id, 'brick', 'spire', 2)).rejects.toThrow(/architect-design-v1 is read only/)
    const v1Rows = await dump(['world_property_designs'], 'to_jsonb(x)')

    // E. Saves of the current catalog (v3, since 0017). The standard treatments on a v1 design are that design: no revision,
    // no accidental redesign.
    const snapshot = async () => {
      const out: Record<string, string[]> = {}
      for (const table of UNTOUCHED) out[table] = (await t.db.query<{ r: string }>(`SELECT to_jsonb(x)::text AS r FROM ${table} x ORDER BY 1`)).rows.map((r) => r.r)
      return out
    }
    const untouched = await snapshot()
    const save = (o: OpenedPlaySession, propertyId: string, design: { facade: string; roof: string; windows: string; lighting: string }, baseRevision: number) =>
      designer.save(o.token, env.actorOf(o), { propertyId, actionId: randomUUID(), baseRevision, catalog: V3, ...design, entrance: 'standard', landscaping: 'standard' })
    expect(await refusalOf(save(ada, pC.id, { facade: 'copper', roof: 'dome', windows: 'grid', lighting: 'standard' }, 1))).toBe('design_unchanged')
    expect(await dump(['world_property_designs'], 'to_jsonb(x)')).toEqual(v1Rows)
    const c2 = await save(ada, pC.id, { facade: 'copper', roof: 'dome', windows: 'arched', lighting: 'warm' }, 1)
    expect(c2).toMatchObject({ fresh: true, design: { revision: 2, catalog: V3, facade: 'copper', roof: 'dome', windows: 'arched', lighting: 'warm' } })
    // F. The new controller inherits D's design and may change it; the former controller (and founder), and a patron, may not.
    expect(await overview(bea, pD.id)).toMatchObject({ control: 'viewer', saved: { revision: 2, catalog: V1, facade: 'limestone', roof: 'spire' } })
    expect(await refusalOf(save(ada, pD.id, { facade: 'limestone', roof: 'spire', windows: 'ribbon', lighting: 'cool' }, 2))).toBe('not_current_controller')
    const cy = await env.open(INSTALLATION_A, player(3, 'Cy'))
    expect(await refusalOf(save(cy, pD.id, { facade: 'limestone', roof: 'spire', windows: 'ribbon', lighting: 'cool' }, 2))).toBe('not_current_controller')
    const d3 = await save(bea, pD.id, { facade: 'limestone', roof: 'spire', windows: 'lattice', lighting: 'cool' }, 2)
    expect(d3.design).toMatchObject({ revision: 3, catalog: V3, windows: 'lattice', lighting: 'cool', designer: { discordUserId: BEA.discordUserId } })
    // B's facade-only v1 design, on a Tier 0 foundation: a later catalog adds windows and lighting it keeps until Tier 1.
    expect((await save(ada, pB.id, { facade: 'brick', roof: 'flat', windows: 'ribbon', lighting: 'standard' }, 1)).design).toMatchObject({ revision: 2 })
    // Nothing else moved: no credit, construction, tier, era, founder, ticket, sequence or event.
    expect(await snapshot()).toEqual(untouched)
    // The v1 history is exactly as it was; only new revisions were appended.
    const after = (await dump(['world_property_designs'], 'to_jsonb(x)')).world_property_designs
    expect(after.filter((r) => JSON.parse(r).catalog === V1)).toEqual(v1Rows.world_property_designs)
    expect(after).toHaveLength(v1Rows.world_property_designs.length + 3)
    // A v1 replay still answers after later revisions, and still writes nothing.
    expect((await legacySave(ada, pD.id, 'limestone', 'spire', 1, dSecond)).design).toMatchObject({ revision: 2, catalog: V1 })
    expect((await dump(['world_property_designs'], 'to_jsonb(x)')).world_property_designs).toEqual(after)

    // Drawn: only the redesigned buildings differ, and only in what was chosen.
    const drawnAfter = await drawn(ada)
    expect(drawnAfter[pA.buildingId]).toEqual(drawnBefore[pA.buildingId])
    expect(drawnAfter[pC.buildingId].architecture).toEqual({ ...DEFAULT_ARCHITECTURE, facade: 'copper', roof: 'dome', windows: 'arched', lighting: 'warm' })
    expect(drawnAfter[pC.buildingId].floodlights).toBe('warm')
    expect(drawnAfter[pD.buildingId].architecture).toEqual({ ...DEFAULT_ARCHITECTURE, facade: 'limestone', roof: 'spire', windows: 'lattice', lighting: 'cool' })
    expect(drawnAfter[pD.buildingId].floodlights).toBe('cool')
    expect(drawnAfter[pB.buildingId].architecture).toEqual({ ...DEFAULT_ARCHITECTURE, facade: 'brick', windows: 'ribbon' })
    for (const p of [pA, pB, pC, pD]) expect(drawnAfter[p.buildingId].ownerBuilt).toBe(drawnBefore[p.buildingId].ownerBuilt)

    // Installations stay apart: B's city reads only its own v1 design.
    expect((await cityDesigns(beaB)).map((d) => [d.propertyId, d.revision, d.catalog])).toEqual([[pOther.id, 1, V1]])
    expect(await refusalOf(save(beaB, pD.id, { facade: 'jade', roof: 'dome', windows: 'grid', lighting: 'cool' }, 3))).toBe('unknown_property')

    // A restart: a new pool and store read the same, and the city verifies.
    const schema = (await one<{ s: string }>('SELECT current_schema() AS s')).s
    const relaunched = createPool(process.env.TEST_DATABASE_URL!, silentLogger, { searchPath: schema })
    try {
      expect(await cityDesigns(ada, createWorldDesignStore(relaunched, { mode: 'local', log: silentLogger }))).toEqual(await cityDesigns(ada))
    } finally {
      await relaunched.end()
    }
    const verified = await verifyCity(t.db)
    expect(verified.violations).toEqual([])
    expect(verified.worlds!.find((x) => x.id === ada.response.world.id)).toMatchObject({ designs: 7, designedProperties: 3 })
  })
})
