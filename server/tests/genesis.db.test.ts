import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSeedState } from '../../src/game/seed'
import { GenesisError, installCanonicalGenesis, installRehearsalGenesis, parseGenesisArgs, replaceStagingFixtureWithRehearsal, type ResetStep, type StagingResetRequest } from '../src/city/genesis'
import { createCityReader, initializeCity } from '../src/city/store'
import { verifyCity } from '../src/city/verify'
import type { AppMode } from '../src/config'
import { migrate } from '../src/db/migrations'
import { createGenesisState, type GameState } from '../src/engine'
import { installDemoFixture } from '../src/fixtures/demoCity'
import { activate, addIdentity, addIntent, advance, unguarded } from './activationFixtures'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'
import { resolveTestDatabase } from './testDb'

const ROOT = resolve(import.meta.dirname, '../..')
const CONFIRMED = { confirmCity: 'main' }

describe('genesis command line', () => {
  it('parses a command and its options, and refuses anything unexpected', () => {
    expect(parseGenesisArgs(['canonical', '--confirm-city', 'main', '--confirm-environment', 'production'])).toEqual({ command: 'canonical', flags: { '--confirm-city': 'main', '--confirm-environment': 'production' } })
    expect(parseGenesisArgs(['replace-staging-fixture', '--expect-instance', 'x', '--expect-sequence', '1'])).toMatchObject({ command: 'replace-staging-fixture' })
    expect(parseGenesisArgs([])).toEqual({ error: 'No command given.' })
    expect(parseGenesisArgs(['reset'])).toEqual({ error: 'Unknown command "reset".' })
    expect(parseGenesisArgs(['canonical', '--force'])).toEqual({ error: 'Unknown option "--force".' })
    expect(parseGenesisArgs(['canonical', '--confirm-city'])).toEqual({ error: '--confirm-city needs a value.' })
    expect(parseGenesisArgs(['canonical', '--confirm-city', '--confirm-environment'])).toEqual({ error: '--confirm-city needs a value.' })
    expect(parseGenesisArgs(['canonical', '--confirm-city', 'main', '--confirm-city', 'main'])).toEqual({ error: '--confirm-city was given twice.' })
    expect(parseGenesisArgs(['canonical', 'main'])).toEqual({ error: 'Unknown option "main".' })
    // An option that belongs to another command is refused, not skipped over.
    for (const command of ['canonical', 'rehearsal'])
      for (const [flag, value] of [['--confirm-reset', 'replace-demo-fixture'], ['--expect-instance', 'x'], ['--expect-sequence', '1']])
        expect(parseGenesisArgs([command, '--confirm-city', 'main', flag, value]), `${command} ${flag}`).toEqual({ error: `${flag} is not an option of "${command}".` })
  })
})

describe.skipIf(NO_TEST_DATABASE)('genesis against a disposable Postgres', () => {
  const t = useTestSchema()
  const setup = (environment: AppMode) => migrate(t.db, { dir: MIGRATIONS_DIR, environment })
  const count = async (table: string) => (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n
  const cityRow = async () => (await t.db.query('SELECT id, instance_id, sequence, canonical, origin, activation_rehearsal, state::text AS state FROM city')).rows[0]
  const events = async () => (await t.db.query('SELECT sequence, type, payload FROM city_events ORDER BY sequence')).rows
  const refusal = async (work: Promise<unknown>) => {
    const err = await work.then(
      () => null,
      (e: unknown) => e,
    )
    if (!(err instanceof GenesisError)) throw new Error(`expected a GenesisError, got ${String(err)}`)
    return err.reason
  }

  describe('createGenesisState in the database', () => {
    it('round-trips exactly and serves as a valid, empty city', async () => {
      await setup('staging')
      await installRehearsalGenesis(t.db, { mode: 'staging', ...CONFIRMED, confirmEnvironment: 'staging' })
      const row = await cityRow()
      expect(row.state).toBe(JSON.stringify(createGenesisState()))
      const record = (await createCityReader(t.db).read())!
      const state = record.state as GameState
      expect([Object.keys(state.users).length, Object.keys(state.buildings).length, Object.keys(state.wallets).length]).toEqual([0, 0, 0])
      expect(record.meta).toMatchObject({ sequence: 1, canonical: false, origin: 'demo-fixture', stateVersion: 5 })
    })
  })

  describe('canonical installer', () => {
    it('installs the canonical, empty city once: sequence 1 and exactly one city.initialized event', async () => {
      await setup('production')
      const meta = await installCanonicalGenesis(t.db, { mode: 'production', ...CONFIRMED, confirmEnvironment: 'production' })
      expect(meta).toMatchObject({ id: 'main', sequence: 1, canonical: true, origin: 'genesis', stateVersion: 5 })
      expect(await cityRow()).toMatchObject({ canonical: true, origin: 'genesis', activation_rehearsal: false, sequence: '1', state: JSON.stringify(createGenesisState()) })
      expect(await events()).toEqual([{ sequence: '1', type: 'city.initialized', payload: { origin: 'genesis', canonical: true, stateVersion: 5, environment: 'production' } }])
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, city: { mode: 'canonical' }, counts: { buildings: 0, users: 0, events: 1, properties: 0 } })
      // Never twice.
      expect(await refusal(installCanonicalGenesis(t.db, { mode: 'production', ...CONFIRMED, confirmEnvironment: 'production' }))).toBe('already-initialized')
      expect(await count('city_events')).toBe(1)
      expect((await cityRow()).instance_id).toBe(meta.instance)
    })

    it('refuses local and staging processes, whatever the database', async () => {
      await setup('production')
      for (const mode of ['local', 'staging'] as const) expect(await refusal(installCanonicalGenesis(t.db, { mode, ...CONFIRMED, confirmEnvironment: 'production' })), mode).toBe('wrong-mode')
      expect(await count('city')).toBe(0)
    })

    it('refuses a database that is not stamped production', async () => {
      await setup('staging')
      expect(await refusal(installCanonicalGenesis(t.db, { mode: 'production', ...CONFIRMED, confirmEnvironment: 'production' }))).toBe('wrong-environment')
      await t.db.query(`UPDATE app_meta SET value = 'local' WHERE key = 'environment'`)
      expect(await refusal(installCanonicalGenesis(t.db, { mode: 'production', ...CONFIRMED, confirmEnvironment: 'production' }))).toBe('wrong-environment')
      expect(await count('city')).toBe(0)
    })

    it('refuses without both explicit confirmations', async () => {
      await setup('production')
      const attempts: Partial<{ confirmCity: string; confirmEnvironment: string }>[] = [{}, { confirmCity: 'main' }, { confirmEnvironment: 'production' }, { confirmCity: 'Main', confirmEnvironment: 'production' }, { confirmCity: 'main', confirmEnvironment: 'staging' }, { confirmCity: 'main', confirmEnvironment: 'prod' }, { confirmCity: 'other', confirmEnvironment: 'production' }]
      for (const a of attempts) expect(await refusal(installCanonicalGenesis(t.db, { mode: 'production', confirmCity: a.confirmCity, confirmEnvironment: a.confirmEnvironment })), JSON.stringify(a)).toBe('confirmation')
      expect(await count('city')).toBe(0)
    })
  })

  describe('rehearsal installer', () => {
    it('installs an empty, non-canonical rehearsal city: sequence 1 and exactly one city.initialized event', async () => {
      await setup('staging')
      const meta = await installRehearsalGenesis(t.db, { mode: 'staging', ...CONFIRMED, confirmEnvironment: 'staging' })
      expect(meta).toMatchObject({ id: 'main', sequence: 1, canonical: false, origin: 'demo-fixture' })
      expect(await cityRow()).toMatchObject({ canonical: false, origin: 'demo-fixture', activation_rehearsal: true, sequence: '1' })
      expect(await events()).toEqual([{ sequence: '1', type: 'city.initialized', payload: { origin: 'demo-fixture', canonical: false, stateVersion: 5, environment: 'staging', activationRehearsal: true } }])
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, city: { mode: 'rehearsal' }, counts: { buildings: 0, properties: 0, events: 1 } })
      expect(await refusal(installRehearsalGenesis(t.db, { mode: 'staging', ...CONFIRMED, confirmEnvironment: 'staging' }))).toBe('already-initialized')
    })

    it('refuses local and production processes, and a database not stamped staging', async () => {
      await setup('staging')
      for (const mode of ['local', 'production'] as const) expect(await refusal(installRehearsalGenesis(t.db, { mode, ...CONFIRMED, confirmEnvironment: 'staging' })), mode).toBe('wrong-mode')
      await t.db.query(`UPDATE app_meta SET value = 'local' WHERE key = 'environment'`)
      expect(await refusal(installRehearsalGenesis(t.db, { mode: 'staging', ...CONFIRMED, confirmEnvironment: 'staging' }))).toBe('wrong-environment')
      await t.db.query(`UPDATE app_meta SET value = 'production' WHERE key = 'environment'`)
      expect(await refusal(installRehearsalGenesis(t.db, { mode: 'staging', ...CONFIRMED, confirmEnvironment: 'staging' }))).toBe('wrong-environment')
      expect(await count('city')).toBe(0)
    })

    it('refuses without confirmations, and never replaces an existing fixture', async () => {
      await setup('staging')
      expect(await refusal(installRehearsalGenesis(t.db, { mode: 'staging', confirmCity: 'main', confirmEnvironment: 'production' }))).toBe('confirmation')
      expect(await refusal(installRehearsalGenesis(t.db, { mode: 'staging', confirmCity: undefined, confirmEnvironment: 'staging' }))).toBe('confirmation')
      const fixture = await installDemoFixture(t.db, 'staging')
      expect(await refusal(installRehearsalGenesis(t.db, { mode: 'staging', ...CONFIRMED, confirmEnvironment: 'staging' }))).toBe('already-initialized')
      expect(await cityRow()).toMatchObject({ instance_id: fixture.instance, activation_rehearsal: false })
    })

    it('the store refuses a rehearsal or fixture that already has buildings as an activatable city', async () => {
      await setup('staging')
      // A city that may hold real properties must start with none: the 180-building seed is refused as a rehearsal.
      await expect(initializeCity(t.db, { state: createSeedState(), origin: 'demo-fixture', rehearsal: true, environment: 'staging' })).rejects.toMatchObject({ reason: 'invalid-state' })
      expect(await count('city')).toBe(0)
    })
  })

  describe('staging rehearsal reset', () => {
    /** A staging database holding the ordinary demo fixture, and a request that names it correctly. */
    async function fixture(): Promise<StagingResetRequest> {
      await setup('staging')
      const meta = await installDemoFixture(t.db, 'staging')
      return { mode: 'staging', confirmCity: 'main', confirmEnvironment: 'staging', confirmReset: 'replace-demo-fixture', expectedInstance: meta.instance, expectedSequence: 1 }
    }
    const untouched = async (before: unknown, beforeEvents: unknown) => {
      expect(await cityRow()).toEqual(before)
      expect(await events()).toEqual(beforeEvents)
    }

    it('replaces an eligible fixture with a new, empty rehearsal city', async () => {
      const request = await fixture()
      const before = await cityRow()
      const result = await replaceStagingFixtureWithRehearsal(t.db, request)

      expect(result.replaced).toEqual({ instance: before.instance_id, sequence: 1, events: 1 })
      expect(result.city.instance).not.toBe(before.instance_id)
      expect(result.city).toMatchObject({ id: 'main', sequence: 1, canonical: false, origin: 'demo-fixture' })
      const after = await cityRow()
      expect(after).toMatchObject({ instance_id: result.city.instance, sequence: '1', canonical: false, origin: 'demo-fixture', activation_rehearsal: true, state: JSON.stringify(createGenesisState()) })
      // Exactly one event, and it says what was replaced.
      expect(await events()).toEqual([{ sequence: '1', type: 'city.initialized', payload: { origin: 'demo-fixture', canonical: false, stateVersion: 5, environment: 'staging', activationRehearsal: true, replaced: { instance: before.instance_id, sequence: 1, events: 1 } } }])
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, city: { mode: 'rehearsal', instance: result.city.instance }, counts: { buildings: 0, users: 0, events: 1, properties: 0, eras: 0, intents: 0 } })
      // The new city can hold a real property; the old one could not.
      await activate(t.db, { identity: await addIdentity(t.db), instance: result.city.instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 })
      expect((await verifyCity(t.db)).ok).toBe(true)
    })

    it('replaces a fixture that has moved on, when the operator names its real sequence', async () => {
      const request = await fixture()
      await advance(t.db, 'test.authority-change', { ...createSeedState(), clock: 3 })
      expect(await refusal(replaceStagingFixtureWithRehearsal(t.db, request))).toBe('sequence-mismatch')
      const result = await replaceStagingFixtureWithRehearsal(t.db, { ...request, expectedSequence: 2 })
      expect(result.replaced).toMatchObject({ sequence: 2, events: 2 })
      expect(await count('city_events')).toBe(1)
    })

    it('refuses without every confirmation, and changes nothing', async () => {
      const request = await fixture()
      const [before, beforeEvents] = [await cityRow(), await events()]
      const missing: Partial<StagingResetRequest>[] = [
        { confirmCity: undefined },
        { confirmCity: 'staging' },
        { confirmEnvironment: undefined },
        { confirmEnvironment: 'production' },
        { confirmReset: undefined },
        { confirmReset: 'yes' },
        { confirmReset: 'replace-demo-fixture ' },
        { expectedInstance: undefined },
        { expectedInstance: 'main' },
        { expectedSequence: undefined },
        { expectedSequence: 0 },
        { expectedSequence: 1.5 },
      ]
      for (const patch of missing) expect(await refusal(replaceStagingFixtureWithRehearsal(t.db, { ...request, ...patch })), JSON.stringify(patch)).toBe('confirmation')
      await untouched(before, beforeEvents)
    })

    it('refuses the wrong instance and the wrong sequence', async () => {
      const request = await fixture()
      const [before, beforeEvents] = [await cityRow(), await events()]
      expect(await refusal(replaceStagingFixtureWithRehearsal(t.db, { ...request, expectedInstance: '00000000-0000-4000-8000-000000000000' }))).toBe('instance-mismatch')
      for (const expectedSequence of [2, 99]) expect(await refusal(replaceStagingFixtureWithRehearsal(t.db, { ...request, expectedSequence }))).toBe('sequence-mismatch')
      await untouched(before, beforeEvents)
    })

    it('refuses when there is no city, and refuses a rehearsal city', async () => {
      await setup('staging')
      const request: StagingResetRequest = { mode: 'staging', confirmCity: 'main', confirmEnvironment: 'staging', confirmReset: 'replace-demo-fixture', expectedInstance: '00000000-0000-4000-8000-000000000000', expectedSequence: 1 }
      expect(await refusal(replaceStagingFixtureWithRehearsal(t.db, request))).toBe('no-city')
      const rehearsal = await installRehearsalGenesis(t.db, { mode: 'staging', ...CONFIRMED, confirmEnvironment: 'staging' })
      const [before, beforeEvents] = [await cityRow(), await events()]
      // A rehearsal city is never replaced by this command, even an empty one named correctly.
      expect(await refusal(replaceStagingFixtureWithRehearsal(t.db, { ...request, expectedInstance: rehearsal.instance }))).toBe('not-a-plain-fixture')
      await untouched(before, beforeEvents)
    })

    it('refuses a canonical city and can never run against a production database', async () => {
      await setup('production')
      const canonical = await installCanonicalGenesis(t.db, { mode: 'production', ...CONFIRMED, confirmEnvironment: 'production' })
      const [before, beforeEvents] = [await cityRow(), await events()]
      const request: StagingResetRequest = { mode: 'staging', confirmCity: 'main', confirmEnvironment: 'staging', confirmReset: 'replace-demo-fixture', expectedInstance: canonical.instance, expectedSequence: 1 }
      // A staging process pointed at the production database.
      expect(await refusal(replaceStagingFixtureWithRehearsal(t.db, request))).toBe('wrong-environment')
      // A production process.
      expect(await refusal(replaceStagingFixtureWithRehearsal(t.db, { ...request, mode: 'production', confirmEnvironment: 'production' }))).toBe('wrong-mode')
      expect(await refusal(replaceStagingFixtureWithRehearsal(t.db, { ...request, mode: 'production' }))).toBe('wrong-mode')
      expect(await refusal(replaceStagingFixtureWithRehearsal(t.db, { ...request, mode: 'local' }))).toBe('wrong-mode')
      await untouched(before, beforeEvents)
      // And if every check in the command were bypassed, the database itself refuses each removal.
      await expect(t.db.query('DELETE FROM city_events')).rejects.toThrow('a production event cannot be removed')
      await expect(t.db.query('DELETE FROM city')).rejects.toThrow(/a production city cannot be removed|foreign key/)
      await untouched(before, beforeEvents)

      // The command's own canonical check, reached directly: a canonical city inside a staging database, which
      // only switching the database guards off can produce, is still not something this command replaces.
      await t.db.query(`DROP SCHEMA ${t.schema} CASCADE; CREATE SCHEMA ${t.schema}`)
      await setup('staging')
      await unguarded(t.db, async () => {
        await t.db.query(`INSERT INTO city (id, canonical, origin, state_version, sequence, state) VALUES ('main', true, 'genesis', 5, 1, $1::json)`, [JSON.stringify(createGenesisState())])
        await t.db.query(`INSERT INTO city_events (city_id, sequence, type) VALUES ('main', 1, 'city.initialized')`)
      })
      const misplaced = await cityRow()
      expect(await refusal(replaceStagingFixtureWithRehearsal(t.db, { ...request, expectedInstance: misplaced.instance_id }))).toBe('not-a-plain-fixture')
      expect(await cityRow()).toEqual(misplaced)
    })

    it('refuses a city with properties, ownership eras or activation intents', async () => {
      const request = await fixture()
      // A fixture holding a real property: a state the database guards make unreachable, built with them switched off.
      const identity = await addIdentity(t.db)
      const done = await unguarded(t.db, () => activate(t.db, { identity, instance: request.expectedInstance!, tokenId: 20_812, familyId: 2, ward: 1, plot: 0 }))
      const [before, beforeEvents] = [await cityRow(), await events()]
      const err = await replaceStagingFixtureWithRehearsal(t.db, { ...request, expectedSequence: 2 }).catch((e: unknown) => e as GenesisError)
      expect(err).toMatchObject({ reason: 'has-activation-history' })
      expect((err as GenesisError).message).toContain('1 properties, 1 ownership eras, 1 activation intents')
      await untouched(before, beforeEvents)
      expect([await count('properties'), await count('ownership_eras'), await count('activation_intents')]).toEqual([1, 1, 1])
      expect((await t.db.query('SELECT status FROM activation_intents WHERE id = $1', [done.intentId])).rows).toEqual([{ status: 'committed' }])
    })

    it('refuses on an activation intent alone, whatever its status', async () => {
      for (const status of ['issued', 'superseded'] as const) {
        await t.db.query(`DROP SCHEMA ${t.schema} CASCADE; CREATE SCHEMA ${t.schema}`)
        const request = await fixture()
        const identity = await addIdentity(t.db)
        const id = await unguarded(t.db, () => addIntent(t.db, { identity, instance: request.expectedInstance!, tokenId: 20_812, familyId: 2, ward: 1, plot: 0 }))
        if (status === 'superseded') await t.db.query(`UPDATE activation_intents SET status = 'superseded' WHERE id = $1`, [id])
        const [before, beforeEvents] = [await cityRow(), await events()]
        expect(await refusal(replaceStagingFixtureWithRehearsal(t.db, request)), status).toBe('has-activation-history')
        await untouched(before, beforeEvents)
      }
    })

    it('refuses a city whose history records an activation, even with no rows left to show for it', async () => {
      const request = await fixture()
      await advance(t.db, 'property.activated')
      const [before, beforeEvents] = [await cityRow(), await events()]
      expect(await refusal(replaceStagingFixtureWithRehearsal(t.db, { ...request, expectedSequence: 2 }))).toBe('has-activation-history')
      await untouched(before, beforeEvents)
    })

    it('refuses a city that is not internally consistent', async () => {
      const request = await fixture()
      // A sequence its events do not account for: the city moved on and no event says why.
      await t.db.query('UPDATE city SET sequence = sequence + 1')
      expect(await refusal(replaceStagingFixtureWithRehearsal(t.db, { ...request, expectedSequence: 2 }))).toBe('inconsistent')
      await t.db.query(`INSERT INTO city_events (city_id, sequence, type) VALUES ('main', 2, 'test.explained')`)
      // A state that fails the authoritative invariants: two buildings on one plot.
      const broken = createSeedState()
      broken.buildings['b-812'].plot = broken.buildings['b-4471'].plot
      broken.buildings['b-812'].districtId = broken.buildings['b-4471'].districtId
      await advance(t.db, 'test.corruption', broken)
      const [before, beforeEvents] = [await cityRow(), await events()]
      expect(await refusal(replaceStagingFixtureWithRehearsal(t.db, { ...request, expectedSequence: 3 }))).toBe('inconsistent')
      await untouched(before, beforeEvents)
    })

    it('rolls everything back when it fails at any step', async () => {
      const request = await fixture()
      const [before, beforeEvents] = [await cityRow(), await events()]
      for (const step of ['verified', 'events-removed', 'city-removed', 'installed'] as const) {
        const seen: ResetStep[] = []
        await expect(
          replaceStagingFixtureWithRehearsal(t.db, request, (at) => {
            seen.push(at)
            if (at === step) throw new Error(`injected failure at ${step}`)
          }),
        ).rejects.toThrow(`injected failure at ${step}`)
        expect(seen.at(-1)).toBe(step)
        await untouched(before, beforeEvents)
        expect((await verifyCity(t.db)).ok, step).toBe(true)
      }
      // A database-level failure half-way is rolled back the same way.
      await t.db.query(`ALTER TABLE city ADD CONSTRAINT test_no_rehearsal CHECK (NOT activation_rehearsal)`)
      await expect(replaceStagingFixtureWithRehearsal(t.db, request)).rejects.toThrow(/test_no_rehearsal/)
      await untouched(before, beforeEvents)
    })

    it('lets exactly one of several concurrent resets through', async () => {
      const request = await fixture()
      const results = await Promise.allSettled([1, 2, 3, 4].map(() => replaceStagingFixtureWithRehearsal(t.db, request)))
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      // The losers waited on the city lock; when they get it, the city they named is gone.
      for (const r of results) if (r.status === 'rejected') expect(['no-city', 'instance-mismatch']).toContain((r.reason as GenesisError).reason)
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(3)
      expect([await count('city'), await count('city_events')]).toEqual([1, 1])
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, city: { mode: 'rehearsal' } })
    })
  })

  describe('operator commands', () => {
    const target = resolveTestDatabase(process.env)
    /** Run a built-from-source command against this test's schema, the way an operator would. */
    function run(script: string, args: string[], env: Record<string, string>) {
      const url = new URL('url' in target ? target.url : 'postgres://unused')
      url.searchParams.set('options', `-c search_path=${t.schema}`)
      const result = spawnSync(resolve(ROOT, 'node_modules/.bin/tsx'), [resolve(ROOT, script), ...args], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', DATABASE_URL: url.toString(), ...env } })
      return { status: result.status, out: `${result.stdout}${result.stderr}` }
    }
    const STAGING = { APP_MODE: 'staging', PUBLIC_ORIGIN: 'https://rarecity.example', TRUSTED_PROXY: 'none' }

    it('city:genesis explains itself and refuses the wrong environment without touching the database', async () => {
      await setup('staging')
      const help = run('server/src/genesis-cli.ts', ['--help'], {})
      expect(help.status).toBe(0)
      for (const text of ['canonical --confirm-city main --confirm-environment production', 'rehearsal --confirm-city main --confirm-environment staging', 'replace-staging-fixture', 'STAGING ONLY, DESTRUCTIVE', 'Never run by a deploy']) expect(help.out).toContain(text)
      expect(run('server/src/genesis-cli.ts', [], {}).status).toBe(1)

      const local = run('server/src/genesis-cli.ts', ['canonical', '--confirm-city', 'main', '--confirm-environment', 'production'], { APP_MODE: 'local' })
      expect([local.status, local.out]).toEqual([1, expect.stringContaining('"reason":"wrong-mode"')])
      const staging = run('server/src/genesis-cli.ts', ['canonical', '--confirm-city', 'main', '--confirm-environment', 'production'], STAGING)
      expect([staging.status, staging.out]).toEqual([1, expect.stringContaining('Canonical genesis requires APP_MODE=production')])
      const unconfirmed = run('server/src/genesis-cli.ts', ['rehearsal'], STAGING)
      expect([unconfirmed.status, unconfirmed.out]).toEqual([1, expect.stringContaining('"reason":"confirmation"')])
      const typo = run('server/src/genesis-cli.ts', ['rehearsal', '--confirm-city', 'main', '--confirm-enviroment', 'staging'], STAGING)
      expect([typo.status, typo.out]).toEqual([1, expect.stringContaining('Unknown option')])
      expect(await count('city')).toBe(0)
    }, 60_000)

    it('city:genesis installs a rehearsal city and replaces a fixture, and city:verify reports each', async () => {
      await setup('staging')
      const empty = run('server/src/verify-cli.ts', [], STAGING)
      expect([empty.status, empty.out]).toEqual([1, expect.stringContaining('"category":"city"')])

      const meta = await installDemoFixture(t.db, 'staging')
      const fixture = run('server/src/verify-cli.ts', [], STAGING)
      expect(fixture.status).toBe(0)
      expect(fixture.out).toContain('"message":"city verified"')
      expect(fixture.out).toContain('"cityMode":"demo-fixture"')
      expect(fixture.out).toContain('"buildings":180')

      const refused = run('server/src/genesis-cli.ts', ['rehearsal', '--confirm-city', 'main', '--confirm-environment', 'staging'], STAGING)
      expect([refused.status, refused.out]).toEqual([1, expect.stringContaining('"reason":"already-initialized"')])
      const wrong = run('server/src/genesis-cli.ts', ['replace-staging-fixture', '--confirm-city', 'main', '--confirm-environment', 'staging', '--confirm-reset', 'replace-demo-fixture', '--expect-instance', meta.instance, '--expect-sequence', '2'], STAGING)
      expect([wrong.status, wrong.out]).toEqual([1, expect.stringContaining('"reason":"sequence-mismatch"')])
      expect((await cityRow()).instance_id).toBe(meta.instance)

      const replaced = run('server/src/genesis-cli.ts', ['replace-staging-fixture', '--confirm-city', 'main', '--confirm-environment', 'staging', '--confirm-reset', 'replace-demo-fixture', '--expect-instance', meta.instance, '--expect-sequence', '1'], STAGING)
      expect(replaced.status).toBe(0)
      expect(replaced.out).toContain('staging demo fixture REPLACED by a NON-CANONICAL activation rehearsal city')
      expect(await cityRow()).toMatchObject({ activation_rehearsal: true, sequence: '1', state: JSON.stringify(createGenesisState()) })
      const rehearsal = run('server/src/verify-cli.ts', [], STAGING)
      expect(rehearsal.status).toBe(0)
      expect(rehearsal.out).toContain('"cityMode":"rehearsal"')
      expect(rehearsal.out).toContain('"buildings":0')

      // A corrupted city is reported by category, with a failing exit code.
      await t.db.query('UPDATE city SET sequence = sequence + 1')
      const broken = run('server/src/verify-cli.ts', [], STAGING)
      expect(broken.status).toBe(1)
      expect(broken.out).toContain('"category":"events"')
      expect(broken.out).toContain('city verification FAILED')
      // No database to ask is a different failure from an invalid city.
      const unreachable = spawnSync(resolve(ROOT, 'node_modules/.bin/tsx'), [resolve(ROOT, 'server/src/verify-cli.ts')], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...STAGING, DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/rarecity_test' } })
      expect(unreachable.status).toBe(2)
      expect(`${unreachable.stdout}${unreachable.stderr}`).not.toContain('nothing@')
    }, 120_000)
  })
})
