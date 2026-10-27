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
 * ARCHITECT ENTRANCES AND LANDSCAPING (P1-C2-E4C, migration 0017) against a disposable Postgres: a database the E4A and E4B
 * builds wrote (catalog v1 designs saved through 0015's guard, then catalog v2 designs through 0016's, each exactly as that
 * build's store wrote it) takes 0017 and keeps every design's meaning.
 *
 *   A  a property never designed                        B  a Tier 0 property with a v1 design
 *   C  a Tier 1 property with a v2 design                D  a Tier 2 property with a v1 then a v2 revision, then a new controller
 *
 * 0017 rewrites no row (the same tuples, the same storage) and rolls back whole when it cannot finish; v1 and v2 designs read
 * and draw exactly as before; a v2 save already recorded replays its original receipt, one never recorded is refused
 * (`design_retired`), and the database takes no new v2 row; a save of the current catalog (v3 when E4C shipped; v4, after
 * 0018, since P1-E6) inherits the retained choices, the new controller may make it and the founder, a patron and the former
 * controller may not; the standard entrance and grounds are no redesign; nothing else moves; installations stay apart; a
 * restart and city:verify agree. The 0018 upgrade of v3 designs is in `propertyDesignColor.db.test.ts`.
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
const V4 = 'architect-design-v4'
/** Every table a design must leave exactly as it was. */
const UNTOUCHED = ['city', 'city_events', 'worlds', 'world_properties', 'world_property_constructions', 'world_property_control_eras', 'world_test_credit_entries', 'world_geometry_freezes', 'world_district_tickets', 'world_config_adoptions']
type Details = { facade: string; roof: string; windows: string; lighting: string }

describe.skipIf(NO_TEST_DATABASE)('Architect entrances and landscaping (migration 0017) against a disposable Postgres', () => {
  const t = useTestSchema()
  const { setup, one, sequenceOf } = ticketWorld(t)

  /** The migrations up to and including `last`, as a directory `migrate` reads. */
  async function through(last: number) {
    const dir = await t.migrationsPlus([])
    const out = await mkdtemp(join(tmpdir(), `rc-${String(last).padStart(4, '0')}-`))
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) <= last)) await copyFile(join(dir, f), join(out, f))
    return out
  }

  it('27-31. 0017 upgrades a populated 0016 database without changing a design: v1 and v2 history is kept, replayed and drawn as before; later saves build on it', async () => {
    // A. A database as E4A left it (0015), with its v1 designs; then as E4B left it (0016), with its v2 designs.
    expect((await migrate(t.db, { dir: await through(15), environment: 'local' })).current).toBe(15)
    const env = await setup({ migrated: true })
    const source = testAuthority()
    const builder = createConstructionService({ sessions: env.sessions, store: createWorldConstructionStore(t.db, { mode: 'local', log: silentLogger }), authority: source.authority })
    const place = async (o: OpenedPlaySession, asset: NftAsset) => {
      const ticket = await env.ticketOf(o, [asset])
      const city = await env.sessions.city(await env.sessions.session(o.token))
      return (await env.activate(o, ticket, asset, city.world.districts.find((d) => d.key === ticket.districtKey)!.candidates.plotIds[0])).property
    }
    /** A design row exactly as the E4A (v1: facade and roof) or E4B (v2: and windows and lighting) store wrote it, through that build's guard. */
    const written = async (o: OpenedPlaySession, propertyId: string, revision: number, design: { facade: string; roof: string; windows?: string; lighting?: string }, actionId = randomUUID()) => {
      const session = await env.sessions.session(o.token)
      const c = await t.db.connect()
      try {
        await c.query('BEGIN')
        const w = await c.query<{ city_id: string; city_instance_id: string; sequence: string }>(
          'SELECT w.city_id, w.city_instance_id, c.sequence FROM worlds w JOIN city c ON c.id = w.city_id AND c.instance_id = w.city_instance_id WHERE w.id = $1 FOR UPDATE OF c',
          [session.scope.worldId],
        )
        const { city_id, city_instance_id, sequence } = w.rows[0]
        const v2 = design.windows !== undefined
        await c.query(
          `INSERT INTO world_property_designs (world_id, city_id, city_instance_id, property_id, revision, action_id, catalog, facade, roof, ${v2 ? 'windows, lighting, ' : ''}designer_core_user_id, designer_discord_user_id,
                                              designed_in_play_session, authority, at_city_sequence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ${v2 ? '$14, $15, ' : ''}$10, $11, $12, 'local-fixture-controller', $13)`,
          [
            session.scope.worldId,
            city_id,
            city_instance_id,
            propertyId,
            revision,
            actionId,
            v2 ? V2 : V1,
            design.facade,
            design.roof,
            session.player.coreUserId,
            session.player.discordUserId,
            session.id,
            sequence,
            ...(v2 ? [design.windows, design.lighting] : []),
          ],
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
    await written(ada, pB.id, 1, { facade: 'brick', roof: 'flat' })
    await written(ada, pD.id, 1, { facade: 'jade', roof: 'terrace' })
    const beaB = await env.open(INSTALLATION_B, BEA)
    const pOther = await place(beaB, keeper(1))
    source.control(GUILD_B, keeper(1), BEA)

    expect((await migrate(t.db, { dir: await through(16), environment: 'local' })).applied).toEqual([16])
    const C_DESIGN: Details = { facade: 'copper', roof: 'dome', windows: 'arched', lighting: 'warm' }
    const D_DESIGN: Details = { facade: 'limestone', roof: 'spire', windows: 'lattice', lighting: 'cool' }
    const cSaved = await written(ada, pC.id, 1, C_DESIGN)
    const dSecond = await written(ada, pD.id, 2, D_DESIGN)
    await written(beaB, pOther.id, 1, { facade: 'jade', roof: 'dome', windows: 'ribbon', lighting: 'standard' })
    // 0016's guard takes no new v1 row: the history above is exactly E4A's, then E4B's.
    await expect(written(ada, pA.id, 1, { facade: 'brick', roof: 'dome' })).rejects.toThrow(/architect-design-v1 is read only/)
    // F. The fixture names Bea D's controller after its designs were saved (a local stand-in for a transfer); Cy is a patron
    // of C (D stands at the recipe's highest tier, so it takes no more construction).
    source.control(GUILD_A, keeper(4), BEA)
    const cy = await env.open(INSTALLATION_A, player(3, 'Cy'))
    source.grant(GUILD_A, player(3), [{ key: 'starter', units: 50 }])
    await builder.construct(cy.token, env.actorOf(cy), { propertyId: pC.id, role: 'patron', actionId: randomUUID() })

    const tables = async () => (await t.db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> 'schema_migrations' ORDER BY 1")).rows.map((r) => r.tablename)
    const dump = async (names: string[], designsAs = 'to_jsonb(x)') => {
      const out: Record<string, string[]> = {}
      for (const n of names) out[n] = (await t.db.query<{ r: string }>(`SELECT (${n === 'world_property_designs' ? designsAs : 'to_jsonb(x)'})::text AS r FROM ${n} x ORDER BY 1`)).rows.map((r) => r.r)
      return out
    }
    /** Where each design row is stored, and which transaction wrote it: a rewrite would change both. */
    const tuples = async () => (await t.db.query<{ r: string }>('SELECT ctid::text || \' \' || xmin::text AS r FROM world_property_designs ORDER BY 1')).rows.map((r) => r.r)
    const storage = async () => (await one<{ n: string }>("SELECT relfilenode::text AS n FROM pg_class WHERE oid = to_regclass('world_property_designs')")).n
    const columns = async () => (await t.db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'world_property_designs' ORDER BY ordinal_position")).rows.map((r) => r.column_name)
    const names = await tables()
    const before = await dump(names)
    const tuplesBefore = await tuples()
    const storageBefore = await storage()
    const columns16 = await columns()
    expect((await t.db.query('SELECT catalog, count(*)::int AS n FROM world_property_designs GROUP BY 1 ORDER BY 1')).rows).toEqual([
      { catalog: V1, n: 2 },
      { catalog: V2, n: 3 },
    ])

    // B. Someone holds world_property_designs: 0017 cannot take its lock in time, and leaves nothing behind.
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql'))
    const name17 = files.find((f) => f.startsWith('0017'))!
    const holder = await t.db.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE world_property_designs IN ACCESS SHARE MODE')
      const short = await through(16)
      await writeFile(join(short, name17), (await readFile(join(MIGRATIONS_DIR, name17), 'utf8')).replace("SET LOCAL lock_timeout = '10s';", "SET LOCAL lock_timeout = '200ms';"))
      await expect(migrate(t.db, { dir: short, environment: 'local' })).rejects.toThrow(/Migration 17 \(architect_entrances_landscaping\) failed and was rolled back/)
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
    }
    // A failure part way through (after the columns were added and the guard replaced) leaves nothing either.
    const broken = await through(16)
    await writeFile(join(broken, name17), `${await readFile(join(MIGRATIONS_DIR, name17), 'utf8')}\nSELECT 1 / 0;\n`)
    await expect(migrate(t.db, { dir: broken, environment: 'local' })).rejects.toThrow(/Migration 17 \(architect_entrances_landscaping\) failed and was rolled back/)
    expect((await one<{ n: number }>('SELECT max(version)::int AS n FROM schema_migrations')).n).toBe(16)
    expect(await columns()).toEqual(columns16)
    expect(await dump(names)).toEqual(before)
    expect((await t.db.query("SELECT 1 FROM pg_proc WHERE proname = 'world_design_known' AND pronamespace = current_schema()::regnamespace")).rows).toEqual([])
    // 0016's guard is still the one in force (it knows nothing of v3), so nothing of 0017's was left half done.
    expect(await t.db.query("SELECT prosrc LIKE '%architect-design-v3%' AS v3 FROM pg_proc WHERE proname = 'world_property_designs_guard' AND pronamespace = current_schema()::regnamespace").then((r) => r.rows[0])).toEqual({ v3: false })

    // C. 0017 applies, once, as checked in.
    expect((await migrate(t.db, { dir: await through(17), environment: 'local' })).applied).toEqual([17])
    const shipped = (await loadMigrations(MIGRATIONS_DIR)).find((m) => m.version === 17)!
    expect(await one<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations WHERE version = 17')).toEqual({ name: 'architect_entrances_landscaping', checksum: shipped.checksum })
    expect(await columns()).toEqual([...columns16, 'entrance', 'landscaping'])
    expect(await tables()).toEqual(names)
    // Every row of every table as it was; each design row byte for byte, in the very same tuple and storage (no rewrite),
    // naming no entrance or landscaping.
    expect(await dump(names, "to_jsonb(x) - 'entrance' - 'landscaping'")).toEqual(before)
    expect(await tuples()).toEqual(tuplesBefore)
    expect(await storage()).toBe(storageBefore)
    expect((await t.db.query('SELECT DISTINCT entrance, landscaping FROM world_property_designs')).rows).toEqual([{ entrance: null, landscaping: null }])
    const pinned = (await t.db.query<{ proname: string; proconfig: string[] | null }>("SELECT proname, proconfig FROM pg_proc WHERE proname IN ('world_design_known', 'world_property_designs_guard') AND pronamespace = current_schema()::regnamespace ORDER BY proname")).rows
    expect(pinned.map((r) => [r.proname, r.proconfig?.some((c) => c.startsWith('search_path=') && c.includes('pg_temp'))])).toEqual([
      ['world_design_known', true],
      ['world_property_designs_guard', true],
    ])
    expect((await verifyCity(t.db)).violations).toEqual([])
    // Edited after it was applied: refused. So is any earlier migration edited now.
    for (const version of ['0016', '0017']) {
      const edited = await t.migrationsPlus([])
      const name = (await readdir(edited)).find((f) => f.startsWith(version))!
      await writeFile(join(edited, name), `${await readFile(join(edited, name), 'utf8')}\n-- edited\n`)
      await expect(migrate(t.db, { dir: edited, environment: 'local' }), version).rejects.toThrow(new RegExp(`Migration ${Number(version)} \\(\\w+\\) was edited after it was applied`))
    }
    // This build's store reads the column 0018 adds (a deployment migrates before it serves), so the database takes 0018
    // next, and every row is still exactly as E4A and E4B wrote it.
    expect((await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })).applied).toEqual([18])
    expect(await dump(names, "to_jsonb(x) - 'entrance' - 'landscaping' - 'color'")).toEqual(before)
    expect(await tuples()).toEqual(tuplesBefore)

    // D. Read as v1 and v2, exactly, and drawn exactly as E4B drew them: no entrance or grounds of their own.
    const designs = createWorldDesignStore(t.db, { mode: 'local', log: silentLogger })
    const designer = createDesignService({ sessions: env.sessions, store: designs, authority: source.authority })
    const overview = async (o: OpenedPlaySession, id: string) => designs.overview(await env.sessions.session(o.token), id, source.authority)
    const cityDesigns = async (o: OpenedPlaySession, store = designs) => store.city(await env.sessions.session(o.token))
    expect(await overview(ada, pA.id)).toMatchObject({ saved: null, historyCount: 0 })
    expect(await overview(ada, pB.id)).toMatchObject({ saved: { revision: 1, catalog: V1, facade: 'brick', roof: 'flat', windows: null, lighting: null, entrance: null, landscaping: null } })
    expect(await overview(ada, pC.id)).toMatchObject({ saved: { revision: 1, catalog: V2, ...C_DESIGN, entrance: null, landscaping: null } })
    expect((await overview(ada, pD.id)).history.map((h) => [h.revision, h.catalog, h.facade, h.windows, h.entrance, h.landscaping])).toEqual([
      [2, V2, 'limestone', 'lattice', null, null],
      [1, V1, 'jade', null, null, null],
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
    expect(drawnBefore[pB.buildingId].architecture).toEqual({ ...DEFAULT_ARCHITECTURE, facade: 'brick' })
    expect(drawnBefore[pC.buildingId].architecture).toEqual({ ...DEFAULT_ARCHITECTURE, facade: 'copper', roof: 'dome', windows: 'arched', lighting: 'warm' })
    expect(drawnBefore[pC.buildingId].floodlights).toBe('warm')
    expect(drawnBefore[pD.buildingId].architecture).toEqual({ ...DEFAULT_ARCHITECTURE, facade: 'limestone', roof: 'spire', windows: 'lattice', lighting: 'cool' })
    for (const p of [pA, pB, pC, pD]) expect(drawnBefore[p.buildingId]).not.toHaveProperty('street')
    const tiers = await t.db.query<{ tier: number }>(
      'SELECT COALESCE((SELECT max(c.tier_after) FROM world_property_constructions c WHERE c.property_id = p.id), 0) AS tier FROM world_properties p WHERE p.id = ANY($1) ORDER BY p.activated_sequence',
      [[pB.id, pC.id, pD.id]],
    )
    expect(tiers.rows.map((r) => r.tier)).toEqual([0, 1, 2])

    // E. The v2 save already recorded replays its original receipt, exactly, and writes nothing: the E4B page's 11-key save,
    // resent after a lost answer.
    const v2Save = (o: OpenedPlaySession, propertyId: string, design: Details, baseRevision: number, actionId = randomUUID()) =>
      designer.save(o.token, env.actorOf(o), { propertyId, actionId, baseRevision, catalog: V2, ...design })
    const recorded = await one<{ designed_at: Date }>('SELECT designed_at FROM world_property_designs WHERE action_id = $1', [dSecond])
    expect(await v2Save(ada, pD.id, D_DESIGN, 1, dSecond)).toEqual({
      fresh: false,
      design: expect.objectContaining({
        propertyId: pD.id,
        revision: 2,
        actionId: dSecond,
        catalog: V2,
        ...D_DESIGN,
        entrance: null,
        landscaping: null,
        designedAt: recorded.designed_at.toISOString(),
        designer: { coreUserId: ADA.coreUserId, discordUserId: ADA.discordUserId },
      }),
    })
    // Even by Ada, who no longer controls D: a replay is a receipt of what was saved, never a new save.
    expect((await v2Save(ada, pC.id, C_DESIGN, 0, cSaved)).design).toMatchObject({ revision: 1, catalog: V2 })
    // Under a recorded id, nothing else: another choice, the same as v3 or v4 (even with the standard street level), or another player.
    expect(await refusalOf(v2Save(ada, pC.id, { ...C_DESIGN, lighting: 'cool' }, 0, cSaved))).toBe('action_conflict')
    expect(await refusalOf(designer.save(ada.token, env.actorOf(ada), { propertyId: pC.id, actionId: cSaved, baseRevision: 0, catalog: V3, ...C_DESIGN, entrance: 'standard', landscaping: 'standard' }))).toBe('action_conflict')
    expect(await refusalOf(designer.save(ada.token, env.actorOf(ada), { propertyId: pC.id, actionId: cSaved, baseRevision: 0, catalog: V4, ...C_DESIGN, entrance: 'standard', landscaping: 'standard', color: 'natural' }))).toBe('action_conflict')
    const bea = await env.open(INSTALLATION_A, BEA)
    expect(await refusalOf(v2Save(bea, pD.id, D_DESIGN, 1, dSecond))).toBe('action_conflict')
    // A v2 save that was never recorded is refused, never applied as a later design; and the database takes no new v2 row.
    expect(await refusalOf(v2Save(ada, pC.id, { ...C_DESIGN, windows: 'ribbon' }, 1))).toBe('design_retired')
    await expect(written(ada, pC.id, 2, { ...C_DESIGN, windows: 'ribbon' })).rejects.toThrow(/architect-design-v4: architect-design-v2 is read only/)
    const kept = await dump(['world_property_designs'])

    // F. Saves of the current catalog (v4, since 0018). The standard entrance and grounds (and the material's own color) on a v2
    // design are that design: no revision, no accidental redesign.
    const snapshot = async () => {
      const out: Record<string, string[]> = {}
      for (const table of UNTOUCHED) out[table] = (await t.db.query<{ r: string }>(`SELECT to_jsonb(x)::text AS r FROM ${table} x ORDER BY 1`)).rows.map((r) => r.r)
      return out
    }
    const untouched = await snapshot()
    const sequence = await sequenceOf(ada.response.world.id)
    const save = (o: OpenedPlaySession, propertyId: string, design: Details & { entrance: string; landscaping: string }, baseRevision: number) =>
      designer.save(o.token, env.actorOf(o), { propertyId, actionId: randomUUID(), baseRevision, catalog: V4, color: 'natural', ...design })
    expect(await refusalOf(save(ada, pC.id, { ...C_DESIGN, entrance: 'standard', landscaping: 'standard' }, 1))).toBe('design_unchanged')
    expect(await dump(['world_property_designs'])).toEqual(kept)
    const c2 = await save(ada, pC.id, { ...C_DESIGN, entrance: 'portico', landscaping: 'garden' }, 1)
    expect(c2).toMatchObject({ fresh: true, design: { revision: 2, catalog: V4, ...C_DESIGN, entrance: 'portico', landscaping: 'garden', color: 'natural', atCitySequence: sequence } })
    // 18-21. The new controller inherits D's whole design and history and may change it; the founder and former controller,
    // and a patron, may not.
    expect(await overview(bea, pD.id)).toMatchObject({ control: 'viewer', saved: { revision: 2, catalog: V2, ...D_DESIGN }, historyCount: 2, history: [{ by: 'other' }, { by: 'other' }] })
    expect(await refusalOf(save(ada, pD.id, { ...D_DESIGN, entrance: 'canopy', landscaping: 'courtyard' }, 2))).toBe('not_current_controller')
    expect(await refusalOf(save(cy, pD.id, { ...D_DESIGN, entrance: 'canopy', landscaping: 'courtyard' }, 2))).toBe('not_current_controller')
    expect(await refusalOf(save(cy, pC.id, { ...C_DESIGN, entrance: 'arched', landscaping: 'courtyard' }, 2))).toBe('not_current_controller')
    const d3 = await save(bea, pD.id, { ...D_DESIGN, entrance: 'canopy', landscaping: 'courtyard' }, 2)
    expect(d3.design).toMatchObject({ revision: 3, catalog: V4, ...D_DESIGN, entrance: 'canopy', landscaping: 'courtyard', designer: { discordUserId: BEA.discordUserId } })
    // Historical attribution stays: Ada designed revisions 1 and 2.
    expect((await overview(ada, pD.id)).history.map((h) => [h.revision, h.catalog, h.by])).toEqual([
      [3, V4, 'other'],
      [2, V2, 'viewer'],
      [1, V1, 'viewer'],
    ])
    // B's v1 design, on a Tier 0 foundation: an entrance and landscaping are kept until Tier 1.
    expect((await save(ada, pB.id, { facade: 'brick', roof: 'flat', windows: 'grid', lighting: 'standard', entrance: 'arched', landscaping: 'garden' }, 1)).design).toMatchObject({ revision: 2, catalog: V4 })
    // 29-31. Nothing else moved: no credit, construction, tier, era, founder, plot, NFT, ticket, sequence or event.
    expect(await snapshot()).toEqual(untouched)
    expect(await sequenceOf(ada.response.world.id)).toBe(sequence)
    // The v1 and v2 history is exactly as it was; only new revisions were appended.
    const after = (await dump(['world_property_designs'])).world_property_designs
    expect(after.filter((r) => JSON.parse(r).catalog !== V4)).toEqual(kept.world_property_designs)
    expect(after).toHaveLength(kept.world_property_designs.length + 3)
    // A v2 replay still answers after later revisions, and still writes nothing.
    expect((await v2Save(ada, pD.id, D_DESIGN, 1, dSecond)).design).toMatchObject({ revision: 2, catalog: V2 })
    expect((await dump(['world_property_designs'])).world_property_designs).toEqual(after)

    // Drawn: only the redesigned buildings differ, and only in what was chosen.
    const drawnAfter = await drawn(ada)
    expect(drawnAfter[pA.buildingId]).toEqual(drawnBefore[pA.buildingId])
    expect(drawnAfter[pC.buildingId].architecture).toEqual(drawnBefore[pC.buildingId].architecture)
    expect(drawnAfter[pC.buildingId].street).toEqual({ entrance: 'grand-portico', grounds: 'garden' })
    expect(drawnAfter[pD.buildingId].street).toEqual({ entrance: 'awning', grounds: 'courtyard' })
    expect(drawnAfter[pB.buildingId].street).toEqual({ entrance: 'arch', grounds: 'garden' })
    // Nothing but the street level (and, for none of these, the architecture) differs: tier, plot, district, NFT, patrons.
    const rest = (b: (typeof drawnAfter)[string]) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'street' && k !== 'architecture'))
    for (const p of [pA, pB, pC, pD]) expect(rest(drawnAfter[p.buildingId])).toEqual(rest(drawnBefore[p.buildingId]))

    // 23. Installations stay apart: B's city reads only its own v2 design, and cannot reach A's.
    expect((await cityDesigns(beaB)).map((d) => [d.propertyId, d.revision, d.catalog, d.entrance])).toEqual([[pOther.id, 1, V2, null]])
    expect(await refusalOf(save(beaB, pD.id, { ...D_DESIGN, entrance: 'portico', landscaping: 'garden' }, 3))).toBe('unknown_property')

    // 17. A restart: a new pool and store read the same, and the city verifies.
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

  it('a clean database takes every migration in one go and saves a design of the current catalog at once; the guard still holds 0017\'s entrance and landscaping rules', async () => {
    const env = await setup()
    expect((await one<{ n: number }>('SELECT max(version)::int AS n FROM schema_migrations')).n).toBe(18)
    const source = testAuthority()
    const designer = createDesignService({ sessions: env.sessions, store: createWorldDesignStore(t.db, { mode: 'local', log: silentLogger }), authority: source.authority })
    const ada = await env.open(INSTALLATION_A, ADA)
    const ticket = await env.ticketOf(ada, [keeper(1)])
    const city = await env.sessions.city(await env.sessions.session(ada.token))
    const p = (await env.activate(ada, ticket, keeper(1), city.world.districts.find((d) => d.key === ticket.districtKey)!.candidates.plotIds[0])).property
    source.control(GUILD_A, keeper(1), ADA)
    const saved = await designer.save(ada.token, env.actorOf(ada), { propertyId: p.id, actionId: randomUUID(), baseRevision: 0, catalog: V4, facade: 'slate', roof: 'flat', windows: 'grid', lighting: 'standard', entrance: 'canopy', landscaping: 'courtyard', color: 'natural' })
    expect(saved.design).toMatchObject({ revision: 1, catalog: V4, entrance: 'canopy', landscaping: 'courtyard' })
    // The service never saves a v1, v2 or v3 design now, and the database refuses one written directly.
    expect(await refusalOf(designer.save(ada.token, env.actorOf(ada), { propertyId: p.id, actionId: randomUUID(), baseRevision: 1, catalog: V2, facade: 'slate', roof: 'flat', windows: 'grid', lighting: 'warm' }))).toBe('design_retired')
    expect(await refusalOf(designer.save(ada.token, env.actorOf(ada), { propertyId: p.id, actionId: randomUUID(), baseRevision: 1, catalog: V3, facade: 'slate', roof: 'flat', windows: 'grid', lighting: 'warm', entrance: 'canopy', landscaping: 'courtyard' }))).toBe('design_retired')
    const row = await one<Record<string, unknown>>('SELECT * FROM world_property_designs WHERE property_id = $1', [p.id])
    const insert = (over: Record<string, unknown>) => {
      const r: Record<string, unknown> = { ...row, revision: 2, action_id: randomUUID(), ...over }
      return t.db.query(
        `INSERT INTO world_property_designs (world_id, city_id, city_instance_id, property_id, revision, action_id, catalog, facade, roof, windows, lighting, entrance, landscaping, color, designer_core_user_id, designer_discord_user_id, designed_in_play_session, authority, at_city_sequence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [r.world_id, r.city_id, r.city_instance_id, r.property_id, r.revision, r.action_id, r.catalog, r.facade, r.roof, r.windows, r.lighting, r.entrance, r.landscaping, r.color, r.designer_core_user_id, r.designer_discord_user_id, r.designed_in_play_session, r.authority, r.at_city_sequence],
      )
    }
    await expect(insert({ catalog: V2, entrance: null, landscaping: null, color: null })).rejects.toThrow(/architect-design-v2 is read only/)
    await expect(insert({ catalog: V3, color: null })).rejects.toThrow(/architect-design-v3 is read only/)
    await expect(insert({ entrance: 'grand-portico' })).rejects.toThrow(/entrance, landscaping and color of a catalog this database knows/)
    await expect(insert({ landscaping: 'none' })).rejects.toThrow(/entrance, landscaping and color of a catalog this database knows/)
    await insert({ entrance: 'portico', landscaping: 'garden' })
    expect((await t.db.query('SELECT revision, entrance, landscaping FROM world_property_designs WHERE property_id = $1 ORDER BY revision', [p.id])).rows).toEqual([
      { revision: 1, entrance: 'canopy', landscaping: 'courtyard' },
      { revision: 2, entrance: 'portico', landscaping: 'garden' },
    ])
    expect((await verifyCity(t.db)).violations).toEqual([])
  })
})
