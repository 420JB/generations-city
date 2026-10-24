import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { persistedBrandCityState } from '../../src/brand/core/persisted'
import { parsePlayCityConfig } from '../../src/brand/core/playConfig'
import { tierFor, totalBuilt } from '../../src/game/economy'
import { verifyCity } from '../src/city/verify'
import { migrate } from '../src/db/migrations'
import { createPool } from '../src/db/pool'
import { assetKey, parseWorldCityState, type NftAsset } from '../src/engine'
import { silentLogger } from '../src/log'
import { PlaySessionError, type OpenedPlaySession } from '../src/play/session'
import {
  createConstructionService,
  createWorldConstructionStore,
  WorldConstructionRefusal,
  type ConstructionAuthority,
  type ConstructionStep,
  type TestCreditGrant,
} from '../src/world/construction'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'
import { ADA, BEA, GUILD_A, GUILD_B, INSTALLATION_A, INSTALLATION_B } from './fakePlay'
import { keeper, player, ticketWorld } from './ticketHarness'

/**
 * PROPERTY CONSTRUCTION (P1-C2-E3A, migration 0013) against a disposable Postgres, through the real launch path, session
 * service, ticket and property stores and the construction store. The trusted source is a MUTABLE stand-in for the
 * rehearsal file (who controls an NFT now, and test credit grants), which a test changes to simulate a transfer.
 *
 *   OWNER     only the source's current controller of the exact NFT, in that Discord server's world, builds as owner;
 *             the original activator is not enough, and an unknown controller authorizes nobody;
 *   PATRON    anyone else builds as a patron: community investment, never the owner's own progression;
 *   ERAS      a new controller begins a new control era; earlier owners' investment stays theirs;
 *   CREDITS   valueless test credits, granted once each by the source, debited by exactly the units built, never below
 *             zero, never twice for one action;
 *   ATOMIC    the city, its event, the era, the construction and the ledger commit together or not at all;
 *   DATABASE  the guards refuse what the service would never write, and anything outside a local database.
 */
const CY = player(3, 'Cy')

function testAuthority() {
  const controllers = new Map<string, string>()
  const grants = new Map<string, TestCreditGrant[]>()
  const calls = { controllerOf: 0, grantsFor: 0 }
  const closed = new Set<string>()
  const authority: ConstructionAuthority = {
    source: 'local-fixture',
    opensIn: (where) => !closed.has(where.guildId),
    controllerOf: (where, asset) => {
      calls.controllerOf++
      return controllers.get(`${where.guildId}|${assetKey(asset)}`) ?? null
    },
    grantsFor: (where) => {
      calls.grantsFor++
      return grants.get(`${where.guildId}|${where.discordUserId}`) ?? []
    },
  }
  return {
    authority,
    calls,
    control: (guild: string, asset: NftAsset, who: { discordUserId: string } | null) => (who ? controllers.set(`${guild}|${assetKey(asset)}`, who.discordUserId) : controllers.delete(`${guild}|${assetKey(asset)}`)),
    grant: (guild: string, who: { discordUserId: string }, list: TestCreditGrant[]) => grants.set(`${guild}|${who.discordUserId}`, list),
    close: (guild: string) => closed.add(guild),
    reopen: (guild: string) => closed.delete(guild),
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

describe.skipIf(NO_TEST_DATABASE)('property construction (migration 0013) against a disposable Postgres', () => {
  const t = useTestSchema()
  const { setup, one, sequenceOf } = ticketWorld(t)

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** A world on installation A (and B) with a property of `who`'s keeper `id` placed on its ticket's first plot, and the construction store. */
  async function world(options: { onStep?: (step: ConstructionStep) => void | Promise<void> } = {}) {
    const env = await setup()
    const source = testAuthority()
    const store = createWorldConstructionStore(t.db, { mode: 'local', log: silentLogger, onStep: options.onStep })
    const service = createConstructionService({ sessions: env.sessions, store, authority: source.authority })
    /** Place `asset` for `o` on its assigned district's first free plot. */
    const place = async (o: OpenedPlaySession, asset: NftAsset) => {
      const ticket = await env.ticketOf(o, [asset])
      const city = await env.sessions.city(await env.sessions.session(o.token))
      const plot = city.world.districts.find((d) => d.key === ticket.districtKey)!.candidates.plotIds[0]
      return (await env.activate(o, ticket, asset, plot)).property
    }
    const build = (o: OpenedPlaySession, propertyId: string, role: 'owner' | 'patron', actionId: string = randomUUID()) => service.construct(o.token, env.actorOf(o), { propertyId, role, actionId })
    const overview = async (o: OpenedPlaySession, propertyId: string) => store.overview(await env.sessions.session(o.token), propertyId, source.authority)
    const ledger = (worldId: string) =>
      t.db
        .query<{ account_discord_user_id: string; entry_seq: number; kind: string; delta: number; balance_after: number; grant_key: string | null; construction_sequence: string | null }>(
          'SELECT account_discord_user_id, entry_seq, kind, delta, balance_after, grant_key, construction_sequence FROM world_test_credit_entries WHERE world_id = $1 ORDER BY account_discord_user_id, entry_seq',
          [worldId],
        )
        .then((r) => r.rows)
    const constructionsOf = (worldId: string) =>
      t.db.query<{ sequence: string; role: string; units: number; control_era_seq: number | null; contributor_discord_user_id: string }>('SELECT sequence, role, units, control_era_seq, contributor_discord_user_id FROM world_property_constructions WHERE world_id = $1 ORDER BY sequence', [worldId]).then((r) => r.rows)
    const stateOf = async (worldId: string) => parseWorldCityState((await one<{ state: unknown }>('SELECT c.state FROM city c JOIN worlds w ON w.city_id = c.id WHERE w.id = $1', [worldId])).state)
    const verified = async () => {
      const report = await verifyCity(t.db)
      expect(report.violations).toEqual([])
      return report
    }
    return { env, source, store, service, place, build, overview, ledger, constructionsOf, stateOf, verified }
  }

  it('a Tier 0 property starts with nothing built; its controller builds it to Tier 1 in two server-computed steps, paid in test credits', async () => {
    const w = await world()
    const a = await w.env.open(INSTALLATION_A, ADA)
    const p = await w.place(a, keeper(1))
    const worldId = a.response.world.id
    w.source.control(GUILD_A, keeper(1), ADA)
    w.source.grant(GUILD_A, ADA, [{ key: 'starter', units: 120 }])

    // 1. Tier 0, as founded: version 2, nothing built, no records.
    const before = await w.overview(a, p.id)
    expect(before.property).toMatchObject({ tier: 0, built: 0, nextTierAt: 100, maxTier: 1 })
    expect(before.control).toBe('viewer')
    expect(before.standing).toEqual({ kind: 'ready', role: 'owner', units: 50 })
    expect(before.credits).toEqual({ available: 120, recorded: 0, pending: 120 })
    expect((await w.stateOf(worldId))!.version).toBe(2)
    expect(await w.ledger(worldId)).toEqual([])
    const sequence = await sequenceOf(worldId)

    // 2-3. One step: the city advances once; 50 units built; the grant recorded once and 50 debited.
    const first = await w.build(a, p.id, 'owner')
    expect(first.fresh).toBe(true)
    expect(first.construction).toMatchObject({ role: 'owner', era: 1, units: 50, builtBefore: 0, builtAfter: 50, tierBefore: 0, tierAfter: 0, recipe: 'local-test-tier1-v1', contributor: { discordUserId: ADA.discordUserId, coreUserId: ADA.coreUserId } })
    expect(first.sequence).toBe(sequence + 1)
    expect(first.balance).toBe(70)
    expect(await sequenceOf(worldId)).toBe(sequence + 1)
    const state = await w.stateOf(worldId)
    expect(state).toMatchObject({ version: 3, development: { [p.buildingId]: { tier: 0, built: 50, sequence: sequence + 1 } } })
    expect(await w.ledger(worldId)).toEqual([
      { account_discord_user_id: ADA.discordUserId, entry_seq: 1, kind: 'fixture-grant', delta: 120, balance_after: 120, grant_key: 'starter', construction_sequence: null },
      { account_discord_user_id: ADA.discordUserId, entry_seq: 2, kind: 'construction-debit', delta: -50, balance_after: 70, grant_key: null, construction_sequence: String(sequence + 1) },
    ])
    const event = await one<{ type: string; payload: Record<string, unknown> }>('SELECT type, payload FROM city_events e JOIN worlds w ON w.city_id = e.city_id WHERE w.id = $1 AND e.sequence = $2', [worldId, sequence + 1])
    expect(event).toEqual({
      type: 'world.property.constructed',
      payload: { propertyId: p.id, buildingId: p.buildingId, recipe: 'local-test-tier1-v1', units: 50, builtBefore: 0, builtAfter: 50, tierBefore: 0, tierAfter: 0, action: first.construction.actionId, role: 'owner' },
    })

    // 4. The second step reaches Tier 1; nothing more can be built by this recipe.
    const second = await w.build(a, p.id, 'owner')
    expect(second.construction).toMatchObject({ builtBefore: 50, builtAfter: 100, tierBefore: 0, tierAfter: 1 })
    expect(second.balance).toBe(20)
    expect(await refusalOf(w.build(a, p.id, 'owner'))).toBe('construction_complete')
    const after = await w.overview(a, p.id)
    expect(after.property).toMatchObject({ tier: 1, built: 100, nextTierAt: null })
    expect(after.standing).toEqual({ kind: 'complete' })
    expect(after.investment).toEqual({ currentOwner: 100, previousOwners: 0, community: 0, total: 100 })
    expect(after.viewer).toEqual({ ownerUnits: 100, patronUnits: 0 })
    expect(after.history.map((h) => [h.role, h.units, h.tierAfter, h.by, h.era])).toEqual([
      ['owner', 50, 1, 'viewer', 1],
      ['owner', 50, 0, 'viewer', 1],
    ])

    // 4. Visible: the city the session reads draws the building at Tier 1 through the standard renderer's tiers.
    const city = await w.env.sessions.city(await w.env.sessions.session(a.token))
    const parsed = parsePlayCityConfig(city.config, worldId)
    if (!parsed.ok) throw new Error('config')
    const drawn = persistedBrandCityState(parsed.config, city.world.state)
    expect(tierFor(totalBuilt(drawn.buildings[p.buildingId]))).toBe(1)
    await w.verified()
  })

  it('a repeat of the same action answers what it built and pays nothing more; two identical requests at once build once', async () => {
    const w = await world()
    const a = await w.env.open(INSTALLATION_A, ADA)
    const p = await w.place(a, keeper(1))
    const worldId = a.response.world.id
    w.source.control(GUILD_A, keeper(1), ADA)
    w.source.grant(GUILD_A, ADA, [{ key: 'starter', units: 200 }])

    const action = randomUUID()
    const first = await w.build(a, p.id, 'owner', action)
    const sequence = await sequenceOf(worldId)
    // 5. Same action, again, and through a later session of the same player.
    const again = await w.build(a, p.id, 'owner', action)
    expect(again.fresh).toBe(false)
    expect(again.construction).toEqual(first.construction)
    expect(again.balance).toBe(150)
    const later = await w.env.open(INSTALLATION_A, ADA, a.token)
    expect((await w.build(later, p.id, 'owner', action)).fresh).toBe(false)
    expect(await sequenceOf(worldId)).toBe(sequence)
    expect((await w.ledger(worldId)).length).toBe(2)
    // The same id for anything else is refused, and builds nothing.
    expect(await refusalOf(w.build(later, p.id, 'patron', action))).toBe('action_conflict')
    const b = await w.env.open(INSTALLATION_A, BEA)
    w.source.grant(GUILD_A, BEA, [{ key: 'starter', units: 200 }])
    expect(await refusalOf(w.build(b, p.id, 'patron', action))).toBe('action_conflict')
    expect(await sequenceOf(worldId)).toBe(sequence)

    // 6. Two identical requests at once: one construction, one debit, one fresh answer.
    const twin = randomUUID()
    const [x, y] = await Promise.all([w.build(later, p.id, 'owner', twin), w.build(later, p.id, 'owner', twin)])
    expect([x.fresh, y.fresh].sort()).toEqual([false, true])
    expect(x.construction).toEqual(y.construction)
    expect(await sequenceOf(worldId)).toBe(sequence + 1)
    expect((await w.ledger(worldId)).filter((e) => e.account_discord_user_id === ADA.discordUserId).map((e) => e.balance_after)).toEqual([200, 150, 100])
    await w.verified()
  })

  it('two different spending actions at once never overspend: one builds, the other is refused for its credits; a short balance writes nothing', async () => {
    const w = await world()
    const a = await w.env.open(INSTALLATION_A, ADA)
    const p1 = await w.place(a, keeper(1))
    const p2 = await w.place(a, keeper(2))
    const worldId = a.response.world.id
    w.source.control(GUILD_A, keeper(1), ADA)
    w.source.control(GUILD_A, keeper(2), ADA)

    // 8. No credits at all: refused, nothing written, nothing recorded.
    const sequence = await sequenceOf(worldId)
    expect(await refusalOf(w.build(a, p1.id, 'owner'))).toBe('insufficient_test_credits')
    w.source.grant(GUILD_A, ADA, [{ key: 'starter', units: 30 }])
    expect(await refusalOf(w.build(a, p1.id, 'owner'))).toBe('insufficient_test_credits')
    expect(await sequenceOf(worldId)).toBe(sequence)
    expect(await w.ledger(worldId)).toEqual([])
    expect((await w.stateOf(worldId))!.version).toBe(2)
    expect((await w.overview(a, p1.id)).standing).toEqual({ kind: 'insufficient', role: 'owner', units: 50 })

    // 7. Exactly one action's worth, two different actions on two properties at once.
    w.source.grant(GUILD_A, ADA, [
      { key: 'starter', units: 30 },
      { key: 'top-up', units: 20 },
    ])
    const outcomes = await Promise.allSettled([w.build(a, p1.id, 'owner'), w.build(a, p2.id, 'owner')])
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
    const refused = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult
    expect((refused.reason as WorldConstructionRefusal).code).toBe('insufficient_test_credits')
    expect(await sequenceOf(worldId)).toBe(sequence + 1)
    const entries = await w.ledger(worldId)
    expect(entries.map((e) => [e.kind, e.delta, e.balance_after])).toEqual([
      ['fixture-grant', 30, 30],
      ['fixture-grant', 20, 50],
      ['construction-debit', -50, 0],
    ])
    expect(entries.every((e) => e.balance_after >= 0)).toBe(true)
    // Recorded grants are never recorded again.
    expect(await refusalOf(w.build(a, p2.id, 'owner'))).toBe('insufficient_test_credits')
    expect((await w.ledger(worldId)).length).toBe(3)

    // Many at once, each a different action, with credits for three: exactly three build.
    w.source.grant(GUILD_A, ADA, [
      { key: 'starter', units: 30 },
      { key: 'top-up', units: 20 },
      { key: 'crowd', units: 150 },
    ])
    const p3 = await w.place(a, keeper(3))
    const p4 = await w.place(a, keeper(4))
    for (const k of [3, 4]) w.source.control(GUILD_A, keeper(k), ADA)
    // Three unbuilt properties, two steps each possible: only the credits decide.
    const crowd = await Promise.allSettled([p2, p3, p4, p2, p3, p4].map((p) => w.build(a, p.id, 'owner')))
    expect(crowd.filter((o) => o.status === 'fulfilled')).toHaveLength(3)
    expect(crowd.filter((o) => o.status === 'rejected').map((o) => ((o as PromiseRejectedResult).reason as WorldConstructionRefusal).code)).toEqual(['insufficient_test_credits', 'insufficient_test_credits', 'insufficient_test_credits'])
    expect((await w.ledger(worldId)).at(-1)!.balance_after).toBe(0)
    await w.verified()
  })

  it('only the current controller of the exact NFT builds as owner: not its founder, not another NFT\'s controller, nobody when unknown; not across worlds', async () => {
    const w = await world()
    const a = await w.env.open(INSTALLATION_A, ADA)
    const b = await w.env.open(INSTALLATION_A, BEA)
    const p = await w.place(a, keeper(1))
    const worldId = a.response.world.id
    for (const who of [ADA, BEA, CY]) w.source.grant(GUILD_A, who, [{ key: 'starter', units: 500 }])
    const sequence = await sequenceOf(worldId)

    // 10. Nobody named: no owner at all, not even the founder.
    expect(await refusalOf(w.build(a, p.id, 'owner'))).toBe('control_unverified')
    expect((await w.overview(a, p.id)).control).toBe('unknown')
    // Someone else named: the founder is not the owner.
    w.source.control(GUILD_A, keeper(1), BEA)
    expect(await refusalOf(w.build(a, p.id, 'owner'))).toBe('not_current_controller')
    expect((await w.overview(a, p.id)).control).toBe('other')
    // Controlling another NFT is not controlling this one.
    w.source.control(GUILD_A, keeper(2), ADA)
    expect(await refusalOf(w.build(a, p.id, 'owner'))).toBe('not_current_controller')
    // The controller cannot pass their own investment off as community investment.
    expect(await refusalOf(w.build(b, p.id, 'patron'))).toBe('controller_builds_as_owner')
    expect(await sequenceOf(worldId)).toBe(sequence)
    // The named controller builds as owner, though they never founded it.
    expect((await w.build(b, p.id, 'owner')).construction).toMatchObject({ role: 'owner', era: 1, contributor: { discordUserId: BEA.discordUserId } })
    // The founding record is untouched by any of it.
    expect(await one('SELECT activator_discord_user_id FROM world_properties WHERE id = $1', [p.id])).toEqual({ activator_discord_user_id: ADA.discordUserId })

    // 11. Another installation's world: the property is not its own, and control in Guild A says nothing about Guild B.
    const ab = await w.env.open(INSTALLATION_B, ADA)
    expect(await refusalOf(w.build(ab, p.id, 'owner'))).toBe('unknown_property')
    expect(await refusalOf(w.build(ab, p.id, 'patron'))).toBe('unknown_property')
    const pb = await w.place(ab, keeper(1))
    w.source.grant(GUILD_B, ADA, [{ key: 'starter', units: 500 }])
    w.source.control(GUILD_A, keeper(1), ADA)
    expect(await refusalOf(w.build(ab, pb.id, 'owner'))).toBe('control_unverified')
    w.source.control(GUILD_B, keeper(1), ADA)
    expect((await w.build(ab, pb.id, 'owner')).construction.era).toBe(1)
    await w.verified()
  })

  it('9. needs exactly the session the page drew, a session at all, and Play active now; a session that ended builds nothing', async () => {
    const w = await world()
    const a = await w.env.open(INSTALLATION_A, ADA)
    const b = await w.env.open(INSTALLATION_A, BEA)
    const p = await w.place(a, keeper(1))
    w.source.control(GUILD_A, keeper(1), ADA)
    w.source.grant(GUILD_A, ADA, [{ key: 'starter', units: 500 }])
    const sequence = await sequenceOf(a.response.world.id)
    const input = { propertyId: p.id, role: 'owner', actionId: randomUUID() }
    expect(await refusalOf(w.service.construct(null, w.env.actorOf(a), input))).toBe('play_session_required')
    // Bea's cookie, Ada's page (or the reverse): the actor is not the one the page drew.
    expect(await refusalOf(w.service.construct(b.token, w.env.actorOf(a), input))).toBe('play_actor_mismatch')
    expect(await refusalOf(w.service.construct(a.token, { ...w.env.actorOf(a), discordUserId: BEA.discordUserId }, input))).toBe('play_actor_mismatch')
    // Play no longer active for the installation: no construction.
    w.env.p.setStatus(INSTALLATION_A, 'suspended')
    expect(await refusalOf(w.service.construct(a.token, w.env.actorOf(a), input))).toBe('installation_not_active')
    // Play's definite no ended that session: it builds nothing, even once the installation is active again.
    w.env.p.setStatus(INSTALLATION_A, 'active')
    expect(await refusalOf(w.service.construct(a.token, w.env.actorOf(a), input))).toBe('play_session_required')
    // A new session, revoked after requireActor answered: the store's own lock refuses it.
    const again = await w.env.open(INSTALLATION_A, ADA)
    const live = await w.env.live(again)
    await t.db.query('UPDATE play_sessions SET revoked_at = now() WHERE id = $1', [live.id])
    expect(await refusalOf(w.store.construct(live, input, w.source.authority))).toBe('session_ended')
    expect(await sequenceOf(a.response.world.id)).toBe(sequence)
  })

  it('12-13. a patron develops the property as community investment, never as the owner\'s own progression, and earns no owner progression either', async () => {
    const w = await world()
    const a = await w.env.open(INSTALLATION_A, ADA)
    const b = await w.env.open(INSTALLATION_A, BEA)
    const p = await w.place(a, keeper(1))
    w.source.grant(GUILD_A, ADA, [{ key: 'starter', units: 100 }])
    w.source.grant(GUILD_A, BEA, [{ key: 'starter', units: 100 }])

    // With no controller known, a patron may still build: no era.
    const early = await w.build(b, p.id, 'patron')
    expect(early.construction).toMatchObject({ role: 'patron', era: null })
    w.source.control(GUILD_A, keeper(1), ADA)
    expect((await w.overview(a, p.id)).investment).toEqual({ currentOwner: 0, previousOwners: 0, community: 50, total: 50 })
    const owner = await w.build(a, p.id, 'owner')
    expect(owner.construction).toMatchObject({ role: 'owner', era: 1, tierAfter: 1 })

    const ada = await w.overview(a, p.id)
    const bea = await w.overview(b, p.id)
    expect(ada.investment).toEqual({ currentOwner: 50, previousOwners: 0, community: 50, total: 100 })
    expect(bea.investment).toEqual(ada.investment)
    // The owner's own progression counts their own units only; the patron's counts none as an owner.
    expect(ada.viewer).toEqual({ ownerUnits: 50, patronUnits: 0 })
    expect(bea.viewer).toEqual({ ownerUnits: 0, patronUnits: 50 })
    expect(bea.history.map((h) => [h.role, h.by])).toEqual([
      ['owner', 'other'],
      ['patron', 'viewer'],
    ])
    expect(bea.control).toBe('other')
    // Each paid from their own account.
    expect((await w.ledger(a.response.world.id)).filter((e) => e.kind === 'construction-debit').map((e) => [e.account_discord_user_id, e.delta])).toEqual([
      [ADA.discordUserId, -50],
      [BEA.discordUserId, -50],
    ])
    await w.verified()
  })

  it('14. a change of controller begins a new era: earlier owners keep their investment, the new owner starts from none of it', async () => {
    const w = await world()
    const a = await w.env.open(INSTALLATION_A, ADA)
    const b = await w.env.open(INSTALLATION_A, BEA)
    const p = await w.place(a, keeper(1))
    const worldId = a.response.world.id
    for (const who of [ADA, BEA]) w.source.grant(GUILD_A, who, [{ key: 'starter', units: 500 }])

    w.source.control(GUILD_A, keeper(1), ADA)
    await w.build(a, p.id, 'owner')
    // Simulated transfer (the fixture now names Bea). Ada is no longer the owner.
    w.source.control(GUILD_A, keeper(1), BEA)
    expect(await refusalOf(w.build(a, p.id, 'owner'))).toBe('not_current_controller')
    // Until Bea's era is recorded, nothing is hers: Ada's units are a previous owner's.
    expect((await w.overview(b, p.id)).investment).toEqual({ currentOwner: 0, previousOwners: 50, community: 0, total: 50 })
    // A patron action sees the new controller first: it records era 2, under Bea, and counts as community.
    const patron = await w.build(a, p.id, 'patron')
    expect(patron.construction).toMatchObject({ role: 'patron', era: 2, tierAfter: 1 })
    expect((await w.overview(b, p.id)).investment).toEqual({ currentOwner: 0, previousOwners: 50, community: 50, total: 100 })
    expect((await w.overview(a, p.id)).viewer).toEqual({ ownerUnits: 50, patronUnits: 50 })

    // Back to Ada (a third era): her first-era units stay a previous owner's.
    const q = await w.place(a, keeper(2))
    w.source.control(GUILD_A, keeper(2), ADA)
    await w.build(a, q.id, 'owner')
    w.source.control(GUILD_A, keeper(2), BEA)
    await w.build(b, q.id, 'owner')
    expect((await w.overview(b, q.id)).investment).toEqual({ currentOwner: 50, previousOwners: 50, community: 0, total: 100 })
    const eras = (await t.db.query<{ era_seq: number; controller_discord_user_id: string; observed_at_sequence: string }>('SELECT era_seq, controller_discord_user_id, observed_at_sequence FROM world_property_control_eras WHERE property_id = $1 ORDER BY era_seq', [q.id])).rows
    expect(eras.map((e) => [e.era_seq, e.controller_discord_user_id])).toEqual([
      [1, ADA.discordUserId],
      [2, BEA.discordUserId],
    ])
    w.source.control(GUILD_A, keeper(2), ADA)
    expect((await w.overview(a, q.id)).investment).toEqual({ currentOwner: 0, previousOwners: 100, community: 0, total: 100 })
    // History is never rewritten: every construction keeps the era and role it was made in.
    expect((await w.constructionsOf(worldId)).map((c) => [c.role, c.control_era_seq, c.contributor_discord_user_id])).toEqual([
      ['owner', 1, ADA.discordUserId],
      ['patron', 2, ADA.discordUserId],
      ['owner', 1, ADA.discordUserId],
      ['owner', 2, BEA.discordUserId],
    ])
    await w.verified()
  })

  it('15-17. founding credit, the property and its plot never move; a later activation in a built city works as before; a fresh read rebuilds the same answer', async () => {
    const w = await world()
    const a = await w.env.open(INSTALLATION_A, ADA)
    const p = await w.place(a, keeper(1))
    const worldId = a.response.world.id
    w.source.control(GUILD_A, keeper(1), ADA)
    w.source.grant(GUILD_A, ADA, [{ key: 'starter', units: 500 }])
    const row = async () => one('SELECT to_jsonb(p) AS row FROM world_properties p WHERE id = $1', [p.id])
    const activation = async () => one('SELECT e.type, e.payload FROM city_events e WHERE e.city_id = $1 AND e.sequence = $2', [`world:${worldId}`, p.sequence])
    const [rowBefore, activationBefore] = [await row(), await activation()]
    await w.build(a, p.id, 'owner')
    await w.build(a, p.id, 'owner')
    expect(await row()).toEqual(rowBefore)
    expect(await activation()).toEqual(activationBefore)
    const building = (await w.stateOf(worldId))!.buildings[p.buildingId]
    expect(building).toEqual({ propertyId: p.id, asset: p.asset, collection: p.collection, districtKey: p.districtKey, ward: p.ward, plot: p.plot, sequence: p.sequence })
    await expect(t.db.query("UPDATE world_properties SET plot = 3, plot_id = district_key || '-w0-p3' WHERE id = $1", [p.id])).rejects.toThrow('a world property is permanent')
    await expect(t.db.query('UPDATE city_events SET payload = $2 WHERE city_id = $1 AND sequence = $3', [`world:${worldId}`, '{}', p.sequence])).rejects.toThrow('append-only')

    // 22. The claim flow on a city with construction: a ticket, an activation, the ticket consumed, state version 3 kept.
    const b = await w.env.open(INSTALLATION_A, BEA)
    const q = await w.place(b, keeper(5))
    const state = (await w.stateOf(worldId))!
    expect(state.version).toBe(3)
    expect(Object.keys(state.buildings)).toEqual([p.buildingId, q.buildingId])
    expect(state.version === 3 && Object.keys(state.development)).toEqual([p.buildingId])
    expect(await one('SELECT status FROM world_district_tickets WHERE property_id = $1', [q.id])).toEqual({ status: 'committed' })
    // A patron builds on the newer property; development stays in building order.
    w.source.grant(GUILD_A, BEA, [{ key: 'starter', units: 50 }])
    await w.build(a, q.id, 'patron')
    const later = (await w.stateOf(worldId))!
    expect(later.version === 3 && Object.keys(later.development)).toEqual([p.buildingId, q.buildingId])

    // 17. Another store, another pool: the same answer from what is stored.
    const fresh = createPool(process.env.TEST_DATABASE_URL!, silentLogger, { searchPath: t.schema })
    try {
      const again = createWorldConstructionStore(fresh, { mode: 'local', log: silentLogger })
      expect(await again.overview(await w.env.sessions.session(a.token), p.id, w.source.authority)).toEqual(await w.overview(a, p.id))
    } finally {
      await fresh.end()
    }
    const city = await w.env.sessions.city(await w.env.sessions.session(b.token))
    expect(city.world.state).toEqual(later)
    await w.verified()
  })

  it('is atomic: a failure at any step leaves the city, its events, eras, constructions and ledger exactly as they were', async () => {
    const steps: ConstructionStep[] = ['locked', 'credited', 'city', 'event', 'era', 'construction', 'debited']
    for (const failAt of steps) {
      let armed = true
      const w = await world({
        onStep: (s) => {
          if (armed && s === failAt) throw new Error(`injected at ${s}`)
        },
      })
      armed = false
      const a = await w.env.open(INSTALLATION_A, ADA)
      const p = await w.place(a, keeper(1))
      const worldId = a.response.world.id
      w.source.control(GUILD_A, keeper(1), ADA)
      w.source.grant(GUILD_A, ADA, [{ key: 'starter', units: 100 }])
      const snapshot = async () => ({
        sequence: await sequenceOf(worldId),
        state: await w.stateOf(worldId),
        events: (await one<{ n: number }>('SELECT count(*)::int AS n FROM city_events WHERE city_id = $1', [`world:${worldId}`])).n,
        eras: (await one<{ n: number }>('SELECT count(*)::int AS n FROM world_property_control_eras')).n,
        constructions: (await w.constructionsOf(worldId)).length,
        ledger: (await w.ledger(worldId)).length,
      })
      const before = await snapshot()
      armed = true
      await expect(w.build(a, p.id, 'owner')).rejects.toThrow(`injected at ${failAt}`)
      armed = false
      expect(await snapshot()).toEqual(before)
      // And the same action then builds, once.
      const action = randomUUID()
      expect((await w.build(a, p.id, 'owner', action)).fresh).toBe(true)
      expect((await w.build(a, p.id, 'owner', action)).fresh).toBe(false)
      await w.verified()
      // Next iteration in a fresh schema.
      await t.db.query(`DROP SCHEMA ${t.schema} CASCADE`)
      await t.db.query(`CREATE SCHEMA ${t.schema}`)
    }
  })

  it('20-21. writes nothing outside local mode, asks no economy, wallet or chain anything, and asks Play only who acts', async () => {
    const w = await world()
    const a = await w.env.open(INSTALLATION_A, ADA)
    const p = await w.place(a, keeper(1))
    w.source.control(GUILD_A, keeper(1), ADA)
    w.source.grant(GUILD_A, ADA, [{ key: 'starter', units: 100 }])
    // A city the source has no construction data for: nothing is read or built there, before anything else is judged.
    w.source.close(GUILD_A)
    expect(await refusalOf(w.build(a, p.id, 'owner'))).toBe('construction_not_open')
    expect(await refusalOf(w.overview(a, p.id))).toBe('construction_not_open')
    expect((await w.stateOf(a.response.world.id))!.version).toBe(2)
    expect(await w.ledger(a.response.world.id)).toEqual([])
    w.source.reopen(GUILD_A)
    for (const mode of ['staging', 'production'] as const) {
      const held = createWorldConstructionStore(t.db, { mode, log: silentLogger })
      expect(await refusalOf(held.construct(await w.env.live(a), { propertyId: p.id, role: 'owner', actionId: randomUUID() }, w.source.authority))).toBe('mutations_held')
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const playCalls = w.env.p.calls.length
    await w.build(a, p.id, 'owner')
    expect(fetchSpy).not.toHaveBeenCalled()
    // requireActor's fresh installation check is the only thing Play is asked.
    expect(w.env.p.calls.slice(playCalls)).toEqual([`getInstallation ${INSTALLATION_A}`])
    expect(w.source.calls.controllerOf).toBeGreaterThan(0)
  })

  it('19. the database refuses what the service never writes: tampered steps, unpaid or overpaid work, changed history, impossible eras and balances', async () => {
    const w = await world()
    const a = await w.env.open(INSTALLATION_A, ADA)
    const b = await w.env.open(INSTALLATION_A, BEA)
    const p = await w.place(a, keeper(1))
    const worldId = a.response.world.id
    const cityId = `world:${worldId}`
    w.source.control(GUILD_A, keeper(1), ADA)
    w.source.grant(GUILD_A, ADA, [{ key: 'starter', units: 100 }])
    const built = await w.build(a, p.id, 'owner')
    const session = (await w.env.live(a)).id
    const bSession = (await w.env.live(b)).id
    const city = await one<{ instance_id: string; sequence: string; state: { development: Record<string, unknown> } }>('SELECT instance_id, sequence, state FROM city WHERE id = $1', [cityId])

    // Records are permanent.
    await expect(t.db.query('UPDATE world_property_constructions SET units = 1 WHERE world_id = $1', [worldId])).rejects.toThrow('a construction is permanent')
    await expect(t.db.query(`DELETE FROM world_property_constructions WHERE world_id = $1`, [worldId])).rejects.toThrow('a construction is permanent')
    await expect(t.db.query('UPDATE world_test_credit_entries SET balance_after = 1000 WHERE world_id = $1', [worldId])).rejects.toThrow('a test credit entry is permanent')
    await expect(t.db.query(`DELETE FROM world_test_credit_entries WHERE world_id = $1`, [worldId])).rejects.toThrow('a test credit entry is permanent')
    await expect(t.db.query('UPDATE world_property_control_eras SET controller_discord_user_id = $2 WHERE property_id = $1', [p.id, BEA.discordUserId])).rejects.toThrow('a control era is permanent')
    await expect(t.db.query(`DELETE FROM world_property_control_eras WHERE property_id = $1`, [p.id])).rejects.toThrow('a control era is permanent')

    /** One hand-written construction transaction: advance the city to `state`, its event, the construction row and a debit, each overridable. */
    async function forge(o: { state?: unknown; event?: Record<string, unknown>; row?: Record<string, unknown>; debit?: number | null; contributor?: typeof ADA; session?: string; era?: number | null; role?: string }) {
      const c = await t.db.connect()
      const next = Number(city.sequence) + 1
      const who = o.contributor ?? ADA
      try {
        await c.query('BEGIN')
        const development = { [p.buildingId]: { tier: 1, built: 100, sequence: next } }
        const state = o.state ?? { ...(await c.query<{ state: Record<string, unknown> }>('SELECT state FROM city WHERE id = $1', [cityId])).rows[0].state, development }
        await c.query('UPDATE city SET state = $1::json, state_version = 3, sequence = $2 WHERE id = $3', [JSON.stringify(state), next, cityId])
        const action = randomUUID()
        const role = o.role ?? 'owner'
        await c.query('INSERT INTO city_events (city_id, sequence, type, payload) VALUES ($1, $2, $3, $4::jsonb)', [
          cityId,
          next,
          'world.property.constructed',
          JSON.stringify({ propertyId: p.id, buildingId: p.buildingId, recipe: 'local-test-tier1-v1', units: 50, builtBefore: 50, builtAfter: 100, tierBefore: 0, tierAfter: 1, action, role, ...o.event }),
        ])
        const row = {
          world_id: worldId,
          city_id: cityId,
          city_instance_id: city.instance_id,
          sequence: next,
          property_id: p.id,
          action_id: action,
          recipe: 'local-test-tier1-v1',
          role,
          contributor_core_user_id: who.coreUserId,
          contributor_discord_user_id: who.discordUserId,
          contributed_in_play_session: o.session ?? session,
          control_era_seq: o.era === undefined ? 1 : o.era,
          resource: 'local-test-credit',
          units: 50,
          built_before: 50,
          built_after: 100,
          tier_before: 0,
          tier_after: 1,
          ...o.row,
        }
        const keys = Object.keys(row)
        await c.query(`INSERT INTO world_property_constructions (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row))
        if (o.debit !== null) {
          const last = (await c.query<{ entry_seq: number; balance_after: number }>('SELECT entry_seq, balance_after FROM world_test_credit_entries WHERE world_id = $1 AND account_discord_user_id = $2 ORDER BY entry_seq DESC LIMIT 1', [worldId, who.discordUserId])).rows[0] ?? { entry_seq: 0, balance_after: 0 }
          const delta = -(o.debit ?? 50)
          await c.query(
            `INSERT INTO world_test_credit_entries (world_id, account_discord_user_id, account_core_user_id, entry_seq, kind, delta, balance_after, city_id, construction_sequence, recorded_in_play_session) VALUES ($1, $2, $3, $4, 'construction-debit', $5, $6, $7, $8, $9)`,
            [worldId, who.discordUserId, who.coreUserId, last.entry_seq + 1, delta, last.balance_after + delta, cityId, next, o.session ?? session],
          )
        }
        await c.query('COMMIT')
      } catch (err) {
        await c.query('ROLLBACK')
        throw err
      } finally {
        c.release()
      }
    }

    // The honest forgery commits (proving the rest are refused for their one difference), then is the city's step 2...
    // so each tampered one below is checked against a city still at step 1: run them first.
    await expect(forge({ row: { units: 60, built_after: 110 } })).rejects.toThrow("a construction builds exactly its recipe's next step")
    await expect(forge({ row: { tier_after: 0 } })).rejects.toThrow("a construction builds exactly its recipe's next step")
    await expect(forge({ row: { built_before: 0, built_after: 50, tier_after: 0 } })).rejects.toThrow("a construction builds exactly its recipe's next step")
    await expect(forge({ row: { recipe: 'free-tier-v9' } })).rejects.toThrow("a construction builds exactly its recipe's next step")
    await expect(forge({ state: { ...city.state, development: { [p.buildingId]: { tier: 0, built: 50, sequence: Number(city.sequence) + 1 } } } })).rejects.toThrow('a construction must be the development its city has just recorded')
    await expect(forge({ event: { role: 'patron' } })).rejects.toThrow('a construction must be recorded by a world.property.constructed event')
    await expect(forge({ debit: null })).rejects.toThrow("a construction is paid for by its contributor's test credits")
    await expect(forge({ debit: 40 })).rejects.toThrow('a test credit debit pays for one construction of its own player, by exactly its units')
    // Bea is no controller: not an owner, in any era; and not a contributor through Ada's session.
    await expect(forge({ contributor: BEA, session: bSession })).rejects.toThrow("an owner builds only in the property's current control era")
    await expect(forge({ contributor: BEA, session: session })).rejects.toThrow("a construction's contributor is the player of the play session that makes it")
    // A patron in an era whose controller they are, or the owner role with no era.
    await expect(forge({ role: 'patron' })).rejects.toThrow('a patron builds in the property')
    await expect(forge({ era: null })).rejects.toThrow("an owner builds only in the property's current control era")
    // Bea has no credits: her honest patron step would leave her below zero.
    await expect(forge({ contributor: BEA, session: bSession, role: 'patron', era: null })).rejects.toThrow('insufficient test credits')
    // The city advanced by a construction event with no construction behind it.
    {
      const c = await t.db.connect()
      try {
        await c.query('BEGIN')
        const next = Number(city.sequence) + 1
        await c.query('UPDATE city SET state = $1::json, state_version = 3, sequence = $2 WHERE id = $3', [JSON.stringify({ ...city.state, development: { [p.buildingId]: { tier: 1, built: 100, sequence: next } } }), next, cityId])
        await c.query("INSERT INTO city_events (city_id, sequence, type, payload) VALUES ($1, $2, 'world.property.constructed', '{}'::jsonb)", [cityId, next])
        await expect(c.query('COMMIT')).rejects.toThrow("a world's city advances only by activating a property or building on one")
      } finally {
        c.release()
      }
    }
    // A grant beyond the bound, a balance that is not its sum, an entry out of order.
    const grant = (o: { seq?: number; delta?: number; balance?: number; key?: string; who?: typeof ADA; session?: string }) =>
      t.db.query(
        `INSERT INTO world_test_credit_entries (world_id, account_discord_user_id, account_core_user_id, entry_seq, kind, delta, balance_after, grant_key, recorded_in_play_session) VALUES ($1, $2, $3, $4, 'fixture-grant', $5, $6, $7, $8)`,
        [worldId, (o.who ?? ADA).discordUserId, (o.who ?? ADA).coreUserId, o.seq ?? 3, o.delta ?? 10, o.balance ?? 60, o.key ?? 'extra', o.session ?? session],
      )
    await expect(grant({ delta: 5000, balance: 5050 })).rejects.toThrow('wtce_delta_bounded')
    await expect(grant({ balance: 1000 })).rejects.toThrow("a test credit entry leaves exactly the account's balance plus its delta")
    await expect(grant({ seq: 7, balance: 60 })).rejects.toThrow('test credit entries are numbered consecutively')
    await expect(grant({ key: 'starter' })).rejects.toThrow('wtce_one_grant')
    await expect(grant({ session: bSession })).rejects.toThrow("by the account's own player")
    // An era with no construction behind it, or the same controller twice.
    await expect(
      t.db.query('INSERT INTO world_property_control_eras (world_id, property_id, era_seq, controller_discord_user_id, source, city_id, observed_at_sequence) VALUES ($1, $2, 2, $3, $4, $5, $6)', [worldId, p.id, ADA.discordUserId, 'local-fixture', cityId, built.sequence]),
    ).rejects.toThrow()
    await expect(
      t.db.query('INSERT INTO world_property_control_eras (world_id, property_id, era_seq, controller_discord_user_id, source, city_id, observed_at_sequence) VALUES ($1, $2, 2, $3, $4, $5, $6)', [worldId, p.id, BEA.discordUserId, 'proofy-core', cityId, built.sequence]),
    ).rejects.toThrow('wpce_source_known')

    // The honest forgery, in the same shape, commits: the refusals above were for their one difference.
    await forge({})
    expect(await sequenceOf(worldId)).toBe(Number(city.sequence) + 1)
    await w.verified()
  })

  it('19-20. outside a local database nothing of it can be written, whatever writes it', async () => {
    await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
    const world = '01a14800-0000-7000-8000-0000000000f1'
    await expect(
      t.db.query(
        `INSERT INTO world_test_credit_entries (world_id, account_discord_user_id, account_core_user_id, entry_seq, kind, delta, balance_after, grant_key, recorded_in_play_session) VALUES ($1, $2, $3, 1, 'fixture-grant', 10, 10, 'k', $1)`,
        [world, ADA.discordUserId, ADA.coreUserId],
      ),
    ).rejects.toThrow('test credits are not enabled in this database')
    await expect(
      t.db.query(
        `INSERT INTO world_property_constructions (world_id, city_id, city_instance_id, sequence, property_id, action_id, recipe, role, contributor_core_user_id, contributor_discord_user_id, contributed_in_play_session, control_era_seq, resource, units, built_before, built_after, tier_before, tier_after)
         VALUES ($1, 'world:x', $1, 3, $1, $1, 'local-test-tier1-v1', 'patron', $2, $3, $1, NULL, 'local-test-credit', 50, 0, 50, 0, 0)`,
        [world, ADA.coreUserId, ADA.discordUserId],
      ),
    ).rejects.toThrow('construction is not enabled in this database')
    await expect(
      t.db.query("INSERT INTO world_property_control_eras (world_id, property_id, era_seq, controller_discord_user_id, source, city_id, observed_at_sequence) VALUES ($1, $1, 1, $2, 'local-fixture', 'world:x', 3)", [world, ADA.discordUserId]),
    ).rejects.toThrow('construction is not enabled in this database')
  })

  it('23. two installations stay apart: credits, eras and construction of one world are not the other\'s', async () => {
    const w = await world()
    const a = await w.env.open(INSTALLATION_A, ADA)
    const ab = await w.env.open(INSTALLATION_B, ADA)
    const p = await w.place(a, keeper(1))
    const pb = await w.place(ab, keeper(1))
    expect(pb.id).not.toBe(p.id)
    w.source.control(GUILD_A, keeper(1), ADA)
    w.source.control(GUILD_B, keeper(1), ADA)
    w.source.grant(GUILD_A, ADA, [{ key: 'starter', units: 100 }])
    await w.build(a, p.id, 'owner')
    await w.build(a, p.id, 'owner')
    // Guild A's grant is spent; Guild B's world has none of it.
    expect(await refusalOf(w.build(ab, pb.id, 'owner'))).toBe('insufficient_test_credits')
    expect((await w.overview(ab, pb.id)).credits).toEqual({ available: 0, recorded: 0, pending: 0 })
    expect((await w.overview(ab, pb.id)).property.tier).toBe(0)
    expect((await w.stateOf(ab.response.world.id))!.version).toBe(2)
    expect(await w.ledger(ab.response.world.id)).toEqual([])
    // The session of one world never reads the other's property.
    expect(await refusalOf(w.overview(ab, p.id))).toBe('unknown_property')
    await w.verified()
  })

  it('18. a restart of the database connection keeps every record; migration 0013 on a populated 0012 database changes nothing that was there', async () => {
    // A populated 0012 database: worlds, properties and tickets, then 0013.
    const dir = await t.migrationsPlus([])
    const { mkdtemp, readdir, copyFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const old = await mkdtemp(join(tmpdir(), 'rc-0012-'))
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) <= 12)) await copyFile(join(dir, f), join(old, f))
    await migrate(t.db, { dir: old, environment: 'local' })
    const env = await setup({ migrated: true })
    const a = await env.open(INSTALLATION_A, ADA)
    const ticket = await env.ticketOf(a, [keeper(1)])
    const city = await env.sessions.city(await env.sessions.session(a.token))
    const placed = await env.activate(a, ticket, keeper(1), city.world.districts.find((d) => d.key === ticket.districtKey)!.candidates.plotIds[0])
    const dump = async () =>
      Object.fromEntries(
        await Promise.all(
          ['city', 'city_events', 'worlds', 'world_properties', 'world_district_tickets', 'world_geometry_freezes', 'world_claim_windows'].map(async (table) => [table, (await t.db.query(`SELECT to_jsonb(x) AS r FROM ${table} x ORDER BY 1::text`)).rows.map((r) => JSON.stringify(r.r)).sort()]),
        ),
      )
    const before = await dump()
    await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })
    expect(await dump()).toEqual(before)
    expect((await one<{ n: number }>('SELECT max(version)::int AS n FROM schema_migrations')).n).toBe(13)
    await verifyCity(t.db).then((r) => expect(r.violations).toEqual([]))

    // Build on the migrated property, then read everything again through a brand new pool.
    const source = testAuthority()
    source.control(GUILD_A, keeper(1), ADA)
    source.grant(GUILD_A, ADA, [{ key: 'starter', units: 100 }])
    const service = createConstructionService({ sessions: env.sessions, store: createWorldConstructionStore(t.db, { mode: 'local', log: silentLogger }), authority: source.authority })
    await service.construct(a.token, env.actorOf(a), { propertyId: placed.property.id, role: 'owner', actionId: randomUUID() })
    await service.construct(a.token, env.actorOf(a), { propertyId: placed.property.id, role: 'owner', actionId: randomUUID() })
    const fresh = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL!, options: `-c search_path=${t.schema}` })
    try {
      const report = await verifyCity(fresh)
      expect(report.violations).toEqual([])
      expect(report.worlds.find((r) => r.id === a.response.world.id)).toMatchObject({ constructions: 2, developedProperties: 1, controlEras: 1, testCreditAccounts: 1 })
    } finally {
      await fresh.end()
    }
  })
})
