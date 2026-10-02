import { ConfigError, loadConfig, type ServerConfig } from './config'
import { defaultMigrationsDir, migrate, MigrationError } from './db/migrations'
import { createPool } from './db/pool'
import { createLogger, errorFields } from './log'

/** `npm run db:migrate`: apply pending migrations to DATABASE_URL, then exit. */
async function main(): Promise<number> {
  const log = createLogger()
  let config: ServerConfig
  try {
    config = loadConfig(process.env)
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err
    log.error(`invalid configuration: ${err.message}`)
    return 1
  }
  if (!config.databaseUrl) {
    log.error('DATABASE_URL is not set; nothing to migrate.')
    return 1
  }

  const db = createPool(config.databaseUrl, log, { queryTimeoutMs: 0 })
  try {
    const result = await migrate(db, { dir: defaultMigrationsDir(), environment: config.mode })
    log.info('migrations complete', { mode: config.mode, applied: result.applied.join(',') || 'none', current: result.current })
    return 0
  } catch (err) {
    if (err instanceof MigrationError) log.error(err.message)
    else log.error('migration run failed', errorFields(err))
    return 1
  } finally {
    await db.end()
  }
}

process.exitCode = await main()
