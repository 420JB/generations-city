/**
 * Server runtime configuration, read once from the environment at boot.
 *
 * APP_MODE is the single switch for which Rare City this process serves:
 * - `local`      a developer machine; the database is optional.
 * - `staging`    the shared, non-canonical environment; the database is required.
 * - `production` the canonical city; the database is required.
 */
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
}

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

export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const mode = readMode(env)
  return {
    mode,
    port: readPort(env),
    host: clean(env.HOST) ?? (mode === 'local' ? '127.0.0.1' : '0.0.0.0'),
    databaseUrl: readDatabaseUrl(env, mode),
    commit: clean(env.RAILWAY_GIT_COMMIT_SHA) ?? clean(env.GIT_SHA) ?? null,
  }
}
