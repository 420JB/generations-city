import { verifyCity } from './city/verify'
import { ConfigError, loadConfig, type ServerConfig } from './config'
import { createPool } from './db/pool'
import { createLogger, errorFields } from './log'

/**
 * `npm run city:verify`
 *
 * READ-ONLY. Checks that the installed city is one an authority may hold: its state's own
 * invariants, exact parity with the normalized property rows where it may hold real
 * properties, its events against its sequence, and its ownership eras.
 *
 * Exit 0 = valid. Exit 1 = an invariant is violated (each is logged with its category).
 * Exit 2 = the check could not be run.
 */
async function main(): Promise<number> {
  const log = createLogger()
  let config: ServerConfig
  try {
    config = loadConfig(process.env)
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err
    log.error(`invalid configuration: ${err.message}`)
    return 2
  }
  if (!config.databaseUrl) {
    log.error('DATABASE_URL is not set; there is no city to verify.')
    return 2
  }

  const db = createPool(config.databaseUrl, log)
  try {
    const report = await verifyCity(db)
    const summary = { mode: config.mode, ...(report.city ? { city: report.city.id, instance: report.city.instance, sequence: report.city.sequence, stateVersion: report.city.stateVersion, cityMode: report.city.mode ?? 'unknown', canonical: report.city.canonical, origin: report.city.origin, activationRehearsal: report.city.activationRehearsal } : {}), ...report.counts }
    if (report.ok) {
      log.info('city verified', summary)
      return 0
    }
    for (const v of report.violations) log.error('city invariant violated', { category: v.category, rule: v.rule, detail: v.detail })
    log.error('city verification FAILED', { ...summary, violations: report.violations.length, categories: [...new Set(report.violations.map((v) => v.category))].sort().join(',') })
    return 1
  } catch (err) {
    log.error('city verification could not be run (has db:migrate been run?)', errorFields(err))
    return 2
  } finally {
    await db.end()
  }
}

process.exitCode = await main()
