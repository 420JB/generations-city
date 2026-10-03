import { CONFIRM, GenesisError, installCanonicalGenesis, installRehearsalGenesis, parseGenesisArgs, replaceStagingFixtureWithRehearsal } from './city/genesis'
import { CityInitError } from './city/store'
import { ConfigError, loadConfig, type ServerConfig } from './config'
import { createPool } from './db/pool'
import { createLogger, errorFields } from './log'

const HELP = `Rare City genesis: explicit operator commands. Never run by a deploy, a request or start-up.

  npm run city:genesis -- canonical --confirm-city ${CONFIRM.city} --confirm-environment production
      Install the CANONICAL, empty city. Requires APP_MODE=production and a database
      stamped production. Refuses if any city exists.

  npm run city:genesis -- rehearsal --confirm-city ${CONFIRM.city} --confirm-environment staging
      Install an empty, NON-CANONICAL activation rehearsal city. Requires APP_MODE=staging
      and a database stamped staging. Refuses if any city exists.

  npm run city:genesis -- replace-staging-fixture --confirm-city ${CONFIRM.city} --confirm-environment staging \\
        --confirm-reset ${CONFIRM.reset} --expect-instance <uuid> --expect-sequence <n>
      STAGING ONLY, DESTRUCTIVE. Replace the disposable demo-fixture city with an empty
      rehearsal city. Refuses unless the city is exactly the instance and sequence named,
      is an ordinary demo fixture, and no property, ownership era or activation intent
      exists. Can never run against production.

  npm run city:verify
      Read-only check of the installed city. Run it before and after any of the above.
`

async function main(): Promise<number> {
  const log = createLogger()
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    process.stdout.write(HELP)
    return argv.length === 0 ? 1 : 0
  }
  const parsed = parseGenesisArgs(argv)
  if ('error' in parsed) {
    log.error(`${parsed.error} Run with --help.`)
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
  if (!config.databaseUrl) {
    log.error('DATABASE_URL is not set; there is no database to act on.')
    return 1
  }

  const { command, flags } = parsed
  const confirmation = { mode: config.mode, confirmCity: flags['--confirm-city'], confirmEnvironment: flags['--confirm-environment'] }
  const db = createPool(config.databaseUrl, log)
  try {
    if (command === 'canonical') {
      const city = await installCanonicalGenesis(db, confirmation)
      log.info('CANONICAL city installed', { mode: config.mode, city: city.id, instance: city.instance, sequence: city.sequence, canonical: city.canonical, origin: city.origin })
    } else if (command === 'rehearsal') {
      const city = await installRehearsalGenesis(db, confirmation)
      log.info('NON-CANONICAL activation rehearsal city installed', { mode: config.mode, city: city.id, instance: city.instance, sequence: city.sequence, canonical: city.canonical, origin: city.origin, activationRehearsal: true })
    } else {
      const sequence = flags['--expect-sequence']
      const result = await replaceStagingFixtureWithRehearsal(db, {
        ...confirmation,
        confirmReset: flags['--confirm-reset'],
        expectedInstance: flags['--expect-instance'],
        expectedSequence: sequence !== undefined && /^[1-9][0-9]*$/.test(sequence) ? Number(sequence) : undefined,
      })
      log.info('staging demo fixture REPLACED by a NON-CANONICAL activation rehearsal city', {
        mode: config.mode,
        replacedInstance: result.replaced.instance,
        replacedSequence: result.replaced.sequence,
        replacedEvents: result.replaced.events,
        city: result.city.id,
        instance: result.city.instance,
        sequence: result.city.sequence,
        canonical: result.city.canonical,
        activationRehearsal: true,
      })
    }
    return 0
  } catch (err) {
    if (err instanceof GenesisError || err instanceof CityInitError) log.error(`Refused: ${err.message}`, { reason: err.reason })
    else log.error('genesis command failed (has db:migrate been run?)', errorFields(err))
    return 1
  } finally {
    await db.end()
  }
}

process.exitCode = await main()
