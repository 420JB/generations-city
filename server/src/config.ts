/**
 * Server runtime configuration, read once from the environment at boot.
 *
 * APP_MODE is the single switch for which Rare City this process serves:
 * - `local`      a developer machine; the database is optional.
 * - `staging`    the shared, non-canonical environment; the database is required.
 * - `production` the canonical city; the database is required.
 *
 * LOCAL_HOSTED_PREVIEW=true is not a mode: it is a profile of `local` for one private, internet-reachable
 * preview of the Districts Play game (`hosted-preview/README.md`). It forces the deployed transport rules
 * (https origin, Railway proxy trust, Secure `__Host-` cookies, HSTS, rate limits) and an access gate, and
 * refuses everything a public local process must not have (`readHostedPreview`).
 */
import { TRUSTED_PROXIES, type TrustedProxy } from './clientKey'
import { PLAY_GAME_KEY, RARE_FRIENDS_CHAIN, type PlayEnvironment } from './engine'
import { PLAY_CREDENTIAL_PATTERN } from './play/client'

export type AppMode = 'local' | 'staging' | 'production'

export const APP_MODES: readonly AppMode[] = ['local', 'staging', 'production']

export interface ServerConfig {
  mode: AppMode
  port: number
  host: string
  /** Postgres connection string, or null when no database is configured (local only). */
  databaseUrl: string | null
  /** Deployed source revision for diagnostics, when the platform provides one. */
  commit: string | null
  /**
   * The one origin this service is reached at, as `scheme://host[:port]`. Sign-in messages
   * name it, and requests that change anything must come from it.
   */
  publicOrigin: string
  /** Robinhood Chain RPC endpoint. May carry provider credentials, so it is never logged. */
  rpcUrl: string
  /** Where Friend ownership is read from. `fixture` is a deterministic stand-in for local work and tests. */
  ownership: OwnershipSource
  /** What stands in front of this process, and so where a request's client network is read from. */
  trustedProxy: TrustedProxy
  /** false only for local automated tests. A shared environment always limits. */
  rateLimits: boolean
  /** Exact https:// origins allowed to frame the app, besides this origin itself. Empty = same-origin only. */
  frameAncestors: string[]
  /** `Strict-Transport-Security` lifetime in seconds. Not sent in local mode. */
  hstsMaxAge: number
  /**
   * Whether permanent Friend activation may run. false unless ACTIVATION_ENABLED says `true`
   * in so many words. Nothing else switches it on: not the mode, and not the kind of city
   * the database holds.
   */
  activationEnabled: boolean
  /**
   * The connection to Proofy Play, as Rare City's game service, or null: not connected, and
   * the Play launch route refuses with `play_disabled`. Set by PLAY_API_URL together with
   * PLAY_SERVICE_CREDENTIAL; one without the other stops start-up, and so does either without
   * DATABASE_URL, because a launch opens the installation's persistent city.
   */
  play: PlayConnection | null
  /**
   * The LOCAL PROPERTY REHEARSAL file (`world/rehearsal.ts`), or null: no rehearsal, and its routes do not
   * exist. Set by LOCAL_PROPERTY_REHEARSAL_FILE, which is refused in any mode but local, and needs Play.
   * It lists TEST NFTs per Discord player: rehearsal data, never verified holdings.
   */
  localRehearsalFile: string | null
  /**
   * The HOSTED PREVIEW profile (LOCAL_HOSTED_PREVIEW=true), or null. When set, every request but the two
   * health probes must pass the preview access gate (`previewGate.ts`) before it is routed, and this local
   * process behaves on the wire as a deployed one does. It authorizes nothing in the game: a play session is
   * still the only game authority.
   */
  hostedPreview: HostedPreviewConfig | null
}

export interface HostedPreviewConfig {
  /** The one HTTP Basic user name the gate accepts. Not a secret, but never logged. */
  accessUser: string
  /** SHA-256 of the gate password, from PREVIEW_ACCESS_PASSWORD_SHA256. The password itself is never configured. */
  accessPasswordSha256: Buffer
}

/**
 * The district ticket lease is not configurable (policy D2, locked): exactly 900 seconds, set by the database (0011).
 * LOCAL_DISTRICT_TICKET_TTL_SECONDS, which earlier builds read, is refused unless it says exactly that, so an old
 * environment cannot silently believe it chose another lifetime.
 */
export const LOCKED_TICKET_LEASE_SECONDS = '900'

export interface PlayConnection {
  /** Base URL of proofy-play-api. */
  apiUrl: string
  /** Rare City's service credential (`ppk_<env>_<keyId>.<secret>`). A secret: never logged or echoed. */
  credential: string
  /** The Play environment the credential was minted in. Must be one this mode may serve. */
  environment: PlayEnvironment
  /** Rare City's game key in Play. */
  gameKey: string
}

/**
 * Which Play environments a deployment of each mode may talk to: the same mapping
 * `world_play_bindings` enforces (migration 0005). A staging city never reads live Play
 * installations, and production never reads anything else.
 */
export const PLAY_ENVIRONMENTS_FOR_MODE: Readonly<Record<AppMode, readonly PlayEnvironment[]>> = {
  local: ['dev', 'test'],
  staging: ['staging'],
  production: ['live'],
}

export type OwnershipSource = 'robinhood' | 'fixture'

export const OWNERSHIP_SOURCES: readonly OwnershipSource[] = ['robinhood', 'fixture']

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

const DEFAULT_PORT = 8787

function clean(value: string | undefined): string | undefined {
  const v = value?.trim()
  return v ? v : undefined
}

function readMode(env: Record<string, string | undefined>): AppMode {
  const raw = clean(env.APP_MODE)
  if (raw === undefined) {
    // A deployed process must say which city it serves; only a dev machine may default.
    if (clean(env.NODE_ENV) === 'production') throw new ConfigError('APP_MODE must be set to staging or production when NODE_ENV=production.')
    return 'local'
  }
  if ((APP_MODES as readonly string[]).includes(raw)) return raw as AppMode
  throw new ConfigError(`APP_MODE must be one of: ${APP_MODES.join(', ')}.`)
}

function readPort(env: Record<string, string | undefined>): number {
  const raw = clean(env.PORT)
  if (raw === undefined) return DEFAULT_PORT
  const port = Number(raw)
  if (!/^\d+$/.test(raw) || port < 1 || port > 65_535) throw new ConfigError('PORT must be an integer between 1 and 65535.')
  return port
}

/** Validates the shape only. The value is a secret, so it is never echoed in an error. */
function readDatabaseUrl(env: Record<string, string | undefined>, mode: AppMode): string | null {
  const raw = clean(env.DATABASE_URL)
  if (raw === undefined) {
    if (mode !== 'local') throw new ConfigError(`DATABASE_URL is required when APP_MODE=${mode}.`)
    return null
  }
  let protocol: string
  try {
    protocol = new URL(raw).protocol
  } catch {
    throw new ConfigError('DATABASE_URL is not a valid URL.')
  }
  if (protocol !== 'postgres:' && protocol !== 'postgresql:') throw new ConfigError('DATABASE_URL must be a postgres:// or postgresql:// URL.')
  return raw
}

/**
 * The origin browsers use to reach this service. A deployed process must be told: deriving
 * it from a request header would let the request choose what a sign-in message says.
 */
function readPublicOrigin(env: Record<string, string | undefined>, mode: AppMode, host: string, port: number): string {
  const raw = clean(env.PUBLIC_ORIGIN)
  if (raw === undefined) {
    if (mode !== 'local') throw new ConfigError(`PUBLIC_ORIGIN is required when APP_MODE=${mode} (for example https://rarecity.example).`)
    return `http://${host.includes(':') ? `[${host}]` : host}:${port}`
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigError('PUBLIC_ORIGIN is not a valid URL.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ConfigError('PUBLIC_ORIGIN must be an http:// or https:// origin.')
  // Session cookies are Secure outside local mode, so the origin has to be one a browser will send them to.
  if (mode !== 'local' && url.protocol !== 'https:') throw new ConfigError(`PUBLIC_ORIGIN must be https:// when APP_MODE=${mode}.`)
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new ConfigError('PUBLIC_ORIGIN must be a bare origin: scheme, host and optional port only.')
  return url.origin
}

/** Validates the shape only. The value may hold provider credentials, so it is never echoed in an error. */
function readRpcUrl(env: Record<string, string | undefined>, mode: AppMode): string {
  const raw = clean(env.ROBINHOOD_RPC_URL)
  if (raw === undefined) return RARE_FRIENDS_CHAIN.publicRpcUrl
  let protocol: string
  try {
    protocol = new URL(raw).protocol
  } catch {
    throw new ConfigError('ROBINHOOD_RPC_URL is not a valid URL.')
  }
  if (protocol !== 'https:' && protocol !== 'http:') throw new ConfigError('ROBINHOOD_RPC_URL must be an http:// or https:// URL.')
  // Ownership answers come over this connection; in a shared environment nobody on the path may be able to alter them.
  if (mode !== 'local' && protocol !== 'https:') throw new ConfigError(`ROBINHOOD_RPC_URL must be https:// when APP_MODE=${mode}.`)
  return raw
}

function readOwnership(env: Record<string, string | undefined>, mode: AppMode): OwnershipSource {
  const raw = clean(env.OWNERSHIP_PROVIDER)
  if (raw === undefined) return 'robinhood'
  if (!(OWNERSHIP_SOURCES as readonly string[]).includes(raw)) throw new ConfigError(`OWNERSHIP_PROVIDER must be one of: ${OWNERSHIP_SOURCES.join(', ')}.`)
  // A shared environment only ever reports what the chain says.
  if (raw === 'fixture' && mode !== 'local') throw new ConfigError(`OWNERSHIP_PROVIDER=fixture is only allowed when APP_MODE=local, not ${mode}.`)
  return raw as OwnershipSource
}

/**
 * Proxy trust is stated, never inferred: a deployed process that guessed wrong would either
 * rate-limit the proxy as one client or believe an address any client can type.
 */
function readTrustedProxy(env: Record<string, string | undefined>, mode: AppMode): TrustedProxy {
  const raw = clean(env.TRUSTED_PROXY)
  if (raw === undefined) {
    if (mode !== 'local') throw new ConfigError(`TRUSTED_PROXY is required when APP_MODE=${mode}: one of ${TRUSTED_PROXIES.join(', ')}.`)
    return 'none'
  }
  if ((TRUSTED_PROXIES as readonly string[]).includes(raw)) return raw as TrustedProxy
  throw new ConfigError(`TRUSTED_PROXY must be one of: ${TRUSTED_PROXIES.join(', ')}.`)
}

function readRateLimits(env: Record<string, string | undefined>, mode: AppMode): boolean {
  const raw = clean(env.RATE_LIMITS)
  if (raw === undefined || raw === 'on') return true
  if (raw !== 'off') throw new ConfigError('RATE_LIMITS must be on or off.')
  // The browser tests sign in far faster than any visitor. Nothing shared may run without limits.
  if (mode !== 'local') throw new ConfigError(`RATE_LIMITS=off is only allowed when APP_MODE=local, not ${mode}.`)
  return false
}

const MAX_FRAME_ANCESTORS = 16
const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?'
/** A lowercase dotted host name: no wildcard, no bare keyword, and nothing that could end the header directive it is written into. */
const FRAME_ANCESTOR = new RegExp(`^https://${HOST_LABEL}(?:\\.${HOST_LABEL})+(?::[0-9]{1,5})?$`)

/**
 * Parent origins allowed to frame the app, separated by spaces or commas. Each must be
 * written exactly as a browser would send it: `https://host[:port]`, nothing more.
 */
function readFrameAncestors(env: Record<string, string | undefined>): string[] {
  const raw = clean(env.FRAME_ANCESTORS)
  if (raw === undefined) return []
  const origins: string[] = []
  for (const value of raw.split(/[\s,]+/).filter(Boolean)) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new ConfigError(`FRAME_ANCESTORS: "${value}" is not an origin.`)
    }
    if (url.protocol !== 'https:') throw new ConfigError(`FRAME_ANCESTORS: "${value}" must be an https:// origin.`)
    // Exact text only: no wildcard, path, credentials, trailing slash or other spelling of the same origin.
    if (!FRAME_ANCESTOR.test(value) || url.origin !== value) throw new ConfigError(`FRAME_ANCESTORS: "${value}" must be an exact origin such as https://example.com (no wildcard, path or trailing slash).`)
    if (!origins.includes(value)) origins.push(value)
  }
  if (origins.length > MAX_FRAME_ANCESTORS) throw new ConfigError(`FRAME_ANCESTORS lists more than ${MAX_FRAME_ANCESTORS} origins.`)
  return origins
}

const DAY_SECONDS = 86_400
const MAX_HSTS_SECONDS = 2 * 365 * DAY_SECONDS

/**
 * How long a browser insists on https:// for this host. Production starts at one day, so a
 * mistake is short-lived, and is raised with HSTS_MAX_AGE once it has held.
 */
function readHstsMaxAge(env: Record<string, string | undefined>, mode: AppMode, hostedPreview: boolean): number {
  const raw = clean(env.HSTS_MAX_AGE)
  if (raw === undefined) return mode === 'production' ? DAY_SECONDS : mode === 'staging' || hostedPreview ? 365 * DAY_SECONDS : 0
  const seconds = Number(raw)
  if (!/^\d+$/.test(raw) || seconds > MAX_HSTS_SECONDS) throw new ConfigError(`HSTS_MAX_AGE must be a whole number of seconds between 0 and ${MAX_HSTS_SECONDS}.`)
  return seconds
}

/**
 * The activation switch. Exactly `true` or `false`, and off when unset. A value that merely
 * looks affirmative (`1`, `yes`, `on`, `TRUE`) is refused rather than read either way: a
 * permanent write is never enabled or disabled by a guess.
 */
function readActivationEnabled(env: Record<string, string | undefined>): boolean {
  const raw = clean(env.ACTIVATION_ENABLED)
  if (raw === undefined || raw === 'false') return false
  if (raw === 'true') return true
  throw new ConfigError('ACTIVATION_ENABLED must be true or false.')
}

const GAME_KEY = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/

/** Validates shapes only. The credential is a secret, so no error ever echoes it. */
function readPlay(env: Record<string, string | undefined>, mode: AppMode): PlayConnection | null {
  const apiUrl = clean(env.PLAY_API_URL)
  const credential = clean(env.PLAY_SERVICE_CREDENTIAL)
  const gameKey = clean(env.PLAY_GAME_KEY) ?? PLAY_GAME_KEY
  if (apiUrl === undefined && credential === undefined) {
    if (clean(env.PLAY_GAME_KEY) !== undefined) throw new ConfigError('PLAY_GAME_KEY is set but PLAY_API_URL and PLAY_SERVICE_CREDENTIAL are not.')
    return null
  }
  if (apiUrl === undefined || credential === undefined) throw new ConfigError('PLAY_API_URL and PLAY_SERVICE_CREDENTIAL must be set together.')
  let url: URL
  try {
    url = new URL(apiUrl)
  } catch {
    throw new ConfigError('PLAY_API_URL is not a valid URL.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ConfigError('PLAY_API_URL must be an http:// or https:// URL.')
  if (mode !== 'local' && url.protocol !== 'https:') throw new ConfigError(`PLAY_API_URL must be https:// when APP_MODE=${mode}.`)
  if (url.username || url.password || url.search || url.hash) throw new ConfigError('PLAY_API_URL must not carry credentials, a query or a fragment.')
  const match = PLAY_CREDENTIAL_PATTERN.exec(credential)
  if (!match) throw new ConfigError('PLAY_SERVICE_CREDENTIAL is not a Proofy Play service credential (ppk_<env>_<keyId>.<secret>).')
  const environment = match[1] as PlayEnvironment
  const allowed = PLAY_ENVIRONMENTS_FOR_MODE[mode]
  if (!allowed.includes(environment)) throw new ConfigError(`PLAY_SERVICE_CREDENTIAL was minted for Play environment ${environment}; APP_MODE=${mode} may only use ${allowed.join(' or ')}.`)
  if (!GAME_KEY.test(gameKey)) throw new ConfigError('PLAY_GAME_KEY is not a Proofy Play game key.')
  return { apiUrl: url.toString().replace(/\/+$/, ''), credential, environment, gameKey }
}

/** The local property rehearsal file. Local mode only, and only with Play: a rehearsal acts for play sessions. */
function readLocalRehearsal(env: Record<string, string | undefined>, mode: AppMode, play: PlayConnection | null): string | null {
  const file = clean(env.LOCAL_PROPERTY_REHEARSAL_FILE)
  if (file === undefined) return null
  if (mode !== 'local') throw new ConfigError(`LOCAL_PROPERTY_REHEARSAL_FILE is only allowed when APP_MODE=local, not ${mode}.`)
  if (!play) throw new ConfigError('LOCAL_PROPERTY_REHEARSAL_FILE needs PLAY_API_URL and PLAY_SERVICE_CREDENTIAL: a rehearsal activation acts for a play session.')
  return file
}

/** The retired district ticket lease setting: refused, unless unset or exactly the locked lease. */
function refuseTicketTtl(env: Record<string, string | undefined>, rehearsal: string | null): void {
  const raw = clean(env.LOCAL_DISTRICT_TICKET_TTL_SECONDS)
  if (raw === undefined) return
  if (rehearsal === null) throw new ConfigError('LOCAL_DISTRICT_TICKET_TTL_SECONDS is only allowed with LOCAL_PROPERTY_REHEARSAL_FILE: district tickets exist only in the local rehearsal.')
  if (raw !== LOCKED_TICKET_LEASE_SECONDS)
    throw new ConfigError(`District tickets last exactly ${LOCKED_TICKET_LEASE_SECONDS} seconds (locked policy D2); LOCAL_DISTRICT_TICKET_TTL_SECONDS cannot change that. Unset it.`)
}

/** Exactly `true` or `false`, off when unset, like ACTIVATION_ENABLED: a public profile is never switched by a guess. */
function readHostedPreviewFlag(env: Record<string, string | undefined>): boolean {
  const raw = clean(env.LOCAL_HOSTED_PREVIEW)
  if (raw === undefined || raw === 'false') return false
  if (raw === 'true') return true
  throw new ConfigError('LOCAL_HOSTED_PREVIEW must be true or false.')
}

/** Environment variables only Railway sets. A process that sees one is reachable from the internet. */
const RAILWAY_MARKERS = ['RAILWAY_ENVIRONMENT_ID', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID'] as const
const PREVIEW_ACCESS_VARIABLES = ['PREVIEW_ACCESS_USER', 'PREVIEW_ACCESS_PASSWORD_SHA256', 'PREVIEW_ACCESS_PASSWORD'] as const
const ACCESS_USER = /^[A-Za-z0-9._-]{1,64}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
/** SHA-256 of the empty string: a gate whose password is nothing. */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])

/**
 * The HOSTED PREVIEW profile. Off, it may leave no trace: a gate variable without the flag would be a gate that is not
 * there, and APP_MODE=local on Railway without the flag would be a developer process on the internet. On, every rule
 * below is checked against what the rest of the configuration already decided, so a contradiction stops start-up
 * instead of being resolved either way. The database stamp is checked again at start-up (`preview.ts`), and none of
 * these rules depends on it.
 */
const previewRefusal = (rule: string) => new ConfigError(`LOCAL_HOSTED_PREVIEW=true: ${rule}`)

/** The profile is a local one: the rehearsal writes it serves exist only in local mode, on a database stamped local. Checked first. */
function refuseUnstatedPreviewMode(env: Record<string, string | undefined>, previewFlag: boolean): void {
  if (previewFlag && clean(env.APP_MODE) !== 'local') throw previewRefusal('APP_MODE must be set to local (the profile is of local mode; a dedicated mode needs its own audited design).')
}

function readHostedPreview(env: Record<string, string | undefined>, base: Omit<ServerConfig, 'hostedPreview'>): HostedPreviewConfig | null {
  if (!readHostedPreviewFlag(env)) {
    const stray = PREVIEW_ACCESS_VARIABLES.find((name) => clean(env[name]) !== undefined)
    if (stray) throw new ConfigError(`${stray} is set but LOCAL_HOSTED_PREVIEW is not true: the preview access gate is only ever on with the hosted preview profile.`)
    if (base.mode === 'local' && RAILWAY_MARKERS.some((name) => clean(env[name]) !== undefined))
      throw new ConfigError('APP_MODE=local is running on Railway: a local process reachable from the internet must use LOCAL_HOSTED_PREVIEW=true, or use APP_MODE=staging or production.')
    return null
  }
  const refuse = previewRefusal
  if (clean(env.PUBLIC_ORIGIN) === undefined || !base.publicOrigin.startsWith('https://')) throw refuse('PUBLIC_ORIGIN must be set to the preview\'s https:// origin.')
  if (clean(env.TRUSTED_PROXY) !== 'railway') throw refuse('TRUSTED_PROXY must be railway: the preview is reached only through Railway\'s edge, which reports the client in X-Real-IP.')
  if (!base.rateLimits) throw refuse('RATE_LIMITS must be on.')
  if (base.hstsMaxAge === 0) throw refuse('HSTS_MAX_AGE must be greater than 0.')
  if (base.frameAncestors.length > 0) throw refuse('FRAME_ANCESTORS is not supported: the preview is opened directly, never framed.')
  if (base.activationEnabled) throw refuse('ACTIVATION_ENABLED must not be true: permanent Friend activation never runs in a preview.')
  // Legacy wallet-fixture ownership (B) is a different thing from the rehearsal file's synthetic NFT controllers (A), which the preview needs.
  if (base.ownership === 'fixture') throw refuse('OWNERSHIP_PROVIDER=fixture is refused: legacy wallet-fixture authentication stays off in a preview.')
  if (!base.play) throw refuse('PLAY_API_URL and PLAY_SERVICE_CREDENTIAL must name a DEV or TEST Proofy Play.')
  const playUrl = new URL(base.play.apiUrl)
  // Railway's private network (`*.railway.internal`) is not the internet; a loopback Play is for running the profile on one machine.
  if (playUrl.protocol !== 'https:' && !playUrl.hostname.endsWith('.railway.internal') && !LOOPBACK_HOSTS.has(playUrl.hostname))
    throw refuse('PLAY_API_URL must be https://, or http:// only to a *.railway.internal or loopback host.')
  if (!base.localRehearsalFile) throw refuse('LOCAL_PROPERTY_REHEARSAL_FILE must name the synthetic preview world (hosted-preview/).')
  if (clean(env.PREVIEW_ACCESS_PASSWORD) !== undefined) throw refuse('PREVIEW_ACCESS_PASSWORD is refused: configure only its SHA-256, PREVIEW_ACCESS_PASSWORD_SHA256, never the password.')
  const accessUser = clean(env.PREVIEW_ACCESS_USER)
  const hash = clean(env.PREVIEW_ACCESS_PASSWORD_SHA256)?.toLowerCase()
  if (accessUser === undefined || hash === undefined) throw refuse('PREVIEW_ACCESS_USER and PREVIEW_ACCESS_PASSWORD_SHA256 must both be set: the preview never runs without its access gate.')
  if (!ACCESS_USER.test(accessUser)) throw refuse('PREVIEW_ACCESS_USER must be 1-64 letters, digits, dots, dashes or underscores.')
  // Never echoed: a hash of a weak password is as good as the password.
  if (!SHA256_HEX.test(hash) || hash === EMPTY_SHA256) throw refuse('PREVIEW_ACCESS_PASSWORD_SHA256 must be the 64-hex-digit SHA-256 of a non-empty, randomly generated password.')
  return { accessUser, accessPasswordSha256: Buffer.from(hash, 'hex') }
}

export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const mode = readMode(env)
  const previewFlag = readHostedPreviewFlag(env)
  refuseUnstatedPreviewMode(env, previewFlag)
  const port = readPort(env)
  // A preview is reached through Railway's edge, so it listens on every interface, as a deployed mode does.
  const host = clean(env.HOST) ?? (mode === 'local' && !previewFlag ? '127.0.0.1' : '0.0.0.0')
  const databaseUrl = readDatabaseUrl(env, mode)
  const play = readPlay(env, mode)
  if (play && !databaseUrl) throw new ConfigError('PLAY_API_URL needs DATABASE_URL: a Play launch opens the installation\'s persistent city.')
  const localRehearsalFile = readLocalRehearsal(env, mode, play)
  refuseTicketTtl(env, localRehearsalFile)
  const base: Omit<ServerConfig, 'hostedPreview'> = {
    mode,
    port,
    host,
    databaseUrl,
    commit: clean(env.RAILWAY_GIT_COMMIT_SHA) ?? clean(env.GIT_SHA) ?? null,
    publicOrigin: readPublicOrigin(env, mode, host, port),
    rpcUrl: readRpcUrl(env, mode),
    ownership: readOwnership(env, mode),
    trustedProxy: readTrustedProxy(env, mode),
    rateLimits: readRateLimits(env, mode),
    frameAncestors: readFrameAncestors(env),
    hstsMaxAge: readHstsMaxAge(env, mode, previewFlag),
    activationEnabled: readActivationEnabled(env),
    play,
    localRehearsalFile,
  }
  return { ...base, hostedPreview: readHostedPreview(env, base) }
}

/**
 * Whether browsers reach this process over https://, and so get Secure `__Host-` cookies, HSTS and
 * upgrade-insecure-requests: every deployed mode, and a local process in the hosted preview profile.
 */
export const secureTransport = (config: Pick<ServerConfig, 'mode' | 'hostedPreview'>): boolean => config.mode !== 'local' || config.hostedPreview !== null
