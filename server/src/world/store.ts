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
  WORLD_CITY_STATE_VERSION,
  WORLD_CONFIG_JUDGE,
  type PlayEnvironment,
  type PlayWorld,
  type WorldConfigJudgement,
  type WorldFoundation,
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
 * depends on the version and the world's foundation alone), check that it may govern the world
 * (it keeps every collection the world has established), adopt it if it is the installation's
 * active version, and read the city back. A version this world cannot accept is recorded as
 * rejected and the launch is refused; so is a launch pinned to an accepted version that may not
 * govern. Either way the world is not changed, replaced or reset. Nothing here ever updates or
 * deletes a city.
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
}

type AcceptedJudgement = Extract<WorldConfigJudgement, { verdict: 'accepted' }>

export interface OpenedWorld {
  world: PlayWorld
  cityId: string
  instance: string
  /** The pinned configuration, as the world accepted it. */
  accepted: AcceptedJudgement
}

/**
 * Ask Play once more which configuration version the installation has active, or null if Play
 * does not say within a deadline shorter than LOCK_TIMEOUT (or the installation is no longer
 * this launch's, or no longer active). Called at most once per launch, and only with this
 * world's lock held, right before a founding or an adoption is written. Never throws.
 */
export type ConfirmActive = () => Promise<{ version: number | null; configHash: string | null } | null>

export interface WorldStore {
  /** The installation's world, founded now if it has none. */
  open(launch: VerifiedLaunch, confirmActive: ConfirmActive): Promise<OpenedWorld>
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

interface VersionRow {
  version: number
  config_hash: string
  verdict: 'accepted' | 'rejected'
  rejection: { code?: unknown; problems?: unknown } | null
  config_canonical: string
}

const unavailable = (why: string) => new WorldRefusal('world_unavailable', why)

/** The geometry part of two foundations: what decides where every plot is. */
const sameGeometry = (a: WorldFoundation, b: WorldFoundation) => JSON.stringify([a.layout, a.districts]) === JSON.stringify([b.layout, b.districts])

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
      world: {
        id: worldId,
        provisioned: true,
        created: true,
        foundedAt: created.created_at.toISOString(),
        sequence: 1,
        definition: { foundingConfigVersion: pinned.version, governingConfigVersion: pinned.version, layoutKey: judged.foundation.layout.key, geometryFingerprint: judged.foundation.layout.geometryFingerprint },
        state,
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
    const city = (
      await client.query<{ instance_id: string; sequence: string; state_version: number; state: unknown }>('SELECT instance_id, sequence, state_version, state FROM city WHERE id = $1 FOR UPDATE', [bound.city_id])
    ).rows[0]
    if (!city || city.instance_id !== bound.city_instance_id) throw unavailable(`world ${worldId} has no city ${bound.city_id}`)
    const sequence = Number(city.sequence)
    const state = city.state_version === WORLD_CITY_STATE_VERSION ? parseWorldCityState(city.state) : null
    // This build reads exactly one kind of world city: as founded. Anything else is refused, not drawn in part.
    if (!state || sequence !== 1) throw unavailable(`world ${worldId} holds a city this build cannot read (state version ${city.state_version}, sequence ${sequence})`)

    const founding = (await client.query<{ type: string; payload: { world?: { id?: unknown; foundingConfig?: { version?: unknown }; foundation?: unknown } } }>('SELECT type, payload FROM city_events WHERE city_id = $1 AND sequence = 1', [bound.city_id])).rows[0]
    const foundation = parseWorldFoundation(founding?.payload?.world?.foundation)
    const foundingVersion = founding?.payload?.world?.foundingConfig?.version
    if (!founding || founding.type !== 'city.initialized' || founding.payload.world?.id !== worldId || !foundation || typeof foundingVersion !== 'number')
      throw unavailable(`world ${worldId} has no readable founding record`)

    const versions = (await client.query<VersionRow>('SELECT version, config_hash, verdict, rejection, config_canonical FROM world_config_versions WHERE world_id = $1 ORDER BY version', [worldId])).rows
    const read = new Map<number, AcceptedJudgement>()
    /** An accepted version, read again: still a valid city on the world's geometry, or the world is unreadable. */
    const accepted = (row: VersionRow): AcceptedJudgement => {
      let j = read.get(row.version)
      if (!j) {
        const again = judgeWorldConfig(JSON.parse(row.config_canonical), worldId, null)
        if (row.verdict !== 'accepted' || again.verdict !== 'accepted' || !sameGeometry(again.foundation, foundation)) throw unavailable(`world ${worldId} holds an accepted configuration this build no longer reads as the same city`)
        read.set(row.version, (j = again))
      }
      return j
    }

    let judged: AcceptedJudgement
    const recorded = versions.find((v) => v.version === pinned.version)
    if (recorded) {
      // Play never changes a version; one that comes back different is not the version this world recorded.
      if (recorded.config_hash !== pinned.configHash) throw new WorldRefusal('config_binding_mismatch', `Play served version ${pinned.version} with another hash than the world recorded.`)
      if (recorded.verdict === 'rejected') return { rejected: refusalFrom(recorded) }
      judged = accepted(recorded)
    } else {
      // Judged against the foundation alone, so the verdict is the same whichever launch brings the version first.
      const verdict = judgeWorldConfig(pinned.config, worldId, foundation)
      await insertVersion(client, worldId, launch, verdict)
      notes.push(['world configuration version recorded', { world: worldId, version: pinned.version, verdict: verdict.verdict, ...(verdict.verdict === 'rejected' ? { code: verdict.code } : {}) }])
      if (verdict.verdict === 'rejected') return { rejected: new WorldRefusal(verdict.code, 'The pinned configuration cannot govern this city.', verdict.problems) }
      judged = verdict
    }

    // Only a version that could govern the world now is drawn or adopted: one that keeps every collection the
    // versions that have governed it established. Collections are additive; nothing is written past this point.
    const adoptions = (await client.query<{ adoption_seq: number; version: number }>('SELECT adoption_seq, version FROM world_config_adoptions WHERE world_id = $1 ORDER BY adoption_seq', [worldId])).rows
    const latest = adoptions.at(-1)
    if (!latest) throw unavailable(`world ${worldId} has no adopted configuration`)
    const governed = adoptions.map((a) => {
      const row = versions.find((v) => v.version === a.version)
      if (!row) throw unavailable(`world ${worldId} adopted version ${a.version}, which it has no copy of`)
      return accepted(row).foundation.collections
    })
    const problems = governingProblems(foundation, establishedCollections(foundation, governed), judged.foundation)
    if (problems.length > 0) return { rejected: new WorldRefusal('config_incompatible', 'The pinned configuration would drop or repoint a collection this city has established, so it cannot govern it.', problems) }

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

    return {
      cityId: bound.city_id,
      instance: city.instance_id,
      accepted: judged,
      world: {
        id: worldId,
        provisioned: true,
        created: false,
        foundedAt: bound.created_at.toISOString(),
        sequence,
        definition: { foundingConfigVersion: foundingVersion, governingConfigVersion: governing, layoutKey: foundation.layout.key, geometryFingerprint: foundation.layout.geometryFingerprint },
        state,
      },
    }
  }

  return {
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

function refusalFrom(row: VersionRow): WorldRefusal {
  const code = row.rejection?.code === 'config_invalid' ? 'config_invalid' : 'config_incompatible'
  const problems = Array.isArray(row.rejection?.problems) ? (row.rejection.problems as { path: string; detail: string }[]) : []
  return new WorldRefusal(code, `Configuration version ${row.version} was rejected for this city when it was first seen.`, problems)
}
