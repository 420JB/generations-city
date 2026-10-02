import { createServer } from 'node:http'
import { createApp, SERVICE_NAME } from './app'
import { ConfigError, loadConfig, type ServerConfig } from './config'
import { defaultMigrationsDir } from './db/migrations'
import { createPool } from './db/pool'
import { createLogger, errorFields } from './log'

const SHUTDOWN_GRACE_MS = 10_000

function main() {
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
  const server = createServer(createApp({ config, db, migrationsDir: defaultMigrationsDir(), log }))

  server.listen(config.port, config.host, () => {
    log.info('listening', { service: SERVICE_NAME, mode: config.mode, host: config.host, port: config.port, database: db ? 'configured' : 'not-configured', commit: config.commit })
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

main()
