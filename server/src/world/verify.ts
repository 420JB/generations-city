import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { PLAY_ENVIRONMENTS_FOR_MODE, type AppMode } from '../config'
import {
  CONSTRUCTED_WORLD_CITY_STATE_VERSION,
  CONSTRUCTION_RECIPES,
  constructionStep,
  DESIGN_CATALOGS,
  isCatalogChoice,
  constructionTier,
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
  PROPERTY_CONSTRUCTED_EVENT,
  replayWorldCity,
  sameFoundation,
  sameGeometry,
  SUPPORTED_PLAY_SCHEMA_VERSIONS,
  WORLD_CITY_STATE_VERSION,
  WORLD_CONFIG_JUDGE_V2,
  worldCityProblems,
  worldCityStateText,
  worldProperty,
  type FoundationCollection,
  type RecordedCityChange,
  type World,
  type WorldFoundation,
  type WorldGeometry,
} from '../engine'
import { canonicalJson } from '../play/canonical'
import { parityProblem, worldCityId, type ConstructionParity, type PropertyRow } from './store'
import { verifyDistrictTickets, type TicketVerifyReport } from './verifyTickets'

/**
 * `city:verify` for persistent brand cities: is every world in this database one an
 * authority may hold? READ-ONLY, on the caller's REPEATABLE READ, READ ONLY transaction, so
 * worlds, bindings, cities, events and configuration rows are one consistent picture.
 *
 * Per world:
 *   binding     exactly one Play binding, for a Play environment this database may serve;
 *   city        its city is `world:<id>`, of the kind 0005 founds a world on in this environment
 *               (canonical in production, a rehearsal elsewhere), and holds no Rare Friends records;
 *   state       a state this build writes: version 1 (founded empty) at sequence 1, version 2 (with
 *               properties) after it, or (0013) version 3 once anything is built. Anything else is a
 *               state no code here wrote, and is reported, never guessed at;
 *   events      exactly one per sequence; the first is `city.initialized` and records the city as
 *               its row is (origin, canonical, rehearsal), the founding state version, the environment
 *               the database is stamped for, the world, its binding, its founding configuration
 *               (version, hash and schema version, as the stored copy has them) and its foundation;
 *               every later one is `world.property.activated` or (0013) `world.property.constructed`;
 *   properties  (migration 0007) one `world_properties` row per later sequence, each exactly a building
 *               of the state; its id the V2 property id of its NFT in this world; its NFT from a
 *               collection of the version that governed the world when it was activated, under that
 *               key; its district's geometry the frozen one; its event exactly the engine's
 *               transition; (0008) its original activator recorded, unless it was written before
 *               0008. REPLAY: every activation and (0013) every construction, in sequence order, from
 *               the empty founded city, through the engine's own proposals (an activation's on its
 *               governing version, a construction's by its recipe), must be valid and rebuild the
 *               stored state byte for byte (so plots, ward openings, development and sequences all
 *               agree), and each event must be exactly the engine's;
 *   construction (migration 0013) each construction names a property of its world, a recipe this build
 *               has and its exact step (0014: never by a recipe older than one the property was built by before), an owner in the control era current then whose controller is
 *               the owner, a patron in that era under someone else or in none, and is paid by exactly
 *               one debit of its contributor; control eras are numbered 1, 2, 3 ... per property, each a
 *               new controller, each observed by a construction of that property in that era; every
 *               test credit account is numbered 1, 2, 3 ..., each entry leaving the balance before it
 *               plus its delta, never below zero, with at most 20 grants;
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
 *   tickets     (migration 0010) the district rotation, its slots and tickets, as `verifyTickets.ts` says.
 *   designs     (migration 0015) each saved design names a property of its world, in that world's city, a facade and
 *               roof of a catalog this build has, and the local fixture controller as its authority; revisions are
 *               numbered 1, 2, 3 ... per property, each saved at a city sequence no earlier than the activation and the
 *               revision before it and no later than the city's; (0016) a v1 design names no window or lighting
 *               treatment, a v2 design one of each of v2's, and no revision is of an older catalog than the one before
 *               it; (0017) only a v3 design names an entrance and a landscaping treatment, one of each of v3's. A design is never a change of the city, so the replay above is untouched by it. (Whether the designer was the NFT's controller is the trusted source's, which
 *               the database cannot see: the guard and the service hold that rule.)
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
  /** Its district ticket rotation (0010), or null if nobody has entered it through a build that issues tickets. */
  districtTickets: TicketVerifyReport | null
  /** Construction actions (0013), the properties they developed, control eras, and test credit accounts. */
  constructions: number
  developedProperties: number
  controlEras: number
  testCreditAccounts: number
  /** Saved designs (0015), and the properties that have one. */
  designs: number
  designedProperties: number
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

interface ConstructionRow {
  world_id: string
  city_id: string
  sequence: string
  property_id: string
  action_id: string
  recipe: string
  role: string
  contributor_core_user_id: string
  contributor_discord_user_id: string
  control_era_seq: number | null
  resource: string
  units: number
  built_before: number
  built_after: number
  tier_before: number
  tier_after: number
}

interface DesignRow {
  world_id: string
  city_id: string
  city_instance_id: string
  property_id: string
  revision: number
  action_id: string
  catalog: string
  facade: string
  roof: string
  /** Null before 0016, and for every v1 design. */
  windows: string | null
  lighting: string | null
  /** Null before 0017, and for every v1 and v2 design. */
  entrance: string | null
  landscaping: string | null
  authority: string
  at_city_sequence: string
}

interface EraRow {
  world_id: string
  property_id: string
  era_seq: number
  controller_discord_user_id: string
  source: string
  city_id: string
  observed_at_sequence: string
}

interface CreditRow {
  world_id: string
  account_discord_user_id: string
  account_core_user_id: string
  entry_seq: number
  kind: string
  delta: number
  balance_after: number
  grant_key: string | null
  city_id: string | null
  construction_sequence: string | null
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
/** Design catalogs in the order they were introduced (v1, v2 ...). */
const CATALOG_ORDER = Object.keys(DESIGN_CATALOGS)
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
  // Before 0013 there is no construction, control era or test credit.
  const building = await present('world_property_constructions')
  const constructions = building
    ? (
        await client.query<ConstructionRow>(
          `SELECT world_id, city_id, sequence, property_id, action_id, recipe, role, contributor_core_user_id, contributor_discord_user_id, control_era_seq, resource, units, built_before, built_after, tier_before, tier_after
             FROM world_property_constructions ORDER BY world_id, sequence`,
        )
      ).rows
    : []
  const eras = building
    ? (await client.query<EraRow>('SELECT world_id, property_id, era_seq, controller_discord_user_id, source, city_id, observed_at_sequence FROM world_property_control_eras ORDER BY world_id, property_id, era_seq')).rows
    : []
  const credits = building
    ? (
        await client.query<CreditRow>(
          `SELECT world_id, account_discord_user_id, account_core_user_id, entry_seq, kind, delta, balance_after, grant_key, city_id, construction_sequence
             FROM world_test_credit_entries ORDER BY world_id, account_discord_user_id, account_core_user_id, entry_seq`,
        )
      ).rows
    : []
  // Before 0015 there is no saved design; before 0016 none names a window or lighting treatment, before 0017 none an entrance or landscaping.
  const designsPresent = await present('world_property_designs')
  const hasColumns = async (names: string[]) =>
    designsPresent &&
    (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid = to_regclass('world_property_designs') AND attname = ANY($1) AND NOT attisdropped`, [names])).rows[0].n === names.length
  const detailed = await hasColumns(['windows', 'lighting'])
  const street = await hasColumns(['entrance', 'landscaping'])
  const designs = designsPresent
    ? (
        await client.query<DesignRow>(
          `SELECT world_id, city_id, city_instance_id, property_id, revision, action_id, catalog, facade, roof, ${detailed ? 'windows, lighting' : 'NULL AS windows, NULL AS lighting'},
                  ${street ? 'entrance, landscaping' : 'NULL AS entrance, NULL AS landscaping'}, authority, at_city_sequence
             FROM world_property_designs ORDER BY world_id, property_id, revision`,
        )
      ).rows
    : []
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
      districtTickets: null,
      constructions: 0,
      developedProperties: 0,
      controlEras: 0,
      testCreditAccounts: 0,
      designs: 0,
      designedProperties: 0,
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
    const built = constructions.filter((c) => c.world_id === w.id)
    report.constructions = built.length
    const expectedVersion = sequence === 1 ? WORLD_CITY_STATE_VERSION : built.length > 0 ? CONSTRUCTED_WORLD_CITY_STATE_VERSION : POPULATED_WORLD_CITY_STATE_VERSION
    if (!state || state.version !== expectedVersion || w.state_version !== expectedVersion)
      add(
        'state',
        `${label} holds state version ${w.state_version} at sequence ${sequence}; this build writes version ${WORLD_CITY_STATE_VERSION} as founded, version ${POPULATED_WORLD_CITY_STATE_VERSION} with properties and version ${CONSTRUCTED_WORLD_CITY_STATE_VERSION} once anything is built`,
      )
    const records = legacy.find((l) => l.city_id === w.city_id)
    if (records && (records.intents > 0 || records.properties > 0)) add('legacy-records', `${label} holds Rare Friends activation records (${records.intents} intents, ${records.properties} properties)`)

    // Events and the founding record.
    const own = events.filter((e) => e.city_id === w.city_id)
    if (own.length !== sequence || own.some((e, i) => Number(e.sequence) !== i + 1)) add('events', `${label} is at sequence ${sequence} but has events ${own.map((e) => e.sequence).join(',') || 'none'}`)
    for (const e of own.slice(1))
      if (e.type !== PROPERTY_ACTIVATED_EVENT && e.type !== PROPERTY_CONSTRUCTED_EVENT) add('events', `${label}'s event ${e.sequence} is ${e.type}; a world's city changes only by activating a property or building on one`)
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
      const latest = new Map<string, ConstructionRow>()
      for (const c of built) latest.set(c.property_id, c)
      const parity: ConstructionParity = { count: built.length, latest: [...latest.values()].map((c) => ({ property_id: c.property_id, sequence: c.sequence, built_after: c.built_after, tier_after: c.tier_after })) }
      report.developedProperties = latest.size
      const mismatch = parityProblem(state, sequence, mine2, parity)
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
    const steps: RecordedCityChange[] = []
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
      steps.push({ kind: 'activation', world, request: { asset, plotId: p.plot_id }, sequence: Number(p.activated_sequence) })
    }
    // Construction (0013): each record's own rules; its place in the city is the replay's.
    const ownEras = eras.filter((e) => e.world_id === w.id)
    report.controlEras = ownEras.length
    let replayable = steps.length === mine2.length
    // (0014) Recipes are versioned, oldest first, and an older one builds nothing after a newer one on the same property.
    const recipeOrder = Object.keys(CONSTRUCTION_RECIPES)
    const latestRecipe = new Map<string, number>()
    for (const c of built) {
      const cLabel = `${label} construction ${c.sequence}`
      const property = mine2.find((p) => p.id === c.property_id)
      const recipe = Object.hasOwn(CONSTRUCTION_RECIPES, c.recipe) ? CONSTRUCTION_RECIPES[c.recipe] : null
      if (!property) add('construction', `${cLabel} names property ${c.property_id}, which is not a property of this world`)
      if (c.city_id !== w.city_id) add('construction', `${cLabel} names city ${c.city_id}`)
      if (!recipe) add('construction', `${cLabel} names recipe ${c.recipe}, which this build does not have`)
      else if (c.units !== constructionStep(recipe, c.built_before) || c.built_after !== c.built_before + c.units || c.tier_before !== constructionTier(recipe, c.built_before) || c.tier_after !== constructionTier(recipe, c.built_after))
        add('construction', `${cLabel} is not its recipe's step from ${c.built_before} units`)
      if (c.resource !== 'local-test-credit') add('construction', `${cLabel} is paid in ${c.resource}`)
      if (recipe) {
        if (recipeOrder.indexOf(c.recipe) < (latestRecipe.get(c.property_id) ?? 0)) add('construction', `${cLabel} is built by recipe ${c.recipe}, older than one its property was already built by`)
        latestRecipe.set(c.property_id, Math.max(latestRecipe.get(c.property_id) ?? 0, recipeOrder.indexOf(c.recipe)))
      }
      // The era current when it was built: the latest observed at or before its sequence.
      const current = ownEras.filter((e) => e.property_id === c.property_id && Number(e.observed_at_sequence) <= Number(c.sequence)).at(-1) ?? null
      if (c.role === 'owner' ? c.control_era_seq === null || c.control_era_seq !== current?.era_seq || current.controller_discord_user_id !== c.contributor_discord_user_id : c.role !== 'patron')
        add('construction', `${cLabel} is an ${c.role} construction outside the era its controller held`)
      if (c.role === 'patron' && c.control_era_seq !== null && (c.control_era_seq !== current?.era_seq || current.controller_discord_user_id === c.contributor_discord_user_id))
        add('construction', `${cLabel} is a patron construction in an era it was not built in, or by that era's controller`)
      const paid = credits.filter((t) => t.city_id === c.city_id && t.construction_sequence === c.sequence)
      if (paid.length !== 1 || paid[0].world_id !== w.id || paid[0].kind !== 'construction-debit' || paid[0].delta !== -c.units || paid[0].account_discord_user_id !== c.contributor_discord_user_id || paid[0].account_core_user_id !== c.contributor_core_user_id)
        add('construction', `${cLabel} is not paid by exactly one debit of its contributor, by its units`)
      if (!property || !recipe) replayable = false
      else steps.push({ kind: 'construction', buildingId: property.building_id, recipe, sequence: Number(c.sequence) })
    }
    const erasByProperty = new Map<string, EraRow[]>()
    for (const e of ownEras) erasByProperty.set(e.property_id, [...(erasByProperty.get(e.property_id) ?? []), e])
    for (const [propertyId, list] of erasByProperty) {
      list.forEach((e, i) => {
        const eLabel = `${label} property ${propertyId} control era ${e.era_seq}`
        if (e.era_seq !== i + 1) add('construction', `${label} property ${propertyId}'s control eras are not numbered 1, 2, 3 ...`)
        if (i > 0 && e.controller_discord_user_id === list[i - 1].controller_discord_user_id) add('construction', `${eLabel} names the controller of the era before it`)
        if (e.source !== 'local-fixture' || e.city_id !== w.city_id) add('construction', `${eLabel} has another source or city than this build records`)
        if (!built.some((c) => c.property_id === propertyId && c.sequence === e.observed_at_sequence && c.control_era_seq === e.era_seq)) add('construction', `${eLabel} was not observed by a construction of its property in it`)
      })
    }
    const accounts = new Map<string, CreditRow[]>()
    for (const t of credits.filter((x) => x.world_id === w.id)) accounts.set(`${t.account_discord_user_id}/${t.account_core_user_id}`, [...(accounts.get(`${t.account_discord_user_id}/${t.account_core_user_id}`) ?? []), t])
    report.testCreditAccounts = accounts.size
    for (const [account, entries] of accounts) {
      let balance = 0
      entries.forEach((t, i) => {
        const tLabel = `${label} test credit account ${account} entry ${t.entry_seq}`
        if (t.entry_seq !== i + 1) add('credits', `${label} test credit account ${account} is not numbered 1, 2, 3 ...`)
        balance += t.delta
        if (t.balance_after !== balance || balance < 0) add('credits', `${tLabel} leaves ${t.balance_after}; its entries add up to ${balance}`)
        if (t.kind === 'construction-debit' && !built.some((c) => c.city_id === t.city_id && c.sequence === t.construction_sequence)) add('credits', `${tLabel} pays for no construction of this world`)
        if (t.kind !== 'construction-debit' && t.kind !== 'fixture-grant') add('credits', `${tLabel} is a ${t.kind}`)
      })
      if (entries.filter((t) => t.kind === 'fixture-grant').length > 20) add('credits', `${label} test credit account ${account} holds more than 20 grants`)
    }
    // Designs (0015): each record's own rules. None is a change of the city, so none is in the replay.
    const designed = designs.filter((d) => d.world_id === w.id)
    report.designs = designed.length
    const byProperty = new Map<string, DesignRow[]>()
    for (const d of designed) byProperty.set(d.property_id, [...(byProperty.get(d.property_id) ?? []), d])
    report.designedProperties = byProperty.size
    for (const [propertyId, list] of byProperty) {
      const property = mine2.find((p) => p.id === propertyId)
      if (!property) add('design', `${label} has a design of property ${propertyId}, which is not a property of this world`)
      list.forEach((d, i) => {
        const dLabel = `${label} property ${propertyId} design ${d.revision}`
        if (d.revision !== i + 1) add('design', `${label} property ${propertyId}'s designs are not numbered 1, 2, 3 ...`)
        if (d.city_id !== w.city_id || d.city_instance_id !== w.city_instance_id) add('design', `${dLabel} names another city than its world's`)
        const catalog = Object.hasOwn(DESIGN_CATALOGS, d.catalog) ? DESIGN_CATALOGS[d.catalog] : null
        if (!catalog) add('design', `${dLabel} names catalog ${d.catalog}, which this build does not have`)
        else if (!isCatalogChoice(catalog, { facade: d.facade, roof: d.roof, windows: d.windows, lighting: d.lighting, entrance: d.entrance, landscaping: d.landscaping }))
          add('design', `${dLabel} is ${d.facade} / ${d.roof} / ${d.windows} / ${d.lighting} / ${d.entrance} / ${d.landscaping}, which catalog ${d.catalog} does not offer`)
        // Catalogs only move forward (0016, 0017: an earlier catalog takes no new save), so no revision is of an older catalog than the one before it.
        if (i > 0 && CATALOG_ORDER.indexOf(d.catalog) < CATALOG_ORDER.indexOf(list[i - 1].catalog)) add('design', `${dLabel} is of catalog ${d.catalog}, older than the revision before it`)
        if (d.authority !== 'local-fixture-controller') add('design', `${dLabel} is authorized by ${d.authority}`)
        const at = Number(d.at_city_sequence)
        if ((property && at < Number(property.activated_sequence)) || at > sequence || (i > 0 && at < Number(list[i - 1].at_city_sequence)))
          add('design', `${dLabel} is saved at city sequence ${at}, outside its property's life in the city or before the revision before it`)
      })
    }
    if (replayable && steps.length > 0) {
      steps.sort((a, b) => a.sequence - b.sequence)
      const replay = replayWorldCity(steps)
      if (!replay.ok) add('replay', `${label} cannot be rebuilt from its properties and constructions: ${replay.detail}`)
      else {
        if (!state || worldCityStateText(replay.state) !== JSON.stringify(w.state)) add('replay', `${label}'s stored state is not the state its properties and constructions rebuild`)
        for (const change of replay.changes) {
          const t = change.transition
          const event = own.find((e) => Number(e.sequence) === t.to)
          if (change.kind === 'activation') {
            const p = mine2.find((x) => Number(x.activated_sequence) === t.to)!
            const expected = { ...change.transition.event, configVersion: p.activated_config_version, adoption: p.activated_adoption_seq }
            if (!event || JSON.stringify(sortKeys(event.payload)) !== JSON.stringify(sortKeys(expected))) add('replay', `${label}'s event ${t.to} does not record the activation of property ${change.transition.property.propertyId} as the engine makes it`)
            if (change.transition.districtGeometryFingerprint !== p.district_geometry_fingerprint) add('replay', `${label} property ${change.transition.property.propertyId} records another district geometry than the engine's`)
          } else {
            const c = built.find((x) => Number(x.sequence) === t.to)!
            const expected = { ...change.transition.event, action: c.action_id, role: c.role }
            if (!event || JSON.stringify(sortKeys(event.payload)) !== JSON.stringify(sortKeys(expected))) add('replay', `${label}'s event ${t.to} does not record the construction of property ${change.transition.propertyId} as the engine makes it`)
            if (change.transition.units !== c.units || change.transition.builtAfter !== c.built_after || change.transition.tierAfter !== c.tier_after) add('replay', `${label} construction ${c.sequence} records another step than the engine's`)
          }
        }
      }
    }
  }

  for (const p of properties) if (!worlds.some((w) => w.id === p.world_id)) add('properties', `property ${p.id} names world ${p.world_id}, which does not exist`)
  for (const c of constructions) if (!worlds.some((w) => w.id === c.world_id)) add('construction', `construction ${c.city_id}/${c.sequence} names world ${c.world_id}, which does not exist`)
  for (const t of credits) if (!worlds.some((w) => w.id === t.world_id)) add('credits', `test credit account ${t.account_discord_user_id} names world ${t.world_id}, which does not exist`)
  for (const d of designs) if (!worlds.some((w) => w.id === d.world_id)) add('design', `design ${d.property_id}/${d.revision} names world ${d.world_id}, which does not exist`)

  // District tickets (0010): the rotation, its slots and tickets.
  const tickets = await verifyDistrictTickets(client, add)
  for (const r of reports) r.districtTickets = tickets.get(r.id) ?? null

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
