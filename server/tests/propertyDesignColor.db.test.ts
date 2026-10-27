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
import { appearanceOf, assetKey, CURRENT_DESIGN_CATALOG, type NftAsset } from '../src/engine'
import { silentLogger } from '../src/log'
import { PlaySessionError, type OpenedPlaySession } from '../src/play/session'
import { createConstructionService, createWorldConstructionStore, type ConstructionAuthority, type TestCreditGrant } from '../src/world/construction'
import { createDesignService, createWorldDesignStore, WorldDesignRefusal } from '../src/world/designs'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'
import { ADA, BEA, GUILD_A, GUILD_B, INSTALLATION_A, INSTALLATION_B } from './fakePlay'
import { keeper, player, ticketWorld } from './ticketHarness'

/**
 * ARCHITECT EXTERIOR COLOR (P1-E6, migration 0018) against a disposable Postgres: a database the E4A, E4B and E4C builds
 * wrote (catalog v1, v2 and v3 designs, each exactly as that build's store wrote it, through that build's guard) takes 0018
 * and keeps every design's meaning.
 *
 *   A  a property never designed                 B  a Tier 0 property with a v1 design
 *   C  a Tier 1 property with a v2 then a v3 revision, a patron's construction
 *   D  a Tier 2 property with a v3 design, then a new controller (a local stand-in for a transfer)
 *
 * 0018 rewrites no row (the same tuples, the same storage) and rolls back whole when it cannot finish; v1, v2 and v3 designs
 * read and draw exactly as before (no exterior color at all); a v3 save already recorded replays its original receipt, one
 * never recorded is refused (`design_retired`), and the database takes no new v3 row; a v4 save chooses the color apart from
 * the material (either can change alone, and every catalog color saves), the new controller inherits it and may change it
 * and the founder, a patron and the former controller may not; the natural color is no redesign; a color is free: nothing
 * else moves (no credit, construction, tier, era, founder, sequence or event); installations stay apart; a restart and
 * city:verify agree.
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
type Street = { facade: string; roof: string; windows: string; lighting: string; entrance: string; landscaping: string }

describe.skipIf(NO_TEST_DATABASE)('Architect exterior color (migration 0018) against a disposable Postgres', () => {
  const t = useTestSchema()
  const { setup, one, sequenceOf } = ticketWorld(t)

  /** The migrations up to and including `last`, as a directory `migrate` reads. */
  async function through(last: number) {
    const dir = await t.migrationsPlus([])
    const out = await mkdtemp(join(tmpdir(), `rc-${String(last).padStart(4, '0')}-`))
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) <= last)) await copyFile(join(dir, f), join(out, f))
    return out
  }

  it('0018 upgrades a populated 0017 database without changing a design: v1, v2 and v3 history is kept, replayed and drawn as before; v4 colors build on it, free', async () => {
    // A. A database as E4A left it (0015, v1 designs), as E4B left it (0016, v2) and as E4C left it (0017, v3).
    expect((await migrate(t.db, { dir: await through(15), environment: 'local' })).current).toBe(15)
    const env = await setup({ migrated: true })
    const source = testAuthority()
    const builder = createConstructionService({ sessions: env.sessions, store: createWorldConstructionStore(t.db, { mode: 'local', log: silentLogger }), authority: source.authority })
    const place = async (o: OpenedPlaySession, asset: NftAsset) => {
      const ticket = await env.ticketOf(o, [asset])
      const city = await env.sessions.city(await env.sessions.session(o.token))
      return (await env.activate(o, ticket, asset, city.world.districts.find((d) => d.key === ticket.districtKey)!.candidates.plotIds[0])).property
    }
    /** A design row exactly as the E4A (v1), E4B (v2) or E4C (v3) store wrote it, through that build's guard. */
    const written = async (o: OpenedPlaySession, propertyId: string, revision: number, design: { facade: string; roof: string; windows?: string; lighting?: string; entrance?: string; landscaping?: string }, actionId = randomUUID()) => {
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
        const v3 = design.entrance !== undefined
        await c.query(
          `INSERT INTO world_property_designs (world_id, city_id, city_instance_id, property_id, revision, action_id, catalog, facade, roof, ${v2 ? 'windows, lighting, ' : ''}${v3 ? 'entrance, landscaping, ' : ''}designer_core_user_id, designer_discord_user_id,
                                              designed_in_play_session, authority, at_city_sequence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ${v2 ? '$14, $15, ' : ''}${v3 ? '$16, $17, ' : ''}$10, $11, $12, 'local-fixture-controller', $13)`,
          [
            session.scope.worldId,
            city_id,
            city_instance_id,
            propertyId,
            revision,
            actionId,
            v3 ? V3 : v2 ? V2 : V1,
            design.facade,
            design.roof,
            session.player.coreUserId,
            session.player.discordUserId,
            session.id,
            sequence,
            ...(v2 ? [design.windows, design.lighting] : []),
            ...(v3 ? [design.entrance, design.landscaping] : []),
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
    expect((await migrate(t.db, { dir: await through(16), environment: 'local' })).applied).toEqual([16])
    await written(ada, pC.id, 1, { facade: 'copper', roof: 'dome', windows: 'arched', lighting: 'warm' })
    expect((await migrate(t.db, { dir: await through(17), environment: 'local' })).applied).toEqual([17])
    const C_DESIGN: Street = { facade: 'copper', roof: 'dome', windows: 'arched', lighting: 'warm', entrance: 'portico', landscaping: 'garden' }
    const D_DESIGN: Street = { facade: 'brick', roof: 'spire', windows: 'lattice', lighting: 'cool', entrance: 'canopy', landscaping: 'courtyard' }
    const cSecond = await written(ada, pC.id, 2, C_DESIGN)
    const dSaved = await written(ada, pD.id, 1, D_DESIGN)
    const beaB = await env.open(INSTALLATION_B, BEA)
    const pOther = await place(beaB, keeper(1))
    source.control(GUILD_B, keeper(1), BEA)
    await written(beaB, pOther.id, 1, { facade: 'jade', roof: 'dome', windows: 'ribbon', lighting: 'standard', entrance: 'arched', landscaping: 'standard' })
    // 0017's guard takes no new v2 row: the history above is exactly E4A's, E4B's, then E4C's.
    await expect(written(ada, pA.id, 1, { facade: 'brick', roof: 'dome', windows: 'grid', lighting: 'warm' })).rejects.toThrow(/architect-design-v2 is read only/)
    // The fixture names Bea D's controller after its design was saved (a local stand-in for a transfer); Cy is a patron of C.
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
    const columns17 = await columns()
    expect((await t.db.query('SELECT catalog, count(*)::int AS n FROM world_property_designs GROUP BY 1 ORDER BY 1')).rows).toEqual([
      { catalog: V1, n: 1 },
      { catalog: V2, n: 1 },
      { catalog: V3, n: 3 },
    ])
    // How the E4C page drew this city: every design as its catalog's appearance, read straight from the rows (this build's
    // store reads the 0018 column, so it is not used before 0018).
    const config = async (o: OpenedPlaySession) => {
      const city = await env.sessions.city(await env.sessions.session(o.token))
      const parsed = parsePlayCityConfig(city.config, o.response.world.id)
      if (!parsed.ok) throw new Error('config')
      return { config: parsed.config, state: city.world.state }
    }
    const rowsDrawn = async (o: OpenedPlaySession) => {
      const latest = (
        await t.db.query<{ building_id: string; facade: string; roof: string; windows: string | null; lighting: string | null; entrance: string | null; landscaping: string | null }>(
          `SELECT DISTINCT ON (d.property_id) p.building_id, d.facade, d.roof, d.windows, d.lighting, d.entrance, d.landscaping
             FROM world_property_designs d JOIN world_properties p ON p.id = d.property_id WHERE d.world_id = $1 ORDER BY d.property_id, d.revision DESC`,
          [o.response.world.id],
        )
      ).rows
      const c = await config(o)
      return persistedBrandCityState(c.config, c.state, Object.fromEntries(latest.map((r) => [r.building_id, appearanceOf({ ...r, color: null })]))).buildings
    }
    const drawnBefore = await rowsDrawn(ada)

    // B. Someone holds world_property_designs: 0018 cannot take its lock in time, and leaves nothing behind.
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql'))
    const name18 = files.find((f) => f.startsWith('0018'))!
    expect(name18).toBe('0018_architect_exterior_color.sql')
    const holder = await t.db.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE world_property_designs IN ACCESS SHARE MODE')
      const short = await through(17)
      await writeFile(join(short, name18), (await readFile(join(MIGRATIONS_DIR, name18), 'utf8')).replace("SET LOCAL lock_timeout = '10s';", "SET LOCAL lock_timeout = '200ms';"))
      await expect(migrate(t.db, { dir: short, environment: 'local' })).rejects.toThrow(/Migration 18 \(architect_exterior_color\) failed and was rolled back/)
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
    }
    // A failure part way through (after the column was added and the guard replaced) leaves nothing either.
    const broken = await through(17)
    await writeFile(join(broken, name18), `${await readFile(join(MIGRATIONS_DIR, name18), 'utf8')}\nSELECT 1 / 0;\n`)
    await expect(migrate(t.db, { dir: broken, environment: 'local' })).rejects.toThrow(/Migration 18 \(architect_exterior_color\) failed and was rolled back/)
    expect((await one<{ n: number }>('SELECT max(version)::int AS n FROM schema_migrations')).n).toBe(17)
    expect(await columns()).toEqual(columns17)
    expect(await dump(names)).toEqual(before)
    expect((await t.db.query("SELECT 1 FROM pg_proc WHERE proname = 'world_design_color_known' AND pronamespace = current_schema()::regnamespace")).rows).toEqual([])
    // 0017's guard is still the one in force (it knows nothing of v4), so nothing of 0018's was left half done.
    expect(await t.db.query("SELECT prosrc LIKE '%architect-design-v4%' AS v4 FROM pg_proc WHERE proname = 'world_property_designs_guard' AND pronamespace = current_schema()::regnamespace").then((r) => r.rows[0])).toEqual({ v4: false })

    // C. 0018 applies, once, as checked in.
    expect((await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })).applied).toEqual([18])
    const shipped = (await loadMigrations(MIGRATIONS_DIR)).find((m) => m.version === 18)!
    expect(await one<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations WHERE version = 18')).toEqual({ name: 'architect_exterior_color', checksum: shipped.checksum })
    expect(await columns()).toEqual([...columns17, 'color'])
    expect(await tables()).toEqual(names)
    // Every row of every table as it was; each design row byte for byte, in the very same tuple and storage (no rewrite),
    // naming no color.
    expect(await dump(names, "to_jsonb(x) - 'color'")).toEqual(before)
    expect(await tuples()).toEqual(tuplesBefore)
    expect(await storage()).toBe(storageBefore)
    expect((await t.db.query('SELECT DISTINCT color FROM world_property_designs')).rows).toEqual([{ color: null }])
    const pinned = (await t.db.query<{ proname: string; proconfig: string[] | null }>("SELECT proname, proconfig FROM pg_proc WHERE proname IN ('world_design_color_known', 'world_property_designs_guard') AND pronamespace = current_schema()::regnamespace ORDER BY proname")).rows
    expect(pinned.map((r) => [r.proname, r.proconfig?.some((c) => c.startsWith('search_path=') && c.includes('pg_temp'))])).toEqual([
      ['world_design_color_known', true],
      ['world_property_designs_guard', true],
    ])
    expect((await verifyCity(t.db)).violations).toEqual([])
    // Edited after it was applied: refused. So is any earlier migration edited now.
    for (const version of ['0017', '0018']) {
      const edited = await t.migrationsPlus([])
      const name = (await readdir(edited)).find((f) => f.startsWith(version))!
      await writeFile(join(edited, name), `${await readFile(join(edited, name), 'utf8')}\n-- edited\n`)
      await expect(migrate(t.db, { dir: edited, environment: 'local' }), version).rejects.toThrow(new RegExp(`Migration ${Number(version)} \\(\\w+\\) was edited after it was applied`))
    }

    // D. Read as v1, v2 and v3, exactly, and drawn exactly as the E4C page drew them: no exterior color of their own.
    const designs = createWorldDesignStore(t.db, { mode: 'local', log: silentLogger })
    const designer = createDesignService({ sessions: env.sessions, store: designs, authority: source.authority })
    const overview = async (o: OpenedPlaySession, id: string) => designs.overview(await env.sessions.session(o.token), id, source.authority)
    const cityDesigns = async (o: OpenedPlaySession, store = designs) => store.city(await env.sessions.session(o.token))
    expect(await overview(ada, pA.id)).toMatchObject({ saved: null, historyCount: 0 })
    expect(await overview(ada, pB.id)).toMatchObject({ saved: { revision: 1, catalog: V1, facade: 'brick', windows: null, entrance: null, color: null } })
    expect(await overview(ada, pC.id)).toMatchObject({ saved: { revision: 2, catalog: V3, ...C_DESIGN, color: null } })
    expect((await overview(ada, pC.id)).history.map((h) => [h.revision, h.catalog, h.entrance, h.color])).toEqual([
      [2, V3, 'portico', null],
      [1, V2, null, null],
    ])
    const drawn = async (o: OpenedPlaySession) => {
      const c = await config(o)
      return persistedBrandCityState(c.config, c.state, Object.fromEntries((await cityDesigns(o)).map((d) => [d.buildingId, appearanceOf(d)]))).buildings
    }
    const drawn18 = await drawn(ada)
    expect(drawn18).toEqual(drawnBefore)
    for (const p of [pA, pB, pC, pD]) expect(drawn18[p.buildingId]).not.toHaveProperty('exterior')
    expect(drawn18[pC.buildingId].architecture).toEqual({ ...DEFAULT_ARCHITECTURE, facade: 'copper', roof: 'dome', windows: 'arched', lighting: 'warm' })
    expect(drawn18[pC.buildingId].street).toEqual({ entrance: 'grand-portico', grounds: 'garden' })

    // E. The v3 save already recorded replays its original receipt, exactly, and writes nothing: the E4C page's 13-key save,
    // resent after a lost answer. Even by Ada, who no longer controls D: a replay is a receipt, never a new save.
    const v3Save = (o: OpenedPlaySession, propertyId: string, design: Street, baseRevision: number, actionId = randomUUID()) =>
      designer.save(o.token, env.actorOf(o), { propertyId, actionId, baseRevision, catalog: V3, ...design })
    const recorded = await one<{ designed_at: Date }>('SELECT designed_at FROM world_property_designs WHERE action_id = $1', [dSaved])
    expect(await v3Save(ada, pD.id, D_DESIGN, 0, dSaved)).toEqual({
      fresh: false,
      design: expect.objectContaining({ propertyId: pD.id, revision: 1, actionId: dSaved, catalog: V3, ...D_DESIGN, color: null, designedAt: recorded.designed_at.toISOString(), designer: { coreUserId: ADA.coreUserId, discordUserId: ADA.discordUserId } }),
    })
    expect((await v3Save(ada, pC.id, C_DESIGN, 1, cSecond)).design).toMatchObject({ revision: 2, catalog: V3, color: null })
    // Under a recorded id, nothing else: another choice, the same as v4 (even in its natural color), or another player.
    expect(await refusalOf(v3Save(ada, pC.id, { ...C_DESIGN, landscaping: 'courtyard' }, 1, cSecond))).toBe('action_conflict')
    expect(await refusalOf(designer.save(ada.token, env.actorOf(ada), { propertyId: pC.id, actionId: cSecond, baseRevision: 1, catalog: V4, ...C_DESIGN, color: 'natural' }))).toBe('action_conflict')
    const bea = await env.open(INSTALLATION_A, BEA)
    expect(await refusalOf(v3Save(bea, pD.id, D_DESIGN, 0, dSaved))).toBe('action_conflict')
    // A v3 save that was never recorded is refused, never applied as a v4 design (it would drop a color unseen); and the
    // database takes no new v3 row.
    expect(await refusalOf(v3Save(ada, pC.id, { ...C_DESIGN, roof: 'spire' }, 2))).toBe('design_retired')
    await expect(written(ada, pC.id, 3, { ...C_DESIGN, roof: 'spire' })).rejects.toThrow(/architect-design-v4: architect-design-v3 is read only/)
    const kept = await dump(['world_property_designs'])

    // F. v4 saves: a color chosen apart from the material. Free: nothing else moves.
    const snapshot = async () => {
      const out: Record<string, string[]> = {}
      for (const table of UNTOUCHED) out[table] = (await t.db.query<{ r: string }>(`SELECT to_jsonb(x)::text AS r FROM ${table} x ORDER BY 1`)).rows.map((r) => r.r)
      return out
    }
    const untouched = await snapshot()
    const sequence = await sequenceOf(ada.response.world.id)
    const save = (o: OpenedPlaySession, propertyId: string, design: Street & { color: string }, baseRevision: number) =>
      designer.save(o.token, env.actorOf(o), { propertyId, actionId: randomUUID(), baseRevision, catalog: V4, ...design })
    // The natural color on a v3 design is that design: no revision, no accidental redesign.
    expect(await refusalOf(save(ada, pC.id, { ...C_DESIGN, color: 'natural' }, 2))).toBe('design_unchanged')
    expect(await dump(['world_property_designs'])).toEqual(kept)
    // The color alone: the material and every other choice stay.
    const c3 = await save(ada, pC.id, { ...C_DESIGN, color: 'ocean-blue' }, 2)
    expect(c3).toMatchObject({ fresh: true, design: { revision: 3, catalog: V4, ...C_DESIGN, color: 'ocean-blue', atCitySequence: sequence } })
    // The material alone: the color stays.
    const c4 = await save(ada, pC.id, { ...C_DESIGN, facade: 'limestone', color: 'ocean-blue' }, 3)
    expect(c4.design).toMatchObject({ revision: 4, facade: 'limestone', color: 'ocean-blue', roof: 'dome', entrance: 'portico' })
    // Every color the catalog lists saves, on every material, as one revision each; then back to the v3 design itself (copper,
    // its natural color), which draws exactly as the E4C page drew it.
    expect(CURRENT_DESIGN_CATALOG.colors).toHaveLength(13)
    let revision = 4
    const materials = CURRENT_DESIGN_CATALOG.facades
    for (const [i, color] of [...CURRENT_DESIGN_CATALOG.colors.filter((c) => c !== 'ocean-blue' && c !== 'natural'), 'natural'].entries()) {
      const facade = color === 'natural' ? C_DESIGN.facade : materials[i % materials.length]
      const done = await save(ada, pC.id, { ...C_DESIGN, facade, color }, revision)
      expect(done.design, color).toMatchObject({ revision: revision + 1, facade, color })
      revision += 1
    }
    expect((await overview(ada, pC.id)).saved).toMatchObject({ revision, color: 'natural' })
    // 18-21. The new controller inherits D's whole design and history and may color it; the founder and former controller,
    // and a patron, may not.
    expect(await overview(bea, pD.id)).toMatchObject({ control: 'viewer', saved: { revision: 1, catalog: V3, ...D_DESIGN, color: null }, historyCount: 1, history: [{ by: 'other' }] })
    expect(await refusalOf(save(ada, pD.id, { ...D_DESIGN, color: 'navy' }, 1))).toBe('not_current_controller')
    expect(await refusalOf(save(cy, pD.id, { ...D_DESIGN, color: 'navy' }, 1))).toBe('not_current_controller')
    expect(await refusalOf(save(cy, pC.id, { ...C_DESIGN, color: 'navy' }, revision))).toBe('not_current_controller')
    const d2 = await save(bea, pD.id, { ...D_DESIGN, color: 'navy' }, 1)
    expect(d2.design).toMatchObject({ revision: 2, catalog: V4, ...D_DESIGN, color: 'navy', designer: { discordUserId: BEA.discordUserId } })
    // Historical attribution stays: Ada designed revision 1, in the material's own color.
    expect((await overview(ada, pD.id)).history.map((h) => [h.revision, h.catalog, h.color, h.by])).toEqual([
      [2, V4, 'navy', 'other'],
      [1, V3, null, 'viewer'],
    ])
    // B's v1 design, on a Tier 0 foundation: a color is drawn on its facade at once.
    expect((await save(ada, pB.id, { facade: 'brick', roof: 'flat', windows: 'grid', lighting: 'standard', entrance: 'standard', landscaping: 'standard', color: 'sage' }, 1)).design).toMatchObject({ revision: 2, catalog: V4, color: 'sage' })
    // A color names only a catalog color, never a value.
    expect(await refusalOf(save(bea, pD.id, { ...D_DESIGN, color: '#22305b' }, 2))).toBe('design_unsupported')
    expect(await refusalOf(save(bea, pD.id, { ...D_DESIGN, color: 'teal' }, 2))).toBe('design_unsupported')
    // Free: no credit, construction, tier, era, founder, plot, NFT, ticket, sequence or event moved.
    expect(await snapshot()).toEqual(untouched)
    expect(await sequenceOf(ada.response.world.id)).toBe(sequence)
    // The v1, v2 and v3 history is exactly as it was; only new revisions were appended.
    const after = (await dump(['world_property_designs'])).world_property_designs
    expect(after.filter((r) => JSON.parse(r).catalog !== V4)).toEqual(kept.world_property_designs)
    expect(after).toHaveLength(kept.world_property_designs.length + (revision - 2) + 2)
    // A v3 replay still answers after v4 revisions, and still writes nothing.
    expect((await v3Save(ada, pD.id, D_DESIGN, 0, dSaved)).design).toMatchObject({ revision: 1, catalog: V3, color: null })
    expect((await dump(['world_property_designs'])).world_property_designs).toEqual(after)

    // Drawn: only the recolored buildings differ, and only by their exterior color; C, restored, is exactly as it was.
    const drawnAfter = await drawn(ada)
    expect(drawnAfter[pA.buildingId]).toEqual(drawnBefore[pA.buildingId])
    expect(drawnAfter[pC.buildingId]).toEqual(drawnBefore[pC.buildingId])
    expect(drawnAfter[pD.buildingId]).toEqual({ ...drawnBefore[pD.buildingId], exterior: 'navy' })
    expect(drawnAfter[pB.buildingId]).toEqual({ ...drawnBefore[pB.buildingId], exterior: 'sage' })

    // 23. Installations stay apart: B's city reads only its own v3 design, and cannot reach A's.
    expect((await cityDesigns(beaB)).map((d) => [d.propertyId, d.revision, d.catalog, d.color])).toEqual([[pOther.id, 1, V3, null]])
    expect(await refusalOf(save(beaB, pD.id, { ...D_DESIGN, color: 'rose' }, 2))).toBe('unknown_property')

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
    expect(verified.worlds!.find((x) => x.id === ada.response.world.id)).toMatchObject({ designs: after.length - 1, designedProperties: 3 })
  })

  it('a clean database takes every migration in one go and saves a colored design at once; the guard holds its new rules', async () => {
    const env = await setup()
    expect((await one<{ n: number }>('SELECT max(version)::int AS n FROM schema_migrations')).n).toBe(18)
    const source = testAuthority()
    const designer = createDesignService({ sessions: env.sessions, store: createWorldDesignStore(t.db, { mode: 'local', log: silentLogger }), authority: source.authority })
    const ada = await env.open(INSTALLATION_A, ADA)
    const ticket = await env.ticketOf(ada, [keeper(1)])
    const city = await env.sessions.city(await env.sessions.session(ada.token))
    const p = (await env.activate(ada, ticket, keeper(1), city.world.districts.find((d) => d.key === ticket.districtKey)!.candidates.plotIds[0])).property
    source.control(GUILD_A, keeper(1), ADA)
    const saved = await designer.save(ada.token, env.actorOf(ada), { propertyId: p.id, actionId: randomUUID(), baseRevision: 0, catalog: V4, facade: 'slate', roof: 'flat', windows: 'grid', lighting: 'standard', entrance: 'standard', landscaping: 'standard', color: 'lavender' })
    expect(saved.design).toMatchObject({ revision: 1, catalog: V4, facade: 'slate', color: 'lavender' })
    // The service never saves a v3 design now, and the database refuses one written directly.
    expect(await refusalOf(designer.save(ada.token, env.actorOf(ada), { propertyId: p.id, actionId: randomUUID(), baseRevision: 1, catalog: V3, facade: 'slate', roof: 'flat', windows: 'grid', lighting: 'warm', entrance: 'standard', landscaping: 'standard' }))).toBe('design_retired')
    const row = await one<Record<string, unknown>>('SELECT * FROM world_property_designs WHERE property_id = $1', [p.id])
    const insert = (over: Record<string, unknown>) => {
      const r: Record<string, unknown> = { ...row, revision: 2, action_id: randomUUID(), ...over }
      return t.db.query(
        `INSERT INTO world_property_designs (world_id, city_id, city_instance_id, property_id, revision, action_id, catalog, facade, roof, windows, lighting, entrance, landscaping, color, designer_core_user_id, designer_discord_user_id, designed_in_play_session, authority, at_city_sequence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [r.world_id, r.city_id, r.city_instance_id, r.property_id, r.revision, r.action_id, r.catalog, r.facade, r.roof, r.windows, r.lighting, r.entrance, r.landscaping, r.color, r.designer_core_user_id, r.designer_discord_user_id, r.designed_in_play_session, r.authority, r.at_city_sequence],
      )
    }
    const KNOWN = /entrance, landscaping and color of a catalog this database knows/
    await expect(insert({ catalog: V3, color: null })).rejects.toThrow(/architect-design-v3 is read only/)
    for (const color of ['teal', 'Navy', '#b07489', 'url(x)', null]) await expect(insert({ color }), String(color)).rejects.toThrow(KNOWN)
    for (const color of CURRENT_DESIGN_CATALOG.colors.filter((c) => c !== 'lavender').slice(0, 3)) {
      await insert({ color, revision: (await one<{ n: number }>('SELECT max(revision)::int AS n FROM world_property_designs WHERE property_id = $1', [p.id])).n + 1 })
    }
    expect((await t.db.query('SELECT revision, color FROM world_property_designs WHERE property_id = $1 ORDER BY revision', [p.id])).rows).toEqual([
      { revision: 1, color: 'lavender' },
      { revision: 2, color: 'natural' },
      { revision: 3, color: 'ivory' },
      { revision: 4, color: 'sand' },
    ])
    // The catalog in the database is exactly the engine's.
    const listed = (await one<{ src: string }>("SELECT prosrc AS src FROM pg_proc WHERE proname = 'world_design_color_known' AND pronamespace = current_schema()::regnamespace")).src
    for (const color of CURRENT_DESIGN_CATALOG.colors) expect(listed, color).toContain(`'${color}'`)
    expect((await verifyCity(t.db)).violations).toEqual([])
  })
})
