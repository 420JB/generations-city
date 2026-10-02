import { CityInitError } from './city/store'
import { ConfigError, loadConfig, type ServerConfig } from './config'
import { createPool } from './db/pool'
import { installDemoFixture } from './fixtures/demoCity'
import { createLogger, errorFields } from './log'

const FLAG = '--non-canonical'

/**
 * `npm run city:seed-demo -- --non-canonical`
 *
 * Installs the NON-CANONICAL demo fixture city into a staging or local database. It is
 * never run by a deploy. It refuses production, refuses a database stamped for another
 * environment, and refuses once a city exists.
 */
async function main(): Promise<number> {
  const log = createLogger()
  if (!process.argv.includes(FLAG)) {
    log.error(`Refusing to run without ${FLAG}: this installs simulated demo state, not production genesis.`)
    return 1
  }
  let config: ServerConfig
  try {
    config = loadConfig(process.env)
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err
    log.error(`invalid configuration: ${err.message}`)
    return 1
  }
  if (config.mode === 'production') {
    log.error('Refusing: the demo fixture can never be installed when APP_MODE=production.')
    return 1
  }
  if (!config.databaseUrl) {
    log.error('DATABASE_URL is not set; nowhere to install the fixture.')
    return 1
  }

  const db = createPool(config.databaseUrl, log)
  try {
    const meta = await installDemoFixture(db, config.mode)
    log.info('NON-CANONICAL demo fixture city installed', { mode: config.mode, city: meta.id, sequence: meta.sequence, canonical: meta.canonical, origin: meta.origin })
    return 0
  } catch (err) {
    if (err instanceof CityInitError) log.error(err.message, { reason: err.reason })
    else log.error('fixture install failed (has db:migrate been run?)', errorFields(err))
    return 1
  } finally {
    await db.end()
  }
}

process.exitCode = await main()
