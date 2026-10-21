import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { migrate } from '../src/db/migrations'
import { assetKey, nftAsset, type DistrictRuleMatch, type NftAsset, type RuleAnswer } from '../src/engine'
import { silentLogger } from '../src/log'
import { createPlayLaunchService } from '../src/play/launch'
import { createPlaySessionService, createPlaySessionStore, PlaySessionError, type OpenedPlaySession } from '../src/play/session'
import { createPropertyActivationService, createWorldPropertyStore, WorldPropertyRefusal, type ActivationStep } from '../src/world/properties'
import type { TicketEligibility } from '../src/world/rotation'
import { createWorldStore } from '../src/world/store'
import { createDistrictTicketStore, DistrictTicketRefusal, type DistrictTicket, type TicketStep } from '../src/world/tickets'
import { MIGRATIONS_DIR, type TestSchema } from './dbHarness'
import { fakePlay, GUILD_A, GUILD_B, INSTALLATION_A, INSTALLATION_B } from './fakePlay'

/**
 * The district ticket suites' world (P1-C2-D1, P1-C2-D2): a disposable schema, a fake Play with two installations, the
 * real launch path, world store, session service, ticket store and property store, and a MUTABLE trusted source standing
 * in for the rehearsal fixture (grants, explicit rules, Proofy rule results), which a test changes to change the rules.
 */
export const contract = (n: number) => `0x${'0'.repeat(36)}${n.toString(16).padStart(4, '0')}`
export const district = (key: string, gate: null | { verificationRuleId: number; label: string } = null) => ({ key, name: key.replace(/-/g, ' '), accent: '#5aa9ff', monument: null, proofyRule: gate })
/** Four default districts and one restricted one, two collections on two chains. */
export const DOC = {
  cityName: 'Harborlight',
  brand: { name: 'Harborlight', logo: null },
  capital: { name: 'Beacon Hall', crest: null },
  collections: [
    { key: 'harbor-keepers', chain: 'eip155:8453', contract: contract(0xa001), displayName: 'Harbor Keepers' },
    { key: 'tide-pass', chain: 'eip155:1', contract: contract(0xa002), displayName: 'Tide Pass' },
  ],
  districts: [district('lantern-quay'), district('tidewater'), district('saltmarsh'), district('compass-row', { verificationRuleId: 41, label: 'Verified Captain role' }), district('dune')],
}
export const ROTATION = ['lantern-quay', 'tidewater', 'saltmarsh', 'dune']
export const keeper = (id: number | string): NftAsset => nftAsset({ chain: 'eip155:8453', contract: contract(0xa001), tokenId: String(id) })!
export const tide = (id: number | string): NftAsset => nftAsset({ chain: 'eip155:1', contract: contract(0xa002), tokenId: String(id) })!
export const player = (n: number, name = `P${n}`) => ({ discordUserId: `9${String(n).padStart(17, '0')}`, coreUserId: `core-p${n}`, displayName: name })

export async function refusalOf(work: Promise<unknown>): Promise<string> {
  const err = await work.then(
    () => null,
    (e: unknown) => e,
  )
  if (err instanceof WorldPropertyRefusal || err instanceof DistrictTicketRefusal || err instanceof PlaySessionError) return err.code
  throw err ?? new Error('expected a refusal, got success')
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A mutable stand-in for the rehearsal fixture: which NFTs a player holds, which rules match an NFT, how a Proofy rule answers. */
export function testSource() {
  const grants = new Map<string, NftAsset[]>()
  const matches = new Map<string, DistrictRuleMatch[]>()
  const answers = new Map<string, RuleAnswer>()
  const eligibility: TicketEligibility = {
    source: 'local-fixture',
    assets: (p) => grants.get(p.discordUserId) ?? [],
    matches: (a) => matches.get(assetKey(a)) ?? [],
    ruleAnswer: (where, rule) => answers.get(`${where.guildId}/${where.discordUserId}/${rule}`) ?? null,
  }
  return {
    eligibility,
    grant: (who: { discordUserId: string }, assets: NftAsset[]) => grants.set(who.discordUserId, assets),
    rules: (asset: NftAsset, m: DistrictRuleMatch[]) => matches.set(assetKey(asset), m),
    answer: (guild: string, who: { discordUserId: string }, rule: number, a: RuleAnswer) => answers.set(`${guild}/${who.discordUserId}/${rule}`, a),
  }
}

export type TestSource = ReturnType<typeof testSource>

export interface SetupOptions {
  db?: pg.Pool
  migrated?: boolean
  play?: ReturnType<typeof fakePlay>
  source?: TestSource
  /** Configuration documents published to installations A and B (default: DOC for both). */
  docs?: [Record<string, unknown>, Record<string, unknown>]
  onStep?: (step: ActivationStep) => void | Promise<void>
  onTicketStep?: (step: TicketStep) => void | Promise<void>
}

export function ticketWorld(t: TestSchema) {
  async function setup(options: SetupOptions = {}) {
    const db = options.db ?? t.db
    if (!options.migrated) await migrate(db, { dir: MIGRATIONS_DIR, environment: 'local' })
    // One Play per database: run ids are Play's, and a second fake would hand out the same ones again.
    const p = options.play ?? fakePlay()
    if (!options.play) {
      p.install(INSTALLATION_A, GUILD_A)
      p.install(INSTALLATION_B, GUILD_B)
      p.publish(INSTALLATION_A, options.docs?.[0] ?? DOC)
      p.publish(INSTALLATION_B, options.docs?.[1] ?? DOC)
    }
    const source = options.source ?? testSource()
    const worlds = createWorldStore(db, { mode: 'local', log: silentLogger })
    const launch = createPlayLaunchService({ play: p.play, environment: 'dev', gameKey: 'rare-city', worlds })
    const sessions = createPlaySessionService({ store: createPlaySessionStore(db), worlds, play: p.play, environment: 'dev', gameKey: 'rare-city', log: silentLogger, installationCacheMs: 0 })
    const store = createWorldPropertyStore(db, { mode: 'local', log: silentLogger, onStep: options.onStep })
    const tickets = createDistrictTicketStore(db, { mode: 'local', log: silentLogger, eligibility: source.eligibility, onStep: options.onTicketStep })
    const activation = createPropertyActivationService({ sessions, store })
    let runs = 0
    const open = async (installation: string, who: { discordUserId: string; coreUserId: string; displayName: string }, presented: string | null = null) =>
      sessions.open(await launch.open({ runToken: p.launch(installation, `run-${++runs}-${randomUUID()}`, { player: who }) }), presented)
    const actorOf = (o: OpenedPlaySession) => ({ sessionRef: o.response.viewer.session.ref, worldId: o.response.world.id, discordUserId: o.response.viewer.player.discordUserId })
    const live = (o: OpenedPlaySession) => sessions.requireActor(o.token, actorOf(o))
    const who = (o: OpenedPlaySession) => ({ discordUserId: o.response.viewer.player.discordUserId })
    /** City entry, eligible by `assets` (the trusted source's list for the player, replaced). */
    const enter = async (o: OpenedPlaySession, assets: NftAsset[] = [keeper(1)]) => {
      source.grant(who(o), assets)
      return tickets.enter(await live(o))
    }
    /** City entry that must issue (or return) a ticket. */
    const ticketOf = async (o: OpenedPlaySession, assets?: NftAsset[]): Promise<DistrictTicket> => {
      const entered = await enter(o, assets)
      if (!entered.ticket) throw new Error(`entry issued no ticket (awaiting ${entered.awaiting})`)
      return entered.ticket
    }
    /** The NFT selected, with the explicit rules the trusted source now says match it (replaced). */
    const assign = async (o: OpenedPlaySession, ticket: { id: string } | null, asset: NftAsset, matches: DistrictRuleMatch[] = []) => {
      source.rules(asset, matches)
      return tickets.assign(await live(o), ticket?.id ?? null, asset)
    }
    const release = async (o: OpenedPlaySession, ticket: { id: string }) => tickets.release(await live(o), ticket.id)
    const drawnOf = async (o: OpenedPlaySession) => (await sessions.city(await sessions.session(o.token))).world.definition.geometryFingerprint
    const activate = async (o: OpenedPlaySession, ticket: { id: string }, asset: NftAsset, plotId: string, matches: DistrictRuleMatch[] = [], drawn?: string, refuseRuleGatedDistricts = true) => {
      source.rules(asset, matches)
      return activation.activate(
        o.token,
        actorOf(o),
        { asset, plotId, geometryFingerprint: drawn ?? (await drawnOf(o)) },
        { refuseRuleGatedDistricts, ticket: { id: ticket.id, matches, ruleAnswer: source.eligibility.ruleAnswer, source: 'local-fixture' } },
      )
    }
    return { p, db, source, worlds, launch, sessions, store, tickets, activation, open, actorOf, live, enter, ticketOf, assign, release, activate, drawnOf }
  }

  const one = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows[0]
  const rotation = (worldId: string) =>
    one<{ epoch: number; high_water: string; committed_count: string; districts: string[]; basis_config_version: number }>(
      'SELECT epoch, high_water, committed_count, districts, basis_config_version FROM world_assignment_rotations WHERE world_id = $1',
      [worldId],
    )
  const slotsOf = async (worldId: string) =>
    (await t.db.query<{ ordinal: string; generation: number; state: string; district_key: string; epoch: number }>('SELECT ordinal, generation, state, district_key, epoch FROM world_assignment_slots WHERE world_id = $1 ORDER BY ordinal', [worldId])).rows.map(
      (s) => ({ ...s, ordinal: Number(s.ordinal) }),
    )
  const sequenceOf = async (worldId: string) => Number((await one<{ sequence: string }>('SELECT c.sequence FROM city c JOIN worlds w ON w.city_id = c.id WHERE w.id = $1', [worldId])).sequence)
  const frozen = async (worldId: string) => (await one<{ n: number }>('SELECT count(*)::int AS n FROM world_geometry_freezes WHERE world_id = $1', [worldId])).n === 1
  const statusOf = async (id: string) => (await one<{ status: string }>('SELECT status FROM world_district_tickets WHERE id = $1', [id])).status

  /**
   * TIME TRAVEL, for tests only. The lease is fixed at 900 seconds (D2), so instead of waiting, a test moves the instants
   * of a player's open claim window and of every ticket issued in it back by the same amount, so that exactly `seconds` remain
   * (negative: it ran out that long ago). Done past the guards (replica role) in this disposable schema; the window stays
   * exactly 900 seconds long, and every check of the stores and the database still reads this database's clock.
   */
  async function leaveOnly(worldId: string, who: { discordUserId: string }, seconds: number, db: pg.Pool = t.db): Promise<void> {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL session_replication_role = 'replica'`)
      const moved = await client.query(
        `WITH w AS (SELECT id, expires_at - (clock_timestamp() + make_interval(secs => $3::double precision)) AS d FROM world_claim_windows WHERE world_id = $1 AND actor_discord_user_id = $2 AND closed_at IS NULL),
              moved AS (UPDATE world_claim_windows c SET opened_at = c.opened_at - w.d, expires_at = c.expires_at - w.d FROM w WHERE c.id = w.id RETURNING c.id)
         UPDATE world_district_tickets t SET issued_at = t.issued_at - w.d, expires_at = t.expires_at - w.d FROM w WHERE t.claim_window = w.id`,
        [worldId, who.discordUserId, seconds],
      )
      if (moved.rowCount === null) throw new Error('nothing moved')
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  return { setup, one, rotation, slotsOf, sequenceOf, frozen, statusOf, leaveOnly }
}
