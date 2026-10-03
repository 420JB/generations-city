import { describe, expect, it } from 'vitest'
import { createSeedState } from '../../src/game/seed'
import { initializeCity } from '../src/city/store'
import { verifyCity, type VerifyCategory } from '../src/city/verify'
import type { AppMode } from '../src/config'
import type { Database } from '../src/db/pool'
import { migrate } from '../src/db/migrations'
import { createGenesisState, type GameState } from '../src/engine'
import { installDemoFixture } from '../src/fixtures/demoCity'
import { activate, addIdentity, addIntent, advance, snapshot, unguarded } from './activationFixtures'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'

describe.skipIf(NO_TEST_DATABASE)('city:verify against a disposable Postgres', () => {
  const t = useTestSchema()
  const setup = (environment: AppMode = 'staging') => migrate(t.db, { dir: MIGRATIONS_DIR, environment })

  /** Write a wrong state the way a bug in a writer would: as an ordinary authoritative change, with its event. */
  async function corrupt(change: (state: GameState) => void) {
    const state = (await t.db.query<{ state: GameState }>('SELECT state FROM city')).rows[0].state
    change(state)
    await advance(t.db, 'test.corruption', state)
  }
  const failing = async () => {
    const report = await verifyCity(t.db)
    expect(report.ok).toBe(false)
    return { categories: [...new Set(report.violations.map((v) => v.category))].sort() as VerifyCategory[], rules: [...new Set(report.violations.map((v) => v.rule))].sort() }
  }
  /** A rehearsal city with three real activations in it. */
  async function rehearsalWithProperties() {
    await setup('staging')
    const meta = await initializeCity(t.db, { state: createGenesisState(), origin: 'demo-fixture', rehearsal: true, environment: 'staging' })
    const a = await activate(t.db, { identity: await addIdentity(t.db), instance: meta.instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 })
    const b = await activate(t.db, { identity: await addIdentity(t.db), instance: meta.instance, tokenId: 77, familyId: 5, ward: 0, plot: 0 })
    const c = await activate(t.db, { identity: await addIdentity(t.db), instance: meta.instance, tokenId: 4471, familyId: 7, ward: 0, plot: 11 })
    return { meta, a, b, c }
  }

  describe('valid cities', () => {
    it('accepts the ordinary demo fixture as a demo fixture, without property rows', async () => {
      await setup('staging')
      const meta = await installDemoFixture(t.db, 'staging')
      expect(await verifyCity(t.db)).toEqual({
        ok: true,
        city: { id: 'main', instance: meta.instance, sequence: 1, stateVersion: 5, canonical: false, origin: 'demo-fixture', activationRehearsal: false, mode: 'demo-fixture' },
        counts: { buildings: 180, users: 57, events: 1, properties: 0, eras: 0, openEras: 0, intents: 0, committedIntents: 0 },
        violations: [],
      })
    })

    it('accepts an empty rehearsal city and an empty canonical city with zero properties', async () => {
      await setup('staging')
      await initializeCity(t.db, { state: createGenesisState(), origin: 'demo-fixture', rehearsal: true, environment: 'staging' })
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, city: { mode: 'rehearsal', activationRehearsal: true }, counts: { buildings: 0, users: 0, properties: 0, events: 1 } })

      await t.db.query(`DROP SCHEMA ${t.schema} CASCADE; CREATE SCHEMA ${t.schema}`)
      await setup('production')
      await initializeCity(t.db, { state: createGenesisState(), origin: 'genesis', environment: 'production' })
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, city: { mode: 'canonical', canonical: true }, counts: { buildings: 0, properties: 0, events: 1 } })
    })

    it('accepts a rehearsal city whose buildings are exactly its properties', async () => {
      const { meta } = await rehearsalWithProperties()
      expect(await verifyCity(t.db)).toEqual({
        ok: true,
        city: { id: 'main', instance: meta.instance, sequence: 4, stateVersion: 5, canonical: false, origin: 'demo-fixture', activationRehearsal: true, mode: 'rehearsal' },
        counts: { buildings: 3, users: 3, events: 4, properties: 3, eras: 3, openEras: 3, intents: 3, committedIntents: 3 },
        violations: [],
      })
    })

    it('accepts a property between owners: the old era closed and none open yet', async () => {
      const { a } = await rehearsalWithProperties()
      await t.db.query(`UPDATE ownership_eras SET ended_at = started_at + interval '1 day', end_reason = 'transfer', end_block = start_block + 10 WHERE id = $1`, [a.eraId])
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, counts: { eras: 3, openEras: 2 } })
    })
  })

  describe('read-only', () => {
    it('reads everything in one read-only transaction and changes nothing', async () => {
      await rehearsalWithProperties()
      const tables = ['city', 'city_events', 'properties', 'ownership_eras', 'activation_intents', 'users', 'wallets', 'sessions']
      const before = await Promise.all(tables.map((table) => snapshot(t.db, table, '1')))
      const statements: string[] = []
      const recording = {
        query: t.db.query.bind(t.db),
        end: t.db.end.bind(t.db),
        async connect() {
          const client = await t.db.connect()
          const original = client.query.bind(client) as (...args: unknown[]) => unknown
          ;(client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
            statements.push(String(args[0]).replace(/\s+/g, ' ').trim())
            return original(...args)
          }
          return client
        },
      } as unknown as Database
      expect((await verifyCity(recording)).ok).toBe(true)
      expect(statements[0]).toBe('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      expect(statements.at(-1)).toBe('ROLLBACK')
      for (const sql of statements.slice(1, -1)) expect(sql, sql).toMatch(/^SELECT /)
      expect(await Promise.all(tables.map((table) => snapshot(t.db, table, '1')))).toEqual(before)
      // The transaction really is read-only: a write inside one like it is refused by Postgres.
      const client = await t.db.connect()
      try {
        await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        await expect(client.query('UPDATE city SET sequence = sequence')).rejects.toThrow(/read-only transaction/)
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    })
  })

  describe('catches a corrupted city, by category', () => {
    it('no city at all', async () => {
      await setup('staging')
      expect(await verifyCity(t.db)).toMatchObject({ ok: false, city: null, violations: [{ category: 'city', rule: 'not-initialized' }] })
    })

    it('a demo fixture whose state breaks its own rules', async () => {
      await setup('staging')
      await installDemoFixture(t.db, 'staging')
      await corrupt((s) => {
        s.buildings['b-812'].plot = s.buildings['b-4471'].plot
        s.buildings['b-812'].districtId = s.buildings['b-4471'].districtId
      })
      expect(await failing()).toEqual({ categories: ['buildings'], rules: ['plot-unique'] })
    })

    it('state corruptions in a rehearsal city: each is named', async () => {
      const cases: [string, (s: GameState) => void, string][] = [
        ['a building filed under the wrong key', (s) => { s.buildings['b-999'] = s.buildings['b-812']; delete s.buildings['b-812'] }, 'building-key'],
        ['a building whose id does not match its Friend', (s) => { s.buildings['b-812'].friendId = 813 }, 'building-id'],
        ['an invalid district', (s) => { ;(s.buildings['b-812'] as { districtId: string }).districtId = 'd12' }, 'district'],
        ['a ward that is not open', (s) => { s.buildings['b-812'].ward = 4 }, 'ward-open'],
        ['a plot beyond its ward', (s) => { s.buildings['b-812'].plot = 5_000 }, 'plot-capacity'],
        ['an owner who is not a user', (s) => { s.buildings['b-812'].ownerId = 'nobody' }, 'owner-user'],
        ['a district with no open ward', (s) => { s.wards.d4 = 0 }, 'wards'],
      ]
      for (const [name, change, rule] of cases) {
        await t.db.query(`DROP SCHEMA ${t.schema} CASCADE; CREATE SCHEMA ${t.schema}`)
        await rehearsalWithProperties()
        await corrupt(change)
        expect((await failing()).rules, name).toContain(rule)
      }
    })

    it('a property without a building, and a building without a property', async () => {
      await rehearsalWithProperties()
      await corrupt((s) => { delete s.buildings['b-812'] })
      expect(await failing()).toMatchObject({ categories: ['properties'], rules: ['count', 'property-without-building'] })

      await t.db.query(`DROP SCHEMA ${t.schema} CASCADE; CREATE SCHEMA ${t.schema}`)
      await rehearsalWithProperties()
      await corrupt((s) => {
        s.buildings['b-555'] = { ...s.buildings['b-812'], id: 'b-555', friendId: 555, plot: 20 }
      })
      expect(await failing()).toMatchObject({ categories: ['properties'], rules: ['building-without-property', 'count'] })
    })

    it('a property and its building that disagree about the plot, the district or the Friend', async () => {
      await rehearsalWithProperties()
      await corrupt((s) => { s.buildings['b-812'].plot = 9 })
      expect(await failing()).toEqual({ categories: ['properties'], rules: ['plot-mismatch'] })
      await corrupt((s) => { s.buildings['b-812'].plot = 3; s.buildings['b-812'].districtId = 'd5' })
      expect(await failing()).toEqual({ categories: ['properties'], rules: ['district-mismatch'] })
      await corrupt((s) => {
        s.buildings['b-812'].districtId = 'd4'
        // Two buildings swapped under each other's keys: every key still has a building, but not its own.
        const [a, b] = [s.buildings['b-812'], s.buildings['b-77']]
        s.buildings['b-812'] = b
        s.buildings['b-77'] = a
      })
      const swapped = await failing()
      // Each key now holds the other owner's building, so the owner no longer matches the open era either.
      expect(swapped.categories).toEqual(['buildings', 'eras', 'properties'])
      expect(swapped.rules).toEqual(expect.arrayContaining(['building-key', 'token-mismatch', 'district-mismatch', 'owner-parity']))
    })

    it('a sequence its events do not account for', async () => {
      await rehearsalWithProperties()
      await t.db.query('UPDATE city SET sequence = sequence + 1')
      expect(await failing()).toEqual({ categories: ['events'], rules: ['sequence'] })
      await t.db.query(`INSERT INTO city_events (city_id, sequence, type) VALUES ('main', 5, 'property.activated')`)
      // Now the count matches, but an activation is recorded that created no property.
      expect(await failing()).toEqual({ categories: ['events'], rules: ['activation-events'] })
    })

    it('an ordinary fixture that holds activation records', async () => {
      await setup('staging')
      const meta = await installDemoFixture(t.db, 'staging')
      // The database guards make both of these unreachable; they are built with the guards switched off.
      const [a, b] = [await addIdentity(t.db), await addIdentity(t.db)]
      await unguarded(t.db, () => addIntent(t.db, { identity: a, instance: meta.instance, tokenId: 20_812, familyId: 2, ward: 1, plot: 0 }))
      expect(await failing()).toEqual({ categories: ['intents'], rules: ['fixture-has-intents'] })
      await unguarded(t.db, () => activate(t.db, { identity: b, instance: meta.instance, tokenId: 20_900, familyId: 2, ward: 1, plot: 1 }))
      const report = await failing()
      expect(report.categories).toEqual(['intents', 'properties'])
      expect(report.rules).toContain('fixture-has-properties')
    })

    it('a seeded fixture relabelled as a rehearsal: 180 buildings with no properties', async () => {
      await setup('staging')
      await installDemoFixture(t.db, 'staging')
      await unguarded(t.db, () => t.db.query('UPDATE city SET activation_rehearsal = true'))
      const report = await verifyCity(t.db)
      expect(report.ok).toBe(false)
      expect(report.city).toMatchObject({ mode: 'rehearsal' })
      // A demo city carries a simulated wallet too, which a city that may hold real properties never does.
      expect(report.violations.slice(0, 2)).toMatchObject([{ category: 'state', rule: 'simulated-wallet' }, { category: 'properties', rule: 'count', detail: '0 properties but 180 buildings' }])
      expect(report.violations.length).toBe(100)
    })

    it('ownership eras whose wallet is not their owner', async () => {
      const { a } = await rehearsalWithProperties()
      const wallet = (await t.db.query<{ owner_wallet_id: string }>('SELECT owner_wallet_id FROM ownership_eras WHERE id = $1', [a.eraId])).rows[0].owner_wallet_id
      // A wallet row re-pointed at another address: the database guards refuse this, so it is done with them off.
      await unguarded(t.db, () => t.db.query(`UPDATE wallets SET address = '0x${'cd'.repeat(20)}' WHERE id = $1`, [wallet]))
      expect(await failing()).toEqual({ categories: ['eras'], rules: ['owner-wallet'] })
      await unguarded(t.db, () => t.db.query(`UPDATE wallets SET address = (SELECT owner_address FROM ownership_eras WHERE id = $2) WHERE id = $1`, [wallet, a.eraId]))
      expect((await verifyCity(t.db)).ok).toBe(true)
      // The wallet handed to another user, which the database does allow, is the same fault.
      const other = await addIdentity(t.db)
      await t.db.query(`UPDATE wallets SET user_id = $2 WHERE id = $1`, [wallet, other.userId])
      expect(await failing()).toEqual({ categories: ['eras'], rules: ['owner-wallet'] })
    })

    it('a building whose owner in the city state is not its property\'s current owner', async () => {
      const { a, b } = await rehearsalWithProperties()
      const owners = async () => (await t.db.query<{ building_id: string; owner_user_id: string }>('SELECT p.building_id, e.owner_user_id FROM properties p JOIN ownership_eras e ON e.property_id = p.id ORDER BY p.activated_sequence')).rows
      const [alice, bob] = await owners()
      // Alice activated b-812. The state is rewritten to say it is Bob's.
      await corrupt((s) => { s.buildings[alice.building_id].ownerId = bob.owner_user_id })
      const report = await verifyCity(t.db)
      expect(report.ok).toBe(false)
      expect(report.violations).toEqual([expect.objectContaining({ category: 'eras', rule: 'owner-parity' })])
      expect(report.violations[0].detail).toContain(alice.owner_user_id)
      // Between owners there is no current owner to disagree with: the building keeps whoever it shows.
      await t.db.query(`UPDATE ownership_eras SET ended_at = started_at + interval '1 day', end_reason = 'transfer', end_block = start_block + 10 WHERE id = $1`, [a.eraId])
      expect((await verifyCity(t.db)).ok).toBe(true)
      expect(b.buildingId).toBe(bob.building_id)
    })

    it('simulated RF, or a user who is nobody, in a city that may hold real properties', async () => {
      await rehearsalWithProperties()
      await corrupt((s) => {
        s.users.ghost = { id: 'ghost', handle: 'ghost', friendId: 1, hue: 0 }
        s.wallets.ghost = 1_000_000_000_000_000
      })
      expect(await failing()).toEqual({ categories: ['state'], rules: ['simulated-wallet'] })
    })

    it('a stored state the build cannot even read', async () => {
      await setup('staging')
      // The database refuses a rehearsal city without an empty buildings object; with the guards off it does not.
      await unguarded(t.db, async () => {
        await t.db.query(`INSERT INTO city (id, canonical, origin, activation_rehearsal, state_version, sequence, state) VALUES ('main', false, 'demo-fixture', true, 5, 1, '{"version":5,"clock":0}'::json)`)
        await t.db.query(`INSERT INTO city_events (city_id, sequence, type) VALUES ('main', 1, 'city.initialized')`)
      })
      const report = await failing()
      expect(report).toEqual({ categories: ['state'], rules: ['collection', 'counter'] })
    })
  })

  it('the seed and the genesis state are what these tests think they are', () => {
    expect(Object.keys(createSeedState().buildings)).toHaveLength(180)
    expect(Object.keys(createGenesisState().buildings)).toHaveLength(0)
  })
})
