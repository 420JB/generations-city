import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { PLAY_ENVIRONMENTS_FOR_MODE, type AppMode } from '../config'
import { cityMode, establishedCollections, governingProblems, judgeWorldConfig, parseWorldCityState, parseWorldFoundation, sameFoundation, SUPPORTED_PLAY_SCHEMA_VERSIONS, WORLD_CITY_STATE_VERSION, WORLD_CONFIG_JUDGE, type FoundationCollection, type WorldFoundation } from '../engine'
import { canonicalJson } from '../play/canonical'
import { worldCityId } from './store'

/**
 * `city:verify` for persistent brand cities: is every world in this database one an
 * authority may hold? READ-ONLY, on the caller's REPEATABLE READ, READ ONLY transaction, so
 * worlds, bindings, cities, events and configuration rows are one consistent picture.
 *
 * Per world:
 *   binding     exactly one Play binding, for a Play environment this database may serve;
 *   city        its city is `world:<id>`, of the kind 0005 founds a world on in this environment
 *               (canonical in production, a rehearsal elsewhere), and holds no Rare Friends records;
 *   state       a state this build reads (version 1: founded empty) at sequence 1. Anything further
 *               is a state no code here wrote, and is reported, never guessed at;
 *   events      exactly one per sequence; the first is `city.initialized` and records the city as
 *               its row is (origin, canonical, rehearsal, state version), the environment the
 *               database is stamped for, the world, its binding, its founding configuration (version,
 *               hash and schema version, as the stored copy has them) and its foundation;
 *   configs     every copy is Play's canonical text of itself and hashes to its hash; every accepted
 *               one is a valid city on the foundation's geometry that keeps every founding
 *               collection and names no founding contract under another key; a rejected one says
 *               why, and one judged by this build's rules has the verdict those rules give it;
 *   adoptions   numbered 1, 2, 3 ...; adoption 1 is the founding version; only accepted versions
 *               are adopted, never the one already governing; and each keeps every collection the
 *               adoptions before it established (collections are additive).
 * Across worlds: no installation, Discord server (per game) or city belongs to two worlds.
 */
export interface WorldVerifyReport {
  id: string
  city: string
  sequence: number | null
  play: { environment: string; gameKey: string; installationId: string; discordGuildId: string } | null
  foundingConfigVersion: number | null
  governingConfigVersion: number | null
  configVersions: { accepted: number; rejected: number }
}

export type AddViolation = (rule: string, detail: string) => void

interface WorldRow {
  id: string
  city_id: string
  city_instance_id: string
  play_environment: string | null
  play_game_key: string | null
  play_installation_id: string | null
  discord_guild_id: string | null
  instance_id: string | null
  sequence: string | null
  state_version: number | null
  state: unknown
  canonical: boolean | null
  origin: string | null
  activation_rehearsal: boolean | null
}

interface EventRow {
  city_id: string
  sequence: string
  type: string
  payload: ({ world?: Record<string, unknown> } & Record<string, unknown>) | null
}

interface VersionRow {
  world_id: string
  version: number
  play_installation_id: string
  schema_version: number
  config_hash: string
  config_canonical: string
  verdict: string
  rejection: { code?: unknown; problems?: unknown } | null
  judged_by: string
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** True when this database has the world tables (migration 0005). A database before it holds no world. */
export async function hasWorldTables(client: PoolClient): Promise<boolean> {
  return (await client.query<{ present: boolean }>(`SELECT to_regclass('worlds') IS NOT NULL AS present`)).rows[0].present
}

/** The ids of the cities that are worlds' cities. */
export async function worldCityIds(client: PoolClient): Promise<Set<string>> {
  return new Set((await client.query<{ city_id: string }>('SELECT city_id FROM worlds')).rows.map((r) => r.city_id))
}

export async function verifyWorlds(client: PoolClient, add: AddViolation): Promise<WorldVerifyReport[]> {
  const stamp = (await client.query<{ value: string }>(`SELECT value FROM app_meta WHERE key = 'environment'`)).rows[0]?.value
  const worlds = (
    await client.query<WorldRow>(
      `SELECT w.id, w.city_id, w.city_instance_id, b.play_environment, b.play_game_key, b.play_installation_id, b.discord_guild_id,
              c.instance_id, c.sequence, c.state_version, c.state, c.canonical, c.origin, c.activation_rehearsal
         FROM worlds w LEFT JOIN world_play_bindings b ON b.world_id = w.id LEFT JOIN city c ON c.id = w.city_id
        ORDER BY w.created_at, w.id`,
    )
  ).rows
  if (worlds.length === 0) return []
  const events = (await client.query<EventRow>('SELECT e.city_id, e.sequence, e.type, e.payload FROM city_events e WHERE e.city_id IN (SELECT city_id FROM worlds) ORDER BY e.city_id, e.sequence')).rows
  const versions = (
    await client.query<VersionRow>('SELECT world_id, version, play_installation_id, schema_version, config_hash, config_canonical, verdict, rejection, judged_by FROM world_config_versions ORDER BY world_id, version')
  ).rows
  const adoptions = (await client.query<{ world_id: string; adoption_seq: number; version: number }>('SELECT world_id, adoption_seq, version FROM world_config_adoptions ORDER BY world_id, adoption_seq')).rows
  const legacy = (
    await client.query<{ city_id: string; intents: number; properties: number }>(
      `SELECT w.city_id, (SELECT count(*) FROM activation_intents i WHERE i.city_id = w.city_id)::int AS intents, (SELECT count(*) FROM properties p WHERE p.city_id = w.city_id)::int AS properties FROM worlds w`,
    )
  ).rows

  const allowed = stamp === 'production' || stamp === 'staging' || stamp === 'local' ? PLAY_ENVIRONMENTS_FOR_MODE[stamp as AppMode] : []
  const expectedMode = stamp === 'production' ? 'canonical' : 'rehearsal'
  const reports: WorldVerifyReport[] = []

  for (const w of worlds) {
    const label = `world ${w.id}`
    const report: WorldVerifyReport = { id: w.id, city: w.city_id, sequence: null, play: null, foundingConfigVersion: null, governingConfigVersion: null, configVersions: { accepted: 0, rejected: 0 } }
    reports.push(report)

    // Binding.
    if (w.play_environment === null || w.play_game_key === null || w.play_installation_id === null || w.discord_guild_id === null) add('binding', `${label} has no Play binding`)
    else {
      report.play = { environment: w.play_environment, gameKey: w.play_game_key, installationId: w.play_installation_id, discordGuildId: w.discord_guild_id }
      if (!allowed.includes(w.play_environment as never)) add('environment', `${label} is bound to Play environment ${w.play_environment}, which a database stamped "${stamp ?? 'unstamped'}" does not serve`)
    }

    // City.
    if (w.city_id !== worldCityId(w.id)) add('city', `${label} names city ${w.city_id}, not ${worldCityId(w.id)}`)
    if (w.instance_id === null || w.sequence === null) {
      add('city', `${label} has no city row`)
      continue
    }
    if (w.instance_id !== w.city_instance_id) add('city', `${label} names another installation of its city`)
    const mode = cityMode({ canonical: w.canonical, origin: w.origin, activationRehearsal: w.activation_rehearsal })
    if (mode !== expectedMode) add('city', `${label} has a ${mode ?? 'unknown'} city; a world's city in a database stamped "${stamp ?? 'unstamped'}" is ${expectedMode}`)
    const sequence = Number(w.sequence)
    report.sequence = sequence
    if (w.state_version !== WORLD_CITY_STATE_VERSION || !parseWorldCityState(w.state)) add('state', `${label} holds state version ${w.state_version} that this build cannot read as a world city (only an empty version ${WORLD_CITY_STATE_VERSION} city)`)
    if (sequence !== 1) add('state', `${label} is at sequence ${sequence}; this build supports only a world as founded (sequence 1)`)
    const records = legacy.find((l) => l.city_id === w.city_id)
    if (records && (records.intents > 0 || records.properties > 0)) add('legacy-records', `${label} holds Rare Friends activation records (${records.intents} intents, ${records.properties} properties)`)

    // Events and the founding record.
    const own = events.filter((e) => e.city_id === w.city_id)
    if (own.length !== sequence || own.some((e, i) => Number(e.sequence) !== i + 1)) add('events', `${label} is at sequence ${sequence} but has events ${own.map((e) => e.sequence).join(',') || 'none'}`)
    const founding = own[0]?.type === 'city.initialized' ? own[0].payload?.world : undefined
    if (own.filter((e) => e.type === 'city.initialized').length !== 1 || !isRecord(founding)) {
      add('founding', `${label} has no city.initialized event recording the world`)
      continue
    }
    const fPayload = own[0].payload ?? {}
    const fPlay = isRecord(founding.play) ? founding.play : {}
    const fConfig = isRecord(founding.foundingConfig) ? founding.foundingConfig : {}
    const foundation = parseWorldFoundation(founding.foundation)
    if (founding.id !== w.id) add('founding', `${label}'s founding event records world ${String(founding.id)}`)
    if (report.play && (fPlay.environment !== report.play.environment || fPlay.gameKey !== report.play.gameKey || fPlay.installationId !== report.play.installationId || fPlay.discordGuildId !== report.play.discordGuildId))
      add('founding', `${label}'s founding event names another Play installation than its binding`)
    if (fPayload.origin !== w.origin || fPayload.canonical !== w.canonical) add('founding', `${label}'s founding event records a ${String(fPayload.origin)} city (canonical ${String(fPayload.canonical)}); its row is ${w.origin} (canonical ${w.canonical})`)
    if ((w.activation_rehearsal === true) !== (fPayload.activationRehearsal === true) || (!w.activation_rehearsal && Object.hasOwn(fPayload, 'activationRehearsal')))
      add('founding', `${label}'s founding event does not record the rehearsal flag its row has (${String(w.activation_rehearsal)})`)
    if (fPayload.stateVersion !== WORLD_CITY_STATE_VERSION || fPayload.stateVersion !== w.state_version) add('founding', `${label}'s founding event records state version ${String(fPayload.stateVersion)}; a world city is founded at version ${WORLD_CITY_STATE_VERSION}`)
    if (fPayload.environment !== stamp) add('founding', `${label}'s founding event records environment ${String(fPayload.environment)}; the database is stamped "${stamp ?? 'unstamped'}"`)
    if (typeof fConfig.version !== 'number' || typeof fConfig.configHash !== 'string' || typeof fConfig.schemaVersion !== 'number') add('founding', `${label}'s founding event names no configuration version`)
    if (!foundation) {
      add('founding', `${label}'s founding event has no readable foundation`)
      continue
    }
    report.foundingConfigVersion = typeof fConfig.version === 'number' ? fConfig.version : null

    // Configuration copies. Each verdict depends on the copy and the foundation alone.
    const mine = versions.filter((v) => v.world_id === w.id)
    const acceptedCollections = new Map<number, FoundationCollection[]>()
    for (const v of mine) {
      const vLabel = `${label} configuration version ${v.version}`
      if (report.play && v.play_installation_id !== report.play.installationId) add('configs', `${vLabel} was served by another installation`)
      let document: unknown
      try {
        document = JSON.parse(v.config_canonical)
      } catch {
        add('configs', `${vLabel} is not JSON`)
        continue
      }
      let canonical: string | null = null
      try {
        canonical = canonicalJson(document)
      } catch {
        // reported below
      }
      if (canonical !== v.config_canonical) add('configs', `${vLabel} is not stored as Play's canonical JSON text`)
      if (sha256(v.config_canonical) !== v.config_hash) add('configs', `${vLabel} does not hash to its config_hash`)
      if (v.verdict === 'rejected') {
        report.configVersions.rejected++
        if (!isRecord(v.rejection) || (v.rejection.code !== 'config_invalid' && v.rejection.code !== 'config_incompatible') || !Array.isArray(v.rejection.problems)) add('configs', `${vLabel} is rejected without a reason`)
        else if (v.judged_by === WORLD_CONFIG_JUDGE && SUPPORTED_PLAY_SCHEMA_VERSIONS.includes(v.schema_version)) {
          const again = judgeWorldConfig(document, w.id, foundation)
          if (again.verdict !== 'rejected' || again.code !== v.rejection.code) add('verdict', `${vLabel} is recorded as rejected (${String(v.rejection.code)}); this build's rules ${again.verdict === 'accepted' ? 'accept it' : `reject it as ${again.code}`}`)
        }
        continue
      }
      report.configVersions.accepted++
      if (!SUPPORTED_PLAY_SCHEMA_VERSIONS.includes(v.schema_version)) {
        add('configs', `${vLabel} is accepted with schema version ${v.schema_version}, which this build cannot read`)
        continue
      }
      const judged = judgeWorldConfig(document, w.id, null)
      if (judged.verdict !== 'accepted') {
        add('configs', `${vLabel} is accepted but is not a valid city: ${judged.problems[0]?.path} ${judged.problems[0]?.detail}`)
        continue
      }
      acceptedCollections.set(v.version, judged.foundation.collections)
      if (v.version === report.foundingConfigVersion && !sameFoundation(judged.foundation, foundation)) add('foundation', `${vLabel} founded the world but does not make the recorded foundation`)
      if (JSON.stringify([judged.foundation.layout, judged.foundation.districts]) !== JSON.stringify([foundation.layout, foundation.districts])) add('geometry', `${vLabel} is accepted but would move the city's districts`)
      if (!keepsCollections(foundation, judged.foundation.collections)) add('collections', `${vLabel} is accepted but drops or repoints a founding collection`)
      for (const c of judged.foundation.collections) {
        const other = foundation.collections.find((f) => f.chain === c.chain && f.contract === c.contract && f.key !== c.key)
        if (other) add('collections', `${vLabel} is accepted but names founding collection ${other.key}'s contract as ${c.key}`)
      }
    }
    const foundingCopy = mine.find((v) => v.version === report.foundingConfigVersion)
    if (!foundingCopy || foundingCopy.verdict !== 'accepted' || foundingCopy.config_hash !== fConfig.configHash) add('founding', `${label}'s founding configuration version is not recorded as accepted with the founding hash`)
    else if (foundingCopy.schema_version !== fConfig.schemaVersion) add('founding', `${label}'s founding event records schema version ${String(fConfig.schemaVersion)}; the founding copy has ${foundingCopy.schema_version}`)

    // Adoptions: the governing history. Each adoption keeps every collection the ones before it established.
    const adopted = adoptions.filter((a) => a.world_id === w.id)
    if (adopted.length === 0) add('adoptions', `${label} has no adopted configuration`)
    else {
      if (adopted[0].version !== report.foundingConfigVersion) add('adoptions', `${label}'s first adoption is version ${adopted[0].version}, not its founding version`)
      if (adopted.some((a, i) => a.adoption_seq !== i + 1)) add('adoptions', `${label}'s adoptions are not numbered 1, 2, 3 ...`)
      for (const a of adopted) if (!mine.some((v) => v.version === a.version && v.verdict === 'accepted')) add('adoptions', `${label} adopted version ${a.version}, which it has not accepted`)
      const governed: FoundationCollection[][] = []
      adopted.forEach((a, i) => {
        if (i > 0 && a.version === adopted[i - 1].version) add('adoptions', `${label}'s adoption ${a.adoption_seq} adopts version ${a.version}, which already governed it`)
        const collections = acceptedCollections.get(a.version)
        if (!collections) return
        const problems = governingProblems(foundation, establishedCollections(foundation, governed), { ...foundation, collections })
        if (problems.length > 0) add('adoptions', `${label}'s adoption ${a.adoption_seq} (version ${a.version}) could not govern it: ${problems[0].detail}`)
        governed.push(collections)
      })
      report.governingConfigVersion = adopted.at(-1)!.version
    }
  }

  // Across worlds: what the binding keys and the city key already promise, checked from the rows.
  const twice = <T>(values: T[]) => values.filter((v, i) => values.indexOf(v) !== i)
  for (const key of new Set(twice(reports.flatMap((r) => (r.play ? [`${r.play.environment}/${r.play.installationId}`] : []))))) add('cross-world', `installation ${key} is bound to more than one world`)
  for (const key of new Set(twice(reports.flatMap((r) => (r.play ? [`${r.play.environment}/${r.play.gameKey}/${r.play.discordGuildId}`] : []))))) add('cross-world', `Discord server ${key} has more than one world`)
  for (const key of new Set(twice(reports.map((r) => r.city)))) add('cross-world', `city ${key} belongs to more than one world`)
  return reports
}

/** Every founding collection is still there, naming the same contract. */
function keepsCollections(foundation: WorldFoundation, collections: readonly FoundationCollection[]): boolean {
  return foundation.collections.every((f) => collections.some((c) => c.key === f.key && c.chain === f.chain && c.contract === f.contract))
}
