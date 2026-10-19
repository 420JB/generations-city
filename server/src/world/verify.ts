import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { PLAY_ENVIRONMENTS_FOR_MODE, type AppMode } from '../config'
import {
  cityMode,
  establishedCollections,
  geometryOf,
  governingProblems,
  judgeWorldConfig,
  judgeWorldConfigAs,
  parseAssetKey,
  parseWorldCityState,
  parseWorldFoundation,
  parseWorldGeometry,
  POPULATED_WORLD_CITY_STATE_VERSION,
  PROPERTY_ACTIVATED_EVENT,
  replayPropertyActivations,
  sameFoundation,
  sameGeometry,
  SUPPORTED_PLAY_SCHEMA_VERSIONS,
  WORLD_CITY_STATE_VERSION,
  WORLD_CONFIG_JUDGE_V2,
  worldCityProblems,
  worldCityStateText,
  worldProperty,
  type FoundationCollection,
  type RecordedActivation,
  type World,
  type WorldFoundation,
  type WorldGeometry,
} from '../engine'
import { canonicalJson } from '../play/canonical'
import { parityProblem, worldCityId, type PropertyRow } from './store'

/**
 * `city:verify` for persistent brand cities: is every world in this database one an
 * authority may hold? READ-ONLY, on the caller's REPEATABLE READ, READ ONLY transaction, so
 * worlds, bindings, cities, events and configuration rows are one consistent picture.
 *
 * Per world:
 *   binding     exactly one Play binding, for a Play environment this database may serve;
 *   city        its city is `world:<id>`, of the kind 0005 founds a world on in this environment
 *               (canonical in production, a rehearsal elsewhere), and holds no Rare Friends records;
 *   state       a state this build writes: version 1 (founded empty) at sequence 1, or version 2 (with
 *               properties) after it. Anything else is a state no code here wrote, and is reported,
 *               never guessed at;
 *   events      exactly one per sequence; the first is `city.initialized` and records the city as
 *               its row is (origin, canonical, rehearsal), the founding state version, the environment
 *               the database is stamped for, the world, its binding, its founding configuration
 *               (version, hash and schema version, as the stored copy has them) and its foundation;
 *               every later one is `world.property.activated`;
 *   properties  (migration 0007) one `world_properties` row per later sequence, each exactly a building
 *               of the state; its id the V2 property id of its NFT in this world; its NFT from a
 *               collection of the version that governed the world when it was activated, under that
 *               key; its district's geometry the frozen one; its event exactly the engine's
 *               transition; (0008) its original activator recorded, unless it was written before
 *               0008. REPLAY: every activation, in order, from the empty founded city, through
 *               the engine's own proposal on its governing version, must be valid and rebuild the
 *               stored state byte for byte (so plots, ward openings and sequences all agree);
 *   freeze      (migration 0008) present exactly when the world has a property: at its first
 *               property's sequence, adoption and version, holding exactly that version's geometry
 *               (for a freeze 0008 recorded, the founding geometry);
 *   configs     every copy is Play's canonical text of itself and hashes to its hash; every accepted
 *               one is a valid city that keeps every founding collection and names no founding
 *               contract under another key, (0008) recorded with exactly the geometry it draws, and,
 *               if judged by world-evolution-v2, on the founding geometry; a rejected one says why,
 *               and one judged by rules this build has (its own, or v2's) has the verdict they give it;
 *   adoptions   numbered 1, 2, 3 ...; adoption 1 is the founding version; only accepted versions
 *               are adopted, never the one already governing; each keeps every collection the
 *               adoptions before it established (collections are additive); and each from the one
 *               that governed the first property on draws the frozen geometry.
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
  /** World properties (migration 0007). */
  properties: number
  /** Of those, properties written before migration 0008, with no recorded original activator. */
  propertiesWithoutActivator: number
  /** The sequence at which the world's first property froze its district geometry (0008), or null. */
  geometryFrozenAt: number | null
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

interface WorldPropertyRow extends PropertyRow {
  world_id: string
  plot_id: string
  building_id: string
  district_geometry_fingerprint: string
  activated_adoption_seq: number
  activated_config_version: number
  activator_core_user_id: string | null
  activator_discord_user_id: string | null
  activated_at: Date
}

interface FreezeRow {
  world_id: string
  city_id: string
  frozen_at_sequence: string
  adoption_seq: number
  config_version: number
  layout_key: string
  layout_geometry_fingerprint: string
  districts: unknown
  frozen_by: string
}

interface GeometryRow {
  world_id: string
  version: number
  layout_key: string
  layout_geometry_fingerprint: string
  districts: unknown
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
  // Before migration 0007 there are no world properties; before 0008 no geometries, freezes or original activators.
  const present = async (table: string) => (await client.query<{ present: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS present`, [table])).rows[0].present
  const policies = await present('world_geometry_freezes')
  const properties = (await present('world_properties'))
    ? (
        await client.query<WorldPropertyRow>(
          `SELECT world_id, id, chain, standard, contract, token_id, collection_key, district_key, ward, plot, plot_id, building_id, district_geometry_fingerprint, activated_sequence, activated_adoption_seq, activated_config_version,
                  ${policies ? 'activator_core_user_id, activator_discord_user_id' : 'NULL AS activator_core_user_id, NULL AS activator_discord_user_id'}, activated_at
             FROM world_properties ORDER BY world_id, activated_sequence`,
        )
      ).rows
    : []
  const freezes = policies
    ? (await client.query<FreezeRow>('SELECT world_id, city_id, frozen_at_sequence, adoption_seq, config_version, layout_key, layout_geometry_fingerprint, districts, frozen_by FROM world_geometry_freezes ORDER BY world_id')).rows
    : []
  const geometries = policies ? (await client.query<GeometryRow>('SELECT world_id, version, layout_key, layout_geometry_fingerprint, districts FROM world_config_geometries ORDER BY world_id, version')).rows : []
  // When 0008 was applied: a property written since must name its original activator.
  const policiesSince = policies ? ((await client.query<{ applied_at: Date }>('SELECT applied_at FROM schema_migrations WHERE version = 8')).rows[0]?.applied_at ?? null) : null
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
    const report: WorldVerifyReport = {
      id: w.id,
      city: w.city_id,
      sequence: null,
      play: null,
      foundingConfigVersion: null,
      governingConfigVersion: null,
      configVersions: { accepted: 0, rejected: 0 },
      properties: 0,
      propertiesWithoutActivator: 0,
      geometryFrozenAt: null,
    }
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
    const state = parseWorldCityState(w.state)
    const expectedVersion = sequence === 1 ? WORLD_CITY_STATE_VERSION : POPULATED_WORLD_CITY_STATE_VERSION
    if (!state || state.version !== expectedVersion || w.state_version !== expectedVersion)
      add('state', `${label} holds state version ${w.state_version} at sequence ${sequence}; this build writes version ${WORLD_CITY_STATE_VERSION} as founded and version ${POPULATED_WORLD_CITY_STATE_VERSION} with properties`)
    const records = legacy.find((l) => l.city_id === w.city_id)
    if (records && (records.intents > 0 || records.properties > 0)) add('legacy-records', `${label} holds Rare Friends activation records (${records.intents} intents, ${records.properties} properties)`)

    // Events and the founding record.
    const own = events.filter((e) => e.city_id === w.city_id)
    if (own.length !== sequence || own.some((e, i) => Number(e.sequence) !== i + 1)) add('events', `${label} is at sequence ${sequence} but has events ${own.map((e) => e.sequence).join(',') || 'none'}`)
    for (const e of own.slice(1)) if (e.type !== PROPERTY_ACTIVATED_EVENT) add('events', `${label}'s event ${e.sequence} is ${e.type}; a world's city changes only by activating a property`)
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
    if (fPayload.stateVersion !== WORLD_CITY_STATE_VERSION) add('founding', `${label}'s founding event records state version ${String(fPayload.stateVersion)}; a world city is founded at version ${WORLD_CITY_STATE_VERSION}`)
    if (fPayload.environment !== stamp) add('founding', `${label}'s founding event records environment ${String(fPayload.environment)}; the database is stamped "${stamp ?? 'unstamped'}"`)
    if (typeof fConfig.version !== 'number' || typeof fConfig.configHash !== 'string' || typeof fConfig.schemaVersion !== 'number') add('founding', `${label}'s founding event names no configuration version`)
    if (!foundation) {
      add('founding', `${label}'s founding event has no readable foundation`)
      continue
    }
    report.foundingConfigVersion = typeof fConfig.version === 'number' ? fConfig.version : null

    // The geometry freeze (0008), read here and checked against the properties below.
    const frozenRow = freezes.find((f) => f.world_id === w.id)
    const freeze = frozenRow ? freezeOf(frozenRow) : null
    if (frozenRow && !freeze) add('freeze', `${label}'s geometry freeze is not a geometry`)
    if (frozenRow) report.geometryFrozenAt = Number(frozenRow.frozen_at_sequence)

    // Configuration copies. Each verdict depends on the copy and the foundation alone.
    const mine = versions.filter((v) => v.world_id === w.id)
    const acceptedFoundations = new Map<number, WorldFoundation>()
    const acceptedWorlds = new Map<number, World>()
    const recordedGeometries = new Map(geometries.filter((g) => g.world_id === w.id).map((g) => [g.version, g]))
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
        if (recordedGeometries.has(v.version)) add('geometry', `${vLabel} is rejected but has a recorded geometry`)
        if (!isRecord(v.rejection) || (v.rejection.code !== 'config_invalid' && v.rejection.code !== 'config_incompatible') || !Array.isArray(v.rejection.problems)) add('configs', `${vLabel} is rejected without a reason`)
        else if (SUPPORTED_PLAY_SCHEMA_VERSIONS.includes(v.schema_version)) {
          // Checked by the rules of the judge that recorded it, when this build has them; never by other rules.
          const again = judgeWorldConfigAs(v.judged_by, document, w.id, foundation)
          if (again && (again.verdict !== 'rejected' || again.code !== v.rejection.code))
            add('verdict', `${vLabel} is recorded as rejected (${String(v.rejection.code)}) by ${v.judged_by}; its rules ${again.verdict === 'accepted' ? 'accept it' : `reject it as ${again.code}`}`)
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
      acceptedFoundations.set(v.version, judged.foundation)
      acceptedWorlds.set(v.version, judged.world)
      if (v.version === report.foundingConfigVersion && !sameFoundation(judged.foundation, foundation)) add('foundation', `${vLabel} founded the world but does not make the recorded foundation`)
      // world-evolution-v2 accepted only the founding geometry; this build's judge leaves geometry to governing (0008).
      if (v.judged_by === WORLD_CONFIG_JUDGE_V2 && !sameGeometry(judged.foundation, foundation)) add('geometry', `${vLabel} is accepted by ${v.judged_by} but would move the city's districts`)
      if (policies) {
        const g = recordedGeometries.get(v.version)
        const recorded = g ? parseWorldGeometry({ key: g.layout_key, geometryFingerprint: g.layout_geometry_fingerprint }, g.districts) : null
        if (!recorded || !sameGeometry(recorded, judged.foundation)) add('geometry', `${vLabel} is accepted but ${g ? 'its recorded geometry is not the one it draws' : 'has no recorded geometry'}`)
      }
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
        const candidate = acceptedFoundations.get(a.version)
        if (!candidate) return
        // From the adoption that governed the first property on, every governing version draws the frozen geometry.
        const frozen = freeze && a.adoption_seq >= freeze.adoption ? freeze.geometry : null
        const problems = governingProblems(establishedCollections(foundation, governed), candidate, frozen)
        if (problems.length > 0) add('adoptions', `${label}'s adoption ${a.adoption_seq} (version ${a.version}) could not govern it: ${problems[0].detail}`)
        governed.push(candidate.collections)
      })
      report.governingConfigVersion = adopted.at(-1)!.version
    }

    // Properties: parity with the state, provenance, and a full replay through the engine.
    const mine2 = properties.filter((p) => p.world_id === w.id)
    report.properties = mine2.length
    if (state && state.version === expectedVersion) {
      const mismatch = parityProblem(state, sequence, mine2)
      if (mismatch) add('properties', `${label}'s city and its property records disagree: ${mismatch}`)
      const governingWorld = report.governingConfigVersion === null ? undefined : acceptedWorlds.get(report.governingConfigVersion)
      if (governingWorld) for (const p of worldCityProblems(governingWorld, state)) add('state', `${label}: ${p}`)
    }
    if (policies) {
      const first = mine2[0]
      if (!first && frozenRow) add('freeze', `${label} has frozen its district geometry but has no property`)
      if (first && !frozenRow) add('freeze', `${label} has properties but no frozen district geometry`)
      if (first && frozenRow && freeze) {
        if (frozenRow.city_id !== w.city_id || Number(frozenRow.frozen_at_sequence) !== Number(first.activated_sequence) || freeze.adoption !== first.activated_adoption_seq || freeze.configVersion !== first.activated_config_version)
          add('freeze', `${label}'s geometry freeze is not at its first property (sequence ${first.activated_sequence}, adoption ${first.activated_adoption_seq}, version ${first.activated_config_version})`)
        const drawn = acceptedFoundations.get(freeze.configVersion)
        if (!drawn || !sameGeometry(drawn, freeze.geometry)) add('freeze', `${label}'s frozen geometry is not the geometry configuration version ${freeze.configVersion} draws`)
        if (frozenRow.frozen_by === 'migration-0008' ? !sameGeometry(freeze.geometry, foundation) : frozenRow.frozen_by !== 'first-property')
          add('freeze', `${label}'s geometry freeze says it was ${frozenRow.frozen_by}, which it cannot have been`)
      }
    }
    const steps: RecordedActivation[] = []
    let lastAdoption = 0
    for (const p of mine2) {
      const pLabel = `${label} property ${p.id}`
      const asset = parseAssetKey(`${p.chain}/${p.standard}:${p.contract}/${p.token_id}`)
      const world = acceptedWorlds.get(p.activated_config_version)
      if (!asset) {
        add('properties', `${pLabel} does not name a canonical NFT`)
        continue
      }
      if (!world) {
        add('properties', `${pLabel} was activated under configuration version ${p.activated_config_version}, which this world has not accepted`)
        continue
      }
      // The adoption that governed the world then: it adopted this version, and adoptions only move forward with the sequence.
      const adoption = adopted.find((a) => a.adoption_seq === p.activated_adoption_seq)
      if (!adoption || adoption.version !== p.activated_config_version) add('properties', `${pLabel} was activated under version ${p.activated_config_version}, which adoption ${p.activated_adoption_seq} did not adopt`)
      if (p.activated_adoption_seq < lastAdoption) add('properties', `${pLabel} names adoption ${p.activated_adoption_seq}, older than the adoption of the property before it (${lastAdoption})`)
      lastAdoption = Math.max(lastAdoption, p.activated_adoption_seq)
      const identity = worldProperty(world, asset)
      if (!identity) add('properties', `${pLabel} is NFT ${p.chain} ${p.contract} #${p.token_id}, which is in no collection of version ${p.activated_config_version}`)
      else {
        if (identity.propertyId !== p.id || identity.buildingId !== p.building_id) add('properties', `${pLabel} does not carry the V2 property id of its NFT in this world`)
        if (identity.collection.key !== p.collection_key) add('properties', `${pLabel} names collection ${p.collection_key}; its NFT is collection ${identity.collection.key}`)
      }
      // Before 0008 a world's geometry froze at its founding.
      const ground: WorldGeometry = policies ? (freeze?.geometry ?? { layout: foundation.layout, districts: [] }) : foundation
      if (!ground.districts.some((d) => d.key === p.district_key && d.geometryFingerprint === p.district_geometry_fingerprint)) add('geometry', `${pLabel} stands on district ${p.district_key} with geometry its world did not freeze`)
      if (p.activator_core_user_id === null || p.activator_discord_user_id === null) {
        report.propertiesWithoutActivator++
        if (p.activator_core_user_id !== p.activator_discord_user_id) add('activator', `${pLabel} records half an original activator`)
        else if (policiesSince && p.activated_at >= policiesSince) add('activator', `${pLabel} was activated after migration 0008 but records no original activator`)
      }
      steps.push({ world, request: { asset, plotId: p.plot_id }, sequence: Number(p.activated_sequence) })
    }
    if (steps.length === mine2.length && mine2.length > 0) {
      const replay = replayPropertyActivations(steps)
      if (!replay.ok) add('replay', `${label} cannot be rebuilt from its properties: ${replay.detail}`)
      else {
        if (!state || worldCityStateText(replay.state) !== JSON.stringify(w.state)) add('replay', `${label}'s stored state is not the state its properties rebuild`)
        replay.transitions.forEach((t, i) => {
          const event = own.find((e) => Number(e.sequence) === t.to)
          const expected = { ...t.event, configVersion: mine2[i].activated_config_version, adoption: mine2[i].activated_adoption_seq }
          if (!event || JSON.stringify(sortKeys(event.payload)) !== JSON.stringify(sortKeys(expected))) add('replay', `${label}'s event ${t.to} does not record the activation of property ${t.property.propertyId} as the engine makes it`)
          if (t.districtGeometryFingerprint !== mine2[i].district_geometry_fingerprint) add('replay', `${label} property ${t.property.propertyId} records another district geometry than the engine's`)
        })
      }
    }
  }

  for (const p of properties) if (!worlds.some((w) => w.id === p.world_id)) add('properties', `property ${p.id} names world ${p.world_id}, which does not exist`)

  // Across worlds: what the binding keys and the city key already promise, checked from the rows.
  const twice = <T>(values: T[]) => values.filter((v, i) => values.indexOf(v) !== i)
  for (const key of new Set(twice(reports.flatMap((r) => (r.play ? [`${r.play.environment}/${r.play.installationId}`] : []))))) add('cross-world', `installation ${key} is bound to more than one world`)
  for (const key of new Set(twice(reports.flatMap((r) => (r.play ? [`${r.play.environment}/${r.play.gameKey}/${r.play.discordGuildId}`] : []))))) add('cross-world', `Discord server ${key} has more than one world`)
  for (const key of new Set(twice(reports.map((r) => r.city)))) add('cross-world', `city ${key} belongs to more than one world`)
  return reports
}

interface Freeze {
  adoption: number
  configVersion: number
  geometry: WorldGeometry
}

function freezeOf(row: FreezeRow): Freeze | null {
  const geometry = parseWorldGeometry({ key: row.layout_key, geometryFingerprint: row.layout_geometry_fingerprint }, row.districts)
  return geometry ? { adoption: row.adoption_seq, configVersion: row.config_version, geometry: geometryOf(geometry) } : null
}

/** A JSON value with object keys sorted, for comparing a jsonb payload (which reorders keys) with what the engine makes. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]))
}

/** Every founding collection is still there, naming the same contract. */
function keepsCollections(foundation: WorldFoundation, collections: readonly FoundationCollection[]): boolean {
  return foundation.collections.every((f) => collections.some((c) => c.key === f.key && c.chain === f.chain && c.contract === f.contract))
}
