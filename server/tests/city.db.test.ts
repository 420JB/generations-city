import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createSeedState } from '../../src/game/seed'
import { createApp } from '../src/app'
import { CITY_ID, CityInitError, createCityReader, initializeCity } from '../src/city/store'
import type { AppMode } from '../src/config'
import { migrate } from '../src/db/migrations'
import { parseCityResponse, type GameState } from '../src/engine'
import { installDemoFixture } from '../src/fixtures/demoCity'
import { silentLogger } from '../src/log'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'
import { testConfig } from './testConfig'

/** An empty city: the shape canonical genesis will have (no residents, nothing held). */
function emptyCity(): GameState {
  const seed = createSeedState()
  const vacant = { holder: null, sinceClock: 0 }
  return {
    ...seed,
    users: {},
    buildings: {},
    wallets: {},
    monuments: Object.fromEntries(Object.keys(seed.monuments).map((m) => [m, vacant])) as GameState['monuments'],
    monumentHistory: Object.fromEntries(Object.keys(seed.monumentHistory).map((m) => [m, []])) as unknown as GameState['monumentHistory'],
    capital: vacant,
    capitalHistory: [],
    crown: vacant,
    crownHistory: [],
    badges: {},
    counters: {},
    radio: [],
    season: { ...seed.season, representatives: {}, activity: {}, joinedClock: {} },
  }
}

describe.skipIf(NO_TEST_DATABASE)('shared city against a disposable Postgres', () => {
  const t = useTestSchema()
  const setup = (environment: AppMode = 'staging') => migrate(t.db, { dir: MIGRATIONS_DIR, environment })
  const count = async (table: string) => (await t.db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number

  const servers: Server[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  })
  async function serve(mode: AppMode): Promise<string> {
    const config = testConfig({ mode, databaseUrl: 'postgres://unused' })
    const server = createServer(createApp({ config, db: t.db, migrationsDir: MIGRATIONS_DIR, log: silentLogger, city: createCityReader(t.db) }))
    servers.push(server)
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  describe('migration 0002', () => {
    it('creates the city structures and no city', async () => {
      await setup()
      expect(await t.tables()).toEqual(expect.arrayContaining(['city', 'city_events']))
      expect(await count('city')).toBe(0)
      expect(await count('city_events')).toBe(0)
      const reader = createCityReader(t.db)
      expect(await reader.meta()).toBeNull()
      expect(await reader.read()).toBeNull()
    })

    it('rejects malformed rows at the database', async () => {
      await setup()
      const insert = (o: { canonical?: boolean; origin?: string; version?: number; sequence?: number; state?: string }) =>
        t.db.query(`INSERT INTO city (id, canonical, origin, state_version, sequence, state) VALUES ('x', $1, $2, $3, $4, $5::json)`, [
          o.canonical ?? false,
          o.origin ?? 'demo-fixture',
          o.version ?? 5,
          o.sequence ?? 1,
          o.state ?? '{"version":5}',
        ])
      await expect(insert({ origin: 'made-up' })).rejects.toThrow(/city_origin_known/)
      await expect(insert({ canonical: true, origin: 'demo-fixture' })).rejects.toThrow(/city_canonical_is_genesis/)
      await expect(insert({ canonical: false, origin: 'genesis' })).rejects.toThrow(/city_canonical_is_genesis/)
      await expect(insert({ sequence: 0 })).rejects.toThrow(/city_sequence_positive/)
      await expect(insert({ state: '[1,2]' })).rejects.toThrow(/city_state_is_object/)
      await expect(insert({ state: '{"version":4}' })).rejects.toThrow(/city_state_version_matches/)
      await expect(insert({ state: '{"version":"5"}' })).rejects.toThrow(/city_state_version_matches/)
      await expect(insert({ state: '{}' })).rejects.toThrow(/city_state_version_matches/)
      await expect(insert({ state: '{not json' })).rejects.toThrow(/invalid input syntax for type json/)
      expect(await count('city')).toBe(0)
      // An event cannot exist without its city, and a sequence cannot be recorded twice.
      await expect(t.db.query(`INSERT INTO city_events (city_id, sequence, type) VALUES ('ghost', 1, 'x')`)).rejects.toThrow(/foreign key/)
    })
  })

  describe('initialisation', () => {
    it('installs a city at sequence 1 with its first event, in one step', async () => {
      await setup()
      const state = createSeedState()
      const meta = await initializeCity(t.db, { state, origin: 'demo-fixture', environment: 'staging' })
      expect(meta).toMatchObject({ id: CITY_ID, sequence: 1, stateVersion: state.version, canonical: false, origin: 'demo-fixture' })
      expect(meta.instance).toMatch(/^[0-9a-f-]{36}$/)
      const events = (await t.db.query('SELECT city_id, sequence, type, payload FROM city_events')).rows
      expect(events).toEqual([{ city_id: CITY_ID, sequence: '1', type: 'city.initialized', payload: { origin: 'demo-fixture', canonical: false, stateVersion: state.version, environment: 'staging' } }])
    })

    it('round-trips the state exactly, key order included', async () => {
      await setup()
      const state = createSeedState()
      await initializeCity(t.db, { state, origin: 'demo-fixture', environment: 'staging' })
      const record = (await createCityReader(t.db).read())!
      expect(JSON.stringify(record.state)).toBe(JSON.stringify(state))
      expect(Object.keys((record.state as GameState).buildings)).toEqual(Object.keys(state.buildings))
      const raw = (await t.db.query('SELECT state::text AS text FROM city')).rows[0].text
      expect(raw).toBe(JSON.stringify(state))
    })

    it('reads deterministically: the same row gives the same meta and state every time', async () => {
      await setup()
      await installDemoFixture(t.db, 'staging')
      const reader = createCityReader(t.db)
      const [a, b, m] = [await reader.read(), await reader.read(), await reader.meta()]
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
      expect(a!.meta).toEqual(m)
    })

    it('never overwrites: a second install is refused and changes nothing', async () => {
      await setup()
      const first = await installDemoFixture(t.db, 'staging')
      const changed = { ...createSeedState(), clock: 999 }
      await expect(initializeCity(t.db, { state: changed, origin: 'demo-fixture', environment: 'staging' })).rejects.toMatchObject({ name: 'CityInitError', reason: 'already-initialized' })
      await expect(installDemoFixture(t.db, 'staging')).rejects.toBeInstanceOf(CityInitError)
      const record = (await createCityReader(t.db).read())!
      expect(record.meta).toEqual(first)
      expect((record.state as GameState).clock).toBe(0)
      expect(await count('city_events')).toBe(1)
    })

    it('lets exactly one of several concurrent installers win', async () => {
      await setup()
      const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => installDemoFixture(t.db, 'staging')))
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ reason: 'already-initialized' })
      expect(await count('city')).toBe(1)
      expect(await count('city_events')).toBe(1)
    })

    it('leaves nothing behind when the install fails part-way', async () => {
      await setup()
      // Make the event insert fail after the city insert succeeded.
      await t.db.query(`ALTER TABLE city_events ADD CONSTRAINT test_block CHECK (type <> 'city.initialized')`)
      await expect(installDemoFixture(t.db, 'staging')).rejects.toThrow(/test_block/)
      expect(await count('city')).toBe(0)
      expect(await count('city_events')).toBe(0)
    })

    it('refuses a state that is not a city state', async () => {
      await setup()
      await expect(initializeCity(t.db, { state: { version: 5 } as GameState, origin: 'demo-fixture', environment: 'staging' })).rejects.toMatchObject({ reason: 'invalid-state' })
      expect(await count('city')).toBe(0)
    })
  })

  describe('environment protection', () => {
    it('refuses a database stamped for another environment', async () => {
      await setup('staging')
      await expect(installDemoFixture(t.db, 'local')).rejects.toMatchObject({ reason: 'wrong-environment' })
      await expect(initializeCity(t.db, { state: emptyCity(), origin: 'genesis', environment: 'production' })).rejects.toMatchObject({ reason: 'wrong-environment' })
      expect(await count('city')).toBe(0)
    })

    it('refuses a database that has not been stamped at all', async () => {
      await setup('staging')
      await t.db.query(`DELETE FROM app_meta WHERE key = 'environment'`)
      await expect(installDemoFixture(t.db, 'staging')).rejects.toMatchObject({ reason: 'wrong-environment' })
    })
  })

  describe('genesis / fixture boundary', () => {
    it('the demo fixture is non-canonical and is refused outright in production mode', async () => {
      await setup('production')
      await expect(installDemoFixture(t.db, 'production')).rejects.toMatchObject({ reason: 'fixture-in-production' })
      await expect(initializeCity(t.db, { state: createSeedState(), origin: 'demo-fixture', environment: 'production' })).rejects.toMatchObject({ reason: 'fixture-in-production' })
      expect(await count('city')).toBe(0)
    })

    it('a production database rejects a non-canonical city even from raw SQL', async () => {
      await setup('production')
      const state = JSON.stringify(createSeedState())
      const raw = (canonical: boolean, origin: string) => t.db.query(`INSERT INTO city (id, canonical, origin, state_version, sequence, state) VALUES ('main', $1, $2, 5, 1, $3::json)`, [canonical, origin, state])
      await expect(raw(false, 'demo-fixture')).rejects.toThrow('a production database cannot hold a non-canonical city')
      expect(await count('city')).toBe(0)
      // A canonical row is accepted, and cannot later be flipped to non-canonical either.
      await raw(true, 'genesis')
      await expect(t.db.query(`UPDATE city SET canonical = false, origin = 'demo-fixture'`)).rejects.toThrow('a production database cannot hold a non-canonical city')
    })

    it('a canonical city can only be genesis, and production accepts it', async () => {
      await setup('production')
      const meta = await initializeCity(t.db, { state: emptyCity(), origin: 'genesis', environment: 'production' })
      expect(meta).toMatchObject({ canonical: true, origin: 'genesis', sequence: 1 })
      const state = (await createCityReader(t.db).read())!.state as GameState
      expect(Object.keys(state.buildings)).toHaveLength(0)
      expect(Object.keys(state.users)).toHaveLength(0)
    })

    it('staging and local accept the fixture and label it non-canonical', async () => {
      await setup('local')
      expect(await installDemoFixture(t.db, 'local')).toMatchObject({ canonical: false, origin: 'demo-fixture' })
      const state = (await createCityReader(t.db).read())!.state as GameState
      expect(Object.keys(state.buildings)).toHaveLength(180)
    })
  })

  describe('GET /v1/city over the real database', () => {
    it('is 503 city_not_initialized until a city is installed', async () => {
      await setup()
      const res = await fetch(`${await serve('staging')}/v1/city`)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'city_not_initialized' })
    })

    it('is 503, not a crash, before migrations have run', async () => {
      const res = await fetch(`${await serve('staging')}/v1/city`)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'city_unavailable' })
    })

    it('serves exactly the stored city to an anonymous viewer', async () => {
      await setup()
      const meta = await installDemoFixture(t.db, 'staging')
      const res = await fetch(`${await serve('staging')}/v1/city`)
      expect(res.status).toBe(200)
      expect(res.headers.get('etag')).toBe(`"${meta.instance}.1"`)
      const body: unknown = await res.json()
      const parsed = parseCityResponse(body)
      if (!parsed.ok) throw new Error(parsed.reason)
      expect(parsed.response.city).toEqual(meta)
      expect(body).not.toHaveProperty('viewer')
      expect(parsed.response.server).toEqual({ mode: 'staging' })
      expect(JSON.stringify(parsed.response.state)).toBe(JSON.stringify(createSeedState()))
    })

    it('follows the sequence: a new sequence is a new ETag and the new state', async () => {
      await setup()
      await installDemoFixture(t.db, 'staging')
      const base = await serve('staging')
      const first = await fetch(`${base}/v1/city`)
      const etag = first.headers.get('etag')!
      expect((await fetch(`${base}/v1/city`, { headers: { 'if-none-match': etag } })).status).toBe(304)
      // What a later command will do: change the state and advance the sequence together.
      await t.db.query(`UPDATE city SET sequence = sequence + 1, state = (jsonb_set(state::jsonb, '{clock}', '7'))::json, updated_at = now()`)
      const next = await fetch(`${base}/v1/city`, { headers: { 'if-none-match': etag } })
      expect(next.status).toBe(200)
      expect(next.headers.get('etag')).not.toBe(etag)
      const body = (await next.json()) as { city: { sequence: number }; state: { clock: number } }
      expect(body.city.sequence).toBe(2)
      expect(body.state.clock).toBe(7)
    })

    it('refuses to serve a stored state that fails validation or has another version', async () => {
      await setup()
      await t.db.query(`INSERT INTO city (id, canonical, origin, state_version, sequence, state) VALUES ('main', false, 'demo-fixture', 5, 1, '{"version":5,"clock":0}'::json)`)
      const base = await serve('staging')
      let res = await fetch(`${base}/v1/city`)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'city_state_invalid' })
      await t.db.query(`UPDATE city SET state_version = 4, sequence = 2, state = '{"version":4}'::json`)
      res = await fetch(`${base}/v1/city`)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'city_state_unsupported' })
    })
  })
})
