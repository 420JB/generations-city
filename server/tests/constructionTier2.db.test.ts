import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { persistedBrandCityState } from '../../src/brand/core/persisted'
import { parsePlayCityConfig } from '../../src/brand/core/playConfig'
import { tierFor, totalBuilt } from '../../src/game/economy'
import { LOCAL_TEST_TIER1_RECIPE } from '../../src/world/construction'
import { verifyCity } from '../src/city/verify'
import { migrate } from '../src/db/migrations'
import { assetKey, parseWorldCityState, type NftAsset } from '../src/engine'
import { silentLogger } from '../src/log'
import { PlaySessionError, type OpenedPlaySession } from '../src/play/session'
import { createConstructionService, createWorldConstructionStore, WorldConstructionRefusal, type ConstructionAuthority, type TestCreditGrant, type WorldConstructionStore } from '../src/world/construction'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'
import { ADA, BEA, GUILD_A, GUILD_B, INSTALLATION_A, INSTALLATION_B } from './fakePlay'
import { keeper, ticketWorld } from './ticketHarness'

/**
 * TIER 2 LOCAL TEST CONSTRUCTION AND ARCHITECT ACTIVITY (P1-C2-E3B, migration 0014) against a disposable Postgres, through
 * the real launch path, session service, ticket, property and construction stores.
 *
 *   RECIPE     `local-test-tier2-v1` (provisional): the E3A recipe up to Tier 1, then Tier 2 at 250, nothing above; every
 *              step server-computed, stopping at each threshold;
 *   E3A DATA   a database an E3A build wrote (0013, `local-test-tier1-v1` records) takes 0014 unchanged, answers its old
 *              presses with their own records, and continues to Tier 2; the retired recipe builds nothing more;
 *   ARCHITECT  a player's own record: owner units split by control era (theirs now, earlier), patron units apart, and
 *              never anyone else's; a new controller starts from none of the previous owner's;
 *   VERIFY     city:verify finds tampered tiers, steps, recipes and ledgers.
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
    control: (guild: string, asset: NftAsset, who: { discordUserId: string } | null) => (who ? controllers.set(`${guild}|${assetKey(asset)}`, who.discordUserId) : controllers.delete(`${guild}|${assetKey(asset)}`)),
    grant: (guild: string, who: { discordUserId: string }, list: TestCreditGrant[]) => grants.set(`${guild}|${who.discordUserId}`, list),
  }
}

async function refusalOf(work: Promise<unknown>): Promise<string> {
  const err = await work.then(
    () => null,
    (e: unknown) => e,
  )
  if (err instanceof WorldConstructionRefusal || err instanceof PlaySessionError) return err.code
  throw err ?? new Error('expected a refusal, got success')
}

describe.skipIf(NO_TEST_DATABASE)('Tier 2 construction and Architect activity (migration 0014) against a disposable Postgres', () => {
  const t = useTestSchema()
  const { setup, one, sequenceOf } = ticketWorld(t)

  async function world(options: { migrated?: boolean; store?: (db: pg.Pool) => WorldConstructionStore } = {}) {
    const env = await setup({ migrated: options.migrated })
    const source = testAuthority()
    const makeStore = options.store ?? ((db) => createWorldConstructionStore(db, { mode: 'local', log: silentLogger }))
    let store = makeStore(t.db)
    let service = createConstructionService({ sessions: env.sessions, store, authority: source.authority })
    const place = async (o: OpenedPlaySession, asset: NftAsset) => {
      const ticket = await env.ticketOf(o, [asset])
      const city = await env.sessions.city(await env.sessions.session(o.token))
      const plot = city.world.districts.find((d) => d.key === ticket.districtKey)!.candidates.plotIds[0]
      return (await env.activate(o, ticket, asset, plot)).property
    }
    const build = (o: OpenedPlaySession, propertyId: string, role: 'owner' | 'patron', actionId: string = randomUUID()) => service.construct(o.token, env.actorOf(o), { propertyId, role, actionId })
    const overview = async (o: OpenedPlaySession, propertyId: string) => store.overview(await env.sessions.session(o.token), propertyId, source.authority)
    const architect = async (o: OpenedPlaySession) => store.architect(await env.sessions.session(o.token), source.authority)
    /** From now on, construct through another store (an upgraded build). */
    const upgrade = (next: WorldConstructionStore) => {
      store = next
      service = createConstructionService({ sessions: env.sessions, store, authority: source.authority })
    }
    const ledger = (worldId: string, who: { discordUserId: string }) =>
      t.db
        .query<{ kind: string; delta: number; balance_after: number }>('SELECT kind, delta, balance_after FROM world_test_credit_entries WHERE world_id = $1 AND account_discord_user_id = $2 ORDER BY entry_seq', [worldId, who.discordUserId])
        .then((r) => r.rows)
    const constructionsOf = (propertyId: string) =>
      t.db
        .query<{ sequence: string; recipe: string; role: string; units: number; built_after: number; tier_after: number; control_era_seq: number | null; contributor_discord_user_id: string }>(
          'SELECT sequence, recipe, role, units, built_after, tier_after, control_era_seq, contributor_discord_user_id FROM world_property_constructions WHERE property_id = $1 ORDER BY sequence',
          [propertyId],
        )
        .then((r) => r.rows)
    const stateOf = async (worldId: string) => parseWorldCityState((await one<{ state: unknown }>('SELECT c.state FROM city c JOIN worlds w ON w.city_id = c.id WHERE w.id = $1', [worldId])).state)
    const drawnTier = async (o: OpenedPlaySession, buildingId: string) => {
      const city = await env.sessions.city(await env.sessions.session(o.token))
      const parsed = parsePlayCityConfig(city.config, o.response.world.id)
      if (!parsed.ok) throw new Error('config')
      const drawn = persistedBrandCityState(parsed.config, city.world.state)
      return { tier: tierFor(totalBuilt(drawn.buildings[buildingId])), built: totalBuilt(drawn.buildings[buildingId]), drawn }
    }
    const violations = async () => (await verifyCity(t.db)).violations
    return { env, source, place, build, overview, architect, upgrade, ledger, constructionsOf, stateOf, drawnTier, violations, store: () => store }
  }

  it('1-4, 14-15, 22. a Tier 1 property continues to Tier 2 in three server-computed steps, then is complete; drawn taller; identity and founder never move; no Crown or Capital', async () => {
    const w = await world()
    const a = await w.env.open(INSTALLATION_A, ADA)
    const p = await w.place(a, keeper(1))
    const worldId = a.response.world.id
    w.source.control(GUILD_A, keeper(1), ADA)
    w.source.grant(GUILD_A, ADA, [{ key: 'starter', units: 300 }])
    const propertyRow = async () => one('SELECT to_jsonb(p) AS row FROM world_properties p WHERE id = $1', [p.id])
    const before = await propertyRow()

    // 1. Tier 0 to Tier 1, exactly as E3A built it (now by the current recipe).
    await w.build(a, p.id, 'owner')
    const t1 = await w.build(a, p.id, 'owner')
    expect(t1.construction).toMatchObject({ recipe: 'local-test-tier2-v1', builtAfter: 100, tierBefore: 0, tierAfter: 1 })
    const tier1 = await w.drawnTier(a, p.buildingId)
    expect(tier1.tier).toBe(1)

    // 2. Tier 1 begins Tier 2: the next goal is 250 lifetime units.
    const o1 = await w.overview(a, p.id)
    expect(o1.property).toEqual({ propertyId: p.id, buildingId: p.buildingId, tier: 1, built: 100, nextTierAt: 250, maxTier: 2 })
    expect(o1.standing).toEqual({ kind: 'ready', role: 'owner', units: 50 })
    const steps = []
    for (let i = 0; i < 3; i++) steps.push(await w.build(a, p.id, 'owner'))
    // 3. Meaningful progress between, and Tier 2 at exactly 250.
    expect(steps.map((s) => [s.construction.builtBefore, s.construction.builtAfter, s.construction.tierBefore, s.construction.tierAfter])).toEqual([
      [100, 150, 1, 1],
      [150, 200, 1, 1],
      [200, 250, 1, 2],
    ])
    expect(steps.map((s) => s.balance)).toEqual([150, 100, 50])
    expect(await refusalOf(w.build(a, p.id, 'owner'))).toBe('construction_complete')
    const done = await w.overview(a, p.id)
    expect(done.property).toMatchObject({ tier: 2, built: 250, nextTierAt: null, maxTier: 2 })
    expect(done.standing).toEqual({ kind: 'complete' })
    expect(done.history.map((h) => [h.recipe, h.tierAfter])).toEqual([
      ['local-test-tier2-v1', 2],
      ['local-test-tier2-v1', 1],
      ['local-test-tier2-v1', 1],
      ['local-test-tier2-v1', 1],
      ['local-test-tier2-v1', 0],
    ])
    expect((await w.stateOf(worldId))!).toMatchObject({ version: 3, development: { [p.buildingId]: { tier: 2, built: 250 } } })
    const event = await one<{ payload: Record<string, unknown> }>('SELECT payload FROM city_events e JOIN worlds w ON w.city_id = e.city_id WHERE w.id = $1 AND e.sequence = $2', [worldId, steps[2].construction.sequence])
    expect(event.payload).toMatchObject({ recipe: 'local-test-tier2-v1', builtBefore: 200, builtAfter: 250, tierBefore: 1, tierAfter: 2 })

    // 4. The building as the city draws it is now the renderer's Tier 2: taller than at Tier 1, on the same plot.
    const tier2 = await w.drawnTier(a, p.buildingId)
    expect(tier2.tier).toBe(2)
    expect(tier2.built).toBeGreaterThan(tier1.built)
    expect(tier2.drawn.buildings[p.buildingId]).toMatchObject({ districtId: p.districtKey, ward: p.ward, plot: p.plot })
    // 22. Valueless test construction earns no canonical Crown, Capital or monument, at Tier 2 either.
    expect(tier2.drawn.crown.holder).toBeNull()
    expect(tier2.drawn.capital.holder).toBeNull()
    expect(Object.values(tier2.drawn.monuments).every((m) => m.holder === null)).toBe(true)

    // 14-15. The founder, the property, its NFT and plot are exactly as activated.
    expect(await propertyRow()).toEqual(before)
    expect((await w.stateOf(worldId))!.buildings[p.buildingId]).toEqual({ propertyId: p.id, asset: p.asset, collection: p.collection, districtKey: p.districtKey, ward: p.ward, plot: p.plot, sequence: p.sequence })
    expect(await w.violations()).toEqual([])
  })

  it('5-8. a repeated or lost Tier 2 press never pays twice; concurrent presses serialize to exactly 250; a short balance writes nothing', async () => {
    const w = await world()
    const a = await w.env.open(INSTALLATION_A, ADA)
    const p = await w.place(a, keeper(1))
    const q = await w.place(a, keeper(2))
    const worldId = a.response.world.id
    for (const k of [1, 2]) w.source.control(GUILD_A, keeper(k), ADA)
    w.source.grant(GUILD_A, ADA, [{ key: 'starter', units: 150 }])
    await w.build(a, p.id, 'owner')
    await w.build(a, p.id, 'owner')

    // 5-6. A Tier 2 press whose answer was lost: the same id again, through a later session too, is the same construction.
    const action = randomUUID()
    const first = await w.build(a, p.id, 'owner', action)
    expect(first).toMatchObject({ fresh: true, balance: 0, construction: { builtAfter: 150, tierAfter: 1 } })
    const again = await w.build(a, p.id, 'owner', action)
    expect(again).toMatchObject({ fresh: false, balance: 0 })
    expect(again.construction).toEqual(first.construction)
    // A relaunch (a new session of the same player, replacing this one) asks again with the same press.
    const later = await w.env.open(INSTALLATION_A, ADA, a.token)
    const relaunched = await w.build(later, p.id, 'owner', action)
    expect(relaunched).toMatchObject({ fresh: false, balance: 0 })
    expect(relaunched.construction).toEqual(first.construction)
    // Twin requests at once with one id, and the balance spent: one record, one debit.
    expect((await Promise.all([w.build(later, p.id, 'owner', action), w.build(later, p.id, 'owner', action)])).map((r) => r.fresh)).toEqual([false, false])
    expect((await w.ledger(worldId, ADA)).filter((e) => e.kind === 'construction-debit').map((e) => e.delta)).toEqual([-50, -50, -50])

    // 8. Nothing left: refused before anything is written, and the property stays where it was.
    const at = await sequenceOf(worldId)
    expect(await refusalOf(w.build(later, p.id, 'owner'))).toBe('insufficient_test_credits')
    expect(await sequenceOf(worldId)).toBe(at)
    expect((await w.overview(later, p.id)).standing).toEqual({ kind: 'insufficient', role: 'owner', units: 50 })

    // 7. Credits for exactly one more step, two different presses at once on two properties: one builds.
    w.source.grant(GUILD_A, ADA, [
      { key: 'starter', units: 150 },
      { key: 'top-up', units: 50 },
    ])
    const pair = await Promise.allSettled([w.build(later, p.id, 'owner'), w.build(later, q.id, 'owner')])
    expect(pair.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(((pair.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as WorldConstructionRefusal).code).toBe('insufficient_test_credits')

    // Plenty of credits, many presses on one property at once: the city lock takes them one by one, to exactly 250, never past it.
    w.source.grant(GUILD_A, ADA, [
      { key: 'starter', units: 150 },
      { key: 'top-up', units: 50 },
      { key: 'crowd', units: 500 },
    ])
    const crowd = await Promise.allSettled(Array.from({ length: 6 }, () => w.build(later, p.id, 'owner')))
    const ok = crowd.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof w.build>>>[]
    const refused = crowd.filter((r) => r.status === 'rejected').map((r) => ((r as PromiseRejectedResult).reason as WorldConstructionRefusal).code)
    const property = await w.overview(later, p.id)
    expect(property.property).toMatchObject({ built: 250, tier: 2 })
    expect(ok.length).toBe((250 - (pair[0].status === 'fulfilled' ? 200 : 150)) / 50)
    expect(refused.every((c) => c === 'construction_complete')).toBe(true)
    const rows = await w.constructionsOf(p.id)
    expect(rows.map((r) => r.built_after)).toEqual([50, 100, 150, 200, 250])
    expect(rows.filter((r) => r.tier_after === 2)).toHaveLength(1)
    const entries = await w.ledger(worldId, ADA)
    expect(entries.every((e) => e.balance_after >= 0)).toBe(true)
    expect(entries.filter((e) => e.kind === 'construction-debit')).toHaveLength(rows.length + (await w.constructionsOf(q.id)).length)
    expect(await w.violations()).toEqual([])
  })

  it('9-11. only the named controller builds as owner toward Tier 2; a patron contributes toward it, as community investment that earns them no owner progress', async () => {
    const w = await world()
    const a = await w.env.open(INSTALLATION_A, ADA)
    const b = await w.env.open(INSTALLATION_A, BEA)
    const p = await w.place(a, keeper(1))
    w.source.control(GUILD_A, keeper(1), ADA)
    for (const who of [ADA, BEA]) w.source.grant(GUILD_A, who, [{ key: 'starter', units: 300 }])
    await w.build(a, p.id, 'owner')
    await w.build(a, p.id, 'owner')

    // 9. Bea is no controller: no owner step at Tier 1 either; the founder is not an owner once the file names nobody.
    expect(await refusalOf(w.build(b, p.id, 'owner'))).toBe('not_current_controller')
    w.source.control(GUILD_A, keeper(1), null)
    expect(await refusalOf(w.build(a, p.id, 'owner'))).toBe('control_unverified')
    w.source.control(GUILD_A, keeper(1), ADA)
    expect(await refusalOf(w.build(a, p.id, 'patron'))).toBe('controller_builds_as_owner')

    // 10. Bea contributes toward Tier 2 as a patron, and the controller completes it.
    expect((await w.build(b, p.id, 'patron')).construction).toMatchObject({ role: 'patron', era: 1, builtAfter: 150 })
    expect((await w.build(b, p.id, 'patron')).construction).toMatchObject({ role: 'patron', builtAfter: 200 })
    expect((await w.build(a, p.id, 'owner')).construction).toMatchObject({ role: 'owner', tierAfter: 2 })
    const seen = await w.overview(b, p.id)
    expect(seen.investment).toEqual({ currentOwner: 150, previousOwners: 0, community: 100, total: 250 })
    expect(seen.contributors).toEqual({ owners: 1, patrons: 1 })

    // 11. Bea's spend developed Ada's property; none of it is Bea's owner progression, and none of it is Ada's either.
    const bea = await w.architect(b)
    expect(bea.totals).toMatchObject({ ownerUnits: 0, currentEraOwnerUnits: 0, earlierEraOwnerUnits: 0, patronUnits: 100, ownerActions: 0, patronActions: 2, propertiesDeveloped: 1, propertiesDevelopedAsOwner: 0, tiersCompleted: 0 })
    const ada = await w.architect(a)
    expect(ada.totals).toMatchObject({ ownerUnits: 150, currentEraOwnerUnits: 150, earlierEraOwnerUnits: 0, patronUnits: 0, tiersCompleted: 2 })
    expect(await w.violations()).toEqual([])
  })

  it('Phase 3, 12-13, 16. Architect activity: each player\'s own record across properties, split by role and control era; a new controller starts from none of it', async () => {
    const w = await world()
    const a = await w.env.open(INSTALLATION_A, ADA)
    const b = await w.env.open(INSTALLATION_A, BEA)
    const p1 = await w.place(a, keeper(1))
    const p2 = await w.place(a, keeper(2))
    const p3 = await w.place(b, keeper(3))
    w.source.control(GUILD_A, keeper(1), ADA)
    w.source.control(GUILD_A, keeper(3), BEA)
    for (const who of [ADA, BEA]) w.source.grant(GUILD_A, who, [{ key: 'starter', units: 400 }])

    // Nothing built yet: Ada's record lists what she founded and controls, with nothing of hers in it.
    const empty = await w.architect(a)
    expect(empty.totals).toEqual({ ownerUnits: 0, currentEraOwnerUnits: 0, earlierEraOwnerUnits: 0, patronUnits: 0, ownerActions: 0, patronActions: 0, tiersCompleted: 0, propertiesDeveloped: 0, propertiesDevelopedAsOwner: 0 })
    expect(empty.properties.map((x) => [x.propertyId, x.founded, x.control])).toEqual([
      [p1.id, true, 'viewer'],
      [p2.id, true, 'unknown'],
    ])
    expect(empty.credits).toEqual({ available: 400, recorded: 0, pending: 400 })

    await w.build(a, p1.id, 'owner')
    await w.build(a, p1.id, 'owner')
    await w.build(a, p3.id, 'patron')
    await w.build(b, p1.id, 'patron')

    const ada = await w.architect(a)
    expect(ada.totals).toEqual({ ownerUnits: 100, currentEraOwnerUnits: 100, earlierEraOwnerUnits: 0, patronUnits: 50, ownerActions: 2, patronActions: 1, tiersCompleted: 1, propertiesDeveloped: 2, propertiesDevelopedAsOwner: 1 })
    // 16. Each property separately, her most recent activity first: Bea's p3 (as patron), her p1 (as owner), then p2 (founded, untouched).
    expect(ada.properties.map((x) => [x.propertyId, x.founded, x.control, x.tier, x.built, x.yours.ownerUnits, x.yours.patronUnits, x.standing])).toEqual([
      [p3.id, false, 'other', 0, 50, 0, 50, { kind: 'ready', role: 'patron', units: 50 }],
      [p1.id, true, 'viewer', 1, 150, 100, 0, { kind: 'ready', role: 'owner', units: 50 }],
      [p2.id, true, 'unknown', 0, 0, 0, 0, { kind: 'ready', role: 'patron', units: 50 }],
    ])
    // Bea: her patron units on Ada's p1 are no owner progress; her own p3 is listed as founded and hers to control.
    const bea = await w.architect(b)
    expect(bea.totals).toMatchObject({ ownerUnits: 0, patronUnits: 50, propertiesDeveloped: 1, propertiesDevelopedAsOwner: 0 })
    expect(bea.properties.map((x) => [x.propertyId, x.founded, x.control, x.yours.patronUnits])).toEqual([
      [p1.id, false, 'other', 50],
      [p3.id, true, 'viewer', 0],
    ])

    // 12. A simulated transfer of p1 to Bea: she builds as its owner in a new era, from none of Ada's progress.
    w.source.control(GUILD_A, keeper(1), BEA)
    expect((await w.build(b, p1.id, 'owner')).construction).toMatchObject({ role: 'owner', era: 2, builtAfter: 200 })
    const beaOwner = await w.architect(b)
    expect(beaOwner.totals).toMatchObject({ ownerUnits: 50, currentEraOwnerUnits: 50, earlierEraOwnerUnits: 0, patronUnits: 50 })
    expect(beaOwner.properties.find((x) => x.propertyId === p1.id)!.yours).toMatchObject({ ownerUnits: 50, currentEraOwnerUnits: 50, patronUnits: 50 })
    // 13. Ada keeps every unit she built, now under earlier control; she can still be a patron there.
    const adaAfter = await w.architect(a)
    expect(adaAfter.totals).toMatchObject({ ownerUnits: 100, currentEraOwnerUnits: 0, earlierEraOwnerUnits: 100, patronUnits: 50 })
    expect(adaAfter.properties.find((x) => x.propertyId === p1.id)).toMatchObject({ control: 'other', founded: true, standing: { kind: 'ready', role: 'patron' }, yours: { ownerUnits: 100, currentEraOwnerUnits: 0, earlierEraOwnerUnits: 100 } })

    // Back to Ada (a third era): only what she builds now is under control she holds now; her first era stays earlier.
    w.source.control(GUILD_A, keeper(1), ADA)
    expect((await w.build(a, p1.id, 'owner')).construction).toMatchObject({ era: 3, builtAfter: 250, tierAfter: 2 })
    expect((await w.architect(a)).totals).toMatchObject({ ownerUnits: 150, currentEraOwnerUnits: 50, earlierEraOwnerUnits: 100, tiersCompleted: 2 })
    expect((await w.architect(b)).totals).toMatchObject({ ownerUnits: 50, currentEraOwnerUnits: 0, earlierEraOwnerUnits: 50 })
    // The property's lifetime keeps everyone's investment; the founder record never moved.
    expect((await w.overview(a, p1.id)).investment).toEqual({ currentOwner: 50, previousOwners: 150, community: 50, total: 250 })
    expect((await w.constructionsOf(p1.id)).map((r) => [r.role, r.control_era_seq, r.contributor_discord_user_id])).toEqual([
      ['owner', 1, ADA.discordUserId],
      ['owner', 1, ADA.discordUserId],
      ['patron', 1, BEA.discordUserId],
      ['owner', 2, BEA.discordUserId],
      ['owner', 3, ADA.discordUserId],
    ])
    expect(await one('SELECT activator_discord_user_id FROM world_properties WHERE id = $1', [p1.id])).toEqual({ activator_discord_user_id: ADA.discordUserId })
    expect(await w.violations()).toEqual([])
  })

  it('17. two installations stay apart: a player\'s Architect activity, credits and Tier 2 progress in one world are nothing in the other', async () => {
    const w = await world()
    const a = await w.env.open(INSTALLATION_A, ADA)
    const ab = await w.env.open(INSTALLATION_B, ADA)
    const p = await w.place(a, keeper(1))
    const pb = await w.place(ab, keeper(1))
    w.source.control(GUILD_A, keeper(1), ADA)
    w.source.control(GUILD_B, keeper(1), ADA)
    w.source.grant(GUILD_A, ADA, [{ key: 'starter', units: 250 }])
    for (let i = 0; i < 5; i++) await w.build(a, p.id, 'owner')
    expect((await w.overview(a, p.id)).property.tier).toBe(2)

    const inB = await w.architect(ab)
    expect(inB.totals.ownerUnits).toBe(0)
    expect(inB.properties.map((x) => x.propertyId)).toEqual([pb.id])
    expect(inB.properties[0]).toMatchObject({ tier: 0, built: 0, standing: { kind: 'insufficient', role: 'owner', units: 50 } })
    expect(inB.credits).toEqual({ available: 0, recorded: 0, pending: 0 })
    const inA = await w.architect(a)
    expect(inA.totals.ownerUnits).toBe(250)
    expect(inA.properties.map((x) => x.propertyId)).toEqual([p.id])
    expect(await refusalOf(w.overview(ab, p.id))).toBe('unknown_property')
    expect(await w.violations()).toEqual([])
  })

  it('19-20. a database an E3A build wrote (0013, tier1-v1 records) takes 0014 unchanged; its old presses answer as recorded; it continues to Tier 2; a restart keeps it all', async () => {
    // An E3A database: migrations up to 0013, and constructions by the E3A recipe, through the store as E3A ran it.
    const dir = await t.migrationsPlus([])
    const old = await mkdtemp(join(tmpdir(), 'rc-0013-'))
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) <= 13)) await copyFile(join(dir, f), join(old, f))
    await migrate(t.db, { dir: old, environment: 'local' })
    const w = await world({ migrated: true, store: (db) => createWorldConstructionStore(db, { mode: 'local', log: silentLogger, recipe: LOCAL_TEST_TIER1_RECIPE }) })
    const a = await w.env.open(INSTALLATION_A, ADA)
    const b = await w.env.open(INSTALLATION_A, BEA)
    const p = await w.place(a, keeper(1))
    const q = await w.place(a, keeper(2))
    const worldId = a.response.world.id
    w.source.control(GUILD_A, keeper(1), ADA)
    w.source.control(GUILD_A, keeper(2), ADA)
    w.source.grant(GUILD_A, ADA, [{ key: 'starter', units: 400 }])
    w.source.grant(GUILD_A, BEA, [{ key: 'starter', units: 100 }])
    const e3a = randomUUID()
    await w.build(a, p.id, 'owner')
    const lastE3a = await w.build(a, p.id, 'owner', e3a)
    expect(lastE3a.construction).toMatchObject({ recipe: 'local-test-tier1-v1', tierAfter: 1 })
    // E3A's recipe ends at Tier 1.
    expect(await refusalOf(w.build(a, p.id, 'owner'))).toBe('construction_complete')
    await w.build(b, q.id, 'patron')
    const e3aArchitect = await w.architect(a)
    const tables = ['city', 'city_events', 'worlds', 'world_properties', 'world_district_tickets', 'world_property_constructions', 'world_property_control_eras', 'world_test_credit_entries']
    const dump = async (db: pg.Pool = t.db) =>
      Object.fromEntries(await Promise.all(tables.map(async (table) => [table, (await db.query(`SELECT to_jsonb(x) AS r FROM ${table} x`)).rows.map((r) => JSON.stringify(r.r)).sort()])))
    const before = await dump()
    expect(await w.violations()).toEqual([])

    // 0014 on it: nothing that was there changes, the verifier reads it as it did, and the recipes are known again.
    expect((await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })).applied).toEqual([14])
    expect(await dump()).toEqual(before)
    expect(await w.violations()).toEqual([])
    expect(await one("SELECT world_construction_tier('local-test-tier1-v1', 100) AS t1, world_construction_units('local-test-tier1-v1', 100) AS u1, world_construction_tier('local-test-tier2-v1', 250) AS t2, world_construction_units('local-test-tier2-v1', 100) AS u2")).toEqual({ t1: 1, u1: null, t2: 2, u2: 50 })

    // The upgraded build: the E3A press, repeated, answers its own E3A record and pays nothing.
    w.upgrade(createWorldConstructionStore(t.db, { mode: 'local', log: silentLogger }))
    const replay = await w.build(a, p.id, 'owner', e3a)
    expect(replay).toMatchObject({ fresh: false, construction: { recipe: 'local-test-tier1-v1', actionId: e3a, builtAfter: 100, tierAfter: 1 } })
    expect(replay.construction).toEqual(lastE3a.construction)
    expect(replay.balance).toBe(lastE3a.balance)
    // 19. The Tier 1 property continues, by the current recipe, to Tier 2; its E3A receipts stay in its history as they were.
    for (let i = 0; i < 3; i++) await w.build(a, p.id, 'owner')
    const o = await w.overview(a, p.id)
    expect(o.property).toMatchObject({ tier: 2, built: 250, maxTier: 2 })
    expect(o.history.map((h) => [h.recipe, h.tierAfter])).toEqual([
      ['local-test-tier2-v1', 2],
      ['local-test-tier2-v1', 1],
      ['local-test-tier2-v1', 1],
      ['local-test-tier1-v1', 1],
      ['local-test-tier1-v1', 0],
    ])
    // A Tier 0 property with an E3A patron step continues the same way.
    expect((await w.build(a, q.id, 'owner')).construction).toMatchObject({ recipe: 'local-test-tier2-v1', builtBefore: 50, builtAfter: 100, tierAfter: 1 })
    expect((await w.architect(a)).totals).toMatchObject({ ownerUnits: e3aArchitect.totals.ownerUnits + 200, tiersCompleted: 3 })
    // The retired recipe builds nothing more, whatever writes it, even the step it would build on a fresh Tier 0 property.
    const r = await w.place(a, keeper(3))
    w.source.control(GUILD_A, keeper(3), ADA)
    const retired = createWorldConstructionStore(t.db, { mode: 'local', log: silentLogger, recipe: LOCAL_TEST_TIER1_RECIPE })
    await expect(retired.construct(await w.env.live(a), { propertyId: r.id, role: 'owner', actionId: randomUUID() }, w.source.authority)).rejects.toThrow('a new construction is built by the current recipe, local-test-tier2-v1')
    expect(await w.constructionsOf(r.id)).toEqual([])
    expect(await w.violations()).toEqual([])

    // 20. A restart of the connection: a new pool and a new store read exactly the same, and the verifier agrees.
    const after = await dump()
    const viewBefore = { overview: await w.overview(a, p.id), architect: await w.architect(a) }
    const fresh = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL!, options: `-c search_path=${t.schema}` })
    try {
      expect(await dump(fresh)).toEqual(after)
      const again = createWorldConstructionStore(fresh, { mode: 'local', log: silentLogger })
      const session = await w.env.sessions.session(a.token)
      expect({ overview: await again.overview(session, p.id, w.source.authority), architect: await again.architect(session, w.source.authority) }).toEqual(viewBefore)
      expect((await verifyCity(fresh)).violations).toEqual([])
    } finally {
      await fresh.end()
    }
    void worldId
  })

  it('18. the database refuses what the service never writes at Tier 2: a skipped tier, a step past 250, an older recipe, a tier its units do not make', async () => {
    const w = await world()
    const a = await w.env.open(INSTALLATION_A, ADA)
    const p = await w.place(a, keeper(1))
    const worldId = a.response.world.id
    const cityId = `world:${worldId}`
    w.source.control(GUILD_A, keeper(1), ADA)
    w.source.grant(GUILD_A, ADA, [{ key: 'starter', units: 1000 }])
    await w.build(a, p.id, 'owner')
    await w.build(a, p.id, 'owner')
    const session = (await w.env.live(a)).id
    const city = await one<{ instance_id: string; sequence: string; state: Record<string, unknown> }>('SELECT instance_id, sequence, state FROM city WHERE id = $1', [cityId])

    /** One hand-written construction from Tier 1 (100 units): the honest one is the current recipe's 50 units, still Tier 1. */
    async function forge(o: { units?: number; tierAfter?: number; recipe?: string; stateTier?: number }) {
      const units = o.units ?? 50
      const tierAfter = o.tierAfter ?? 1
      const recipe = o.recipe ?? 'local-test-tier2-v1'
      const c = await t.db.connect()
      const next = Number(city.sequence) + 1
      try {
        await c.query('BEGIN')
        await c.query('UPDATE city SET state = $1::json, state_version = 3, sequence = $2 WHERE id = $3', [
          JSON.stringify({ ...city.state, development: { [p.buildingId]: { tier: o.stateTier ?? tierAfter, built: 100 + units, sequence: next } } }),
          next,
          cityId,
        ])
        const action = randomUUID()
        await c.query("INSERT INTO city_events (city_id, sequence, type, payload) VALUES ($1, $2, 'world.property.constructed', $3::jsonb)", [
          cityId,
          next,
          JSON.stringify({ propertyId: p.id, buildingId: p.buildingId, recipe, units, builtBefore: 100, builtAfter: 100 + units, tierBefore: 1, tierAfter, action, role: 'owner' }),
        ])
        await c.query(
          `INSERT INTO world_property_constructions (world_id, city_id, city_instance_id, sequence, property_id, action_id, recipe, role, contributor_core_user_id, contributor_discord_user_id, contributed_in_play_session, control_era_seq, resource, units, built_before, built_after, tier_before, tier_after)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'owner', $8, $9, $10, 1, 'local-test-credit', $11, 100, $12, 1, $13)`,
          [worldId, cityId, city.instance_id, next, p.id, action, recipe, ADA.coreUserId, ADA.discordUserId, session, units, 100 + units, tierAfter],
        )
        const last = (await c.query<{ entry_seq: number; balance_after: number }>('SELECT entry_seq, balance_after FROM world_test_credit_entries WHERE world_id = $1 AND account_discord_user_id = $2 ORDER BY entry_seq DESC LIMIT 1', [worldId, ADA.discordUserId])).rows[0]
        await c.query(
          `INSERT INTO world_test_credit_entries (world_id, account_discord_user_id, account_core_user_id, entry_seq, kind, delta, balance_after, city_id, construction_sequence, recorded_in_play_session) VALUES ($1, $2, $3, $4, 'construction-debit', $5, $6, $7, $8, $9)`,
          [worldId, ADA.discordUserId, ADA.coreUserId, last.entry_seq + 1, -units, last.balance_after - units, cityId, next, session],
        )
        await c.query('COMMIT')
      } catch (err) {
        await c.query('ROLLBACK')
        throw err
      } finally {
        c.release()
      }
    }
    // Straight to Tier 2 in one step, or past its threshold, or Tier 2 claimed before 250.
    await expect(forge({ units: 150, tierAfter: 2 })).rejects.toThrow("a construction builds exactly its recipe's next step")
    await expect(forge({ units: 200, tierAfter: 2 })).rejects.toThrow("a construction builds exactly its recipe's next step")
    await expect(forge({ units: 50, tierAfter: 2 })).rejects.toThrow("a construction builds exactly its recipe's next step")
    // A state that draws Tier 2 under a Tier 1 record.
    await expect(forge({ stateTier: 2 })).rejects.toThrow('a construction must be the development its city has just recorded')
    // The retired recipe, or one that does not exist.
    await expect(forge({ recipe: 'local-test-tier1-v1', units: 50 })).rejects.toThrow("a construction builds exactly its recipe's next step")
    await expect(forge({ recipe: 'local-test-tier3-v1' })).rejects.toThrow("a construction builds exactly its recipe's next step")
    expect(await sequenceOf(worldId)).toBe(Number(city.sequence))
    // The honest forgery commits: each refusal above was for its one difference.
    await forge({})
    expect(await sequenceOf(worldId)).toBe(Number(city.sequence) + 1)
    expect(await w.violations()).toEqual([])
  })

  it('21. city:verify finds a tampered Tier 2: a tier its units do not make, a recorded step that is not the recipe\'s, an older recipe after a newer one, a ledger that does not add up', async () => {
    const w = await world()
    const a = await w.env.open(INSTALLATION_A, ADA)
    const p = await w.place(a, keeper(1))
    const worldId = a.response.world.id
    const cityId = `world:${worldId}`
    w.source.control(GUILD_A, keeper(1), ADA)
    w.source.grant(GUILD_A, ADA, [{ key: 'starter', units: 300 }])
    for (let i = 0; i < 5; i++) await w.build(a, p.id, 'owner')
    expect(await w.violations()).toEqual([])
    const rows = await w.constructionsOf(p.id)

    /** Past every guard (replica role), in this disposable schema: a write no code here makes, then undone the same way. */
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
    // The stored state's exact text, to put back after a change of it (jsonb would reorder its keys).
    const stateText = (await one<{ s: string }>('SELECT state::text AS s FROM city WHERE id = $1', [cityId])).s
    const restoreState: [string, unknown[]] = ['UPDATE city SET state = $2::json WHERE id = $1', [cityId, stateText]]
    const cases: { label: string; do: [string, unknown[]]; undo: [string, unknown[]]; expect: RegExp }[] = [
      {
        label: 'state drawn at Tier 2 with 200 units',
        do: [`UPDATE city SET state = jsonb_set(state::jsonb, '{development,${p.buildingId},built}', '200')::json WHERE id = $1`, [cityId]],
        undo: restoreState,
        expect: /tier 2; 200 units make it tier 1|stored state is not the state/,
      },
      {
        label: 'state drawn at Tier 3',
        do: [`UPDATE city SET state = jsonb_set(state::jsonb, '{development,${p.buildingId},tier}', '3')::json WHERE id = $1`, [cityId]],
        undo: restoreState,
        expect: /records tier 3|stored state is not the state/,
      },
      {
        label: 'the Tier 2 record says Tier 1',
        do: ['UPDATE world_property_constructions SET tier_after = 1 WHERE city_id = $1 AND sequence = $2', [cityId, rows[4].sequence]],
        undo: ['UPDATE world_property_constructions SET tier_after = 2 WHERE city_id = $1 AND sequence = $2', [cityId, rows[4].sequence]],
        expect: /is not its recipe's step/,
      },
      {
        label: 'the Tier 2 record skipped a step',
        do: ['UPDATE world_property_constructions SET units = 100, built_before = 150 WHERE city_id = $1 AND sequence = $2', [cityId, rows[4].sequence]],
        undo: ['UPDATE world_property_constructions SET units = 50, built_before = 200 WHERE city_id = $1 AND sequence = $2', [cityId, rows[4].sequence]],
        expect: /is not its recipe's step|is not paid by exactly one debit/,
      },
      {
        label: 'the second step relabelled as the retired recipe, record and event alike',
        do: [
          `WITH c AS (UPDATE world_property_constructions SET recipe = 'local-test-tier1-v1' WHERE city_id = $1 AND sequence = $2 RETURNING sequence)
           UPDATE city_events SET payload = jsonb_set(payload, '{recipe}', '"local-test-tier1-v1"') WHERE city_id = $1 AND sequence = $2`,
          [cityId, rows[1].sequence],
        ],
        undo: [
          `WITH c AS (UPDATE world_property_constructions SET recipe = 'local-test-tier2-v1' WHERE city_id = $1 AND sequence = $2 RETURNING sequence)
           UPDATE city_events SET payload = jsonb_set(payload, '{recipe}', '"local-test-tier2-v1"') WHERE city_id = $1 AND sequence = $2`,
          [cityId, rows[1].sequence],
        ],
        expect: /is built by recipe local-test-tier1-v1, older than one its property was already built by/,
      },
      {
        label: 'a debit that leaves the wrong balance',
        do: ["UPDATE world_test_credit_entries SET balance_after = balance_after + 50 WHERE world_id = $1 AND kind = 'construction-debit' AND construction_sequence = $2", [worldId, rows[4].sequence]],
        undo: ["UPDATE world_test_credit_entries SET balance_after = balance_after - 50 WHERE world_id = $1 AND kind = 'construction-debit' AND construction_sequence = $2", [worldId, rows[4].sequence]],
        expect: /leaves \d+; its entries add up to/,
      },
    ]
    for (const c of cases) {
      await tamper(...c.do)
      const found = (await w.violations()).map((v) => `${v.rule}: ${v.detail}`)
      expect(found.some((v) => c.expect.test(v)), `${c.label}: ${JSON.stringify(found)}`).toBe(true)
      await tamper(...c.undo)
      expect(await w.violations(), `${c.label} undone`).toEqual([])
    }
  })

  it('0014 is forward only: it applies to a fresh database, rolls back whole when it cannot finish, and cannot be edited once applied', async () => {
    const dir = await t.migrationsPlus([])
    const upTo13 = await mkdtemp(join(tmpdir(), 'rc-0013-'))
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql'))
    for (const f of files.filter((f) => Number(f.slice(0, 4)) <= 13)) await copyFile(join(dir, f), join(upTo13, f))
    await migrate(t.db, { dir: upTo13, environment: 'local' })
    const before = await one<{ tier: number | null; units: number | null; trig: number }>(
      "SELECT world_construction_tier('local-test-tier2-v1', 250) AS tier, world_construction_units('local-test-tier2-v1', 100) AS units, (SELECT count(*)::int FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE g.tgname = 'world_property_constructions_recipe_guard' AND c.relnamespace = current_schema()::regnamespace) AS trig",
    )
    expect(before).toEqual({ tier: null, units: null, trig: 0 })

    // Someone holds world_property_constructions: 0014 cannot take its trigger lock within its timeout, and leaves nothing behind.
    const holder = await t.db.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE world_property_constructions IN ACCESS EXCLUSIVE MODE')
      const sql = (await readFile(join(dir, files.find((f) => f.startsWith('0014'))!), 'utf8')).replace("SET LOCAL lock_timeout = '10s';", "SET LOCAL lock_timeout = '200ms';")
      const short = await mkdtemp(join(tmpdir(), 'rc-0014-'))
      for (const f of files.filter((f) => Number(f.slice(0, 4)) <= 13)) await copyFile(join(dir, f), join(short, f))
      await writeFile(join(short, files.find((f) => f.startsWith('0014'))!), sql)
      await expect(migrate(t.db, { dir: short, environment: 'local' })).rejects.toThrow(/Migration 14 \(construction_tier2\) failed and was rolled back/)
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
    }
    expect(await one("SELECT world_construction_tier('local-test-tier2-v1', 250) AS tier, world_construction_units('local-test-tier2-v1', 100) AS units, (SELECT count(*)::int FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE g.tgname = 'world_property_constructions_recipe_guard' AND c.relnamespace = current_schema()::regnamespace) AS trig")).toEqual(before)
    expect((await one<{ n: number }>('SELECT max(version)::int AS n FROM schema_migrations')).n).toBe(13)

    // The shipped 0014 then applies, with its functions pinned to this schema like 0013's.
    expect((await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })).applied).toEqual([14])
    expect(await one("SELECT world_construction_tier('local-test-tier2-v1', 250) AS tier, world_construction_units('local-test-tier2-v1', 100) AS units, (SELECT count(*)::int FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE g.tgname = 'world_property_constructions_recipe_guard' AND c.relnamespace = current_schema()::regnamespace) AS trig")).toEqual({ tier: 2, units: 50, trig: 1 })
    const pinned = (await t.db.query<{ proname: string; proconfig: string[] | null }>("SELECT proname, proconfig FROM pg_proc WHERE proname IN ('world_construction_tier', 'world_construction_units', 'world_property_constructions_recipe_guard') AND pronamespace = current_schema()::regnamespace ORDER BY proname")).rows
    expect(pinned.map((r) => [r.proname, r.proconfig?.some((c) => c.startsWith('search_path=') && c.includes('pg_temp'))])).toEqual([
      ['world_construction_tier', true],
      ['world_construction_units', true],
      ['world_property_constructions_recipe_guard', true],
    ])
    // Its every tier1-v1 answer is 0013's, for every amount a construction can record up to 300.
    const diff = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM generate_series(0, 300) b
        WHERE world_construction_tier('local-test-tier1-v1', b) IS DISTINCT FROM (CASE WHEN b >= 100 THEN 1 ELSE 0 END)
           OR world_construction_units('local-test-tier1-v1', b) IS DISTINCT FROM (CASE WHEN b >= 0 AND b < 100 THEN least(50, 100 - b) END)`,
    )
    expect(diff.n).toBe(0)

    // Edited after it was applied: refused.
    const edited = await t.migrationsPlus([])
    const name = (await readdir(edited)).find((f) => f.startsWith('0014'))!
    await writeFile(join(edited, name), `${await readFile(join(edited, name), 'utf8')}\n-- edited\n`)
    await expect(migrate(t.db, { dir: edited, environment: 'local' })).rejects.toThrow('Migration 14 (construction_tier2) was edited after it was applied')
  })
})
