import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyCity } from '../src/city/verify'
import { migrate } from '../src/db/migrations'
import { assetKey, type NftAsset } from '../src/engine'
import { silentLogger } from '../src/log'
import type { OpenedPlaySession } from '../src/play/session'
import { ARCHITECT_PROPERTY_LIMIT, createConstructionService, createWorldConstructionStore, WorldConstructionRefusal, type ConstructionAuthority, type TestCreditGrant } from '../src/world/construction'
import { createDesignService, createWorldDesignStore } from '../src/world/designs'
import type { PropertyLegacy } from '../src/world/legacy'
import { legacyView } from '../src/world/rehearsal'
import { parseRehearsalPropertyLegacy } from '../../src/protocol/playRehearsal'
import { NO_TEST_DATABASE, useTestSchema } from './dbHarness'
import { ADA, BEA, GUILD_A, GUILD_B, INSTALLATION_A, INSTALLATION_B } from './fakePlay'
import { keeper, player, ticketWorld } from './ticketHarness'

/**
 * ARCHITECT PORTFOLIO AND PROPERTY LEGACY (P1-C2-E5A) against a disposable Postgres, through the real launch path, session
 * service, ticket, property, construction and design stores. READ ONLY: no migration, no route that writes.
 *
 *   ACCOUNTING  a controller's own units stay in their control era; a patron's never become the controller's; a transfer
 *               starts the new controller from none of the previous one's; lifetime investment keeps every legitimate
 *               unit once; personal totals add up to the property totals with nothing counted twice or invented;
 *   FOUNDING    founding is never control, and a transfer never moves it;
 *   ISOLATION   another world's (installation's) properties and units are never read, summed or told;
 *   DESIGNS     v1, v2 and v3 revisions read by their catalogs, attributed by relation only; a design save is not a
 *               construction unit, a credit or Architect progress;
 *   NO WRITE    every read leaves every table exactly as it was;
 *   NO NAMES    no other player's id appears in any answer.
 */

function testAuthority() {
  const controllers = new Map<string, string>()
  const grants = new Map<string, TestCreditGrant[]>()
  const open = new Set<string>([GUILD_A, GUILD_B])
  const authority: ConstructionAuthority = {
    source: 'local-fixture',
    opensIn: (where) => open.has(where.guildId),
    controllerOf: (where, asset) => (open.has(where.guildId) ? (controllers.get(`${where.guildId}|${assetKey(asset)}`) ?? null) : null),
    grantsFor: (where) => grants.get(`${where.guildId}|${where.discordUserId}`) ?? [],
  }
  return {
    authority,
    control: (guild: string, asset: NftAsset, who: { discordUserId: string } | null) => (who ? controllers.set(`${guild}|${assetKey(asset)}`, who.discordUserId) : controllers.delete(`${guild}|${assetKey(asset)}`)),
    grant: (guild: string, who: { discordUserId: string }, list: TestCreditGrant[]) => grants.set(`${guild}|${who.discordUserId}`, list),
    close: (guild: string) => open.delete(guild),
  }
}

const CY = player(3, 'Cy')
const IDS = [ADA, BEA, CY].flatMap((p) => [p.discordUserId, p.coreUserId])

describe.skipIf(NO_TEST_DATABASE)('Architect portfolio and property legacy (read only) against a disposable Postgres', () => {
  const t = useTestSchema()
  const { setup } = ticketWorld(t)

  async function world(options: { migrated?: boolean } = {}) {
    const env = await setup({ migrated: options.migrated })
    const source = testAuthority()
    const store = createWorldConstructionStore(t.db, { mode: 'local', log: silentLogger })
    const builder = createConstructionService({ sessions: env.sessions, store, authority: source.authority })
    const designer = createDesignService({ sessions: env.sessions, store: createWorldDesignStore(t.db, { mode: 'local', log: silentLogger }), authority: source.authority })
    const place = async (o: OpenedPlaySession, asset: NftAsset) => {
      const ticket = await env.ticketOf(o, [asset])
      const city = await env.sessions.city(await env.sessions.session(o.token))
      return (await env.activate(o, ticket, asset, city.world.districts.find((d) => d.key === ticket.districtKey)!.candidates.plotIds[0])).property
    }
    const build = (o: OpenedPlaySession, propertyId: string, role: 'owner' | 'patron') => builder.construct(o.token, env.actorOf(o), { propertyId, role, actionId: randomUUID() })
    const legacy = async (o: OpenedPlaySession, propertyId: unknown) => store.legacy(await env.sessions.session(o.token), propertyId, source.authority)
    const architect = async (o: OpenedPlaySession) => store.architect(await env.sessions.session(o.token), source.authority)
    /** Every row of every table, with the transaction that wrote it: a read that wrote anything would change this. */
    const snapshot = async () => {
      const tables = (await t.db.query<{ tablename: string }>('SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY 1')).rows.map((r) => r.tablename)
      const out: Record<string, string[]> = {}
      for (const n of tables) out[n] = (await t.db.query<{ r: string }>(`SELECT xmin::text || ' ' || to_jsonb(x)::text AS r FROM ${n} x ORDER BY 1`)).rows.map((r) => r.r)
      return out
    }
    return { env, source, builder, designer, place, build, legacy, architect, snapshot }
  }

  /** The legacy exactly as the route answers it, and as the page parses it: every sum must agree. */
  const told = (l: PropertyLegacy) => {
    const parsed = parseRehearsalPropertyLegacy(JSON.parse(JSON.stringify(legacyView(l))))
    expect(parsed, JSON.stringify(l)).not.toBeNull()
    return parsed!
  }

  it('1-8, 11-14, 17. personal and property accounting through a transfer, patrons and two worlds; founding never moves; reads write nothing', async () => {
    const w = await world()
    const ada = await w.env.open(INSTALLATION_A, ADA)
    const bea = await w.env.open(INSTALLATION_A, BEA)
    const cy = await w.env.open(INSTALLATION_A, CY)
    // Ada founds K1, K2 and K3; Bea founds K4; Cy founds K5 (never built).
    const k1 = await w.place(ada, keeper(1))
    const k2 = await w.place(ada, keeper(2))
    const k3 = await w.place(ada, keeper(3))
    const k4 = await w.place(bea, keeper(4))
    const k5 = await w.place(cy, keeper(5))
    // The file: Ada controls K1; Bea controls K2 (Ada founded it) and K4; nobody controls K3 or K5.
    w.source.control(GUILD_A, keeper(1), ADA)
    w.source.control(GUILD_A, keeper(2), BEA)
    w.source.control(GUILD_A, keeper(4), BEA)
    for (const p of [ADA, BEA, CY]) w.source.grant(GUILD_A, p, [{ key: 'starter', units: 500 }])

    // Era 1 of K1 (Ada): two owner steps to Tier 1, then Bea and Cy as patrons.
    await w.build(ada, k1.id, 'owner')
    await w.build(ada, k1.id, 'owner')
    await w.build(bea, k1.id, 'patron')
    await w.build(cy, k1.id, 'patron')
    // K2: Bea as its controller. K3: Ada as a patron, while nobody is named (no era). K4: Ada as a patron, Bea as owner: Tier 1.
    await w.build(bea, k2.id, 'owner')
    await w.build(ada, k3.id, 'patron')
    await w.build(ada, k4.id, 'patron')
    await w.build(bea, k4.id, 'owner')

    const foundingBefore = (await t.db.query('SELECT to_jsonb(p) AS r FROM world_properties p ORDER BY activated_sequence')).rows
    // The transfer (a local stand-in): the file now names Bea K1's controller. She takes it to Tier 2 in her own era.
    w.source.control(GUILD_A, keeper(1), BEA)
    await w.build(bea, k1.id, 'owner')
    expect((await t.db.query('SELECT to_jsonb(p) AS r FROM world_properties p ORDER BY activated_sequence')).rows).toEqual(foundingBefore)

    // World B (another installation and Discord server): the same NFT is another property; Ada controls it there.
    const beaB = await w.env.open(INSTALLATION_B, BEA)
    const adaB = await w.env.open(INSTALLATION_B, ADA)
    const b1 = await w.place(beaB, keeper(1))
    w.source.control(GUILD_B, keeper(1), ADA)
    w.source.grant(GUILD_B, ADA, [{ key: 'starter', units: 500 }])
    await w.build(adaB, b1.id, 'owner')
    await w.build(adaB, b1.id, 'owner')
    await w.build(adaB, b1.id, 'owner')

    const before = await w.snapshot()

    // K1, as Ada sees it: she founded it, controlled it in era 1 (100 units, still hers), and holds no control now.
    const a1 = told(await w.legacy(ada, k1.id))
    expect(a1.property).toMatchObject({ tier: 2, built: 250, nextTierAt: null, maxTier: 2, foundingOrder: 1 })
    expect(a1).toMatchObject({ founding: 'viewer', control: 'other', open: true })
    expect(a1.investment).toEqual({ currentController: 50, previousControllers: 100, community: 100, total: 250 })
    expect(a1.yours).toEqual({ ownerUnits: 100, currentEraOwnerUnits: 0, earlierEraOwnerUnits: 100, patronUnits: 0, actions: 2 })
    expect(a1.eras.map((e) => [e.era, e.current, e.yours, e.ownerUnits, e.patronUnits, e.actions, e.tierBefore, e.tierAfter])).toEqual([
      [2, true, false, 50, 0, 1, 1, 2],
      [1, false, true, 100, 100, 4, 0, 1],
    ])
    expect(a1.unattributed).toEqual({ patronUnits: 0, actions: 0 })
    expect(a1.contributors).toEqual({ owners: 2, patrons: 2 })
    // K1, as Bea sees it: the current controller, her era's 50 units, and her earlier patron step apart. Ada's 100 are not hers.
    const b1a = told(await w.legacy(bea, k1.id))
    expect(b1a).toMatchObject({ founding: 'other', control: 'viewer' })
    expect(b1a.investment).toEqual(a1.investment)
    expect(b1a.yours).toEqual({ ownerUnits: 50, currentEraOwnerUnits: 50, earlierEraOwnerUnits: 0, patronUnits: 50, actions: 2 })
    expect(b1a.eras.map((e) => [e.era, e.current, e.yours])).toEqual([
      [2, true, true],
      [1, false, false],
    ])
    // 12. K1, as Cy sees it: no control, a patron's 50 units, nothing of anyone else's identity.
    const c1 = told(await w.legacy(cy, k1.id))
    expect(c1).toMatchObject({ founding: 'other', control: 'other' })
    expect(c1.yours).toEqual({ ownerUnits: 0, currentEraOwnerUnits: 0, earlierEraOwnerUnits: 0, patronUnits: 50, actions: 1 })
    expect(c1.eras.every((e) => !e.yours)).toBe(true)

    // 8. Tiers 0, 1 and 2, and a property nobody built (no era, no investment).
    const tiers = await Promise.all([k1, k2, k3, k4, k5].map(async (p) => told(await w.legacy(cy, p.id)).property.tier))
    expect(tiers).toEqual([2, 0, 0, 1, 0])
    const l3 = told(await w.legacy(ada, k3.id))
    expect(l3).toMatchObject({ control: 'unknown', eras: [], eraCount: 0, unattributed: { patronUnits: 50, actions: 1 }, investment: { currentController: 0, previousControllers: 0, community: 50, total: 50 } })
    const l5 = told(await w.legacy(cy, k5.id))
    expect(l5).toMatchObject({ founding: 'viewer', eras: [], unattributed: { patronUnits: 0, actions: 0 }, investment: { currentController: 0, previousControllers: 0, community: 0, total: 0 }, yours: { actions: 0 }, designs: [], designCount: 0 })
    // 2. K2: founded by Ada, controlled by Bea. Founding is not controlling.
    expect(told(await w.legacy(ada, k2.id))).toMatchObject({ founding: 'viewer', control: 'other', investment: { currentController: 50, previousControllers: 0 }, yours: { actions: 0 } })
    expect(told(await w.legacy(bea, k2.id))).toMatchObject({ founding: 'other', control: 'viewer', yours: { ownerUnits: 50, currentEraOwnerUnits: 50 } })

    // 1, 3, 5, 7. The portfolios: each player's own record, never another's.
    const ap = await w.architect(ada)
    expect(ap.totals).toMatchObject({ ownerUnits: 100, currentEraOwnerUnits: 0, earlierEraOwnerUnits: 100, patronUnits: 100, ownerActions: 2, patronActions: 2, propertiesDeveloped: 3, propertiesDevelopedAsOwner: 1 })
    expect(Object.fromEntries(ap.properties.map((a) => [a.propertyId, [a.founded, a.control]]))).toEqual({ [k1.id]: [true, 'other'], [k2.id]: [true, 'other'], [k3.id]: [true, 'unknown'], [k4.id]: [false, 'other'] })
    const bp = await w.architect(bea)
    // Bea inherited K1, not Ada's 100 owner units on it: her own are her era's 50 and K2's and K4's.
    expect(bp.totals).toMatchObject({ ownerUnits: 150, currentEraOwnerUnits: 150, earlierEraOwnerUnits: 0, patronUnits: 50 })
    expect(bp.properties.find((a) => a.propertyId === k1.id)).toMatchObject({ founded: false, control: 'viewer', yours: { ownerUnits: 50, currentEraOwnerUnits: 50, patronUnits: 50 } })
    const cp = await w.architect(cy)
    expect(cp.totals).toMatchObject({ ownerUnits: 0, patronUnits: 50 })
    expect(cp.properties.map((a) => a.propertyId).sort()).toEqual([k1.id, k5.id].sort())

    // 11. Nothing counted twice or invented: every player's own units, added up, are exactly every property's lifetime units,
    // by owner and patron; and those are exactly the construction records of this world.
    const legacies = await Promise.all([k1, k2, k3, k4, k5].map(async (p) => told(await w.legacy(cy, p.id))))
    const portfolios = [ap, bp, cp]
    const ownerByPlayers = portfolios.reduce((n, p) => n + p.totals.ownerUnits, 0)
    const patronByPlayers = portfolios.reduce((n, p) => n + p.totals.patronUnits, 0)
    expect(ownerByPlayers).toBe(legacies.reduce((n, l) => n + l.investment.currentController + l.investment.previousControllers, 0))
    expect(patronByPlayers).toBe(legacies.reduce((n, l) => n + l.investment.community, 0))
    const recorded = await t.db.query<{ role: string; n: number }>('SELECT role, sum(units)::int AS n FROM world_property_constructions WHERE world_id = $1 GROUP BY role ORDER BY role', [ada.response.world.id])
    expect(recorded.rows).toEqual([
      { role: 'owner', n: ownerByPlayers },
      { role: 'patron', n: patronByPlayers },
    ])
    expect(legacies.reduce((n, l) => n + l.investment.total, 0)).toBe(ownerByPlayers + patronByPlayers)
    for (const l of [...legacies, a1, b1a, c1]) {
      for (const v of [...Object.values(l.investment), ...Object.values(l.yours), ...l.eras.flatMap((e) => [e.ownerUnits, e.patronUnits])]) expect(v).toBeGreaterThanOrEqual(0)
    }

    // 6, 14. World B is apart: its property is no property of world A, its units are in no sum of world A, and the other way round.
    const bLegacy = told(await w.legacy(adaB, b1.id))
    expect(bLegacy).toMatchObject({ founding: 'other', control: 'viewer', investment: { currentController: 150, previousControllers: 0, community: 0, total: 150 }, yours: { ownerUnits: 150 } })
    expect(bLegacy.property.foundingOrder).toBe(1)
    for (const [o, id] of [
      [ada, b1.id],
      [adaB, k1.id],
    ] as const)
      await expect(w.legacy(o, id)).rejects.toMatchObject({ code: 'unknown_property' })
    expect((await w.architect(adaB)).totals).toMatchObject({ ownerUnits: 150, patronUnits: 0 })
    expect(ap.properties.some((a) => a.propertyId === b1.id)).toBe(false)

    // 13. No other player's id, and no claim of verified ownership, in any answer.
    for (const [viewer, l] of [
      [ADA, a1],
      [BEA, b1a],
      [CY, c1],
    ] as const) {
      const text = JSON.stringify(legacyView(await w.legacy(viewer === ADA ? ada : viewer === BEA ? bea : cy, k1.id)))
      for (const id of IDS.filter((x) => x !== viewer.discordUserId && x !== viewer.coreUserId)) expect(text).not.toContain(id)
      expect(text).not.toMatch(/verified":true|"rank|"level|"xp|"badge|"reward/i)
      expect(l.property.propertyId).toBe(k1.id)
    }

    // 17. Repeated reads changed nothing, anywhere: every row of every table, and the transaction that wrote it.
    for (let i = 0; i < 3; i++) {
      for (const o of [ada, bea, cy]) {
        await w.legacy(o, k1.id)
        await w.architect(o)
      }
    }
    expect(await w.snapshot()).toEqual(before)
    expect((await verifyCity(t.db)).violations).toEqual([])
  })

  it('9-10. v1, v2, v3 and v4 design history by relation; the new controller inherits the design, not the record; a design is never a unit, credit or progress', async () => {
    // A database as E4A (0015: v1), E4B (0016: v2) and E4C (0017: v3) wrote it, then the current one.
    const through = async (last: number) => {
      const dir = await t.migrationsPlus([])
      const out = await mkdtemp(join(tmpdir(), `rc-legacy-${last}-`))
      for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) <= last)) await copyFile(join(dir, f), join(out, f))
      return out
    }
    await migrate(t.db, { dir: await through(15), environment: 'local' })
    const w = await world({ migrated: true })
    const ada = await w.env.open(INSTALLATION_A, ADA)
    const bea = await w.env.open(INSTALLATION_A, BEA)
    const k1 = await w.place(ada, keeper(1))
    w.source.control(GUILD_A, keeper(1), ADA)
    w.source.grant(GUILD_A, ADA, [{ key: 'starter', units: 200 }])
    await w.build(ada, k1.id, 'owner')
    /** A row exactly as the E4A (v1), E4B (v2) or E4C (v3) store wrote it, through that build's guard. */
    const written = async (o: OpenedPlaySession, revision: number, design: { facade: string; roof: string; windows?: string; lighting?: string; entrance?: string; landscaping?: string }) => {
      const session = await w.env.sessions.session(o.token)
      const c = await t.db.connect()
      try {
        await c.query('BEGIN')
        const r = (await c.query<{ city_id: string; city_instance_id: string; sequence: string }>('SELECT w.city_id, w.city_instance_id, c.sequence FROM worlds w JOIN city c ON c.id = w.city_id AND c.instance_id = w.city_instance_id WHERE w.id = $1 FOR UPDATE OF c', [session.scope.worldId])).rows[0]
        const v2 = design.windows !== undefined
        const v3 = design.entrance !== undefined
        await c.query(
          `INSERT INTO world_property_designs (world_id, city_id, city_instance_id, property_id, revision, action_id, catalog, facade, roof, ${v2 ? 'windows, lighting, ' : ''}${v3 ? 'entrance, landscaping, ' : ''}designer_core_user_id, designer_discord_user_id, designed_in_play_session, authority, at_city_sequence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ${v2 ? '$14, $15, ' : ''}${v3 ? '$16, $17, ' : ''}$10, $11, $12, 'local-fixture-controller', $13)`,
          [
            session.scope.worldId,
            r.city_id,
            r.city_instance_id,
            k1.id,
            revision,
            randomUUID(),
            v3 ? 'architect-design-v3' : v2 ? 'architect-design-v2' : 'architect-design-v1',
            design.facade,
            design.roof,
            session.player.coreUserId,
            session.player.discordUserId,
            session.id,
            r.sequence,
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
    }
    await written(ada, 1, { facade: 'brick', roof: 'dome' })
    await migrate(t.db, { dir: await through(16), environment: 'local' })
    await written(ada, 2, { facade: 'copper', roof: 'spire', windows: 'arched', lighting: 'warm' })
    await migrate(t.db, { dir: await through(17), environment: 'local' })
    await written(ada, 3, { facade: 'limestone', roof: 'flat', windows: 'ribbon', lighting: 'cool', entrance: 'canopy', landscaping: 'garden' })
    await migrate(t.db, { dir: (await t.migrationsPlus([])), environment: 'local' })

    const credits = async () => (await t.db.query('SELECT to_jsonb(e) AS r FROM world_test_credit_entries e ORDER BY world_id, account_discord_user_id, entry_seq')).rows
    const constructions = async () => (await t.db.query('SELECT to_jsonb(c) AS r FROM world_property_constructions c ORDER BY sequence')).rows
    const sequence = async () => (await t.db.query<{ s: string }>('SELECT c.sequence AS s FROM city c JOIN worlds w ON w.city_id = c.id WHERE w.id = $1', [ada.response.world.id])).rows[0].s
    const ledgerBefore = await credits()
    const constructionsBefore = await constructions()
    const sequenceBefore = await sequence()
    /** What a design save must leave exactly as it was: the viewer's Architect record and the property's construction side. */
    const progress = async (o: OpenedPlaySession) => {
      const l = told(await w.legacy(o, k1.id))
      return { totals: (await w.architect(o)).totals, investment: l.investment, yours: l.yours, property: l.property, eras: l.eras }
    }

    // Ada saves a v4 revision: her record and the property's construction are as they were.
    const save = (o: OpenedPlaySession, baseRevision: number, d: { facade: string; roof: string; entrance: string; landscaping: string; color: string }) =>
      w.designer.save(o.token, w.env.actorOf(o), { propertyId: k1.id, actionId: randomUUID(), baseRevision, catalog: 'architect-design-v4', windows: 'grid', lighting: 'standard', ...d })
    const adaBefore = await progress(ada)
    await save(ada, 3, { facade: 'jade', roof: 'terrace', entrance: 'portico', landscaping: 'garden', color: 'natural' })
    expect(await progress(ada)).toEqual(adaBefore)
    // Then the file names Bea the controller (Ada's 50 owner units move to earlier control, as a transfer does), and Bea saves one.
    w.source.control(GUILD_A, keeper(1), BEA)
    const afterTransfer = { ada: await progress(ada), bea: await progress(bea) }
    expect(afterTransfer.ada.totals).toMatchObject({ ownerUnits: 50, currentEraOwnerUnits: 0, earlierEraOwnerUnits: 50 })
    await save(bea, 4, { facade: 'jade', roof: 'terrace', entrance: 'portico', landscaping: 'courtyard', color: 'terracotta' })
    expect({ ada: await progress(ada), bea: await progress(bea) }).toEqual(afterTransfer)

    // 10. Not a unit, credit or sequence: everything construction-side is exactly as it was.
    expect(await credits()).toEqual(ledgerBefore)
    expect(await constructions()).toEqual(constructionsBefore)
    expect(await sequence()).toBe(sequenceBefore)
    const ad = told(await w.legacy(ada, k1.id))

    // 9. Five revisions, newest first, each read by its catalog and told by relation only: the property keeps the color the
    // new controller chose, and every earlier revision keeps exactly what it named (none of them a color).
    expect(ad.designCount).toBe(5)
    expect(ad.designs.map((d) => [d.revision, d.catalog, d.facade, d.roof, d.windows, d.lighting, d.entrance, d.landscaping, d.color, d.by, d.savedBy])).toEqual([
      [5, 'architect-design-v4', 'jade', 'terrace', 'grid', 'standard', 'portico', 'courtyard', 'terracotta', 'other', 'current-controller'],
      [4, 'architect-design-v4', 'jade', 'terrace', 'grid', 'standard', 'portico', 'garden', 'natural', 'viewer', 'earlier-controller'],
      [3, 'architect-design-v3', 'limestone', 'flat', 'ribbon', 'cool', 'canopy', 'garden', null, 'viewer', 'earlier-controller'],
      [2, 'architect-design-v2', 'copper', 'spire', 'arched', 'warm', null, null, null, 'viewer', 'earlier-controller'],
      [1, 'architect-design-v1', 'brick', 'dome', null, null, null, null, null, 'viewer', 'earlier-controller'],
    ])
    // Bea, the new controller: the property's design history, none of it hers but revision 5; Ada's founding is untouched.
    const bd = told(await w.legacy(bea, k1.id))
    expect(bd).toMatchObject({ founding: 'other', control: 'viewer', yours: { actions: 0, ownerUnits: 0 } })
    expect(bd.designs.map((d) => [d.revision, d.by, d.savedBy])).toEqual([
      [5, 'viewer', 'current-controller'],
      [4, 'other', 'earlier-controller'],
      [3, 'other', 'earlier-controller'],
      [2, 'other', 'earlier-controller'],
      [1, 'other', 'earlier-controller'],
    ])
    expect((await w.architect(bea)).totals).toMatchObject({ ownerUnits: 0, patronUnits: 0 })
    expect((await verifyCity(t.db)).violations).toEqual([])
  })

  it('names exactly one property of the session\'s own world; a city whose file has no data is still told (read only, nobody in control)', async () => {
    const w = await world()
    const ada = await w.env.open(INSTALLATION_A, ADA)
    const k1 = await w.place(ada, keeper(1))
    for (const bad of [null, 7, 'k1', `${k1.id}x`, k1.id.toUpperCase(), randomUUID()]) {
      const err = await w.legacy(ada, bad).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(WorldConstructionRefusal)
      expect((err as WorldConstructionRefusal).code).toBe('unknown_property')
    }
    w.source.close(GUILD_A)
    expect(told(await w.legacy(ada, k1.id))).toMatchObject({ open: false, control: 'unknown', founding: 'viewer', investment: { total: 0 } })
  })

  it('AUDIT A, B, C, G, H, I. no controller after an era; B → C → B without building; one designer across separate control; personal units stay personal; patron units once', async () => {
    const w = await world()
    const ada = await w.env.open(INSTALLATION_A, ADA)
    const bea = await w.env.open(INSTALLATION_A, BEA)
    const cy = await w.env.open(INSTALLATION_A, CY)
    const k1 = await w.place(ada, keeper(1))
    const k2 = await w.place(ada, keeper(2))
    for (const p of [ADA, BEA, CY]) w.source.grant(GUILD_A, p, [{ key: 'starter', units: 500 }])
    const records = async (propertyId: string) => (await t.db.query<{ role: string; n: number }>('SELECT role, sum(units)::int AS n FROM world_property_constructions WHERE property_id = $1 GROUP BY role ORDER BY role', [propertyId])).rows

    // A. Bea controls K1 and builds (era 1); then the file names nobody, and Cy builds as a patron after that era.
    w.source.control(GUILD_A, keeper(1), BEA)
    const b1 = await w.build(bea, k1.id, 'owner')
    w.source.control(GUILD_A, keeper(1), null)
    const c1 = await w.build(cy, k1.id, 'patron')
    expect(c1.construction.sequence).toBeGreaterThan(b1.construction.sequence)
    expect(c1.construction.era).toBeNull()
    const a = told(await w.legacy(cy, k1.id))
    // Counted once: in the patrons' total and the no-controller units, in no era.
    expect(a.unattributed).toEqual({ patronUnits: 50, actions: 1 })
    expect(a.eras.map((e) => [e.era, e.current, e.ownerUnits, e.patronUnits, e.actions])).toEqual([[1, false, 50, 0, 1]])
    expect(a.investment).toEqual({ currentController: 0, previousControllers: 50, community: 50, total: 100 })
    expect(await records(k1.id)).toEqual([
      { role: 'owner', n: 50 },
      { role: 'patron', n: 50 },
    ])
    // I. Nobody named: nobody is current, nobody saves as the current controller, and the former controller's units are earlier.
    expect(a.control).toBe('unknown')
    expect(a.eras.some((e) => e.current)).toBe(false)
    const ab = told(await w.legacy(bea, k1.id))
    expect(ab).toMatchObject({ control: 'unknown', yours: { ownerUnits: 50, currentEraOwnerUnits: 0, earlierEraOwnerUnits: 50 } })
    expect((await w.architect(bea)).totals).toMatchObject({ ownerUnits: 50, currentEraOwnerUnits: 0, earlierEraOwnerUnits: 50 })
    expect((await w.architect(bea)).properties.find((p) => p.propertyId === k1.id)).toMatchObject({ control: 'unknown' })

    // B, G. K2: Bea builds (era 1); the file names Cy (nobody builds); then Bea again. No era is invented for Cy.
    w.source.control(GUILD_A, keeper(2), BEA)
    await w.build(bea, k2.id, 'owner')
    w.source.control(GUILD_A, keeper(2), CY)
    const underCy = told(await w.legacy(cy, k2.id))
    expect(underCy).toMatchObject({ control: 'viewer', eraCount: 1, investment: { currentController: 0, previousControllers: 50, community: 0, total: 50 }, yours: { actions: 0 } })
    expect(underCy.eras.map((e) => [e.era, e.current, e.yours])).toEqual([[1, false, false]])
    // G. Bea's 50 stay hers (earlier now); Cy, named now, has none of them.
    expect((await w.architect(cy)).totals).toMatchObject({ ownerUnits: 0, currentEraOwnerUnits: 0 })
    expect((await w.architect(cy)).properties.find((p) => p.propertyId === k2.id)).toMatchObject({ control: 'viewer', yours: { ownerUnits: 0 } })
    expect(told(await w.legacy(bea, k2.id)).yours).toEqual({ ownerUnits: 50, currentEraOwnerUnits: 0, earlierEraOwnerUnits: 50, patronUnits: 0, actions: 1 })
    // Back to Bea: still one recorded era (the change through Cy left none), its controller named now again.
    w.source.control(GUILD_A, keeper(2), BEA)
    const back = told(await w.legacy(bea, k2.id))
    expect(back).toMatchObject({ control: 'viewer', eraCount: 1, investment: { currentController: 50, previousControllers: 0 } })
    expect(back.eras.map((e) => [e.era, e.current, e.yours])).toEqual([[1, true, true]])

    // C. Ada saves a design on K2 while she controls it; Bea controls it; Ada controls it again. Designs make no era.
    const save = (o: OpenedPlaySession, baseRevision: number, facade: string) =>
      w.designer.save(o.token, w.env.actorOf(o), { propertyId: k2.id, actionId: randomUUID(), baseRevision, catalog: 'architect-design-v4', facade, roof: 'dome', windows: 'grid', lighting: 'standard', entrance: 'standard', landscaping: 'standard', color: 'natural' })
    w.source.control(GUILD_A, keeper(2), ADA)
    await save(ada, 0, 'copper')
    w.source.control(GUILD_A, keeper(2), BEA)
    await save(bea, 1, 'jade')
    w.source.control(GUILD_A, keeper(2), ADA)
    const aba = told(await w.legacy(ada, k2.id))
    // savedBy relates the designer to the controller named now, not to the period: Ada's revision 1 is hers, now "current".
    expect(aba.designs.map((d) => [d.revision, d.by, d.savedBy])).toEqual([
      [2, 'other', 'earlier-controller'],
      [1, 'viewer', 'current-controller'],
    ])
    expect(aba.eraCount).toBe(1)
    expect(aba.eras.map((e) => [e.current, e.yours])).toEqual([[false, false]])

    // H. Cy, a patron of K1, is later named its controller and builds as owner: 50 patron and 50 owner, each counted once.
    w.source.control(GUILD_A, keeper(1), CY)
    await w.build(cy, k1.id, 'owner')
    const h = told(await w.legacy(cy, k1.id))
    expect(h.investment).toEqual({ currentController: 50, previousControllers: 50, community: 50, total: 150 })
    expect(h.yours).toEqual({ ownerUnits: 50, currentEraOwnerUnits: 50, earlierEraOwnerUnits: 0, patronUnits: 50, actions: 2 })
    expect(h.eras.map((e) => [e.era, e.current, e.yours, e.ownerUnits, e.patronUnits])).toEqual([
      [2, true, true, 50, 0],
      [1, false, false, 50, 0],
    ])
    expect(h.unattributed).toEqual({ patronUnits: 50, actions: 1 })
    expect((await w.architect(cy)).totals).toMatchObject({ ownerUnits: 50, patronUnits: 50, ownerActions: 1, patronActions: 1 })
    const all = [await w.architect(ada), await w.architect(bea), await w.architect(cy)]
    const recorded = await t.db.query<{ role: string; n: number }>('SELECT role, sum(units)::int AS n FROM world_property_constructions WHERE world_id = $1 GROUP BY role ORDER BY role', [ada.response.world.id])
    expect(recorded.rows).toEqual([
      { role: 'owner', n: all.reduce((n, p) => n + p.totals.ownerUnits, 0) },
      { role: 'patron', n: all.reduce((n, p) => n + p.totals.patronUnits, 0) },
    ])
    expect((await verifyCity(t.db)).violations).toEqual([])
  })

  it('AUDIT E, F, I2. more than 50 ACTIVE properties: 50 listed, every one counted in the totals, and each listed one still exact', async () => {
    const w = await world()
    const ada = await w.env.open(INSTALLATION_A, ADA)
    const bea = await w.env.open(INSTALLATION_A, BEA)
    const N = ARCHITECT_PROPERTY_LIMIT + 3
    // Grants are bounded one by one (0013): several, enough for a step on every property.
    const grants = Array.from({ length: Math.ceil(N / 10) }, (_, i) => ({ key: `starter-${i}`, units: 500 }))
    w.source.grant(GUILD_A, ADA, grants)
    w.source.grant(GUILD_A, BEA, grants)
    const placed: { id: string }[] = []
    for (let n = 1; n <= N; n++) {
      const p = await w.place(ada, keeper(100 + n))
      placed.push(p)
      // Every one built on by Ada, as its controller; Bea a patron of the even ones too. So the properties the cap leaves out
      // (Ada's oldest activity) hold Ada's own units: totals over the listed ones only would be short.
      w.source.control(GUILD_A, keeper(100 + n), ADA)
      await w.build(ada, p.id, 'owner')
      if (n % 2 === 0) await w.build(bea, p.id, 'patron')
    }
    const owned = N
    const patroned = Math.floor(N / 2)
    const ap = await w.architect(ada)
    expect(ap.propertyCount).toBe(N)
    expect(ap.properties).toHaveLength(ARCHITECT_PROPERTY_LIMIT)
    // F. The totals are of every property, listed or not.
    expect(ap.totals).toMatchObject({ ownerUnits: 50 * owned, currentEraOwnerUnits: 50 * owned, earlierEraOwnerUnits: 0, ownerActions: owned, propertiesDeveloped: owned, propertiesDevelopedAsOwner: owned, patronUnits: 0 })
    const bp = await w.architect(bea)
    expect(bp.propertyCount).toBe(patroned)
    expect(bp.totals).toMatchObject({ patronUnits: 50 * patroned, ownerUnits: 0, propertiesDeveloped: patroned })
    // Most recent activity first: the three left out are Ada's three oldest, each holding 50 of her units the totals still count.
    const listed = new Set(ap.properties.map((a) => a.propertyId))
    expect(placed.filter((p) => !listed.has(p.id)).map((p) => p.id)).toEqual(placed.slice(0, 3).map((p) => p.id))
    expect(ap.properties.reduce((n, a) => n + a.yours.ownerUnits, 0)).toBe(ap.totals.ownerUnits - 3 * 50)
    // Every property still tells its legacy exactly, listed in the portfolio or not.
    for (const [i, p] of placed.slice(0, 3).entries())
      expect(told(await w.legacy(ada, p.id))).toMatchObject({ yours: { ownerUnits: 50 }, investment: { currentController: 50, community: i % 2 ? 50 : 0 } })
    // Read again: the same answer (nothing counted again).
    expect(await w.architect(ada)).toEqual(ap)
  })
})
