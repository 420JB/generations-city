import type { PoolClient } from 'pg'
import { environmentStamp } from '../city/store'
import { PLAY_ENVIRONMENTS_FOR_MODE, type AppMode } from '../config'
import type { Database } from '../db/pool'
import { withTransaction } from '../db/transaction'
import {
  emptyWorldCityState,
  establishedCollections,
  governingProblems,
  judgeWorldConfig,
  parseWorldCityState,
  parseWorldFoundation,
  parseWorldGeometry,
  POPULATED_WORLD_CITY_STATE_VERSION,
  projectWorldDistricts,
  sameGeometry,
  worldBuildingId,
  WORLD_CITY_STATE_VERSION,
  WORLD_CONFIG_JUDGE,
  type PlayEnvironment,
  type PlayWorld,
  type World,
  type WorldBuildingRecord,
  type WorldCityState,
  type WorldConfigJudgement,
  type WorldGeometry,
} from '../engine'
import type { LogFields, Logger } from '../log'
import { canonicalJson } from '../play/canonical'
import { uuidv7 } from './ids'

/**
 * PERSISTENT BRAND CITIES: one world per Proofy Play installation, in the tables of migration
 * 0005, founded by the installation's first launch and returned by every launch after it.
 *
 * Who decides what:
 *   - Play (through the launch path, which has already checked everything Play said against
 *     the run) decides WHICH installation, Discord server and configuration version a launch is.
 *   - This store decides WHICH WORLD that is, from its own binding rows alone. Nothing the
 *     browser sends reaches it.
 *   - The database guards (0004, 0005) are the last word on what may be written.
 *
 * Founding is one transaction: the city row (sequence 1, empty), its `city.initialized` event
 * (which records the world's foundation for good), the world, its permanent binding, the
 * accepted configuration version and adoption 1. Either all of it commits or none of it does.
 * Two first launches racing each other found ONE world: the binding's unique keys let exactly
 * one commit, and the other rolls back everything it wrote and reads the winner's world.
 *
 * Later launches record the version they are pinned to (once, with this game's verdict, which
 * depends on the version and the world's founding collections alone, and, when accepted, the
 * geometry it draws), check that it may govern the world (it keeps every collection the world has
 * established and, once the world's first property has frozen its district geometry, draws exactly
 * that geometry), adopt it if it is the installation's active version, and read the city back. A
 * version this world cannot accept is recorded as rejected and the launch is refused; so is a
 * launch pinned to an accepted version that may not govern, and one pinned to a version that does
 * not govern and draws other districts than the one that does (it would show a city that is not
 * there). Either way the world is not changed, replaced or reset. Nothing here ever updates or
 * deletes a city.
 *
 * GEOMETRY (migration 0008, locked policy). A world's district geometry is that of the version
 * governing it until its first property; the first property's transaction (`world/properties.ts`)
 * freezes the geometry it stood on (`world_geometry_freezes`). Adoptions and that activation take
 * the same city row lock, so an adoption either governed the first property, or comes after it and
 * must draw the frozen geometry.
 *
 * A play session reads its world back with `read` (`play/session.ts`): one read-only snapshot of
 * the city, its founding record, its property records and the version that governs it now,
 * through the exact binding the session names. It asks Play nothing, takes no lock and writes
 * nothing.
 *
 * A world's city is read only when it is one this build wrote: as founded (state version 1,
 * sequence 1), or with properties (version 2, one per sequence after the first, migration 0007),
 * where every building in the state is exactly one `world_properties` row and the engine finds the
 * state possible on the world's geometry. Anything else is refused, never drawn in part. Every
 * answer carries the engine's read-only projection of the districts (open wards, plot candidates).
 * Properties are written only by `world/properties.ts`, never here.
 *
 * Adoption follows what Play reports as active. The launch path asks Play before the
 * transaction, and that report can be overtaken by the time the transaction runs: an admin
 * re-activates another version and another launch sees it. So a founding or an adoption is
 * written only after Play CONFIRMS the version is still active, asked once more while this
 * world's lock is held (the city row; for a founding, the installation's binding key), with a
 * deadline shorter than the lock timeout (`ConfirmActive`). Founding and adoptions are then
 * written in the order Play reported them. If Play does not confirm in time, nothing is adopted
 * (the next launch pinned to the active version adopts it) and a founding is refused as
 * superseded. Play is never asked while a lock is held on any other path.
 */
export type WorldRefusalCode = 'config_invalid' | 'config_incompatible' | 'config_superseded' | 'config_binding_mismatch' | 'world_binding_conflict' | 'world_unavailable'

export class WorldRefusal extends Error {
  readonly code: WorldRefusalCode
  readonly problems: { path: string; detail: string }[] | undefined
  constructor(code: WorldRefusalCode, message: string, problems?: { path: string; detail: string }[]) {
    super(message)
    this.name = 'WorldRefusal'
    this.code = code
    this.problems = problems
  }
}

/** Another launch founded this installation's world first. Everything this one wrote is rolled back. */
class LostFoundingRace extends Error {}

/** What the launch path has established from Play and checked against the run. */
export interface VerifiedLaunch {
  /** The Play environment of Rare City's credential. */
  environment: PlayEnvironment
  gameKey: string
  installationId: string
  discordGuildId: string
  /** The installation's active configuration as Play reported it during this launch. */
  active: { version: number | null; configHash: string | null }
  /** The version the run is pinned to, its hash already recomputed and matched. */
  pinned: { version: number; schemaVersion: number; configHash: string; config: Record<string, unknown> }
  /** The player Play's run named, only to tell them which properties they originally activated. Never written. */
  player?: { discordUserId: string; coreUserId: string }
}

type AcceptedJudgement = Extract<WorldConfigJudgement, { verdict: 'accepted' }>

export interface OpenedWorld {
  world: PlayWorld
  cityId: string
  instance: string
  /** The pinned configuration, as the world accepted it. */
  accepted: AcceptedJudgement
  /** The ids of the properties `launch.player` originally activated in this world, in activation order. */
  originalActivations: string[]
  /** The ids of this world's properties whose original activator was never recorded (written before 0008), in activation order. */
  unrecordedActivations: string[]
}

/**
 * Ask Play once more which configuration version the installation has active, or null if Play
 * does not say within a deadline shorter than LOCK_TIMEOUT (or the installation is no longer
 * this launch's, or no longer active). Called at most once per launch, and only with this
 * world's lock held, right before a founding or an adoption is written. Never throws.
 */
export type ConfirmActive = () => Promise<{ version: number | null; configHash: string | null } | null>

/** Exactly which world a play session names, and the binding it was opened through (migration 0006). */
export interface WorldScope {
  worldId: string
  environment: PlayEnvironment
  gameKey: string
  installationId: string
  discordGuildId: string
}

/** A world as stored, with the accepted configuration version that governs it now. */
export interface ReadWorld {
  world: PlayWorld
  governing: { version: number; schemaVersion: number; configHash: string; config: Record<string, unknown> }
  /** The ids of the properties the reading player originally activated, in activation order (none without a player). */
  originalActivations: string[]
  /** The ids of the world's properties whose original activator was never recorded (written before 0008), in activation order. */
  unrecordedActivations: string[]
}

/** Who a property's original activator is (migration 0008): the player Proofy named for the activating session. */
export interface ActivatorIdentity {
  discordUserId: string
  coreUserId: string
}

/** The district geometry a world's first property froze (migration 0008). */
export interface GeometryFreeze {
  sequence: number
  adoption: number
  configVersion: number
  geometry: WorldGeometry
  /** `migration-0008`: the first property was placed before 0008, when geometry froze at founding. */
  frozenBy: 'first-property' | 'migration-0008'
}

export interface WorldStore {
  /** The installation's world, founded now if it has none. */
  open(launch: VerifiedLaunch, confirmActive: ConfirmActive): Promise<OpenedWorld>
  /**
   * A world, read and nothing else: no Play, no lock, nothing written. The binding must still be exactly
   * `scope`'s. Everything comes from one snapshot, so the state, sequence and governing version agree.
   * `player`, the session's, is only matched against the properties' original activators.
   */
  read(scope: WorldScope, player?: ActivatorIdentity): Promise<ReadWorld>
}

/** Points in founding at which a test may make it fail, to prove nothing is left half-written. */
export type FoundingStep = 'city' | 'event' | 'world' | 'binding' | 'version' | 'adopted'

export interface WorldStoreOptions {
  /** APP_MODE: the database must be stamped for it. */
  mode: AppMode
  log: Logger
  onFoundingStep?: (step: FoundingStep) => void | Promise<void>
}

/** A world's city row id. Never `main`, so never the Rare Friends city. */
export const worldCityId = (worldId: string) => `world:${worldId}`

const LOCK_TIMEOUT = '5s'
const STATEMENT_TIMEOUT = '8s'
const IDLE_IN_TRANSACTION_TIMEOUT = '15s'

interface BindingRow {
  world_id: string
  play_installation_id: string
  play_game_key: string
  discord_guild_id: string
  city_id: string
  city_instance_id: string
  created_at: Date
}

/** A `world_properties` row, as far as a read needs it (migration 0007). */
export interface PropertyRow {
  id: string
  chain: string
  standard: string
  contract: string
  token_id: string
  collection_key: string
  district_key: string
  ward: number
  plot: number
  activated_sequence: string
}

interface VersionRow {
  version: number
  schema_version: number
  config_hash: string
  verdict: 'accepted' | 'rejected'
  rejection: { code?: unknown; problems?: unknown } | null
  config_canonical: string
  /** Its recorded geometry (`world_config_geometries`, 0008): null for a rejected version. */
  g_layout_key: string | null
  g_layout_fingerprint: string | null
  g_districts: unknown
}

/** A world's configuration copies, each with the geometry recorded for it. */
const VERSIONS = `SELECT v.version, v.schema_version, v.config_hash, v.verdict, v.rejection, v.config_canonical,
                         g.layout_key AS g_layout_key, g.layout_geometry_fingerprint AS g_layout_fingerprint, g.districts AS g_districts
                    FROM world_config_versions v LEFT JOIN world_config_geometries g ON g.world_id = v.world_id AND g.version = v.version
                   WHERE v.world_id = $1`

const unavailable = (why: string) => new WorldRefusal('world_unavailable', why)

/** What `PlayWorld.definition` says of a world drawn with `drawn`. */
function definitionOf(foundingVersion: number, governingVersion: number, drawn: AcceptedJudgement, freeze: GeometryFreeze | null): PlayWorld['definition'] {
  return {
    foundingConfigVersion: foundingVersion,
    governingConfigVersion: governingVersion,
    layoutKey: drawn.foundation.layout.key,
    geometryFingerprint: drawn.foundation.layout.geometryFingerprint,
    districtGeometry: freeze ? { frozen: true, atSequence: freeze.sequence, configVersion: freeze.configVersion } : { frozen: false },
  }
}

/** The properties of a world `player` originally activated (0008), in activation order. */
async function originalActivationsOf(client: PoolClient, worldId: string, player: ActivatorIdentity | undefined): Promise<string[]> {
  if (!player) return []
  return (
    await client.query<{ id: string }>(
      'SELECT id FROM world_properties WHERE world_id = $1 AND activator_discord_user_id = $2 AND activator_core_user_id = $3 ORDER BY activated_sequence',
      [worldId, player.discordUserId, player.coreUserId],
    )
  ).rows.map((r) => r.id)
}

/**
 * The properties of a world whose original activator was never recorded: written before 0008, when no activator was kept.
 * Who placed them is unknown, to everyone; saying so names nobody.
 */
async function unrecordedActivationsOf(client: PoolClient, worldId: string): Promise<string[]> {
  return (await client.query<{ id: string }>('SELECT id FROM world_properties WHERE world_id = $1 AND activator_core_user_id IS NULL ORDER BY activated_sequence', [worldId])).rows.map((r) => r.id)
}

export function createWorldStore(db: Database, { mode, log, onFoundingStep }: WorldStoreOptions): WorldStore {
  const isRefusal = (err: unknown) => err instanceof WorldRefusal || err instanceof LostFoundingRace

  /**
   * The bindings of this installation and of this game on this Discord server, read in ONE statement so both
   * come from one snapshot: two statements could see a founder's commit fall between them.
   */
  async function bindingsOf(client: PoolClient, launch: VerifiedLaunch): Promise<BindingRow[]> {
    return (
      await client.query<BindingRow>(
        `SELECT b.world_id, b.play_installation_id, b.play_game_key, b.discord_guild_id, w.city_id, w.city_instance_id, w.created_at
           FROM world_play_bindings b JOIN worlds w ON w.id = b.world_id
          WHERE b.play_environment = $1 AND (b.play_installation_id = $2 OR (b.play_game_key = $3 AND b.discord_guild_id = $4))`,
        [launch.environment, launch.installationId, launch.gameKey, launch.discordGuildId],
      )
    ).rows
  }

  /** Whether Play, asked now, still has the pinned version active. Any failure is a no. */
  async function stillActive(launch: VerifiedLaunch, confirmActive: ConfirmActive): Promise<boolean> {
    const now = await confirmActive().catch(() => null)
    return now !== null && now.version === launch.pinned.version && now.configHash === launch.pinned.configHash
  }

  /** Found the installation's world. Throws LostFoundingRace if another launch bound it first. */
  async function found(client: PoolClient, launch: VerifiedLaunch, confirmActive: ConfirmActive): Promise<OpenedWorld> {
    const { pinned } = launch
    // The world is founded on what the installation shows NOW: a run pinned to a version that has since been
    // replaced would fix a geometry the brand has already moved away from.
    if (launch.active.version !== pinned.version || launch.active.configHash !== pinned.configHash)
      throw new WorldRefusal('config_superseded', 'This server\'s city configuration changed after this launch was issued.')

    const worldId = uuidv7()
    const judged = judgeWorldConfig(pinned.config, worldId, null)
    if (judged.verdict === 'rejected') throw new WorldRefusal(judged.code, 'The pinned configuration is not a valid Rare City city.', judged.problems)

    const cityId = worldCityId(worldId)
    // 0005 founds a world only on a city that may hold properties: canonical in production, a rehearsal elsewhere.
    const canonical = mode === 'production'
    const state = emptyWorldCityState()
    const city = (
      await client.query<{ instance_id: string }>(
        `INSERT INTO city (id, canonical, origin, state_version, sequence, state, activation_rehearsal) VALUES ($1, $2, $3, $4, 1, $5::json, $6) RETURNING instance_id`,
        [cityId, canonical, canonical ? 'genesis' : 'demo-fixture', WORLD_CITY_STATE_VERSION, JSON.stringify(state), !canonical],
      )
    ).rows[0]
    await onFoundingStep?.('city')

    const play = { environment: launch.environment, gameKey: launch.gameKey, installationId: launch.installationId, discordGuildId: launch.discordGuildId }
    const payload = {
      origin: canonical ? 'genesis' : 'demo-fixture',
      canonical,
      stateVersion: WORLD_CITY_STATE_VERSION,
      environment: mode,
      ...(canonical ? {} : { activationRehearsal: true }),
      world: { id: worldId, play, foundingConfig: { version: pinned.version, configHash: pinned.configHash, schemaVersion: pinned.schemaVersion }, foundation: judged.foundation },
    }
    await client.query(`INSERT INTO city_events (city_id, sequence, type, payload) VALUES ($1, 1, 'city.initialized', $2::jsonb)`, [cityId, JSON.stringify(payload)])
    await onFoundingStep?.('event')

    const created = (await client.query<{ created_at: Date }>('INSERT INTO worlds (id, city_id, city_instance_id) VALUES ($1, $2, $3) RETURNING created_at', [worldId, cityId, city.instance_id])).rows[0]
    await onFoundingStep?.('world')

    // Either unique key (installation, or game and Discord server) taken means someone else's binding exists:
    // this transaction then rolls back the city, its event and the world it just wrote.
    const bound = await client.query(
      `INSERT INTO world_play_bindings (world_id, play_environment, play_game_key, play_installation_id, discord_guild_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING world_id`,
      [worldId, launch.environment, launch.gameKey, launch.installationId, launch.discordGuildId],
    )
    if (bound.rowCount !== 1) throw new LostFoundingRace()
    await onFoundingStep?.('binding')
    // The installation's binding key is now held: any other founding of it waits here. Play confirms the version.
    if (!(await stillActive(launch, confirmActive))) throw new WorldRefusal('config_superseded', 'This server\'s city configuration changed after this launch was issued.')

    await insertVersion(client, worldId, launch, judged)
    await onFoundingStep?.('version')
    await client.query('INSERT INTO world_config_adoptions (world_id, adoption_seq, version) VALUES ($1, 1, $2)', [worldId, pinned.version])
    await onFoundingStep?.('adopted')

    return {
      cityId,
      instance: city.instance_id,
      accepted: judged,
      originalActivations: [],
      unrecordedActivations: [],
      world: {
        id: worldId,
        provisioned: true,
        created: true,
        foundedAt: created.created_at.toISOString(),
        sequence: 1,
        definition: definitionOf(pinned.version, pinned.version, judged, null),
        state,
        districts: districtsOf(worldId, judged.world, state),
      },
    }
  }

  async function insertVersion(client: PoolClient, worldId: string, launch: VerifiedLaunch, judged: WorldConfigJudgement) {
    const { pinned } = launch
    const rejection = judged.verdict === 'rejected' ? JSON.stringify({ code: judged.code, problems: judged.problems }) : null
    await client.query(
      `INSERT INTO world_config_versions (world_id, version, play_installation_id, schema_version, config_hash, config_canonical, verdict, rejection, judged_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [worldId, pinned.version, launch.installationId, pinned.schemaVersion, pinned.configHash, canonicalJson(pinned.config), judged.verdict, rejection, WORLD_CONFIG_JUDGE],
    )
    // An accepted version is recorded with the geometry it draws (0008), whether or not it ever governs.
    if (judged.verdict === 'accepted')
      await client.query(
        'INSERT INTO world_config_geometries (world_id, version, layout_key, layout_geometry_fingerprint, districts, recorded_by) VALUES ($1, $2, $3, $4, $5::jsonb, $6)',
        [worldId, pinned.version, judged.foundation.layout.key, judged.foundation.layout.geometryFingerprint, JSON.stringify(judged.foundation.districts), WORLD_CONFIG_JUDGE],
      )
  }

  /**
   * An existing world: record the pinned version, adopt it if it is the active one, and read the city. What it
   * wrote goes into `notes`, logged only once the transaction has committed.
   */
  async function enter(client: PoolClient, bound: BindingRow, launch: VerifiedLaunch, confirmActive: ConfirmActive, notes: [string, LogFields][]): Promise<OpenedWorld | { rejected: WorldRefusal }> {
    const worldId = bound.world_id
    const { pinned } = launch
    if (bound.play_game_key !== launch.gameKey || bound.discord_guild_id !== launch.discordGuildId)
      throw new WorldRefusal('world_binding_conflict', 'This installation\'s city is bound to another game or Discord server.')

    // The lock every change to this city takes: launches of one installation queue here, so versions and adoptions are written in order.
    const { instance, sequence, state, foundation, foundingVersion, freeze } = await readFounded(client, bound, true)

    const versions = (await client.query<VersionRow>(`${VERSIONS} ORDER BY v.version`, [worldId])).rows
    const accepted = acceptedReader(worldId)

    let judged: AcceptedJudgement
    const recorded = versions.find((v) => v.version === pinned.version)
    if (recorded) {
      // Play never changes a version; one that comes back different is not the version this world recorded.
      if (recorded.config_hash !== pinned.configHash) throw new WorldRefusal('config_binding_mismatch', `Play served version ${pinned.version} with another hash than the world recorded.`)
      if (recorded.verdict === 'rejected') return { rejected: refusalFrom(recorded) }
      judged = accepted(recorded)
    } else {
      // Judged against the founding collections alone, so the verdict is the same whichever launch brings the version first.
      const verdict = judgeWorldConfig(pinned.config, worldId, foundation)
      await insertVersion(client, worldId, launch, verdict)
      if (verdict.verdict === 'accepted') versions.push(versionRowOf(pinned, verdict))
      notes.push(['world configuration version recorded', { world: worldId, version: pinned.version, verdict: verdict.verdict, ...(verdict.verdict === 'rejected' ? { code: verdict.code } : {}) }])
      if (verdict.verdict === 'rejected') return { rejected: new WorldRefusal(verdict.code, 'The pinned configuration cannot govern this city.', verdict.problems) }
      judged = verdict
    }

    // Only a version that could govern the world now is drawn or adopted: one that keeps every collection the
    // versions that have governed it established (collections are additive) and, once the world's first property
    // has frozen its geometry, draws exactly that geometry. Nothing but an adoption is written past this point.
    const adoptions = (await client.query<{ adoption_seq: number; version: number }>('SELECT adoption_seq, version FROM world_config_adoptions WHERE world_id = $1 ORDER BY adoption_seq', [worldId])).rows
    const latest = adoptions.at(-1)
    if (!latest) throw unavailable(`world ${worldId} has no adopted configuration`)
    const governed = adoptions.map((a) => {
      const row = versions.find((v) => v.version === a.version)
      if (!row) throw unavailable(`world ${worldId} adopted version ${a.version}, which it has no copy of`)
      return accepted(row).foundation.collections
    })
    const problems = governingProblems(establishedCollections(foundation, governed), judged.foundation, freeze?.geometry ?? null)
    if (problems.length > 0)
      return { rejected: new WorldRefusal('config_incompatible', 'The pinned configuration would move the districts this city\'s properties stand on, or drop or repoint a collection it has established, so it cannot govern it.', problems) }

    // The configuration that governs the city follows the installation's ACTIVE version. A run pinned to an
    // older version is still drawn with that version's presentation, but does not turn the city back. Nor does
    // a report of the active version that Play no longer confirms (see the top of this file).
    let governing = latest.version
    if (launch.active.version === pinned.version && launch.active.configHash === pinned.configHash && governing !== pinned.version) {
      if (!(await stillActive(launch, confirmActive))) {
        notes.push(['world configuration adoption deferred', { world: worldId, version: pinned.version, governing }])
      } else {
        await client.query('INSERT INTO world_config_adoptions (world_id, adoption_seq, version) VALUES ($1, $2, $3)', [worldId, latest.adoption_seq + 1, pinned.version])
        notes.push(['world configuration adopted', { world: worldId, version: pinned.version, adoption: latest.adoption_seq + 1 }])
        governing = pinned.version
      }
    }

    // A version that does not govern is drawn only on the districts of the one that does: before the first property
    // the governing version may have changed them, and a run pinned to an older version would show a city that is
    // not there. (Once the geometry is frozen every governing version draws it, so this holds already.)
    const governingRow = versions.find((v) => v.version === governing)
    if (!governingRow) throw unavailable(`world ${worldId} is governed by version ${governing}, which it has no copy of`)
    if (governing !== pinned.version && !sameGeometry(accepted(governingRow).foundation, judged.foundation))
      return { rejected: new WorldRefusal('config_superseded', 'This server\'s city configuration changed after this launch was issued.') }

    return {
      cityId: bound.city_id,
      instance,
      accepted: judged,
      originalActivations: await originalActivationsOf(client, worldId, launch.player),
      unrecordedActivations: await unrecordedActivationsOf(client, worldId),
      world: {
        id: worldId,
        provisioned: true,
        created: false,
        foundedAt: bound.created_at.toISOString(),
        sequence,
        definition: definitionOf(foundingVersion, governing, judged, freeze),
        state,
        districts: districtsOf(worldId, judged.world, state),
      },
    }
  }

  /** Read a world in one read-only snapshot. */
  async function readWorld(scope: WorldScope, player?: ActivatorIdentity): Promise<ReadWorld> {
    return withTransaction(db, isRefusal, async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)
      const stamp = await environmentStamp(client)
      if (stamp !== mode) throw unavailable(`the database is stamped "${stamp ?? 'unstamped'}", not "${mode}"`)
      if (!PLAY_ENVIRONMENTS_FOR_MODE[mode].includes(scope.environment)) throw unavailable(`Play environment ${scope.environment} is not served by APP_MODE=${mode}`)

      const bound = await boundTo(client, scope)
      const { sequence, state, foundingVersion, freeze } = await readFounded(client, bound, false)
      const { row, judged } = await governingOf(client, scope.worldId, freeze)
      const config = JSON.parse(row.config_canonical) as Record<string, unknown>
      return {
        governing: { version: row.version, schemaVersion: row.schema_version, configHash: row.config_hash, config },
        originalActivations: await originalActivationsOf(client, scope.worldId, player),
        unrecordedActivations: await unrecordedActivationsOf(client, scope.worldId),
        world: {
          id: scope.worldId,
          provisioned: true,
          created: false,
          foundedAt: bound.created_at.toISOString(),
          sequence,
          definition: definitionOf(foundingVersion, row.version, judged, freeze),
          state,
          districts: districtsOf(scope.worldId, judged.world, state),
        },
      }
    })
  }

  return {
    read: readWorld,
    async open(launch, confirmActive) {
      for (let attempt = 1; ; attempt++) {
        const notes: [string, LogFields][] = []
        try {
          const outcome = await withTransaction(db, isRefusal, async (client) => {
            await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
            await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)
            await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${IDLE_IN_TRANSACTION_TIMEOUT}'`)
            const stamp = await environmentStamp(client)
            if (stamp !== mode) throw unavailable(`the database is stamped "${stamp ?? 'unstamped'}", not "${mode}"`)
            if (!PLAY_ENVIRONMENTS_FOR_MODE[mode].includes(launch.environment)) throw unavailable(`Play environment ${launch.environment} is not served by APP_MODE=${mode}`)

            const bindings = await bindingsOf(client, launch)
            const bound = bindings.find((b) => b.play_installation_id === launch.installationId)
            if (bound) return enter(client, bound, launch, confirmActive, notes)
            // One Discord server, one city of this game: never a second one beside a city bound to another installation.
            if (bindings.length > 0) throw new WorldRefusal('world_binding_conflict', 'This Discord server already has a city, bound to another installation.')
            return found(client, launch, confirmActive)
          })
          for (const [message, fields] of notes) log.info(message, fields)
          if ('rejected' in outcome) throw outcome.rejected
          if (outcome.world.created) log.info('world founded', { world: outcome.world.id, city: outcome.cityId, installation: launch.installationId, guild: launch.discordGuildId, playEnvironment: launch.environment, configVersion: launch.pinned.version })
          return outcome
        } catch (err) {
          // The loser of a founding race reads the winner's world on its next attempt. A third attempt would mean
          // bindings appearing and vanishing, which they never do.
          if (err instanceof LostFoundingRace && attempt < 2) continue
          if (err instanceof LostFoundingRace) throw unavailable('the installation\'s binding could not be read after a founding race')
          throw err
        }
      }
    },
  }
}

/**
 * A world's city and its founding record, checked: the bound city row, as founded (sequence 1, version 1) or with
 * properties (version 2, one property per later sequence), the `city.initialized` event that fixed its foundation,
 * its property records, which must be exactly the buildings its state holds, and its geometry freeze, which it has
 * exactly when it has a property. `lock` takes the lock every change to the city takes (before anything else is
 * read, so a change that held it is seen whole); a read takes none.
 */
async function readFounded(client: PoolClient, bound: Pick<BindingRow, 'world_id' | 'city_id' | 'city_instance_id'>, lock: boolean) {
  const worldId = bound.world_id
  const city = (
    await client.query<{ instance_id: string; sequence: string; state_version: number; state: unknown }>(`SELECT instance_id, sequence, state_version, state FROM city WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [bound.city_id])
  ).rows[0]
  if (!city || city.instance_id !== bound.city_instance_id) throw unavailable(`world ${worldId} has no city ${bound.city_id}`)
  const sequence = Number(city.sequence)
  const state = parseWorldCityState(city.state)
  const expected = sequence === 1 ? WORLD_CITY_STATE_VERSION : POPULATED_WORLD_CITY_STATE_VERSION
  // This build reads exactly the world cities it writes. Anything else is refused, not drawn in part.
  if (!state || state.version !== expected || city.state_version !== expected)
    throw unavailable(`world ${worldId} holds a city this build cannot read (state version ${city.state_version}, sequence ${sequence})`)

  const founding = (await client.query<{ type: string; payload: { world?: { id?: unknown; foundingConfig?: { version?: unknown }; foundation?: unknown } } }>('SELECT type, payload FROM city_events WHERE city_id = $1 AND sequence = 1', [bound.city_id])).rows[0]
  const foundation = parseWorldFoundation(founding?.payload?.world?.foundation)
  const foundingVersion = founding?.payload?.world?.foundingConfig?.version
  if (!founding || founding.type !== 'city.initialized' || founding.payload.world?.id !== worldId || !foundation || typeof foundingVersion !== 'number')
    throw unavailable(`world ${worldId} has no readable founding record`)

  const properties = (
    await client.query<PropertyRow>(
      'SELECT id, chain, standard, contract, token_id, collection_key, district_key, ward, plot, activated_sequence FROM world_properties WHERE world_id = $1 ORDER BY activated_sequence',
      [worldId],
    )
  ).rows
  const mismatch = parityProblem(state, sequence, properties)
  if (mismatch) throw unavailable(`world ${worldId}'s city and its property records disagree: ${mismatch}`)

  const frozen = (
    await client.query<{ frozen_at_sequence: string; adoption_seq: number; config_version: number; layout_key: string; layout_geometry_fingerprint: string; districts: unknown; frozen_by: string }>(
      'SELECT frozen_at_sequence, adoption_seq, config_version, layout_key, layout_geometry_fingerprint, districts, frozen_by FROM world_geometry_freezes WHERE world_id = $1',
      [worldId],
    )
  ).rows[0]
  let freeze: GeometryFreeze | null = null
  if (frozen) {
    const geometry = parseWorldGeometry({ key: frozen.layout_key, geometryFingerprint: frozen.layout_geometry_fingerprint }, frozen.districts)
    const first = properties[0]
    if (!geometry || (frozen.frozen_by !== 'first-property' && frozen.frozen_by !== 'migration-0008') || !first || Number(frozen.frozen_at_sequence) !== Number(first.activated_sequence))
      throw unavailable(`world ${worldId} holds a geometry freeze this build cannot read, or not at its first property`)
    freeze = { sequence: Number(frozen.frozen_at_sequence), adoption: frozen.adoption_seq, configVersion: frozen.config_version, geometry, frozenBy: frozen.frozen_by }
  } else if (properties.length > 0) throw unavailable(`world ${worldId} has properties but no frozen geometry`)
  return { instance: city.instance_id, sequence, state, foundation, foundingVersion, properties, freeze }
}

/** The world a scope names, through its whole binding: a session names a world through the binding it was opened by. */
async function boundTo(client: PoolClient, scope: WorldScope): Promise<BindingRow> {
  const bound = (
    await client.query<BindingRow>(
      `SELECT b.world_id, b.play_installation_id, b.play_game_key, b.discord_guild_id, w.city_id, w.city_instance_id, w.created_at
         FROM world_play_bindings b JOIN worlds w ON w.id = b.world_id
        WHERE b.world_id = $1 AND b.play_environment = $2 AND b.play_game_key = $3 AND b.play_installation_id = $4 AND b.discord_guild_id = $5`,
      [scope.worldId, scope.environment, scope.gameKey, scope.installationId, scope.discordGuildId],
    )
  ).rows[0]
  if (!bound) throw unavailable(`world ${scope.worldId} is not bound to the installation that names it`)
  return bound
}

/**
 * The version that governs a world now (its latest adoption), read again exactly as a launch would: still an
 * accepted city drawing its recorded geometry and, once the world's geometry is frozen, exactly that geometry.
 * Anything else makes the world unreadable.
 */
async function governingOf(client: PoolClient, worldId: string, freeze: GeometryFreeze | null): Promise<{ row: VersionRow; judged: AcceptedJudgement; adoption: number }> {
  const latest = (await client.query<{ adoption_seq: number; version: number }>('SELECT adoption_seq, version FROM world_config_adoptions WHERE world_id = $1 ORDER BY adoption_seq DESC LIMIT 1', [worldId])).rows[0]
  if (!latest) throw unavailable(`world ${worldId} has no adopted configuration`)
  const row = (await client.query<VersionRow>(`${VERSIONS} AND v.version = $2`, [worldId, latest.version])).rows[0]
  if (!row) throw unavailable(`world ${worldId} adopted version ${latest.version}, which it has no copy of`)
  const judged = acceptedReader(worldId)(row)
  if (freeze && !sameGeometry(judged.foundation, freeze.geometry)) throw unavailable(`world ${worldId} is governed by version ${row.version}, which does not draw the geometry its first property froze`)
  return { row, judged, adoption: latest.adoption_seq }
}

/** A world's city, locked for a change, with everything a change is judged against. */
export interface LockedWorld {
  cityId: string
  instance: string
  sequence: number
  state: WorldCityState
  /** The governing configuration's compiled world: the engine's authority on districts, plots and collections. */
  world: World
  /** The governing configuration itself (district names, Proofy rules), as the world accepted it. */
  config: AcceptedJudgement['config']
  governingVersion: number
  /** Its configuration hash: what Play's active pointer must name for the version to be the installation's active one. */
  governingConfigHash: string
  /** The adoption that made `governingVersion` govern (`world_config_adoptions.adoption_seq`). */
  governingAdoption: number
  /** The geometry the world's first property froze, or null while it has none: the next activation freezes the governing geometry. */
  freeze: GeometryFreeze | null
}

/**
 * For a writer, on ITS transaction: the world `scope` names, through its whole binding, its city row locked FOR
 * UPDATE (the lock every change to the city takes, launches included), read exactly as a session read would be,
 * and the version that governs it now. Throws WorldRefusal('world_unavailable') for anything this build cannot read.
 */
export async function lockWorldForChange(client: PoolClient, scope: WorldScope): Promise<LockedWorld> {
  const bound = await boundTo(client, scope)
  const { instance, sequence, state, freeze } = await readFounded(client, bound, true)
  const { row, judged, adoption } = await governingOf(client, scope.worldId, freeze)
  // The state must be one the world's own geometry can hold, as every read requires.
  districtsOf(scope.worldId, judged.world, state)
  return { cityId: bound.city_id, instance, sequence, state, world: judged.world, config: judged.config, governingVersion: row.version, governingConfigHash: row.config_hash, governingAdoption: adoption, freeze }
}

/**
 * Reads accepted versions again, once each: still a valid city, drawing exactly the geometry recorded for it, or
 * the world is unreadable.
 */
function acceptedReader(worldId: string): (row: VersionRow) => AcceptedJudgement {
  const read = new Map<number, AcceptedJudgement>()
  return (row) => {
    let j = read.get(row.version)
    if (!j) {
      const again = judgeWorldConfig(JSON.parse(row.config_canonical), worldId, null)
      const recorded = parseWorldGeometry({ key: row.g_layout_key, geometryFingerprint: row.g_layout_fingerprint }, row.g_districts)
      if (row.verdict !== 'accepted' || again.verdict !== 'accepted' || !recorded || !sameGeometry(again.foundation, recorded))
        throw unavailable(`world ${worldId} holds an accepted configuration this build no longer reads as the same city`)
      read.set(row.version, (j = again))
    }
    return j
  }
}

/** The row of a version this transaction has just recorded as accepted. */
function versionRowOf(pinned: VerifiedLaunch['pinned'], judged: AcceptedJudgement): VersionRow {
  return {
    version: pinned.version,
    schema_version: pinned.schemaVersion,
    config_hash: pinned.configHash,
    verdict: 'accepted',
    rejection: null,
    config_canonical: canonicalJson(pinned.config),
    g_layout_key: judged.foundation.layout.key,
    g_layout_fingerprint: judged.foundation.layout.geometryFingerprint,
    g_districts: judged.foundation.districts,
  }
}

/**
 * Why a city's state and its property records are not one picture, or null: one building per property, the same
 * NFT, collection, plot and sequence, and one property per sequence after the founding one.
 */
export function parityProblem(state: WorldCityState, sequence: number, properties: readonly PropertyRow[]): string | null {
  const buildings = Object.keys(state.buildings).length
  if (properties.length !== buildings || sequence !== properties.length + 1) return `sequence ${sequence}, ${buildings} buildings, ${properties.length} property records`
  for (const [i, p] of properties.entries()) {
    const b = (state.buildings as Record<string, WorldBuildingRecord>)[worldBuildingId(p.id)]
    const asset = `${p.chain}/${p.standard}:${p.contract}/${p.token_id}`
    if (Number(p.activated_sequence) !== i + 2) return `property ${p.id} records sequence ${p.activated_sequence}, not ${i + 2}`
    if (!b || b.propertyId !== p.id || b.asset !== asset || b.collection !== p.collection_key || b.districtKey !== p.district_key || b.ward !== p.ward || b.plot !== p.plot || b.sequence !== i + 2)
      return `property ${p.id} is not the building its city state holds`
  }
  return null
}

/** The read-only district projection of a stored city on its world, or the world is unreadable. */
function districtsOf(worldId: string, world: World, state: WorldCityState) {
  try {
    return projectWorldDistricts(world, state)
  } catch (err) {
    throw unavailable(`world ${worldId} holds a city state its own geometry cannot hold: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function refusalFrom(row: VersionRow): WorldRefusal {
  const code = row.rejection?.code === 'config_invalid' ? 'config_invalid' : 'config_incompatible'
  const problems = Array.isArray(row.rejection?.problems) ? (row.rejection.problems as { path: string; detail: string }[]) : []
  return new WorldRefusal(code, `Configuration version ${row.version} was rejected for this city when it was first seen.`, problems)
}
