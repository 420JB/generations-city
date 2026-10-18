import { parseWorldCityState, type WorldCityState } from '../world/cityState'

/**
 * Wire contract for opening a brand city from a Proofy Play launch. Used by the server and
 * the client. Portable: no browser or Node dependency.
 *
 * Proofy Play launches a player into Rare City by sending the browser to Rare City's
 * registered launch URL with a Play-signed run token in the URL FRAGMENT
 * (`<launchUrl>#runToken=<jwt>`; Play contract 1.1.0 §11: never a query string). The page
 * posts that token here, once:
 *
 *   `POST /v1/play/session`  `{ "runToken": "<jwt>" }`
 *
 * The browser sends nothing else. It never names an installation, a server, a world or a
 * configuration version: the server learns all of them from Play by redeeming the token with
 * Rare City's service credential, then loads the configuration version the run was pinned
 * to and checks it against the run before anything is drawn.
 *
 * Redemption is single use (Play `run_already_redeemed`), so a run token opens the city once
 * and is never kept. A launch that opens the city also opens a PLAY SESSION: the server sets
 * an HttpOnly cookie, scoped to this origin, naming the player Play's run named and the city
 * the launch opened. With it the same browser reads the city again (a reload, a new tab)
 * without another launch:
 *
 *   `GET  /v1/play/city`    the session's player, city, sequence, state and governing configuration
 *   `POST /v1/play/logout`  `{}`: end the session
 *
 * Neither takes anything that names a city: the session alone says which one. A launch never
 * changes WHO a browser is signed in as: a run for another player than the browser's live session
 * opens nothing (`play_session_other_player`) and the session is kept. To switch players, sign out
 * first. A session ends
 * when Play's run does (or sooner, see the server's PLAY_SESSION_MAX_MS), on logout, on a newer
 * launch in the same browser, and when Play says the installation is no longer active. It is
 * never extended: launching again from Proofy Play is how a player is re-authorized, and that
 * is when Proofy Core checks their Discord membership and Play entitlement again.
 *
 * The city is PERSISTENT: one world per installation, founded by the installation's first
 * launch and returned by every launch after it, whatever configuration version it runs.
 */
export const PLAY_SESSION_ENDPOINT = '/v1/play/session'
/** The session's city, read again. GET, no body, no parameters. */
export const PLAY_CITY_ENDPOINT = '/v1/play/city'
/** End the session. POST `{}`. */
export const PLAY_LOGOUT_ENDPOINT = '/v1/play/logout'

/** URL fragment parameter that carries the run token. */
export const RUN_TOKEN_FRAGMENT_PARAM = 'runToken'

/** `POST /v1/play/session` request. Exactly this key. */
export interface PlaySessionRequest {
  runToken: string
}

/** A JWS compact token, bounded. Play's run tokens are a few hundred characters. */
export const RUN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,1024}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,1024}$/

/** Where the city's configuration came from, as Play reported it and Rare City checked it. */
export interface PlayCitySource {
  environment: 'dev' | 'test' | 'staging' | 'live'
  gameKey: string
  installationId: string
  discordGuildId: string
  /** On a launch, the version the run is pinned to. On a session read, the version that governs the city. */
  configVersion: number
  configHash: string
  schemaVersion: number
}

/**
 * Something about the viewer, and how it is known. `verified` says who established it and when:
 * `launch` means at the launch that opened this session (Proofy Core signed it into the context
 * the run was started from, at most a few minutes before), `live` means asked of Play for this
 * answer. `unknown` is never a no: it is a question no authority answered.
 */
export type PlayFact<T> =
  | { status: 'verified'; value: T; source: 'proofy-core' | 'proofy-play'; basis: 'launch' | 'live'; at: string }
  | {
      status: 'unknown'
      /** `not-in-contract`: no authority tells Rare City this. `authority-unavailable`: the authority did not answer in time. `not-checked`: Rare City does not ask yet. */
      reason: 'not-in-contract' | 'authority-unavailable' | 'not-checked'
    }

/** The player a play session belongs to, as Proofy established them, and what they may do. */
export interface PlayViewer {
  authenticated: true
  /** From Play's redeemed run. The Discord user id is the canonical Proofy player identity; the Core user id is opaque. */
  player: { discordUserId: string; coreUserId: string; displayName: string }
  /**
   * `ref` identifies the session this answer was drawn for (it authorizes nothing). Anything that acts names it,
   * and is refused if the browser's session is no longer that one. The session never extends: past
   * `expiresAt`, launch again from Proofy Play.
   */
  session: { ref: string; expiresAt: string; renewal: 'relaunch' }
  status: {
    /** Proofy Core checked live Discord membership before it signed the launch context. */
    guildMember: PlayFact<true>
    /** Core said the server is entitled to Play, and Play refuses a launch otherwise. */
    playEntitled: PlayFact<true>
    /** Whether Play has the installation active. */
    installationActive: PlayFact<true>
    /** Core tells Play, but Play's run does not tell the game. */
    brandAdmin: PlayFact<boolean>
    /** Whether the player meets the city's Proofy verification rules. Not asked yet. */
    districtRules: PlayFact<Record<string, boolean>>
  }
  /** What the session allows. Only viewing is open. */
  permissions: { viewCity: true; claim: false; build: false }
}

/** `GET /v1/play/city`: the session's city, as stored, with the configuration that governs it. */
export interface PlayCityResponse {
  play: PlayCitySource
  viewer: PlayViewer
  /** The installation's persistent city, as stored. */
  world: PlayWorld
  /**
   * The configuration document the city is drawn with, exactly as the world accepted it: on a
   * launch the pinned version (hash-checked against Play), on a session read the governing one.
   */
  config: unknown
}

/** `POST /v1/play/session`: the city a launch opened, and the session it opened for this browser. */
export interface PlaySessionResponse extends PlayCityResponse {
  play: PlayCitySource & { runId: string; runExpiresAt: string }
  /** The player Play launched. Presentation only (the same as `viewer.player.displayName`). */
  player: { displayName: string }
}

/** The persistent city of an installation (a `worlds` row and its city, migration 0005). */
export interface PlayWorld {
  /** `worlds.id`: the city's permanent identity, a UUIDv7 bound once to this installation. */
  id: string
  provisioned: true
  /** true when this launch founded the city; every later launch returns it unchanged. */
  created: boolean
  foundedAt: string
  /** Authoritative changes the city has had; 1 = as founded. */
  sequence: number
  /** What the city was founded on and which accepted configuration version governs it now. */
  definition: { foundingConfigVersion: number; governingConfigVersion: number; layoutKey: string; geometryFingerprint: string }
  /** The stored state. Version 1 is an empty city: nothing has been claimed or built. */
  state: WorldCityState
}

/** Error bodies are `{ "error": <code> }`, plus `problems` for `config_invalid`. */
export type PlayErrorCode =
  | 'invalid_request'
  | 'invalid_json'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'origin_mismatch'
  | 'rate_limited'
  /** This deployment is not connected to Proofy Play. */
  | 'play_disabled'
  /** Play did not accept the run token for Rare City: forged, expired, or another game's. */
  | 'run_token_refused'
  /** The run was already opened. */
  | 'run_already_used'
  | 'run_expired'
  | 'installation_not_active'
  /** What Play served does not belong to the run (installation, server, version or hash). */
  | 'config_binding_mismatch'
  /** The run is pinned to a configuration schema version this build cannot read. */
  | 'config_schema_unsupported'
  /** The pinned configuration is not a valid Rare City city. */
  | 'config_invalid'
  /** The pinned configuration would move the city's districts or drop a collection; the city is unchanged. */
  | 'config_incompatible'
  /** The city does not exist yet and this run is pinned to a configuration that is no longer active. */
  | 'config_superseded'
  /** This Discord server's city is bound to another installation (or Play disagrees with the binding). */
  | 'world_binding_conflict'
  /** The city's storage could not be reached, or holds a state this build cannot read. */
  | 'world_unavailable'
  /** Proofy Play could not be reached, or answered outside its contract. */
  | 'play_unavailable'
  /** No live play session: none was opened in this browser, or it expired, was revoked, or ended. Launch from Proofy Play. */
  | 'play_session_required'
  /** The session could not be read or written just now. */
  | 'play_session_unavailable'
  /** Proofy Play refused Rare City itself (its credential or the game). The session is over. */
  | 'play_authorization_refused'
  /** Proofy Play has not confirmed the installation recently enough to show the city. The session is kept: try again. */
  | 'installation_unverified'
  /** The launch was for another player than the one this browser is signed in as. Nothing was opened; the session is kept. */
  | 'play_session_other_player'
  /** The page acted for a session this browser no longer holds. Nothing was done. */
  | 'play_actor_mismatch'

export interface PlayErrorBody {
  error: PlayErrorCode
  problems?: { path: string; detail: string }[]
  /** With `play_session_other_player`: who this browser is still signed in as. */
  session?: { displayName: string }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A UUIDv7 (`worlds.id`): never the old derived preview ids, which were UUIDv8. */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const GUILD = /^[0-9]{15,25}$/
const ENVIRONMENTS = ['dev', 'test', 'staging', 'live'] as const

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1

const CORE_ID = /^[A-Za-z0-9_-]{1,64}$/
const FACT_SOURCES = ['proofy-core', 'proofy-play'] as const
const FACT_BASES = ['launch', 'live'] as const
const UNKNOWN_REASONS = ['not-in-contract', 'authority-unavailable', 'not-checked'] as const
const isIn = <T extends string>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v)

function parseSource(play: Record<string, unknown>): PlayCitySource | null {
  if (!isIn(ENVIRONMENTS, play.environment)) return null
  if (typeof play.gameKey !== 'string' || typeof play.installationId !== 'string' || !UUID.test(play.installationId)) return null
  if (typeof play.discordGuildId !== 'string' || !GUILD.test(play.discordGuildId)) return null
  if (!posInt(play.configVersion) || !posInt(play.schemaVersion) || typeof play.configHash !== 'string' || !HASH.test(play.configHash)) return null
  return { environment: play.environment, gameKey: play.gameKey, installationId: play.installationId, discordGuildId: play.discordGuildId, configVersion: play.configVersion, configHash: play.configHash, schemaVersion: play.schemaVersion }
}

function parseFact<T>(v: unknown, value: (x: unknown) => x is T): PlayFact<T> | null {
  if (!isRecord(v)) return null
  if (v.status === 'unknown') return isIn(UNKNOWN_REASONS, v.reason) ? { status: 'unknown', reason: v.reason } : null
  if (v.status !== 'verified' || !value(v.value) || !isIn(FACT_SOURCES, v.source) || !isIn(FACT_BASES, v.basis) || typeof v.at !== 'string' || Number.isNaN(Date.parse(v.at))) return null
  return { status: 'verified', value: v.value, source: v.source, basis: v.basis, at: v.at }
}

const isTrue = (x: unknown): x is true => x === true
const isBool = (x: unknown): x is boolean => typeof x === 'boolean'
const isAnswers = (x: unknown): x is Record<string, boolean> => isRecord(x) && Object.values(x).every(isBool)

export function parsePlayViewer(v: unknown): PlayViewer | null {
  if (!isRecord(v) || v.authenticated !== true || !isRecord(v.player) || !isRecord(v.session) || !isRecord(v.status) || !isRecord(v.permissions)) return null
  const { player, session, status, permissions } = v
  if (typeof player.discordUserId !== 'string' || !GUILD.test(player.discordUserId) || typeof player.coreUserId !== 'string' || !CORE_ID.test(player.coreUserId)) return null
  if (typeof player.displayName !== 'string' || player.displayName.length === 0) return null
  if (typeof session.ref !== 'string' || !UUID.test(session.ref)) return null
  if (typeof session.expiresAt !== 'string' || Number.isNaN(Date.parse(session.expiresAt)) || session.renewal !== 'relaunch') return null
  const guildMember = parseFact(status.guildMember, isTrue)
  const playEntitled = parseFact(status.playEntitled, isTrue)
  const installationActive = parseFact(status.installationActive, isTrue)
  const brandAdmin = parseFact(status.brandAdmin, isBool)
  const districtRules = parseFact(status.districtRules, isAnswers)
  if (!guildMember || !playEntitled || !installationActive || !brandAdmin || !districtRules) return null
  // Only viewing is open: a page that is told otherwise is talking to something else.
  if (permissions.viewCity !== true || permissions.claim !== false || permissions.build !== false) return null
  return {
    authenticated: true,
    player: { discordUserId: player.discordUserId, coreUserId: player.coreUserId, displayName: player.displayName },
    session: { ref: session.ref, expiresAt: session.expiresAt, renewal: 'relaunch' },
    status: { guildMember, playEntitled, installationActive, brandAdmin, districtRules },
    permissions: { viewCity: true, claim: false, build: false },
  }
}

/** `GET /v1/play/city`'s body, or null if it is not one. The configuration itself is validated separately. */
export function parsePlayCityResponse(body: unknown): PlayCityResponse | null {
  if (!isRecord(body) || !isRecord(body.play) || !isRecord(body.world) || !isRecord(body.config)) return null
  const play = parseSource(body.play)
  const viewer = parsePlayViewer(body.viewer)
  const world = parsePlayWorld(body.world)
  if (!play || !viewer || !world) return null
  return { play, viewer, world, config: body.config }
}

/** `POST /v1/play/session`'s body, or null if it is not one. The configuration itself is validated separately. */
export function parsePlaySessionResponse(body: unknown): PlaySessionResponse | null {
  const city = parsePlayCityResponse(body)
  if (!city || !isRecord(body) || !isRecord(body.play) || !isRecord(body.player)) return null
  const { runId, runExpiresAt } = body.play
  if (typeof runId !== 'string' || !UUID.test(runId) || typeof runExpiresAt !== 'string') return null
  if (typeof body.player.displayName !== 'string') return null
  return { ...city, play: { ...city.play, runId, runExpiresAt }, player: { displayName: body.player.displayName } }
}

function parsePlayWorld(world: Record<string, unknown>): PlayWorld | null {
  const { definition: d } = world
  if (typeof world.id !== 'string' || !UUID_V7.test(world.id) || world.provisioned !== true || typeof world.created !== 'boolean') return null
  if (typeof world.foundedAt !== 'string' || Number.isNaN(Date.parse(world.foundedAt)) || !posInt(world.sequence)) return null
  if (!isRecord(d) || !posInt(d.foundingConfigVersion) || !posInt(d.governingConfigVersion) || typeof d.layoutKey !== 'string' || !KEY.test(d.layoutKey) || typeof d.geometryFingerprint !== 'string' || !HASH.test(d.geometryFingerprint)) return null
  const state = parseWorldCityState(world.state)
  if (!state) return null
  return {
    id: world.id,
    provisioned: true,
    created: world.created,
    foundedAt: world.foundedAt,
    sequence: world.sequence,
    definition: { foundingConfigVersion: d.foundingConfigVersion, governingConfigVersion: d.governingConfigVersion, layoutKey: d.layoutKey, geometryFingerprint: d.geometryFingerprint },
    state,
  }
}

/** The run token in a launch URL fragment (`#runToken=…`), or null. */
export function runTokenFromFragment(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const all = params.getAll(RUN_TOKEN_FRAGMENT_PARAM)
  return all.length === 1 && RUN_TOKEN_PATTERN.test(all[0]) ? all[0] : null
}
