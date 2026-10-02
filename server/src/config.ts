/**
 * Server runtime configuration, read once from the environment at boot.
 *
 * APP_MODE is the single switch for which Rare City this process serves:
 * - `local`      a developer machine; the database is optional.
 * - `staging`    the shared, non-canonical environment; the database is required.
 * - `production` the canonical city; the database is required.
 */
import { RARE_FRIENDS_CHAIN } from './engine'

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

export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const mode = readMode(env)
  const port = readPort(env)
  const host = clean(env.HOST) ?? (mode === 'local' ? '127.0.0.1' : '0.0.0.0')
  return {
    mode,
    port,
    host,
    databaseUrl: readDatabaseUrl(env, mode),
    commit: clean(env.RAILWAY_GIT_COMMIT_SHA) ?? clean(env.GIT_SHA) ?? null,
    publicOrigin: readPublicOrigin(env, mode, host, port),
    rpcUrl: readRpcUrl(env, mode),
    ownership: readOwnership(env, mode),
  }
}
