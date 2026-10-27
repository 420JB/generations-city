import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { http } from 'viem'
import { createPropertyReader } from './activation/properties'
import { createActivationService } from './activation/service'
import { createApp, SERVICE_NAME } from './app'
import { createAuthService } from './auth/service'
import { createCityReader } from './city/store'
import { DISTRICT_TICKET_LEASE_SECONDS } from './engine'
import { ConfigError, loadConfig, type ServerConfig } from './config'
import { defaultMigrationsDir } from './db/migrations'
import { createPool } from './db/pool'
import { createLogger, errorFields } from './log'
import { createFixtureOwnershipProvider } from './ownership/fixture'
import { createGenerationsOwnershipProvider } from './ownership/generations'
import { createFriendsReader } from './ownership/reader'
import { createPlayClient } from './play/client'
import { createPlayLaunchService } from './play/launch'
import { createPlaySessionService, createPlaySessionStore } from './play/session'
import { assertPreviewDatabase, PreviewStartupError } from './preview'
import { loadStaticSite } from './static'
import { createWorldPropertyStore } from './world/properties'
import { createWorldConstructionStore } from './world/construction'
import { createWorldDesignStore } from './world/designs'
import { createLocalPropertyRehearsal, parseRehearsalFile, rehearsalEligibility, type LocalPropertyRehearsal } from './world/rehearsal'
import { createDistrictTicketStore } from './world/tickets'
import { createWorldStore } from './world/store'

const SHUTDOWN_GRACE_MS = 10_000
const RPC_TIMEOUT_MS = 10_000

/** `npm run build:app` puts the server-mode client here; without it the service is API only. */
const CLIENT_DIR = resolve(process.cwd(), 'dist-server/public')
/** `npm run build:preview` puts the Districts Play client here: the only page a hosted preview serves. */
const PREVIEW_CLIENT_DIR = resolve(process.cwd(), 'dist-server/play')

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
  const preview = config.hostedPreview !== null
  // HOSTED PREVIEW: the built Play client, behind the access gate, never cached by anything shared; and nothing is served
  // without it or from a database that is not a migrated, local-stamped one.
  const site = preview ? await loadStaticSite(PREVIEW_CLIENT_DIR, { privateCache: true }) : await loadStaticSite(CLIENT_DIR)
  if (preview) {
    try {
      if (!site) throw new PreviewStartupError('the Districts Play client is not built (npm run build:preview).')
      await assertPreviewDatabase(db!, defaultMigrationsDir())
    } catch (err) {
      log.error(`hosted preview refused to start: ${err instanceof PreviewStartupError ? err.message : 'the preview database could not be checked.'}`)
      process.exit(1)
    }
  }
  // Ownership is read from the chain. The fixture is a labelled stand-in that config only allows in local mode.
  const ownership =
    config.ownership === 'fixture' ? createFixtureOwnershipProvider() : createGenerationsOwnershipProvider({ transport: http(config.rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: 1, retryDelay: 250 }) })
  // Config refuses Play without a database: every launch opens the installation's persistent city, and a play session to read it again.
  const play = config.play && db ? createPlayClient({ baseUrl: config.play.apiUrl, credential: config.play.credential }) : null
  const worlds = config.play && db ? createWorldStore(db, { mode: config.mode, log }) : null
  const playSessions =
    config.play && play && worlds && db ? createPlaySessionService({ store: createPlaySessionStore(db), worlds, play, environment: config.play.environment, gameKey: config.play.gameKey, log }) : null
  // LOCAL PROPERTY REHEARSAL: only with APP_MODE=local and its file (config refuses the file anywhere else). Test NFTs, not holdings.
  let rehearsal: LocalPropertyRehearsal | null = null
  if (config.localRehearsalFile && playSessions && db) {
    try {
      const fixture = parseRehearsalFile(JSON.parse(await readFile(config.localRehearsalFile, 'utf8')))
      // The ticket store and the rehearsal judge eligibility, rules and rule results on the same fixture.
      const tickets = createDistrictTicketStore(db, { mode: config.mode, log, eligibility: rehearsalEligibility(fixture) })
      rehearsal = createLocalPropertyRehearsal({
        mode: config.mode,
        fixture,
        sessions: playSessions,
        store: createWorldPropertyStore(db, { mode: config.mode, log }),
        tickets,
        // LOCAL TEST construction, its owners and test credits from the same fixture (file v4; none in earlier versions).
        construction: createWorldConstructionStore(db, { mode: config.mode, log }),
        // Architect design (P1-C2-E4A): the same fixture's controllers are the only ones who may save one.
        designs: createWorldDesignStore(db, { mode: config.mode, log }),
        log,
      })
      log.warn('LOCAL PROPERTY REHEARSAL ENABLED: test NFTs, district rules and Proofy rule results from a local file stand in for Proofy Core eligibility; district tickets are issued and properties placed permanently in this local database. Not verified ownership or rule results.', { players: fixture.grants.size, districtRules: fixture.rules.length, ruleResults: fixture.results.length, ticketLeaseSeconds: DISTRICT_TICKET_LEASE_SECONDS })
    } catch (err) {
      log.error(`invalid local rehearsal file: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  }
  const server = createServer(
    createApp({
      config,
      db,
      migrationsDir: defaultMigrationsDir(),
      log,
      city: db ? createCityReader(db) : null,
      // Never in a hosted preview (the app ignores them there too): no wallet sign-in, owned-Friends read or activation.
      auth: db && !preview ? createAuthService({ db, publicOrigin: config.publicOrigin }) : null,
      friends: preview ? null : createFriendsReader(ownership),
      // Built whenever there is a database, and inert unless ACTIVATION_ENABLED=true: the routes and the service both refuse first.
      activation: db && !preview ? createActivationService({ db, ownership, publicOrigin: config.publicOrigin, enabled: config.activationEnabled, log }) : null,
      properties: db && !preview ? createPropertyReader(db) : null,
      playLaunch: config.play && play && worlds ? createPlayLaunchService({ play, environment: config.play.environment, gameKey: config.play.gameKey, worlds }) : null,
      playSessions,
      rehearsal,
      site,
    }),
  )
  // A request has this long to arrive in full; nothing the service accepts is large.
  server.headersTimeout = 15_000
  server.requestTimeout = 30_000

  if (preview) log.warn('HOSTED PREVIEW: a local rehearsal reachable from the internet behind its access gate. Synthetic NFTs, controllers and valueless TEST credits only; no wallet sign-in or activation.', { origin: config.publicOrigin })
  // Allowed, because a deployment may truly have nothing in front of it. Behind a proxy it would make every visitor one client.
  if (config.mode !== 'local' && config.trustedProxy === 'none') log.warn('TRUSTED_PROXY=none: the client network is the socket peer. If a proxy is in front, every visitor shares one rate-limit bucket.', { mode: config.mode })

  server.listen(config.port, config.host, () => {
    // The RPC endpoint is deliberately absent: it may carry provider credentials.
    log.info('listening', { service: SERVICE_NAME, mode: config.mode, host: config.host, port: config.port, origin: config.publicOrigin, database: db ? 'configured' : 'not-configured', ownership: ownership.source, client: site ? `${site.size} files` : 'none', trustedProxy: config.trustedProxy, rateLimits: config.rateLimits ? 'on' : 'off', frameAncestors: config.frameAncestors.length, activationEnabled: config.activationEnabled, play: config.play ? `${config.play.environment}/${config.play.gameKey}` : 'not-connected', localRehearsal: rehearsal ? 'enabled' : 'off', hostedPreview: preview ? 'on (access gate: basic)' : 'off', commit: config.commit })
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
