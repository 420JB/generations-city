import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { http } from 'viem'
import { createApp, SERVICE_NAME } from './app'
import { createAuthService } from './auth/service'
import { createCityReader } from './city/store'
import { ConfigError, loadConfig, type ServerConfig } from './config'
import { defaultMigrationsDir } from './db/migrations'
import { createPool } from './db/pool'
import { createLogger, errorFields } from './log'
import { createFixtureOwnershipProvider } from './ownership/fixture'
import { createGenerationsOwnershipProvider } from './ownership/generations'
import { createFriendsReader } from './ownership/reader'
import { loadStaticSite } from './static'

const SHUTDOWN_GRACE_MS = 10_000
const RPC_TIMEOUT_MS = 10_000

/** `npm run build:app` puts the server-mode client here; without it the service is API only. */
const CLIENT_DIR = resolve(process.cwd(), 'dist-server/public')

async function main() {
  const log = createLogger()
  let config: ServerConfig
  try {
    config = loadConfig(process.env)
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err
    log.error(`invalid configuration: ${err.message}`)
    process.exit(1)
  }

  const db = config.databaseUrl ? createPool(config.databaseUrl, log) : null
  const site = await loadStaticSite(CLIENT_DIR)
  // Ownership is read from the chain. The fixture is a labelled stand-in that config only allows in local mode.
  const ownership =
    config.ownership === 'fixture' ? createFixtureOwnershipProvider() : createGenerationsOwnershipProvider({ transport: http(config.rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: 1, retryDelay: 250 }) })
  const server = createServer(
    createApp({
      config,
      db,
      migrationsDir: defaultMigrationsDir(),
      log,
      city: db ? createCityReader(db) : null,
      auth: db ? createAuthService({ db, publicOrigin: config.publicOrigin }) : null,
      friends: createFriendsReader(ownership),
      site,
    }),
  )
  // A request has this long to arrive in full; nothing the service accepts is large.
  server.headersTimeout = 15_000
  server.requestTimeout = 30_000

  // Allowed, because a deployment may truly have nothing in front of it. Behind a proxy it would make every visitor one client.
  if (config.mode !== 'local' && config.trustedProxy === 'none') log.warn('TRUSTED_PROXY=none: the client network is the socket peer. If a proxy is in front, every visitor shares one rate-limit bucket.', { mode: config.mode })

  server.listen(config.port, config.host, () => {
    // The RPC endpoint is deliberately absent: it may carry provider credentials.
    log.info('listening', { service: SERVICE_NAME, mode: config.mode, host: config.host, port: config.port, origin: config.publicOrigin, database: db ? 'configured' : 'not-configured', ownership: ownership.source, client: site ? `${site.size} files` : 'none', trustedProxy: config.trustedProxy, rateLimits: config.rateLimits ? 'on' : 'off', frameAncestors: config.frameAncestors.length, commit: config.commit })
  })

  let stopping = false
  const shutdown = (signal: string) => {
    if (stopping) return
    stopping = true
    log.info('shutting down', { signal })
    const force = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS)
    force.unref()
    server.close(() => {
      Promise.resolve(db?.end())
        .catch((err: unknown) => log.error('database pool close failed', errorFields(err)))
        .finally(() => process.exit(0))
    })
    server.closeIdleConnections()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

await main()
