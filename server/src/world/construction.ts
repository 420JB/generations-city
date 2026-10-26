import pg, { type PoolClient } from 'pg'
import { environmentStamp } from '../city/store'
import type { AppMode } from '../config'
import type { Database } from '../db/pool'
import { withTransaction } from '../db/transaction'
import {
  CONSTRUCTED_WORLD_CITY_STATE_VERSION,
  constructionStep,
  constructionTier,
  LOCAL_TEST_CONSTRUCTION_RECIPE,
  nextTierAt,
  parseAssetKey,
  PROPERTY_CONSTRUCTED_EVENT,
  proposePropertyConstruction,
  recipeMaxTier,
  worldCityStateText,
  type ConstructionRecipe,
  type NftAsset,
} from '../engine'
import type { Logger } from '../log'
import type { ExpectedActor, LivePlaySession, PlaySessionService } from '../play/session'
import { readPropertyLegacy, type PropertyLegacy } from './legacy'
import { lockWorldForChange, WorldRefusal, type ActivatorIdentity, type WorldScope } from './store'

/**
 * PROPERTY CONSTRUCTION, AUTHORITATIVE PERSISTENCE (P1-C2-E3A, Tier 2 in P1-C2-E3B). LOCAL ONLY, TEST CREDITS ONLY.
 *
 * What a player can BUILD into a property: one fixed step of the engine's current recipe
 * (`LOCAL_TEST_CONSTRUCTION_RECIPE`, provisional local tuning: Tier 0 to Tier 2), paid for with valueless
 * LOCAL TEST credits. A construction an earlier recipe made (`local-test-tier1-v1`) keeps that recipe's record, and
 * is answered exactly as recorded when its press is repeated; the property continues under the current recipe, which
 * extends the earlier one. The one caller outside tests is the local rehearsal (`rehearsal.ts`), whose routes exist
 * only in a local deployment started with an explicit rehearsal file. Like property activation it refuses any
 * mode or database but a local one, and so does the database (migration 0013). Nothing here touches RF, Proofy
 * Points, a token, a wallet or any economy provider, and nothing grants credits on request.
 *
 * WHAT THE BROWSER DECIDES: which property, in which role (owner or patron), and the id of this one press.
 * Nothing else. The engine computes the step (units and resulting tier) from the city as stored, under its
 * lock; the server computes the cost (the units) and the balance; the page is answered with what committed.
 *
 * WHERE. Construction is open only in a city whose Discord server the trusted source has construction data for (a
 * controller or a grant). Every other city, rehearsal or not, reads and builds nothing (`construction_not_open`).
 *
 * WHO MAY BUILD AS OWNER. Founding a property (its original activator, 0008) proves nothing about who holds
 * its NFT now, so it authorizes nothing here. An owner builds only while the trusted source
 * (`ConstructionAuthority`, locally the rehearsal file: TEST DATA, never verified ownership) names them, by the
 * Discord user Proofy Play redeemed for their session, as the NFT's current controller in this world's Discord
 * server. Anyone else in the world builds as a patron; the controller cannot build as a patron (their own
 * investment is the owner's). An unknown controller authorizes no owner. The source is asked again for every
 * action, under the city lock.
 *
 * CONTROL ERAS. The first action to see a controller records it as the property's next control era, in its own
 * transaction. An owner's units are counted in the era they were built in, so a later controller never inherits
 * an earlier one's investment, and nothing earlier is rewritten. Investment reads (`overview`) split a property's
 * lifetime units into the current owner's (the latest era, while the source still names its controller),
 * previous owners' (every other owner unit) and the community's (every patron unit).
 *
 * TEST CREDITS. One append-only running balance per player and world (`world_test_credit_entries`). The trusted
 * source lists bounded grants per Discord server and player; a grant is recorded once (by its key), inside the
 * first construction transaction of that player that needs it, never on a read and never through a route of its
 * own. An action costs exactly the units it builds; a balance never goes below zero.
 *
 * ONE TRANSACTION, or nothing: the city advances exactly one sequence (state version 3), its
 * `world.property.constructed` event, a new control era if one began, the construction record, any grants not
 * recorded yet and the debit. Every construction of a world queues on its city row (FOR UPDATE, as activations
 * and adoptions do), so two actions never spend one balance twice and each is judged on the city the one before
 * left. The play session is locked FOR SHARE right after, and must be live.
 *
 * IDEMPOTENCY. The page names each press with a fresh UUID (`actionId`), unique per world. The same player
 * repeating it, for the same property and role, gets the construction it made back (`fresh: false`), its stored
 * record whatever recipe is current now, and pays nothing more; any other use of that id is refused
 * (`action_conflict`). Two identical requests at once queue on the city lock: one builds, the other is answered with
 * what it built.
 *
 * ARCHITECT ACTIVITY (`architect`, P1-C2-E3B). A player's own construction record in one world, read from the
 * construction records only: what they built as the NFT's controller (owner units: their own Architect progression),
 * split into the control eras that are still theirs now and earlier ones, and what they built as a patron (which
 * develops others' properties and is never counted as their own progression). Descriptive statistics only: no rank,
 * level, XP, badge or reward exists, and none is implied.
 *
 * PROPERTY LEGACY (`legacy`, P1-C2-E5A, `legacy.ts`). One property's founding, control eras, investment by whose it is, the
 * viewer's own part in it and its design revisions, read from those records only. Read only, like the two reads above.
 */
export type ConstructionRole = 'owner' | 'patron'

export type WorldConstructionRefusalCode =
  /** This deployment does not build (anything but a local database). */
  | 'mutations_held'
  /** The trusted source has no construction data at all for this Discord server's city: construction is not open in it. */
  | 'construction_not_open'
  /** The world could not be read as one this build wrote, or its storage failed. */
  | 'world_unavailable'
  /** The city moved while this construction was being written (should not happen under its lock). */
  | 'sequence_conflict'
  /** The play session ended before the construction could be written. Nothing was. */
  | 'session_ended'
  /** The property is not one of this world's. */
  | 'unknown_property'
  /** The property already stands at the highest tier the recipe builds. */
  | 'construction_complete'
  /** An owner construction, and the trusted source names someone else as the NFT's current controller. */
  | 'not_current_controller'
  /** An owner construction, and the trusted source names nobody as the NFT's current controller. */
  | 'control_unverified'
  /** A patron construction by the NFT's current controller: their investment is the owner's. */
  | 'controller_builds_as_owner'
  /** The player's test credits do not cover this action. Nothing was written. */
  | 'insufficient_test_credits'
  /** The action id already names another construction (another player's, property's or role's). */
  | 'action_conflict'

export class WorldConstructionRefusal extends Error {
  readonly code: WorldConstructionRefusalCode
  constructor(code: WorldConstructionRefusalCode, message: string = code) {
    super(message)
    this.name = 'WorldConstructionRefusal'
    this.code = code
  }
}

/** What a construction action names. Untyped: checked here. */
export interface ConstructionInput {
  propertyId: unknown
  role: unknown
  actionId: unknown
}

/** A test credit grant of the trusted source: `units` credits for one player in one Discord server's city, once, by `key`. */
export interface TestCreditGrant {
  key: string
  units: number
}

/**
 * The trusted source of who controls an NFT now and which test credits a player is granted. Locally the rehearsal
 * file (`source: 'local-fixture'`): TEST DATA, keyed by the Discord server the world belongs to and the Discord user
 * Proofy Play redeemed for the session, never by anything a browser says. Nothing else exists.
 */
export interface ConstructionAuthority {
  source: 'local-fixture'
  /** Whether construction is open in this Discord server's city at all: the source names a controller or a grant there. */
  opensIn(where: { guildId: string }): boolean
  /** The Discord user named as `asset`'s current controller in this Discord server's city, or null: nobody known. */
  controllerOf(where: { guildId: string }, asset: NftAsset): string | null
  /** The test credit grants of one player in one Discord server's city. */
  grantsFor(where: { guildId: string; discordUserId: string }): readonly TestCreditGrant[]
}

/** A construction as stored. */
export interface ConstructionRecord {
  /** The city sequence it produced. */
  sequence: number
  propertyId: string
  actionId: string
  recipe: string
  role: ConstructionRole
  contributor: ActivatorIdentity
  /** The property's control era it was built in: the owner's own; for a patron the one current then, or none. */
  era: number | null
  units: number
  builtBefore: number
  builtAfter: number
  tierBefore: number
  tierAfter: number
  constructedAt: string
}

export interface ConstructionResult {
  /** false when this action had already built: nothing was written, nothing paid. */
  fresh: boolean
  construction: ConstructionRecord
  /** The city's sequence after this call. */
  sequence: number
  /** The player's recorded test credit balance after this call. */
  balance: number
}

/** What a viewer may do on a property now, as the server judges it (an answer, not an authorization: `construct` judges again). */
export type ConstructionStanding =
  | { kind: 'ready'; role: ConstructionRole; units: number }
  | { kind: 'complete' }
  | { kind: 'insufficient'; role: ConstructionRole; units: number }

export interface ConstructionOverview {
  recipe: ConstructionRecipe
  property: { propertyId: string; buildingId: string; tier: number; built: number; nextTierAt: number | null; maxTier: number }
  /** Who the trusted source names as the NFT's current controller, as the viewer may know it: them, someone else, nobody. */
  control: 'viewer' | 'other' | 'unknown'
  standing: ConstructionStanding
  /** The viewer's test credits here: recorded (the ledger), granted but not recorded yet, and the sum they can spend. */
  credits: { available: number; recorded: number; pending: number }
  /** The property's lifetime units, by whose investment they are. */
  investment: { currentOwner: number; previousOwners: number; community: number; total: number }
  /** What the viewer has built in this world: as an owner (their own, Architect progression) and as a patron of others. */
  viewer: { ownerUnits: number; patronUnits: number }
  /** How many different players have built here, as an owner and as a patron (one player may be both). Nobody is named. */
  contributors: { owners: number; patrons: number }
  /** The property's constructions, newest first (at most HISTORY_LIMIT), and how many it has in all. Each names the recipe that computed it. */
  history: { sequence: number; recipe: string; role: ConstructionRole; units: number; tierAfter: number; by: 'viewer' | 'other'; era: number | null; at: string }[]
  historyCount: number
}

export const HISTORY_LIMIT = 20

/** One property in a player's Architect activity: why it is listed, where it stands, and what the player built in it. */
export interface ArchitectProperty {
  propertyId: string
  buildingId: string
  /** CAIP-19 key of its NFT. */
  asset: string
  collection: string
  districtKey: string
  plotId: string
  ward: number
  plot: number
  /** The player is its original activator (0008). Founding is a permanent record, never ownership. */
  founded: boolean
  /** Whom the trusted source names as its NFT's current controller, as the player may know it. Never verified. */
  control: 'viewer' | 'other' | 'unknown'
  tier: number
  built: number
  nextTierAt: number | null
  /** What the player could do there now (the server judges it again when they do). */
  standing: ConstructionStanding
  /** What the player built there, by role, and which of their owner units are in the control era that is theirs now. */
  yours: { ownerUnits: number; currentEraOwnerUnits: number; earlierEraOwnerUnits: number; patronUnits: number; actions: number; tiersCompleted: number; lastSequence: number | null }
}

/** A player's own LOCAL TEST construction record in one world, from its construction records. Descriptive only. */
export interface ArchitectOverview {
  recipe: ConstructionRecipe
  credits: { available: number; recorded: number; pending: number }
  totals: {
    /** Units built as the NFT's named controller: the player's own Architect progression, every era. */
    ownerUnits: number
    /** Of those, units in control eras the player still holds now. */
    currentEraOwnerUnits: number
    /** Of those, units in earlier eras: still theirs, but of a control that has since ended (or not been seen again). */
    earlierEraOwnerUnits: number
    /** Units built as a patron: develops others' properties, never the player's own progression. */
    patronUnits: number
    ownerActions: number
    patronActions: number
    /** Tier changes the player's own actions completed, either role. */
    tiersCompleted: number
    /** Properties the player has built into, and those they built into as an owner. */
    propertiesDeveloped: number
    propertiesDevelopedAsOwner: number
  }
  /** Properties the player founded, controls now (per the source) or built into: most recent activity first, at most ARCHITECT_PROPERTY_LIMIT. */
  properties: ArchitectProperty[]
  propertyCount: number
}

export const ARCHITECT_PROPERTY_LIMIT = 50

/** Points inside the write at which a test may make it fail, or act, to prove nothing is left half-written. */
export type ConstructionStep = 'locked' | 'credited' | 'city' | 'event' | 'era' | 'construction' | 'debited'

export interface WorldConstructionStore {
  /** Build one step for a session `requireActor` returned. LOCAL ONLY: see the top of this file. */
  construct(actor: LivePlaySession, input: ConstructionInput, authority: ConstructionAuthority): Promise<ConstructionResult>
  /** A property's construction as `viewer` may see it. Read only: one snapshot, no lock, nothing written. */
  overview(viewer: LivePlaySession, propertyId: unknown, authority: ConstructionAuthority): Promise<ConstructionOverview>
  /** `viewer`'s own construction record in their session's world. Read only: one snapshot, no lock, nothing written. */
  architect(viewer: LivePlaySession, authority: ConstructionAuthority): Promise<ArchitectOverview>
  /** A property's legacy as `viewer` may see it (`legacy.ts`). Read only: one snapshot, no lock, nothing written. */
  legacy(viewer: LivePlaySession, propertyId: unknown, authority: ConstructionAuthority): Promise<PropertyLegacy>
}

export interface WorldConstructionStoreOptions {
  mode: AppMode
  log: Logger
  onStep?: (step: ConstructionStep) => void | Promise<void>
  /**
   * The recipe new constructions are computed by: the current one (`LOCAL_TEST_CONSTRUCTION_RECIPE`), always, outside
   * tests. A test passes an earlier one only to write a database as an earlier build did, under that build's migrations;
   * from migration 0014 the database refuses any recipe but the current one.
   */
  recipe?: ConstructionRecipe
}

/** What `world_property_constructions_guard` and `world_test_credit_entries_guard` (0013) raise when the session is not live. */
const GUARD_SESSION_NOT_LIVE = ['a construction is made only in a live play session of its world', "a test credit entry is recorded only in a live play session of its world, by the account's own player"]
/** PL/pgSQL `RAISE EXCEPTION` without an ERRCODE, and a unique key taken. */
const RAISE_EXCEPTION = 'P0001'
const UNIQUE_VIOLATION = '23505'

const LOCK_TIMEOUT = '5s'
const STATEMENT_TIMEOUT = '8s'
const IDLE_IN_TRANSACTION_TIMEOUT = '15s'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface ConstructionRow {
  sequence: string
  property_id: string
  action_id: string
  recipe: string
  role: ConstructionRole
  contributor_core_user_id: string
  contributor_discord_user_id: string
  control_era_seq: number | null
  units: number
  built_before: number
  built_after: number
  tier_before: number
  tier_after: number
  constructed_at: Date
}

const CONSTRUCTION_COLUMNS =
  'sequence, property_id, action_id, recipe, role, contributor_core_user_id, contributor_discord_user_id, control_era_seq, units, built_before, built_after, tier_before, tier_after, constructed_at'

const recordOf = (r: ConstructionRow): ConstructionRecord => ({
  sequence: Number(r.sequence),
  propertyId: r.property_id,
  actionId: r.action_id,
  recipe: r.recipe,
  role: r.role,
  contributor: { coreUserId: r.contributor_core_user_id, discordUserId: r.contributor_discord_user_id },
  era: r.control_era_seq,
  units: r.units,
  builtBefore: r.built_before,
  builtAfter: r.built_after,
  tierBefore: r.tier_before,
  tierAfter: r.tier_after,
  constructedAt: r.constructed_at.toISOString(),
})

interface PropertyRef {
  id: string
  building_id: string
  chain: string
  standard: string
  contract: string
  token_id: string
}

/** A property of exactly the world `scope` names, through its whole binding. */
async function propertyIn(client: Pick<PoolClient, 'query'>, scope: WorldScope, propertyId: string): Promise<PropertyRef | null> {
  return (
    (
      await client.query<PropertyRef>(
        `SELECT p.id, p.building_id, p.chain, p.standard, p.contract, p.token_id
           FROM world_properties p JOIN world_play_bindings b ON b.world_id = p.world_id
          WHERE p.id = $1 AND p.world_id = $2 AND b.play_environment = $3 AND b.play_game_key = $4 AND b.play_installation_id = $5 AND b.discord_guild_id = $6`,
        [propertyId, scope.worldId, scope.environment, scope.gameKey, scope.installationId, scope.discordGuildId],
      )
    ).rows[0] ?? null
  )
}

const assetOf = (p: PropertyRef) => parseAssetKey(`${p.chain}/${p.standard}:${p.contract}/${p.token_id}`)

interface Account {
  entries: number
  balance: number
  grantKeys: Set<string>
}

/** A player's test credit account in a world: how many entries it has, its balance, and the grant keys it has recorded. */
async function accountOf(client: Pick<PoolClient, 'query'>, worldId: string, who: ActivatorIdentity): Promise<Account> {
  const rows = (
    await client.query<{ entry_seq: number; balance_after: number; grant_key: string | null }>(
      'SELECT entry_seq, balance_after, grant_key FROM world_test_credit_entries WHERE world_id = $1 AND account_discord_user_id = $2 AND account_core_user_id = $3 ORDER BY entry_seq',
      [worldId, who.discordUserId, who.coreUserId],
    )
  ).rows
  // A grant key is the player's in this world whatever Core id recorded it (0013: one per Discord user and key).
  const keys = (await client.query<{ grant_key: string }>("SELECT grant_key FROM world_test_credit_entries WHERE world_id = $1 AND account_discord_user_id = $2 AND kind = 'fixture-grant'", [worldId, who.discordUserId])).rows
  return { entries: rows.length, balance: rows.at(-1)?.balance_after ?? 0, grantKeys: new Set(keys.map((k) => k.grant_key)) }
}

/** The grants of the trusted source not recorded yet, in the source's order. */
const pendingGrants = (account: Account, grants: readonly TestCreditGrant[]) => grants.filter((g) => !account.grantKeys.has(g.key))

/** The role an input names, or null. */
const roleOf = (v: unknown): ConstructionRole | null => (v === 'owner' || v === 'patron' ? v : null)

/** What a viewer may do on a property with `built` units, whose controller the source names as `controller`, with `available` credits. */
function standingOf(recipe: ConstructionRecipe, built: number, controller: string | null, viewer: string, available: number): ConstructionStanding {
  const role: ConstructionRole = controller === viewer ? 'owner' : 'patron'
  const step = constructionStep(recipe, built)
  return step === null ? { kind: 'complete' } : available >= step ? { kind: 'ready', role, units: step } : { kind: 'insufficient', role, units: step }
}

/** The control era of a property that is current now: its latest, while the source still names that era's controller. */
const currentEraOf = (latest: { era_seq: number; controller_discord_user_id: string } | undefined, controller: string | null) =>
  latest && controller !== null && latest.controller_discord_user_id === controller ? latest.era_seq : null

const sumUnits = (rows: readonly { units: number }[]) => rows.reduce((n, r) => n + r.units, 0)

export function createWorldConstructionStore(db: Database, { mode, log, onStep, recipe = LOCAL_TEST_CONSTRUCTION_RECIPE }: WorldConstructionStoreOptions): WorldConstructionStore {
  const isRefusal = (err: unknown) => err instanceof WorldConstructionRefusal || err instanceof WorldRefusal

  async function construct(actor: LivePlaySession, input: ConstructionInput, authority: ConstructionAuthority): Promise<ConstructionResult> {
    // The service's own hold, before anything is read. The database holds the same line (0013).
    if (mode !== 'local') throw new WorldConstructionRefusal('mutations_held', 'Construction is written only in a local database until live player mutations are authorized.')
    const role = roleOf(input.role)
    if (typeof input.propertyId !== 'string' || !UUID.test(input.propertyId) || !role || typeof input.actionId !== 'string' || !UUID.test(input.actionId))
      throw new WorldConstructionRefusal('unknown_property', 'The construction names no property, role or action this server can read.')
    const propertyId = input.propertyId
    const actionId = input.actionId
    const where = { guildId: actor.scope.discordGuildId }
    if (!authority.opensIn(where)) throw new WorldConstructionRefusal('construction_not_open', 'Construction is not open in this city on this local server.')

    return withTransaction(db, isRefusal, async (client) => {
      await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)
      await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${IDLE_IN_TRANSACTION_TIMEOUT}'`)
      const stamp = await environmentStamp(client)
      if (stamp !== 'local') throw new WorldConstructionRefusal('mutations_held', `the database is stamped "${stamp ?? 'unstamped'}"; construction is written only in a local database`)

      // The world exactly as the session names it, its city locked FOR UPDATE: every change to the city queues here.
      const read = await lockWorldForChange(client, actor.scope)
      await onStep?.('locked')
      // The session, locked until this transaction ends: its row names the contributor, as Proofy Play's redeemed run named them.
      const live = (
        await client.query<{ core_user_id: string; discord_user_id: string }>(
          'SELECT core_user_id, discord_user_id FROM play_sessions WHERE id = $1 AND world_id = $2 AND revoked_at IS NULL AND expires_at > clock_timestamp() FOR SHARE',
          [actor.id, actor.scope.worldId],
        )
      ).rows
      if (live.length !== 1) throw new WorldConstructionRefusal('session_ended', 'The play session ended before the construction was written.')
      const contributor: ActivatorIdentity = { coreUserId: live[0].core_user_id, discordUserId: live[0].discord_user_id }

      // The same press again: the construction it made, for the player who made it, and only for exactly that.
      const done = (await client.query<ConstructionRow>(`SELECT ${CONSTRUCTION_COLUMNS} FROM world_property_constructions WHERE world_id = $1 AND action_id = $2`, [actor.scope.worldId, actionId])).rows[0]
      if (done) {
        if (done.property_id !== propertyId || done.role !== role || done.contributor_core_user_id !== contributor.coreUserId || done.contributor_discord_user_id !== contributor.discordUserId)
          throw new WorldConstructionRefusal('action_conflict', 'This action id already names another construction.')
        return { fresh: false, construction: recordOf(done), sequence: read.sequence, balance: (await accountOf(client, actor.scope.worldId, contributor)).balance }
      }

      const property = await propertyIn(client, actor.scope, propertyId)
      const asset = property && assetOf(property)
      if (!property || !asset) throw new WorldConstructionRefusal('unknown_property', 'That is not a property of this city.')

      // Who controls the NFT now, as the trusted source says it today: never the founder, never the browser.
      const controller = authority.controllerOf(where, asset)
      if (role === 'owner' && controller === null) throw new WorldConstructionRefusal('control_unverified', 'Nobody is named as this NFT\'s current controller, so nobody can build as its owner.')
      if (role === 'owner' && controller !== contributor.discordUserId) throw new WorldConstructionRefusal('not_current_controller', 'You are not named as this NFT\'s current controller.')
      if (role === 'patron' && controller === contributor.discordUserId) throw new WorldConstructionRefusal('controller_builds_as_owner', 'You are named as this NFT\'s current controller: build as its owner.')

      const proposed = proposePropertyConstruction(read.state, read.sequence, { buildingId: property.building_id, recipe })
      if (!proposed.ok) throw new WorldConstructionRefusal(proposed.reason === 'construction-complete' ? 'construction_complete' : 'unknown_property')
      const t = proposed.transition

      // The player's credits: grants the trusted source lists that are not recorded yet are recorded now, before the
      // debit, in this transaction (a refused action records none of them).
      const account = await accountOf(client, actor.scope.worldId, contributor)
      let entries = account.entries
      let balance = account.balance
      for (const g of pendingGrants(account, authority.grantsFor({ ...where, discordUserId: contributor.discordUserId }))) {
        entries++
        balance += g.units
        await client.query(
          `INSERT INTO world_test_credit_entries (world_id, account_discord_user_id, account_core_user_id, entry_seq, kind, delta, balance_after, grant_key, recorded_in_play_session)
           VALUES ($1, $2, $3, $4, 'fixture-grant', $5, $6, $7, $8)`,
          [actor.scope.worldId, contributor.discordUserId, contributor.coreUserId, entries, g.units, balance, g.key, actor.id],
        )
      }
      await onStep?.('credited')
      if (balance < t.units) throw new WorldConstructionRefusal('insufficient_test_credits', `This action costs ${t.units} test credits; you have ${balance}.`)

      // The property's control era: a controller the source names now, and the latest era does not, begins the next one.
      const latestEra = (await client.query<{ era_seq: number; controller_discord_user_id: string }>('SELECT era_seq, controller_discord_user_id FROM world_property_control_eras WHERE property_id = $1 ORDER BY era_seq DESC LIMIT 1', [property.id])).rows[0]
      const newEra = controller !== null && latestEra?.controller_discord_user_id !== controller ? (latestEra?.era_seq ?? 0) + 1 : null
      const era = controller === null ? null : (newEra ?? latestEra!.era_seq)

      const moved = await client.query(
        'UPDATE city SET state = $1::json, state_version = $2, sequence = $3, updated_at = now() WHERE id = $4 AND instance_id = $5 AND sequence = $6',
        [worldCityStateText(t.state), CONSTRUCTED_WORLD_CITY_STATE_VERSION, t.to, read.cityId, read.instance, t.from],
      )
      if (moved.rowCount !== 1) throw new WorldConstructionRefusal('sequence_conflict')
      await onStep?.('city')
      await client.query('INSERT INTO city_events (city_id, sequence, type, payload) VALUES ($1, $2, $3, $4::jsonb)', [read.cityId, t.to, PROPERTY_CONSTRUCTED_EVENT, JSON.stringify({ ...t.event, action: actionId, role })])
      await onStep?.('event')
      if (newEra !== null) {
        await client.query(
          `INSERT INTO world_property_control_eras (world_id, property_id, era_seq, controller_discord_user_id, source, city_id, observed_at_sequence) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [actor.scope.worldId, property.id, newEra, controller, authority.source, read.cityId, t.to],
        )
        await onStep?.('era')
      }
      const row = (
        await client.query<ConstructionRow>(
          `INSERT INTO world_property_constructions (world_id, city_id, city_instance_id, sequence, property_id, action_id, recipe, role, contributor_core_user_id, contributor_discord_user_id,
                                                     contributed_in_play_session, control_era_seq, resource, units, built_before, built_after, tier_before, tier_after)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'local-test-credit', $13, $14, $15, $16, $17) RETURNING ${CONSTRUCTION_COLUMNS}`,
          [actor.scope.worldId, read.cityId, read.instance, t.to, property.id, actionId, t.recipe, role, contributor.coreUserId, contributor.discordUserId, actor.id, era, t.units, t.builtBefore, t.builtAfter, t.tierBefore, t.tierAfter],
        )
      ).rows[0]
      await onStep?.('construction')
      await client.query(
        `INSERT INTO world_test_credit_entries (world_id, account_discord_user_id, account_core_user_id, entry_seq, kind, delta, balance_after, city_id, construction_sequence, recorded_in_play_session)
         VALUES ($1, $2, $3, $4, 'construction-debit', $5, $6, $7, $8, $9)`,
        [actor.scope.worldId, contributor.discordUserId, contributor.coreUserId, entries + 1, -t.units, balance - t.units, read.cityId, t.to, actor.id],
      )
      await onStep?.('debited')
      return { fresh: true, construction: recordOf(row), sequence: t.to, balance: balance - t.units }
    })
  }

  return {
    async construct(actor, input, authority) {
      let result: ConstructionResult
      try {
        result = await construct(actor, input, authority)
      } catch (err) {
        if (err instanceof WorldConstructionRefusal) throw err
        if (err instanceof WorldRefusal) throw new WorldConstructionRefusal('world_unavailable', err.message)
        if (err instanceof pg.DatabaseError && err.code === RAISE_EXCEPTION && GUARD_SESSION_NOT_LIVE.includes(err.message)) throw new WorldConstructionRefusal('session_ended', 'The play session ended before the construction was written.')
        // Only under a lock this store always takes could another writer have taken the action id or the entry number
        // first; answering a repeat needs a fresh read, so the caller is told to try again (nothing was written).
        if (err instanceof pg.DatabaseError && err.code === UNIQUE_VIOLATION) throw new WorldConstructionRefusal('sequence_conflict', 'Another construction was written at the same moment; nothing was written by this one.')
        throw err
      }
      if (result.fresh)
        log.info('world property constructed', { world: actor.scope.worldId, property: result.construction.propertyId, role: result.construction.role, units: result.construction.units, tier: result.construction.tierAfter, sequence: result.sequence })
      return result
    },

    async overview(viewer, propertyIdInput, authority) {
      if (typeof propertyIdInput !== 'string' || !UUID.test(propertyIdInput)) throw new WorldConstructionRefusal('unknown_property')
      if (!authority.opensIn({ guildId: viewer.scope.discordGuildId })) throw new WorldConstructionRefusal('construction_not_open', 'Construction is not open in this city on this local server.')
      const propertyId = propertyIdInput
      const who = viewer.player
      return withTransaction(db, isRefusal, async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)
        const property = await propertyIn(client, viewer.scope, propertyId)
        const asset = property && assetOf(property)
        if (!property || !asset) throw new WorldConstructionRefusal('unknown_property', 'That is not a property of this city.')
        const rows = (await client.query<ConstructionRow>(`SELECT ${CONSTRUCTION_COLUMNS} FROM world_property_constructions WHERE property_id = $1 ORDER BY sequence DESC`, [property.id])).rows
        const latestEra = (await client.query<{ era_seq: number; controller_discord_user_id: string }>('SELECT era_seq, controller_discord_user_id FROM world_property_control_eras WHERE property_id = $1 ORDER BY era_seq DESC LIMIT 1', [property.id])).rows[0]
        const mine = (
          await client.query<{ role: ConstructionRole; units: string }>(
            'SELECT role, sum(units) AS units FROM world_property_constructions WHERE world_id = $1 AND contributor_discord_user_id = $2 AND contributor_core_user_id = $3 GROUP BY role',
            [viewer.scope.worldId, who.discordUserId, who.coreUserId],
          )
        ).rows
        const account = await accountOf(client, viewer.scope.worldId, { discordUserId: who.discordUserId, coreUserId: who.coreUserId })
        const pending = pendingGrants(account, authority.grantsFor({ guildId: viewer.scope.discordGuildId, discordUserId: who.discordUserId })).reduce((n, g) => n + g.units, 0)

        const built = rows[0]?.built_after ?? 0
        const controller = authority.controllerOf({ guildId: viewer.scope.discordGuildId }, asset)
        const ownerUnits = sumUnits(rows.filter((r) => r.role === 'owner'))
        // The current owner's investment is the latest era's, while the source still names that era's controller.
        const currentEra = currentEraOf(latestEra, controller)
        const currentOwner = currentEra === null ? 0 : sumUnits(rows.filter((r) => r.role === 'owner' && r.control_era_seq === currentEra))
        const community = sumUnits(rows.filter((r) => r.role === 'patron'))
        const available = account.balance + pending
        const standing = standingOf(recipe, built, controller, who.discordUserId, available)
        const distinct = (role: ConstructionRole) => new Set(rows.filter((r) => r.role === role).map((r) => `${r.contributor_discord_user_id}/${r.contributor_core_user_id}`)).size
        return {
          recipe,
          property: { propertyId: property.id, buildingId: property.building_id, tier: constructionTier(recipe, built), built, nextTierAt: nextTierAt(recipe, built), maxTier: recipeMaxTier(recipe) },
          control: controller === null ? 'unknown' : controller === who.discordUserId ? 'viewer' : 'other',
          standing,
          credits: { available, recorded: account.balance, pending },
          investment: { currentOwner, previousOwners: ownerUnits - currentOwner, community, total: built },
          viewer: { ownerUnits: Number(mine.find((m) => m.role === 'owner')?.units ?? 0), patronUnits: Number(mine.find((m) => m.role === 'patron')?.units ?? 0) },
          contributors: { owners: distinct('owner'), patrons: distinct('patron') },
          history: rows.slice(0, HISTORY_LIMIT).map((r) => ({
            sequence: Number(r.sequence),
            recipe: r.recipe,
            role: r.role,
            units: r.units,
            tierAfter: r.tier_after,
            by: r.contributor_discord_user_id === who.discordUserId && r.contributor_core_user_id === who.coreUserId ? ('viewer' as const) : ('other' as const),
            era: r.control_era_seq,
            at: r.constructed_at.toISOString(),
          })),
          historyCount: rows.length,
        }
      })
    },

    async architect(viewer, authority) {
      const where = { guildId: viewer.scope.discordGuildId }
      if (!authority.opensIn(where)) throw new WorldConstructionRefusal('construction_not_open', 'Construction is not open in this city on this local server.')
      const who = viewer.player
      return withTransaction(db, isRefusal, async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)
        // Every property of exactly the world the session names, through its whole binding: nothing of another world or installation.
        const properties = (
          await client.query<PropertyRef & { collection_key: string; district_key: string; plot_id: string; ward: number; plot: number; founded: boolean }>(
            `SELECT p.id, p.building_id, p.chain, p.standard, p.contract, p.token_id, p.collection_key, p.district_key, p.plot_id, p.ward, p.plot,
                    (p.activator_discord_user_id = $6 AND p.activator_core_user_id = $7) IS TRUE AS founded
               FROM world_properties p JOIN world_play_bindings b ON b.world_id = p.world_id
              WHERE p.world_id = $1 AND b.play_environment = $2 AND b.play_game_key = $3 AND b.play_installation_id = $4 AND b.discord_guild_id = $5
              ORDER BY p.activated_sequence`,
            [viewer.scope.worldId, viewer.scope.environment, viewer.scope.gameKey, viewer.scope.installationId, viewer.scope.discordGuildId, who.discordUserId, who.coreUserId],
          )
        ).rows
        const rows = (await client.query<ConstructionRow>(`SELECT ${CONSTRUCTION_COLUMNS} FROM world_property_constructions WHERE world_id = $1 ORDER BY sequence`, [viewer.scope.worldId])).rows
        const eras = (await client.query<{ property_id: string; era_seq: number; controller_discord_user_id: string }>('SELECT property_id, era_seq, controller_discord_user_id FROM world_property_control_eras WHERE world_id = $1 ORDER BY property_id, era_seq', [viewer.scope.worldId])).rows
        const account = await accountOf(client, viewer.scope.worldId, { discordUserId: who.discordUserId, coreUserId: who.coreUserId })
        const pending = pendingGrants(account, authority.grantsFor({ ...where, discordUserId: who.discordUserId })).reduce((n, g) => n + g.units, 0)
        const available = account.balance + pending
        // The player's own records: by the player Proofy Play redeemed for this session, both ids, never anyone a browser names.
        const isMine = (r: ConstructionRow) => r.contributor_discord_user_id === who.discordUserId && r.contributor_core_user_id === who.coreUserId

        const listed: ArchitectProperty[] = []
        for (const p of properties) {
          const asset = assetOf(p)
          if (!asset) continue
          const here = rows.filter((r) => r.property_id === p.id)
          const mine = here.filter(isMine)
          const controller = authority.controllerOf(where, asset)
          if (!p.founded && mine.length === 0 && controller !== who.discordUserId) continue
          const built = here.at(-1)?.built_after ?? 0
          const currentEra = currentEraOf(eras.filter((e) => e.property_id === p.id).at(-1), controller)
          const owner = mine.filter((r) => r.role === 'owner')
          const currentEraOwnerUnits = currentEra === null ? 0 : sumUnits(owner.filter((r) => r.control_era_seq === currentEra))
          listed.push({
            propertyId: p.id,
            buildingId: p.building_id,
            asset: `${p.chain}/${p.standard}:${p.contract}/${p.token_id}`,
            collection: p.collection_key,
            districtKey: p.district_key,
            plotId: p.plot_id,
            ward: p.ward,
            plot: p.plot,
            founded: p.founded,
            control: controller === null ? 'unknown' : controller === who.discordUserId ? 'viewer' : 'other',
            tier: constructionTier(recipe, built),
            built,
            nextTierAt: nextTierAt(recipe, built),
            standing: standingOf(recipe, built, controller, who.discordUserId, available),
            yours: {
              ownerUnits: sumUnits(owner),
              currentEraOwnerUnits,
              earlierEraOwnerUnits: sumUnits(owner) - currentEraOwnerUnits,
              patronUnits: sumUnits(mine.filter((r) => r.role === 'patron')),
              actions: mine.length,
              tiersCompleted: mine.filter((r) => r.tier_after > r.tier_before).length,
              lastSequence: mine.length === 0 ? null : Number(mine.at(-1)!.sequence),
            },
          })
        }
        // Most recent activity of the player first; then the rest in the order they were activated.
        const order = (a: ArchitectProperty) => a.yours.lastSequence ?? -1
        const sorted = listed.map((a, i) => ({ a, i })).sort((x, y) => order(y.a) - order(x.a) || x.i - y.i).map((x) => x.a)
        const mine = rows.filter(isMine)
        const owner = mine.filter((r) => r.role === 'owner')
        const currentEraOwnerUnits = listed.reduce((n, a) => n + a.yours.currentEraOwnerUnits, 0)
        return {
          recipe,
          credits: { available, recorded: account.balance, pending },
          totals: {
            ownerUnits: sumUnits(owner),
            currentEraOwnerUnits,
            earlierEraOwnerUnits: sumUnits(owner) - currentEraOwnerUnits,
            patronUnits: sumUnits(mine.filter((r) => r.role === 'patron')),
            ownerActions: owner.length,
            patronActions: mine.length - owner.length,
            tiersCompleted: mine.filter((r) => r.tier_after > r.tier_before).length,
            propertiesDeveloped: new Set(mine.map((r) => r.property_id)).size,
            propertiesDevelopedAsOwner: new Set(owner.map((r) => r.property_id)).size,
          },
          properties: sorted.slice(0, ARCHITECT_PROPERTY_LIMIT),
          propertyCount: sorted.length,
        }
      })
    },

    legacy: (viewer, propertyId, authority) => readPropertyLegacy(db, recipe, viewer, propertyId, authority),
  }
}

/**
 * The only composition a construction route may use: `requireActor` (the cookie's live session must be exactly the one
 * the page drew, and Play must answer `active` now), then the store, with the trusted source.
 */
export function createConstructionService({ sessions, store, authority }: { sessions: Pick<PlaySessionService, 'requireActor'>; store: WorldConstructionStore; authority: ConstructionAuthority }) {
  return {
    async construct(presented: string | null, expected: ExpectedActor, input: ConstructionInput): Promise<ConstructionResult> {
      const actor = await sessions.requireActor(presented, expected)
      return store.construct(actor, input, authority)
    },
  }
}
