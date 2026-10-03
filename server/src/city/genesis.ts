import type { AppMode } from '../config'
import type { Database } from '../db/pool'
import { checkAuthoritativeCity, createGenesisState, type CityMeta } from '../engine'
import { assertInstallable, CITY_ID, CityInitError, environmentStamp, initializeCity, insertCity, type CityInstall } from './store'

/**
 * How an empty city comes to exist. OPERATOR COMMANDS ONLY.
 *
 * Nothing here is reachable from an HTTP request, a deploy or start-up: these functions
 * are called by `genesis-cli.ts` and by tests, and by nothing else.
 *
 * - `installCanonicalGenesis`  the real city, once, in production.
 * - `installRehearsalGenesis`  an empty activation rehearsal city, on a staging database
 *                              that has no city yet.
 * - `replaceStagingFixtureWithRehearsal`  the one destructive path: it swaps staging's
 *                              disposable demo-fixture city for an empty rehearsal city.
 *                              It can never run against production.
 */
export type GenesisRefusal =
  | 'wrong-mode'
  | 'confirmation'
  | 'wrong-environment'
  | 'already-initialized'
  | 'no-city'
  | 'instance-mismatch'
  | 'sequence-mismatch'
  | 'not-a-plain-fixture'
  | 'has-activation-history'
  | 'inconsistent'

export class GenesisError extends Error {
  readonly reason: GenesisRefusal
  constructor(reason: GenesisRefusal, message: string) {
    super(message)
    this.name = 'GenesisError'
    this.reason = reason
  }
}

/** What an operator must type to confirm each action. Deliberately not derivable from anything else on the command line. */
export const CONFIRM = {
  city: CITY_ID,
  reset: 'replace-demo-fixture',
} as const

export interface GenesisConfirmation {
  /** APP_MODE of the process running the command. */
  mode: AppMode
  /** Must be the city id, `main`. */
  confirmCity: string | undefined
  /** Must name the environment being acted on: `production` or `staging`. */
  confirmEnvironment: string | undefined
}

function requireMode(mode: AppMode, required: AppMode, what: string) {
  if (mode !== required) throw new GenesisError('wrong-mode', `${what} requires APP_MODE=${required}; this process is APP_MODE=${mode}.`)
}

function requireConfirmations(c: GenesisConfirmation, environment: AppMode) {
  if (c.confirmCity !== CONFIRM.city) throw new GenesisError('confirmation', `Confirm the city with --confirm-city ${CONFIRM.city}.`)
  if (c.confirmEnvironment !== environment) throw new GenesisError('confirmation', `Confirm the environment with --confirm-environment ${environment}.`)
}

/** Translate the store's refusals that these commands promise by name. */
async function install(db: Database, options: CityInstall): Promise<CityMeta> {
  try {
    return await initializeCity(db, options)
  } catch (err) {
    if (err instanceof CityInitError && err.reason === 'already-initialized') throw new GenesisError('already-initialized', 'This database already has a city. Genesis never overwrites one.')
    if (err instanceof CityInitError && err.reason === 'wrong-environment') throw new GenesisError('wrong-environment', err.message)
    throw err
  }
}

/**
 * CANONICAL GENESIS: the real, empty city. canonical = true, origin = genesis,
 * activation_rehearsal = false, sequence 1, one `city.initialized` event.
 *
 * Requires APP_MODE=production, a database stamped production, and both confirmations.
 * Refuses if any city exists.
 */
export async function installCanonicalGenesis(db: Database, confirmation: GenesisConfirmation): Promise<CityMeta> {
  requireMode(confirmation.mode, 'production', 'Canonical genesis')
  requireConfirmations(confirmation, 'production')
  return install(db, { state: createGenesisState(), origin: 'genesis', rehearsal: false, environment: 'production' })
}

/**
 * REHEARSAL GENESIS: an empty, disposable city in which real activation can be rehearsed.
 * canonical = false, origin = demo-fixture, activation_rehearsal = true.
 *
 * Requires APP_MODE=staging, a database stamped staging, and both confirmations. Refuses
 * if any city exists: replacing one is `replaceStagingFixtureWithRehearsal`'s job alone.
 */
export async function installRehearsalGenesis(db: Database, confirmation: GenesisConfirmation): Promise<CityMeta> {
  requireMode(confirmation.mode, 'staging', 'Rehearsal genesis')
  requireConfirmations(confirmation, 'staging')
  return install(db, { state: createGenesisState(), origin: 'demo-fixture', rehearsal: true, environment: 'staging' })
}

export interface StagingResetRequest extends GenesisConfirmation {
  /** Must be `replace-demo-fixture`. */
  confirmReset: string | undefined
  /** The instance id of the city the operator believes they are replacing. */
  expectedInstance: string | undefined
  /** The sequence the operator believes that city is at. */
  expectedSequence: number | undefined
}

export interface StagingResetResult {
  replaced: { instance: string; sequence: number; events: number }
  city: CityMeta
}

/** Steps of the reset at which a test may make it fail, to prove nothing is left half-done. */
export type ResetStep = 'verified' | 'events-removed' | 'city-removed' | 'installed'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Event types that only an activation, or anything built on one, ever writes. */
const ACTIVATION_EVENT = /^(property|ownership|activation)\./

/**
 * STAGING ONLY. Replace the disposable demo-fixture city with an empty rehearsal city.
 *
 * This is the only code that removes a city. It is not a general reset: it replaces
 * exactly one kind of city (a non-canonical, non-rehearsal demo fixture that has never
 * held anything permanent), and only the one the operator named by instance and sequence.
 *
 * Refuses unless ALL of these hold:
 *   - APP_MODE=staging, and the database is stamped staging;
 *   - --confirm-city main, --confirm-environment staging, --confirm-reset replace-demo-fixture;
 *   - the city's instance and sequence are exactly the ones supplied;
 *   - the city is canonical = false, origin = demo-fixture, activation_rehearsal = false;
 *   - there are no properties, no ownership eras and no activation intents of any status;
 *   - its events are exactly sequence 1..N starting with city.initialized, and none of
 *     them is an activation event;
 *   - its state passes the authoritative invariants for a demo fixture.
 *
 * One transaction. The city row is locked first and every condition is checked under that
 * lock. Then the fixture's events and row are removed and a NEW city (new instance id,
 * sequence 1, empty genesis state, one `city.initialized` event) is installed. Any failure
 * rolls all of it back. A production database additionally refuses the removals itself.
 */
export async function replaceStagingFixtureWithRehearsal(db: Database, request: StagingResetRequest, onStep?: (step: ResetStep) => void | Promise<void>): Promise<StagingResetResult> {
  requireMode(request.mode, 'staging', 'The staging rehearsal reset')
  requireConfirmations(request, 'staging')
  if (request.confirmReset !== CONFIRM.reset) throw new GenesisError('confirmation', `Confirm the replacement with --confirm-reset ${CONFIRM.reset}.`)
  if (typeof request.expectedInstance !== 'string' || !UUID.test(request.expectedInstance)) throw new GenesisError('confirmation', 'Name the city being replaced with --expect-instance <its instance id>.')
  if (typeof request.expectedSequence !== 'number' || !Number.isSafeInteger(request.expectedSequence) || request.expectedSequence < 1) throw new GenesisError('confirmation', 'State the city\'s current sequence with --expect-sequence <n>.')

  const install: CityInstall = { state: createGenesisState(), origin: 'demo-fixture', rehearsal: true, environment: 'staging' }
  assertInstallable(install)

  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL lock_timeout = '5s'`)
    const stamp = await environmentStamp(client)
    if (stamp !== 'staging') throw new GenesisError('wrong-environment', `This database belongs to the "${stamp ?? 'unstamped'}" environment; the rehearsal reset only ever runs against staging.`)

    // The lock every city change takes. Everything below is decided while holding it.
    const city = (
      await client.query<{ instance_id: string; sequence: string; canonical: boolean; origin: string; activation_rehearsal: boolean; state: unknown }>(
        'SELECT instance_id, sequence, canonical, origin, activation_rehearsal, state FROM city WHERE id = $1 FOR UPDATE',
        [CITY_ID],
      )
    ).rows[0]
    if (!city) throw new GenesisError('no-city', 'There is no city to replace. Use the rehearsal installer instead.')
    const sequence = Number(city.sequence)
    if (city.instance_id !== request.expectedInstance) throw new GenesisError('instance-mismatch', 'The city in this database is not the instance named with --expect-instance. Nothing was changed.')
    if (sequence !== request.expectedSequence) throw new GenesisError('sequence-mismatch', `The city is at sequence ${sequence}, not ${request.expectedSequence}. Nothing was changed.`)
    if (city.canonical || city.origin !== 'demo-fixture' || city.activation_rehearsal) throw new GenesisError('not-a-plain-fixture', 'Only an ordinary demo-fixture city (non-canonical, not a rehearsal) can be replaced.')

    const counts = (
      await client.query<{ properties: number; eras: number; intents: number }>(
        'SELECT (SELECT count(*) FROM properties)::int AS properties, (SELECT count(*) FROM ownership_eras)::int AS eras, (SELECT count(*) FROM activation_intents)::int AS intents',
      )
    ).rows[0]
    if (counts.properties > 0 || counts.eras > 0 || counts.intents > 0)
      throw new GenesisError('has-activation-history', `This database holds activation records (${counts.properties} properties, ${counts.eras} ownership eras, ${counts.intents} activation intents). It is not disposable.`)

    const events = (await client.query<{ sequence: string; type: string }>('SELECT sequence, type FROM city_events WHERE city_id = $1 ORDER BY sequence', [CITY_ID])).rows
    if (events.some((e) => ACTIVATION_EVENT.test(e.type))) throw new GenesisError('has-activation-history', 'The city\'s history contains an activation event. It is not disposable.')
    if (events.length !== sequence || events.some((e, i) => Number(e.sequence) !== i + 1) || events[0]?.type !== 'city.initialized')
      throw new GenesisError('inconsistent', 'The city\'s events do not account for its sequence. Run city:verify and investigate before replacing anything.')
    const check = checkAuthoritativeCity({ flags: { canonical: city.canonical, origin: city.origin, activationRehearsal: city.activation_rehearsal }, state: city.state, properties: [] })
    if (check.mode !== 'demo-fixture' || check.violations.length > 0)
      throw new GenesisError('inconsistent', `The city's state fails ${check.violations.length} invariant(s) (${check.violations[0]?.detail ?? 'unknown mode'}). Investigate before replacing anything.`)
    await onStep?.('verified')

    // Events first: they reference the city.
    await client.query('DELETE FROM city_events WHERE city_id = $1', [CITY_ID])
    await onStep?.('events-removed')
    const removed = await client.query('DELETE FROM city WHERE id = $1 AND instance_id = $2', [CITY_ID, city.instance_id])
    if (removed.rowCount !== 1) throw new GenesisError('inconsistent', 'The city changed while it was locked. Nothing was changed.')
    await onStep?.('city-removed')

    const replaced = { instance: city.instance_id, sequence, events: events.length }
    const meta = await insertCity(client, { ...install, eventExtra: { replaced } })
    if (!meta) throw new GenesisError('inconsistent', 'A city appeared while the fixture was being replaced. Nothing was changed.')
    await onStep?.('installed')

    await client.query('COMMIT')
    return { replaced, city: meta }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------

export const GENESIS_COMMANDS = ['canonical', 'rehearsal', 'replace-staging-fixture'] as const
export type GenesisCommand = (typeof GENESIS_COMMANDS)[number]
const FLAGS = ['--confirm-city', '--confirm-environment', '--confirm-reset', '--expect-instance', '--expect-sequence'] as const
type Flag = (typeof FLAGS)[number]
/** The options each command takes. One meant for another command is an error, not something to skip over. */
const COMMAND_FLAGS: Record<GenesisCommand, readonly Flag[]> = {
  canonical: ['--confirm-city', '--confirm-environment'],
  rehearsal: ['--confirm-city', '--confirm-environment'],
  'replace-staging-fixture': FLAGS,
}

/** `--flag value` pairs. Anything unrecognised, repeated, missing its value or not for this command is an error, never ignored. */
export function parseGenesisArgs(argv: readonly string[]): { command: GenesisCommand; flags: Partial<Record<Flag, string>> } | { error: string } {
  const [command, ...rest] = argv
  if (!(GENESIS_COMMANDS as readonly string[]).includes(command ?? '')) return { error: command ? `Unknown command "${command}".` : 'No command given.' }
  const flags: Partial<Record<Flag, string>> = {}
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i] as Flag
    const value = rest[i + 1]
    if (!(FLAGS as readonly string[]).includes(name)) return { error: `Unknown option "${rest[i]}".` }
    if (!COMMAND_FLAGS[command as GenesisCommand].includes(name)) return { error: `${name} is not an option of "${command}".` }
    if (value === undefined || value.startsWith('--')) return { error: `${name} needs a value.` }
    if (name in flags) return { error: `${name} was given twice.` }
    flags[name] = value
  }
  return { command: command as GenesisCommand, flags }
}
