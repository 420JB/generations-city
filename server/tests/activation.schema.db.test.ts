import { randomBytes, randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSeedState } from '../../src/game/seed'
import { createAuthService } from '../src/auth/service'
import { CITY_ID, initializeCity } from '../src/city/store'
import type { AppMode } from '../src/config'
import { loadMigrations, migrate } from '../src/db/migrations'
import { createGenesisState, FAMILY_DISTRICTS } from '../src/engine'
import { activate, addIdentity, addIntent, advance, CHAIN_ID, COLLECTION, insertRow, INTENT_TTL_MS, intentColumns, propertyColumns, snapshot, unguarded, type Identity } from './activationFixtures'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'

const GUARDS = ['rc_database_is_production', 'city_guard_canonical', 'city_guard_environment', 'app_meta_guard', 'city_events_guard', 'activation_intents_guard', 'properties_guard', 'properties_require_completion', 'ownership_eras_guard', 'wallets_guard', 'sessions_guard']

describe.skipIf(NO_TEST_DATABASE)('migration 0004: activation schema against a disposable Postgres', () => {
  const t = useTestSchema()
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  })
  const count = async (table: string) => (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n
  const versions = async () => (await t.db.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version)
  const fresh = () => t.db.query(`DROP SCHEMA ${t.schema} CASCADE; CREATE SCHEMA ${t.schema}`)
  const constraints = async (table: string, type: 'c' | 'u' | 'f') => (await t.db.query<{ conname: string }>(`SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = $2 ORDER BY conname`, [table, type])).rows.map((r) => r.conname)

  /** A copy of the shipped migrations up to and including `last`, optionally with 0004 replaced. */
  async function migrationsThrough(last: number, replace0004?: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'rc-activation-'))
    dirs.push(dir)
    for (const file of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()) {
      const version = Number(file.slice(0, 4))
      if (version > last) continue
      if (version === 4 && replace0004 !== undefined) await writeFile(join(dir, file), replace0004)
      else await copyFile(join(MIGRATIONS_DIR, file), join(dir, file))
    }
    return dir
  }

  /** A migrated database with an empty rehearsal city (staging) or the canonical city (production). */
  async function setup(environment: AppMode = 'staging'): Promise<{ instance: string; identity: Identity }> {
    await migrate(t.db, { dir: MIGRATIONS_DIR, environment })
    const meta = environment === 'production' ? await initializeCity(t.db, { state: createGenesisState(), origin: 'genesis', environment }) : await initializeCity(t.db, { state: createGenesisState(), origin: 'demo-fixture', rehearsal: true, environment })
    return { instance: meta.instance, identity: await addIdentity(t.db) }
  }

  describe('applying the migration', () => {
    it('builds a fresh database 0001 -> 0004 with the activation tables and no rows', async () => {
      const result = await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      expect(result).toEqual({ applied: [1, 2, 3, 4], current: 4 })
      expect(await t.tables()).toEqual(['activation_intents', 'app_meta', 'auth_challenges', 'city', 'city_events', 'ownership_eras', 'properties', 'schema_migrations', 'sessions', 'users', 'wallets'])
      for (const table of ['city', 'city_events', 'activation_intents', 'properties', 'ownership_eras']) expect(await count(table), table).toBe(0)
      expect((await loadMigrations(MIGRATIONS_DIR)).map((m) => `${m.version}:${m.name}`)).toEqual(['1:foundation', '2:city', '3:identity', '4:activation'])
    })

    it('upgrades a populated P0-C database and leaves its city and identity rows exactly as they were', async () => {
      // A database as staging holds it: migrations 1-3, the demo fixture at sequence 1, people who have signed in.
      await migrate(t.db, { dir: await migrationsThrough(3), environment: 'staging' })
      const state = JSON.stringify(createSeedState())
      await t.db.query(`INSERT INTO city (id, canonical, origin, state_version, sequence, state) VALUES ('main', false, 'demo-fixture', 5, 1, $1::json)`, [state])
      await t.db.query(`INSERT INTO city_events (city_id, sequence, type, payload) VALUES ('main', 1, 'city.initialized', '{"origin":"demo-fixture","canonical":false,"stateVersion":5,"environment":"staging"}')`)
      const identity = await addIdentity(t.db)
      await t.db.query(`INSERT INTO auth_challenges (nonce, chain_id, address, message, issued_at, expires_at) VALUES ($1, 4663, $2, 'sign me', now(), now() + interval '5 minutes')`, ['a'.repeat(32), identity.address])

      const columns = 'id, instance_id, canonical, origin, state_version, sequence, state::text AS state, created_at, updated_at'
      const before = {
        city: JSON.stringify((await t.db.query(`SELECT ${columns} FROM city`)).rows),
        meta: await snapshot(t.db, 'app_meta', 'key'),
        events: await snapshot(t.db, 'city_events', 'sequence'),
        users: await snapshot(t.db, 'users', 'id'),
        wallets: await snapshot(t.db, 'wallets', 'id'),
        sessions: await snapshot(t.db, 'sessions', 'id'),
        challenges: await snapshot(t.db, 'auth_challenges', 'nonce'),
      }

      const result = await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      expect(result).toEqual({ applied: [4], current: 4 })
      expect(JSON.stringify((await t.db.query(`SELECT ${columns} FROM city`)).rows)).toBe(before.city)
      expect(await snapshot(t.db, 'app_meta', 'key')).toBe(before.meta)
      expect(await snapshot(t.db, 'city_events', 'sequence')).toBe(before.events)
      expect(await snapshot(t.db, 'users', 'id')).toBe(before.users)
      expect(await snapshot(t.db, 'wallets', 'id')).toBe(before.wallets)
      expect(await snapshot(t.db, 'sessions', 'id')).toBe(before.sessions)
      expect(await snapshot(t.db, 'auth_challenges', 'nonce')).toBe(before.challenges)
      // The existing city is an ordinary fixture, not a rehearsal, and its stored state is byte-identical.
      const city = (await t.db.query('SELECT activation_rehearsal, state::text AS state FROM city')).rows[0]
      expect(city).toEqual({ activation_rehearsal: false, state })
      for (const table of ['activation_intents', 'properties', 'ownership_eras']) expect(await count(table), table).toBe(0)
      // Running it again changes nothing.
      expect((await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })).applied).toEqual([])
      // What is already live keeps working on the upgraded database: a wallet signs in again, a session is
      // revoked and later deleted, and the city still changes.
      expect((await t.db.query('UPDATE wallets SET last_verified_at = now() WHERE id = $1', [identity.walletId])).rowCount).toBe(1)
      expect((await t.db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [identity.sessionId])).rowCount).toBe(1)
      expect((await t.db.query('DELETE FROM sessions')).rowCount).toBe(1)
      expect(await advance(t.db, 'test.authority-change', { ...createSeedState(), clock: 1 })).toBe(2)
    })

    it('leaves nothing behind when the migration fails part-way', async () => {
      await migrate(t.db, { dir: await migrationsThrough(3), environment: 'staging' })
      const tablesBefore = await t.tables()
      const real = (await readFile(join(MIGRATIONS_DIR, '0004_activation.sql'), 'utf8')).replace(/\r\n/g, '\n')
      const broken = await migrationsThrough(4, `${real}\nINSERT INTO does_not_exist VALUES (1);\n`)
      await expect(migrate(t.db, { dir: broken, environment: 'staging' })).rejects.toThrow(/Migration 4 \(activation\) failed and was rolled back/)
      expect(await versions()).toEqual([1, 2, 3])
      expect(await t.tables()).toEqual(tablesBefore)
      const cityColumns = (await t.db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'city'`, [t.schema])).rows.map((r) => r.column_name)
      expect(cityColumns).not.toContain('activation_rehearsal')
      const functions = async () => (await t.db.query<{ proname: string; config: string[] | null }>(`SELECT p.proname, p.proconfig AS config FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = $1 AND p.proname = ANY($2) ORDER BY p.proname`, [t.schema, GUARDS])).rows
      // Only the guard that 0002 created exists, and the failed run did not leave it altered.
      expect(await functions()).toEqual([{ proname: 'city_guard_canonical', config: null }])
      // The real migration then applies cleanly on the same database.
      expect((await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })).applied).toEqual([4])
      expect((await functions()).map((f) => f.proname)).toEqual([...GUARDS].sort())
    })
  })

  describe('the guards cannot be switched off from a session', () => {
    it('pins every guard function to its own schema, with temporary tables searched last', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'production' })
      const rows = (await t.db.query<{ proname: string; config: string[] }>(`SELECT p.proname, p.proconfig AS config FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = $1 AND p.proname = ANY($2) ORDER BY p.proname`, [t.schema, GUARDS])).rows
      expect(rows.map((r) => r.proname)).toEqual([...GUARDS].sort())
      for (const r of rows) expect(r.config, r.proname).toEqual([`search_path=${t.schema}, pg_temp`])
    })

    it('a temporary table named like a guarded table changes nothing', async () => {
      const { instance, identity } = await setup('production')
      const done = await activate(t.db, { identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 })
      const client = await t.db.connect()
      try {
        // One session, which is all an attacker with arbitrary SQL has: shadow every table a guard reads.
        await client.query('CREATE TEMP TABLE app_meta (key text, value text)')
        await client.query('CREATE TEMP TABLE city (LIKE city)')
        await client.query('CREATE TEMP TABLE city_events (LIKE city_events)')
        await client.query('CREATE TEMP TABLE activation_intents (LIKE activation_intents)')
        const real = (table: string) => `${t.schema}.${table}`
        await expect(client.query(`DELETE FROM ${real('ownership_eras')}`)).rejects.toThrow('ownership history is permanent: an era cannot be removed')
        await expect(client.query(`DELETE FROM ${real('properties')}`)).rejects.toThrow('a property is permanent: it cannot be removed')
        await expect(client.query(`DELETE FROM ${real('city_events')}`)).rejects.toThrow('a production event cannot be removed')
        await expect(client.query(`DELETE FROM ${real('activation_intents')} WHERE id = $1`, [done.intentId])).rejects.toThrow('a committed activation intent is permanent')
        await expect(client.query(`DELETE FROM ${real('city')}`)).rejects.toThrow(/a production city cannot be removed|foreign key/)
        await expect(client.query(`UPDATE ${real('app_meta')} SET value = 'staging' WHERE key = 'environment'`)).rejects.toThrow('a production database stays a production database')
        await expect(client.query(`INSERT INTO ${real('city')} (id, canonical, origin, state_version, sequence, state) VALUES ('other', false, 'demo-fixture', 5, 1, '{"version":5}'::json)`)).rejects.toThrow('a production database cannot hold a non-canonical city')
      } finally {
        for (const table of ['app_meta', 'city', 'city_events', 'activation_intents']) await client.query(`DROP TABLE IF EXISTS pg_temp.${table}`)
        client.release()
      }
      expect([await count('city'), await count('city_events'), await count('properties'), await count('ownership_eras'), await count('activation_intents')]).toEqual([1, 2, 1, 1, 1])
    })

    it('the production stamp cannot be changed or removed, and a database with a fixture cannot become production', async () => {
      await setup('production')
      await expect(t.db.query(`UPDATE app_meta SET value = 'staging' WHERE key = 'environment'`)).rejects.toThrow('a production database stays a production database: its environment stamp is permanent')
      await expect(t.db.query(`UPDATE app_meta SET key = 'was-environment' WHERE key = 'environment'`)).rejects.toThrow('a production database stays a production database')
      await expect(t.db.query(`DELETE FROM app_meta WHERE key = 'environment'`)).rejects.toThrow('a production database stays a production database')
      await expect(t.db.query('DELETE FROM app_meta')).rejects.toThrow('a production database stays a production database')
      expect((await t.db.query(`SELECT value FROM app_meta WHERE key = 'environment'`)).rows).toEqual([{ value: 'production' }])
      // Other facts about the database are ordinary rows.
      await t.db.query(`INSERT INTO app_meta (key, value) VALUES ('note', 'x')`)
      await t.db.query(`UPDATE app_meta SET value = 'y' WHERE key = 'note'`)
      await t.db.query(`DELETE FROM app_meta WHERE key = 'note'`)

      await fresh()
      await setup('staging')
      for (const sql of [`UPDATE app_meta SET value = 'production' WHERE key = 'environment'`, `INSERT INTO app_meta (key, value) VALUES ('environment', 'production') ON CONFLICT (key) DO UPDATE SET value = 'production'`])
        await expect(t.db.query(sql), sql).rejects.toThrow('a database that holds a non-canonical city cannot become a production database')
      await t.db.query(`DELETE FROM app_meta WHERE key = 'environment'`)
      await expect(t.db.query(`INSERT INTO app_meta (key, value) VALUES ('environment', 'production')`)).rejects.toThrow('a database that holds a non-canonical city cannot become a production database')
    })
  })

  describe('city: canonical, fixture or rehearsal, and nothing else', () => {
    const insertCity = (o: { canonical: boolean; origin: string; rehearsal: boolean; state?: string }) =>
      t.db.query(`INSERT INTO city (id, canonical, origin, activation_rehearsal, state_version, sequence, state) VALUES ('main', $1, $2, $3, 5, 1, $4::json)`, [o.canonical, o.origin, o.rehearsal, o.state ?? '{"version":5,"buildings":{}}'])
    const SEEDED = JSON.stringify(createSeedState())

    it('staging accepts an ordinary fixture or an empty rehearsal, and nothing canonical', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      await expect(insertCity({ canonical: true, origin: 'genesis', rehearsal: false })).rejects.toThrow('only a production database can hold a canonical city')
      await expect(insertCity({ canonical: true, origin: 'genesis', rehearsal: true })).rejects.toThrow('only a production database can hold a canonical city')
      await expect(insertCity({ canonical: false, origin: 'genesis', rehearsal: true })).rejects.toThrow(/city_canonical_is_genesis/)
      // A rehearsal must start empty: the seeded demo city cannot be one.
      await expect(insertCity({ canonical: false, origin: 'demo-fixture', rehearsal: true, state: SEEDED })).rejects.toThrow('a city that may hold properties must start with no buildings')
      await insertCity({ canonical: false, origin: 'demo-fixture', rehearsal: true })
      expect((await t.db.query('SELECT canonical, origin, activation_rehearsal FROM city')).rows).toEqual([{ canonical: false, origin: 'demo-fixture', activation_rehearsal: true }])

      await fresh()
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      await insertCity({ canonical: false, origin: 'demo-fixture', rehearsal: false, state: SEEDED })
      await expect(t.db.query(`UPDATE city SET activation_rehearsal = NULL`)).rejects.toThrow(/null value|cannot change/)
    })

    it('production accepts only the canonical, empty, non-rehearsal city', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'production' })
      await expect(insertCity({ canonical: true, origin: 'genesis', rehearsal: true })).rejects.toThrow(/city_rehearsal_is_disposable/)
      await expect(insertCity({ canonical: false, origin: 'demo-fixture', rehearsal: true })).rejects.toThrow('a production database cannot hold a non-canonical city')
      await expect(insertCity({ canonical: false, origin: 'demo-fixture', rehearsal: false })).rejects.toThrow('a production database cannot hold a non-canonical city')
      await expect(insertCity({ canonical: true, origin: 'genesis', rehearsal: false, state: SEEDED })).rejects.toThrow('a city that may hold properties must start with no buildings')
      await insertCity({ canonical: true, origin: 'genesis', rehearsal: false })
      await expect(t.db.query(`DELETE FROM city`)).rejects.toThrow('a production city cannot be removed')
      expect(await count('city')).toBe(1)
    })

    it('what a city is never changes after it is installed', async () => {
      for (const environment of ['staging', 'production'] as const) {
        await fresh()
        await migrate(t.db, { dir: MIGRATIONS_DIR, environment })
        await insertCity(environment === 'production' ? { canonical: true, origin: 'genesis', rehearsal: false } : { canonical: false, origin: 'demo-fixture', rehearsal: false, state: SEEDED })
        const before = await snapshot(t.db, 'city', 'id')
        const changes = [`activation_rehearsal = NOT activation_rehearsal`, `instance_id = gen_random_uuid()`, `id = 'other'`]
        for (const set of changes) await expect(t.db.query(`UPDATE city SET ${set}`), `${environment}: ${set}`).rejects.toThrow(/what a city is cannot change|city_rehearsal_is_disposable|a production database cannot hold/)
        expect(await snapshot(t.db, 'city', 'id')).toBe(before)
      }
      // The fixture -> rehearsal flip, specifically: a populated fixture can never be relabelled as activatable.
      await fresh()
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      await insertCity({ canonical: false, origin: 'demo-fixture', rehearsal: false, state: SEEDED })
      await expect(t.db.query('UPDATE city SET activation_rehearsal = true')).rejects.toThrow('what a city is cannot change: its id, installation, canonical flag, origin and rehearsal flag are permanent')
    })

    it('is installed at sequence 1, and as an activatable city only with an empty buildings object', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      await expect(t.db.query(`INSERT INTO city (id, canonical, origin, state_version, sequence, state) VALUES ('main', false, 'demo-fixture', 5, 50, '{"version":5}'::json)`)).rejects.toThrow('a city is installed at sequence 1')
      for (const buildings of ['[1]', '"x"', 'null', '{"b-1":{}}'])
        await expect(insertCity({ canonical: false, origin: 'demo-fixture', rehearsal: true, state: `{"version":5,"buildings":${buildings}}` }), buildings).rejects.toThrow('a city that may hold properties must start with no buildings')
      await expect(insertCity({ canonical: false, origin: 'demo-fixture', rehearsal: true, state: '{"version":5}' })).rejects.toThrow('a city that may hold properties must start with no buildings')
      expect(await count('city')).toBe(0)
    })

    it('a sequence moves forward one step at a time, and the state only changes with it', async () => {
      await setup('staging')
      const state = JSON.stringify({ ...createGenesisState(), clock: 1 })
      await expect(t.db.query('UPDATE city SET state = $1::json', [state])).rejects.toThrow('a city state only changes together with its sequence')
      await expect(t.db.query('UPDATE city SET sequence = sequence + 2, state = $1::json', [state])).rejects.toThrow('a city sequence moves forward one step at a time')
      await expect(t.db.query('UPDATE city SET sequence = 0')).rejects.toThrow(/one step at a time|city_sequence_positive/)
      expect(await advance(t.db, 'test.change', { ...createGenesisState(), clock: 1 })).toBe(2)
      await expect(t.db.query('UPDATE city SET sequence = 1, state = $1::json', [JSON.stringify(createGenesisState())])).rejects.toThrow('a city sequence moves forward one step at a time')
      // Touching the row without changing anything authoritative is not a change.
      await t.db.query('UPDATE city SET updated_at = now()')
      expect((await t.db.query('SELECT sequence FROM city')).rows).toEqual([{ sequence: '2' }])
    })

    it('a canonical city cannot be installed outside production, by the store or by raw SQL', async () => {
      for (const environment of ['staging', 'local'] as const) {
        await fresh()
        await migrate(t.db, { dir: MIGRATIONS_DIR, environment })
        await expect(initializeCity(t.db, { state: createGenesisState(), origin: 'genesis', environment })).rejects.toMatchObject({ reason: 'canonical-outside-production' })
        await expect(insertCity({ canonical: true, origin: 'genesis', rehearsal: false })).rejects.toThrow('only a production database can hold a canonical city')
        expect(await count('city')).toBe(0)
      }
    })
  })

  describe('wallets and sessions: what intents and eras rely on does not move', () => {
    it('a wallet keeps its address and chain; a session keeps its owner, credential and lifetime, and stays revoked', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const [alice, bob] = [await addIdentity(t.db), await addIdentity(t.db)]
      const before = [await snapshot(t.db, 'wallets', 'id'), await snapshot(t.db, 'sessions', 'id')]
      for (const set of [`address = '0x${'cd'.repeat(20)}'`, `address = '${bob.address}'`, 'chain_id = 1', 'id = gen_random_uuid()'])
        await expect(t.db.query(`UPDATE wallets SET ${set} WHERE id = $1`, [alice.walletId]), set).rejects.toThrow(/a wallet is one address on one chain|wallets_chain_address_unique/)
      for (const set of [`user_id = '${bob.userId}'`, `wallet_id = '${bob.walletId}'`, `user_id = '${bob.userId}', wallet_id = '${bob.walletId}'`, 'id = gen_random_uuid()'])
        await expect(t.db.query(`UPDATE sessions SET ${set} WHERE id = $1`, [alice.sessionId]), set).rejects.toThrow('a session belongs to the user and wallet that opened it')
      for (const set of [`expires_at = expires_at + interval '1 day'`, `expires_at = now() - interval '1 second', created_at = now() - interval '1 day'`, `created_at = created_at - interval '1 day'`, `token_hash = decode('${'ab'.repeat(32)}', 'hex')`])
        await expect(t.db.query(`UPDATE sessions SET ${set} WHERE id = $1`, [alice.sessionId]), set).rejects.toThrow('a session keeps the credential and the lifetime it was opened with')
      expect([await snapshot(t.db, 'wallets', 'id'), await snapshot(t.db, 'sessions', 'id')]).toEqual(before)

      // Exactly the statements the sign-in service issues.
      expect((await t.db.query('UPDATE wallets SET last_verified_at = now() WHERE chain_id = 4663 AND address = $1 RETURNING id', [alice.address])).rowCount).toBe(1)
      expect((await t.db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [alice.sessionId])).rowCount).toBe(1)
      // Revoked is final: it cannot be cleared or moved, and revoking again is a no-op.
      for (const set of ['revoked_at = NULL', `revoked_at = now() + interval '1 hour'`]) await expect(t.db.query(`UPDATE sessions SET ${set} WHERE id = $1`, [alice.sessionId]), set).rejects.toThrow('a revoked session stays revoked')
      expect((await t.db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [alice.sessionId])).rowCount).toBe(0)
      expect((await t.db.query('DELETE FROM sessions WHERE id = ANY($1)', [[alice.sessionId, bob.sessionId]])).rowCount).toBe(2)
    })
  })

  describe('city_events: append-only', () => {
    it('never lets an event be changed, in any environment', async () => {
      for (const environment of ['staging', 'production'] as const) {
        await fresh()
        await setup(environment)
        for (const change of [`type = 'city.rewritten'`, `payload = '{}'`, 'sequence = 2', `created_at = now()`, 'type = type'])
          await expect(t.db.query(`UPDATE city_events SET ${change}`), `${environment}: ${change}`).rejects.toThrow('city_events is append-only: an event cannot be changed')
        await expect(t.db.query(`INSERT INTO city_events (city_id, sequence, type) VALUES ('main', 1, 'x') ON CONFLICT (city_id, sequence) DO UPDATE SET type = 'city.rewritten'`)).rejects.toThrow('city_events is append-only: an event cannot be changed')
        expect((await t.db.query('SELECT sequence, type FROM city_events')).rows).toEqual([{ sequence: '1', type: 'city.initialized' }])
      }
    })

    it('only accepts an event at the sequence its city has just reached', async () => {
      await setup('staging')
      for (const sequence of [2, 3, 999]) await expect(t.db.query(`INSERT INTO city_events (city_id, sequence, type) VALUES ('main', $1, 'test.ahead')`, [sequence]), String(sequence)).rejects.toThrow('a city event is appended at the sequence its city has just reached')
      expect(await advance(t.db, 'test.appended')).toBe(2)
      // Not behind it either, and never twice.
      await expect(t.db.query(`INSERT INTO city_events (city_id, sequence, type) VALUES ('main', 1, 'test.behind')`)).rejects.toThrow(/has just reached/)
      await expect(t.db.query(`INSERT INTO city_events (city_id, sequence, type) VALUES ('main', 2, 'test.again')`)).rejects.toThrow(/city_events_pkey|duplicate key/)
      // An event for a city that does not exist is still refused by the foreign key.
      await expect(t.db.query(`INSERT INTO city_events (city_id, sequence, type) VALUES ('ghost', 1, 'x')`)).rejects.toThrow(/foreign key/)
      expect((await t.db.query('SELECT sequence, type FROM city_events ORDER BY sequence')).rows).toEqual([{ sequence: '1', type: 'city.initialized' }, { sequence: '2', type: 'test.appended' }])
    })

    it('never lets a production event be removed', async () => {
      await setup('production')
      await expect(t.db.query('DELETE FROM city_events')).rejects.toThrow('city_events is append-only: a production event cannot be removed')
      await expect(t.db.query(`DELETE FROM city_events WHERE sequence = 1`)).rejects.toThrow('a production event cannot be removed')
      expect(await count('city_events')).toBe(1)
      // Appending is the one thing that is allowed.
      await advance(t.db, 'test.appended')
      expect(await count('city_events')).toBe(2)
    })

    it('lets a staging event be removed, which only the fixture replacement does', async () => {
      await setup('staging')
      expect((await t.db.query('DELETE FROM city_events')).rowCount).toBe(1)
      expect(await count('city_events')).toBe(0)
    })
  })

  describe('activation_intents', () => {
    it('accepts a well-formed issued intent and refuses every malformed one', async () => {
      const { instance, identity } = await setup()
      const other = await addIdentity(t.db)
      const base = { identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 }
      await addIntent(t.db, base)
      const attempt = (override: Record<string, unknown>) => addIntent(t.db, { ...base, tokenId: 813, plot: 4, override: { plot_id: 'd4-w0-p4', ...override } })

      const refused: [Record<string, unknown>, RegExp][] = [
        [{ id: 'A'.repeat(64) }, /ai_id_shape/],
        [{ id: 'ab' }, /ai_id_shape/],
        [{ collection: `0x${'1'.repeat(40)}` }, /ai_canonical_chain/],
        [{ collection: COLLECTION.replace('0x14c', '0x14C') }, /ai_canonical_chain/],
        [{ family_id: 9, district_id: 'd4' }, /ai_family_district/],
        [{ family_id: 2, district_id: 'd5', plot_id: 'd5-w0-p4' }, /ai_family_district/],
        [{ ward: -1, plot_id: 'd4-w-1-p4' }, /ai_plot_shape/],
        [{ plot_id: 'd4-w0-p5' }, /ai_plot_shape/],
        [{ plot_id: 'D4-W0-P4' }, /ai_plot_shape/],
        [{ plot_id: 'd4-w0-p4 ' }, /ai_plot_shape/],
        [{ origin: 'https://rarecity.example/path' }, /ai_origin_shape/],
        [{ origin: 'https://rarecity.example/' }, /ai_origin_shape/],
        [{ origin: 'https://RareCity.example' }, /ai_origin_shape/],
        [{ origin: 'https://user:pw@rarecity.example' }, /ai_origin_shape/],
        [{ origin: 'https://rarecity.example?x=1' }, /ai_origin_shape/],
        [{ origin: 'https://rare city.example' }, /ai_origin_shape/],
        [{ digest: randomBytes(31) }, /ai_digest_is_32/],
        [{ expires_at: new Date('2026-10-02T11:00:00.000Z') }, /ai_expiry_after_issue/],
        [{ issued_block: -1 }, /ai_block_nonnegative/],
        [{ signature: randomBytes(65) }, /ai_uncommitted_empty/],
        [{ committed_at: new Date(Date.now() + 1_000) }, /ai_uncommitted_empty/],
        [{ origin: 'https://:' }, /ai_origin_shape/],
        [{ origin: 'https://[' }, /ai_origin_shape/],
        [{ origin: 'https://-' }, /ai_origin_shape/],
        [{ origin: 'https://rarecity.example.' }, /ai_origin_shape/],
        [{ origin: 'https://a:b:c' }, /ai_origin_shape/],
        [{ origin: 'https://rarecity.example:999999' }, /ai_origin_shape/],
      ]
      for (const [override, error] of refused) await expect(attempt(override), JSON.stringify(Object.keys(override))).rejects.toThrow(error)

      // An intent begins as issued, by one user, through their own wallet and session.
      for (const status of ['committed', 'superseded', 'cancelled']) await expect(attempt({ status }), status).rejects.toThrow('an activation intent begins as issued')
      const mismatched: Record<string, unknown>[] = [{ user_id: other.userId }, { wallet_id: other.walletId }, { owner_address: other.address }, { owner_address: identity.address.toUpperCase().replace('0X', '0x') }, { chain_id: 1 }, { user_id: randomUUID() }]
      for (const override of mismatched) await expect(attempt(override), JSON.stringify(override)).rejects.toThrow('an activation intent is issued to one user through their own wallet')
      // A wallet, session or city that does not exist is refused by the guard itself, not left for the foreign key.
      await expect(attempt({ wallet_id: randomUUID() })).rejects.toThrow('an activation intent is issued to one user through their own wallet')
      await expect(attempt({ session_id: randomUUID() })).rejects.toThrow('an activation intent is issued in a session of the same user and wallet')
      for (const override of [{ city_instance_id: randomUUID() }, { city_id: 'other' }]) await expect(attempt(override), JSON.stringify(Object.keys(override))).rejects.toThrow('an activation intent can only be issued for a canonical or rehearsal city')
      expect(await count('activation_intents')).toBe(1)

      // The largest supported token id is accepted: it is still a safe integer in the city state.
      await addIntent(t.db, { ...base, tokenId: '9007199254740991', plot: 5 })
      // With the guard off, the table's own constraints still refuse a malformed row.
      await unguarded(t.db, async () => {
        await expect(attempt({ status: 'cancelled' })).rejects.toThrow(/ai_status_known/)
        await expect(attempt({ status: 'committed' })).rejects.toThrow(/ai_committed_shape/)
        await expect(attempt({ status: 'superseded', signature: randomBytes(65) })).rejects.toThrow(/ai_uncommitted_empty/)
        for (const origin of ['rarecity.example', 'ftp://rarecity.example', '//rarecity.example', 'http://rarecity.example/path']) await expect(attempt({ origin }), origin).rejects.toThrow(/ai_origin_shape/)
        await expect(attempt({ owner_address: '0x1234' })).rejects.toThrow(/ai_owner_normalized/)
        await expect(attempt({ owner_address: identity.address.toUpperCase().replace('0X', '0x') })).rejects.toThrow(/ai_owner_normalized/)
        await expect(attempt({ chain_id: 1 })).rejects.toThrow(/ai_canonical_chain/)
        // The foreign keys stand on their own too.
        await expect(attempt({ user_id: randomUUID() })).rejects.toThrow(/activation_intents_user_id_fkey/)
        await expect(attempt({ wallet_id: randomUUID() })).rejects.toThrow(/activation_intents_wallet_id_fkey/)
        await expect(attempt({ session_id: randomUUID() })).rejects.toThrow(/activation_intents_session_id_fkey/)
        await expect(attempt({ city_instance_id: randomUUID() })).rejects.toThrow(/ai_city/)
      })
      expect(await constraints('activation_intents', 'c')).toEqual(['ai_block_nonnegative', 'ai_canonical_chain', 'ai_committed_in_time', 'ai_committed_shape', 'ai_digest_is_32', 'ai_expiry_after_issue', 'ai_family_district', 'ai_id_shape', 'ai_lifetime_bounded', 'ai_origin_shape', 'ai_owner_normalized', 'ai_plot_shape', 'ai_signature_is_65', 'ai_status_known', 'ai_token_supported', 'ai_uncommitted_empty'])
    })

    it('is issued for an https origin, except on a developer machine', async () => {
      const HTTPS_ONLY = 'an activation intent is issued for an https origin'
      for (const environment of ['staging', 'production'] as const) {
        await fresh()
        const { instance, identity } = await setup(environment)
        const base = { identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 }
        for (const origin of ['http://rarecity.example', 'http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:9000', 'rarecity.example', 'ftp://rarecity.example']) await expect(addIntent(t.db, { ...base, override: { origin } }), `${environment} ${origin}`).rejects.toThrow(HTTPS_ONLY)
        await addIntent(t.db, { ...base, override: { origin: 'https://rarecity.example' } })
        await addIntent(t.db, { ...base, tokenId: 813, override: { origin: 'https://staging.rarecity.example:8443' } })
      }
      // A database with no stamp at all is not a developer machine either.
      await fresh()
      const unstamped = await setup('staging')
      await t.db.query(`DELETE FROM app_meta WHERE key = 'environment'`)
      await expect(addIntent(t.db, { identity: unstamped.identity, instance: unstamped.instance, tokenId: 812, familyId: 2, ward: 0, plot: 3, override: { origin: 'http://127.0.0.1:8787' } })).rejects.toThrow(HTTPS_ONLY)

      // Local: plain http on loopback is how the service runs there (PUBLIC_ORIGIN allows it only in local mode).
      await fresh()
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })
      const meta = await initializeCity(t.db, { state: createGenesisState(), origin: 'demo-fixture', rehearsal: true, environment: 'local' })
      const identity = await addIdentity(t.db)
      let tokenId = 900
      for (const origin of ['http://127.0.0.1:8787', 'http://[::1]:9000', 'http://localhost:8787', 'https://rarecity.example']) await addIntent(t.db, { identity, instance: meta.instance, tokenId: tokenId++, familyId: 2, ward: 0, plot: 3, override: { origin } })
      await expect(addIntent(t.db, { identity, instance: meta.instance, tokenId: 950, familyId: 2, ward: 0, plot: 3, override: { origin: 'http://127.0.0.1:8787/x' } })).rejects.toThrow(/ai_origin_shape/)
    })

    it('begins inside a live session of the same user and wallet, and never without one', async () => {
      const { instance, identity } = await setup()
      const base = { identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 }
      const other = await addIdentity(t.db)
      const SAME = 'an activation intent is issued in a session of the same user and wallet'
      const LIVE = 'an activation intent is issued in a live session'
      const session = async (userId: string, walletId: string) => (await t.db.query<{ id: string }>(`INSERT INTO sessions (token_hash, user_id, wallet_id, expires_at) VALUES ($1, $2, $3, now() + interval '7 days') RETURNING id`, [randomBytes(32), userId, walletId])).rows[0].id

      // No session.
      await expect(addIntent(t.db, { ...base, override: { session_id: null } })).rejects.toThrow('an activation intent is issued in a session: it cannot begin without one')
      // Somebody else's session; a session of the same user through another wallet; of the same wallet under another user.
      await expect(addIntent(t.db, { ...base, override: { session_id: other.sessionId } })).rejects.toThrow(SAME)
      const secondWallet = (await t.db.query<{ id: string }>('INSERT INTO wallets (user_id, chain_id, address) VALUES ($1, 4663, $2) RETURNING id', [identity.userId, `0x${'e1'.repeat(20)}`])).rows[0].id
      await expect(addIntent(t.db, { ...base, override: { session_id: await session(identity.userId, secondWallet) } })).rejects.toThrow(SAME)
      await expect(addIntent(t.db, { ...base, override: { session_id: await session(other.userId, identity.walletId) } })).rejects.toThrow(SAME)

      // A session that has been revoked.
      const revoked = await addIdentity(t.db)
      await t.db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [revoked.sessionId])
      await expect(addIntent(t.db, { ...base, identity: revoked })).rejects.toThrow(LIVE)
      // A session that expired yesterday, whatever issue time the writer claims.
      const expired = await addIdentity(t.db, { opened: new Date(Date.now() - 8 * 86_400_000) })
      await expect(addIntent(t.db, { ...base, identity: expired })).rejects.toThrow(LIVE)
      const backdated = new Date(Date.now() - 2 * 86_400_000)
      await expect(addIntent(t.db, { ...base, identity: expired, override: { issued_at: backdated, expires_at: new Date(backdated.getTime() + INTENT_TTL_MS) } })).rejects.toThrow(LIVE)
      expect(await count('activation_intents')).toBe(0)

      // The ordinary case: issued now, in the session that is asking.
      const id = await addIntent(t.db, base)
      expect((await t.db.query('SELECT status, session_id, user_id, wallet_id FROM activation_intents WHERE id = $1', [id])).rows).toEqual([{ status: 'issued', session_id: identity.sessionId, user_id: identity.userId, wallet_id: identity.walletId }])
    })

    it('is issued inside its session\'s lifetime, to the millisecond, and at the time the database says it is', async () => {
      const { instance } = await setup()
      const LIVE = 'an activation intent is issued in a live session'
      const NOW = 'an activation intent is issued now: its issue time must agree with this database\'s clock'
      const at = (identity: Identity, tokenId: number, issued: Date, expires = new Date(issued.getTime() + 1_000)) => addIntent(t.db, { identity, instance, tokenId, familyId: 2, ward: 0, plot: 3, override: { issued_at: issued, expires_at: expires } })

      // The start of the session: the very instant it opened is inside it; a millisecond earlier is not.
      const opened = new Date(Date.now() - 5_000)
      const fresh = await addIdentity(t.db, { opened })
      await expect(at(fresh, 812, new Date(opened.getTime() - 1))).rejects.toThrow(LIVE)
      await at(fresh, 812, opened)
      // The end of the session: a millisecond before it ends is inside it; the instant it ends is not.
      const ending = await addIdentity(t.db, { opened: new Date(Date.now() - 5_000), lifetimeMs: 35_000 })
      const end = (await t.db.query<{ expires_at: Date }>('SELECT expires_at FROM sessions WHERE id = $1', [ending.sessionId])).rows[0].expires_at
      await expect(at(ending, 813, end, new Date(end.getTime() + 1))).rejects.toThrow(LIVE)
      await at(ending, 813, new Date(end.getTime() - 1), end)

      // "Now" is the database's clock. A week-long session does not make a ten-minute intent usable in six days' time,
      // nor can an intent be dated into the past.
      const week = await addIdentity(t.db, { opened: new Date(Date.now() - 3_600_000) })
      for (const offset of [6 * 86_400_000, 3_600_000, 2 * 60_000, -2 * 60_000, -30 * 60_000]) await expect(at(week, 814, new Date(Date.now() + offset)), String(offset)).rejects.toThrow(NOW)
      // A few seconds either way is ordinary clock disagreement between the service and the database.
      await at(week, 814, new Date(Date.now() + 5_000))
      await at(week, 815, new Date(Date.now() - 5_000))
      expect(await count('activation_intents')).toBe(4)
    })

    it('cannot dodge a rule by adding the row it depends on later in the same statement', async () => {
      const { instance, identity } = await setup()
      const other = await addIdentity(t.db)
      const columns = intentColumns({ identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 })
      const names = Object.keys(columns)
      const intentInsert = (override: Record<string, unknown>) => {
        const row = { ...columns, ...override }
        return { sql: `INSERT INTO activation_intents (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING session_id, wallet_id`, values: names.map((n) => row[n]) }
      }
      // A session that does not exist yet, created by the same statement after the intent: another user's, already revoked.
      const session = randomUUID()
      const viaSession = intentInsert({ session_id: session })
      await expect(
        t.db.query(`WITH i AS (${viaSession.sql}) INSERT INTO sessions (id, token_hash, user_id, wallet_id, expires_at, revoked_at) SELECT i.session_id, $${names.length + 1}, $${names.length + 2}, $${names.length + 3}, now() + interval '1 day', now() FROM i`, [...viaSession.values, randomBytes(32), other.userId, other.walletId]),
      ).rejects.toThrow('an activation intent is issued in a session of the same user and wallet')
      // A wallet that does not exist yet, created afterwards as somebody else's.
      const wallet = randomUUID()
      const viaWallet = intentInsert({ wallet_id: wallet })
      await expect(
        t.db.query(`WITH i AS (${viaWallet.sql}) INSERT INTO wallets (id, user_id, chain_id, address) SELECT i.wallet_id, $${names.length + 1}, 4663, $${names.length + 2} FROM i`, [...viaWallet.values, other.userId, `0x${'e2'.repeat(20)}`]),
      ).rejects.toThrow('an activation intent is issued to one user through their own wallet')
      // An event for a city that does not exist yet, at a sequence that city will not be at.
      await expect(t.db.query(`WITH e AS (INSERT INTO city_events (city_id, sequence, type) VALUES ('second', 5, 'x') RETURNING city_id) INSERT INTO city (id, canonical, origin, state_version, sequence, state) SELECT city_id, false, 'demo-fixture', 5, 1, '{"version":5}'::json FROM e`)).rejects.toThrow(/needs its city to exist first/)
      // An ownership era for a property that does not exist.
      await expect(insertRow(t.db, 'ownership_eras', { id: randomUUID(), property_id: randomUUID(), era_number: 1, owner_address: identity.address, owner_wallet_id: identity.walletId, owner_user_id: identity.userId, started_at: new Date(), start_reason: 'activation', start_block: 1 })).rejects.toThrow(/needs its property to exist first/)
      expect([await count('activation_intents'), await count('ownership_eras'), await count('city_events'), await count('city')]).toEqual([0, 0, 1, 1])
    })

    it('lives at most ten minutes, and never beyond its session', async () => {
      const { instance, identity } = await setup()
      const lasting = (who: Identity, ms: number, tokenId: number) => {
        const issued = new Date()
        return addIntent(t.db, { identity: who, instance, tokenId, familyId: 2, ward: 0, plot: 3, override: { issued_at: issued, expires_at: new Date(issued.getTime() + ms) } })
      }
      for (const ms of [INTENT_TTL_MS + 1, INTENT_TTL_MS + 60_000, 3_600_000, 6 * 86_400_000]) await expect(lasting(identity, ms, 812), String(ms)).rejects.toThrow(/ai_lifetime_bounded/)
      // Longer than the session itself is refused on that account first.
      await expect(lasting(identity, 8 * 86_400_000, 812)).rejects.toThrow('an activation intent cannot outlive the session it was issued in')
      await lasting(identity, INTENT_TTL_MS, 812)
      await lasting(identity, 1_000, 813)

      // A session with five minutes left cannot issue a ten-minute intent, but can issue a four-minute one.
      const closing = await addIdentity(t.db, { lifetimeMs: 5 * 60_000 })
      await expect(lasting(closing, INTENT_TTL_MS, 814)).rejects.toThrow('an activation intent cannot outlive the session it was issued in')
      await expect(lasting(closing, 6 * 60_000, 814)).rejects.toThrow('an activation intent cannot outlive the session it was issued in')
      await lasting(closing, 4 * 60_000, 814)
      expect(await count('activation_intents')).toBe(3)
    })

    it('holds a token id exactly: a fraction is refused, never rounded', async () => {
      const { instance, identity } = await setup()
      const withToken = (token_id: string, n: number) => addIntent(t.db, { identity, instance, tokenId: 1, familyId: 2, ward: 0, plot: n, override: { token_id } })
      const refused = ['1.5', '812.1', '0.5', '812.0', '811.9999999999999999999999', '-1', '-0.5', '9007199254740992', '9007199254740991.5', '1e16', 'NaN', 'Infinity', '-Infinity']
      for (const token of refused) await expect(withToken(token, 3), token).rejects.toThrow(/ai_token_supported/)
      expect(await count('activation_intents')).toBe(0)
      // Whole numbers in range are kept exactly as the integer they are.
      await withToken('0', 4)
      await withToken('812', 5)
      await withToken('9007199254740991', 6)
      expect((await t.db.query<{ token: string }>('SELECT token_id::text AS token FROM activation_intents ORDER BY token_id')).rows.map((r) => r.token)).toEqual(['0', '812', '9007199254740991'])
      // Nor can a stored id be rewritten into a fraction, or into another spelling of itself.
      for (const set of ['token_id = 812.5', 'token_id = 813']) await expect(t.db.query(`UPDATE activation_intents SET ${set} WHERE token_id = 812`), set).rejects.toThrow('the signed fields of an activation intent cannot be changed')
      await expect(t.db.query(`UPDATE activation_intents SET token_id = 812.0 WHERE token_id = 812`)).rejects.toThrow(/ai_token_supported/)
      const column = (await t.db.query<{ data_type: string; numeric_scale: number | null }>(`SELECT data_type, numeric_scale FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'activation_intents' AND column_name = 'token_id'`, [t.schema])).rows[0]
      expect(column).toEqual({ data_type: 'numeric', numeric_scale: null })
    })

    it('cannot be issued for an ordinary demo fixture city', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const meta = await initializeCity(t.db, { state: createSeedState(), origin: 'demo-fixture', environment: 'staging' })
      await expect(addIntent(t.db, { identity: await addIdentity(t.db), instance: meta.instance, tokenId: 20_812, familyId: 2, ward: 1, plot: 0 })).rejects.toThrow('an activation intent can only be issued for a canonical or rehearsal city')
      expect(await count('activation_intents')).toBe(0)
    })

    it('allows at most one issued intent per wallet and Friend', async () => {
      const { instance, identity } = await setup()
      const first = await addIntent(t.db, { identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 })
      await expect(addIntent(t.db, { identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 9 })).rejects.toThrow(/activation_intents_one_issued/)
      // Another Friend, or another wallet, is unaffected.
      await addIntent(t.db, { identity, instance, tokenId: 813, familyId: 2, ward: 0, plot: 9 })
      await addIntent(t.db, { identity: await addIdentity(t.db), instance, tokenId: 812, familyId: 2, ward: 0, plot: 9 })
      // Superseding the first makes room for exactly one new one.
      await t.db.query(`UPDATE activation_intents SET status = 'superseded' WHERE id = $1`, [first])
      await addIntent(t.db, { identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 9 })
      await expect(addIntent(t.db, { identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 10 })).rejects.toThrow(/activation_intents_one_issued/)
    })

    it('never lets a signed field be rewritten', async () => {
      const { instance, identity } = await setup()
      const other = await addIdentity(t.db)
      const id = await addIntent(t.db, { identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 })
      const before = await snapshot(t.db, 'activation_intents', 'id')
      const rewrites = [
        `id = '${'f'.repeat(64)}'`,
        `user_id = '${other.userId}'`,
        `wallet_id = '${other.walletId}'`,
        `owner_address = '${other.address}'`,
        `token_id = 999`,
        `family_id = 3, district_id = 'd5', plot_id = 'd5-w0-p3'`,
        `ward = 1, plot_id = 'd4-w1-p3'`,
        `plot = 4, plot_id = 'd4-w0-p4'`,
        `origin = 'https://evil.example'`,
        `digest = decode('${'00'.repeat(32)}', 'hex')`,
        `issued_at = issued_at - interval '1 hour'`,
        `expires_at = expires_at + interval '1 year'`,
        `issued_block = issued_block + 1`,
      ]
      for (const set of rewrites) await expect(t.db.query(`UPDATE activation_intents SET ${set} WHERE id = $1`, [id]), set).rejects.toThrow('the signed fields of an activation intent cannot be changed')
      await expect(t.db.query(`UPDATE activation_intents SET session_id = $2 WHERE id = $1`, [id, other.sessionId])).rejects.toThrow('an activation intent cannot be moved to another session')
      await expect(t.db.query(`UPDATE activation_intents SET status = 'superseded', session_id = $2 WHERE id = $1`, [id, other.sessionId])).rejects.toThrow('an activation intent cannot be moved to another session')
      expect(await snapshot(t.db, 'activation_intents', 'id')).toBe(before)
    })

    it('moves issued -> superseded once, and nowhere else', async () => {
      const { instance, identity } = await setup()
      const id = await addIntent(t.db, { identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 })
      expect((await t.db.query(`UPDATE activation_intents SET status = 'superseded' WHERE id = $1`, [id])).rowCount).toBe(1)
      await expect(t.db.query(`UPDATE activation_intents SET status = 'issued' WHERE id = $1`, [id])).rejects.toThrow('an activation intent can only move from issued to committed or superseded')
      await expect(t.db.query(`UPDATE activation_intents SET status = 'committed', committed_at = issued_at + interval '1 minute', signature = $2, property_id = $3 WHERE id = $1`, [id, randomBytes(65), randomUUID()])).rejects.toThrow('an activation intent can only move from issued to committed or superseded')
      expect((await t.db.query('SELECT status FROM activation_intents')).rows).toEqual([{ status: 'superseded' }])
    })

    it('moves issued -> committed only with the whole committed shape, in time, pointing at its own property', async () => {
      const { instance, identity } = await setup()
      const input = { identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 }
      const intent = intentColumns(input)
      await insertRow(t.db, 'activation_intents', intent)
      const commit = (set: string, values: unknown[] = []) => t.db.query(`UPDATE activation_intents SET ${set} WHERE id = $1`, [intent.id, ...values])
      const IN_TIME = `committed_at = issued_at + interval '1 minute'`

      await expect(commit(`status = 'committed'`)).rejects.toThrow(/ai_committed_shape/)
      await expect(commit(`status = 'committed', ${IN_TIME}, signature = $2`, [randomBytes(65)])).rejects.toThrow(/ai_committed_shape/)
      await expect(commit(`status = 'committed', ${IN_TIME}, signature = $2, property_id = $3`, [randomBytes(64), randomUUID()])).rejects.toThrow(/ai_signature_is_65/)
      await expect(commit(`status = 'committed', committed_at = issued_at - interval '1 second', signature = $2, property_id = $3`, [randomBytes(65), randomUUID()])).rejects.toThrow(/ai_committed_in_time/)
      // An expired intent authorises nothing.
      await expect(commit(`status = 'committed', committed_at = expires_at + interval '1 second', signature = $2, property_id = $3`, [randomBytes(65), randomUUID()])).rejects.toThrow(/ai_committed_in_time/)
      // A property that does not exist, or that belongs to another intent, cannot be claimed.
      await expect(commit(`status = 'committed', ${IN_TIME}, signature = $2, property_id = $3`, [randomBytes(65), randomUUID()])).rejects.toThrow(/ai_property/)
      const other = await activate(t.db, { identity: await addIdentity(t.db), instance, tokenId: 900, familyId: 2, ward: 0, plot: 7 })
      await expect(commit(`status = 'committed', ${IN_TIME}, signature = $2, property_id = $3`, [randomBytes(65), other.propertyId])).rejects.toThrow(/ai_property/)
      // Committed fields cannot be set while still issued.
      await expect(commit(`signature = $2`, [randomBytes(65)])).rejects.toThrow('the outcome of an activation intent cannot be changed')
      expect((await t.db.query('SELECT status, committed_at, signature, property_id FROM activation_intents WHERE id = $1', [intent.id])).rows).toEqual([{ status: 'issued', committed_at: null, signature: null, property_id: null }])

      // The real thing, in order: event, property, era, then the commit.
      const done = await activate(t.db, { ...input, tokenId: 814, plot: 8 })
      const row = (await t.db.query('SELECT status, property_id, octet_length(signature) AS sig FROM activation_intents WHERE id = $1', [done.intentId])).rows[0]
      expect(row).toEqual({ status: 'committed', property_id: done.propertyId, sig: 65 })
      // Committed is final.
      for (const set of [`status = 'issued', committed_at = NULL, signature = NULL, property_id = NULL`, `status = 'superseded', committed_at = NULL, signature = NULL, property_id = NULL`])
        await expect(t.db.query(`UPDATE activation_intents SET ${set} WHERE id = $1`, [done.intentId]), set).rejects.toThrow('an activation intent can only move from issued to committed or superseded')
      for (const set of [`committed_at = committed_at + interval '1 second'`, `signature = decode('${'00'.repeat(65)}', 'hex')`])
        await expect(t.db.query(`UPDATE activation_intents SET ${set} WHERE id = $1`, [done.intentId]), set).rejects.toThrow('the outcome of an activation intent cannot be changed')
    })

    it('lets session clean-up null the session of an intent in any status, and nothing else changes', async () => {
      const { instance } = await setup()
      const issued = await addIdentity(t.db)
      const superseded = await addIdentity(t.db)
      const committed = await addIdentity(t.db)
      const issuedId = await addIntent(t.db, { identity: issued, instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 })
      const supersededId = await addIntent(t.db, { identity: superseded, instance, tokenId: 813, familyId: 2, ward: 0, plot: 4 })
      await t.db.query(`UPDATE activation_intents SET status = 'superseded' WHERE id = $1`, [supersededId])
      const done = await activate(t.db, { identity: committed, instance, tokenId: 814, familyId: 2, ward: 0, plot: 5 })
      /** Every column of every intent except the one clean-up is allowed to touch. */
      const others = async () => JSON.stringify((await t.db.query('SELECT * FROM activation_intents ORDER BY id')).rows.map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => column !== 'session_id'))))
      const before = await others()
      expect(Object.keys(JSON.parse(before)[0])).toHaveLength(23)

      // While a session still exists nobody can detach it by hand, in any status, alone or with another change.
      const KEEPS = 'an activation intent keeps its session for as long as that session exists'
      for (const id of [issuedId, supersededId, done.intentId]) await expect(t.db.query('UPDATE activation_intents SET session_id = NULL WHERE id = $1', [id]), id).rejects.toThrow(KEEPS)
      await expect(t.db.query('UPDATE activation_intents SET session_id = NULL')).rejects.toThrow(KEEPS)
      await expect(t.db.query(`UPDATE activation_intents SET status = 'superseded', session_id = NULL WHERE id = $1`, [issuedId])).rejects.toThrow(KEEPS)
      // Not even once the session has been revoked: only its deletion releases the intent.
      await t.db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [issued.sessionId])
      await expect(t.db.query('UPDATE activation_intents SET session_id = NULL WHERE id = $1', [issuedId])).rejects.toThrow(KEEPS)
      expect((await t.db.query('SELECT count(*)::int AS n FROM activation_intents WHERE session_id IS NULL')).rows[0].n).toBe(0)
      expect(await others()).toBe(before)

      // What the service's retention does: delete ended sessions. Here, all three, for real, in one statement.
      const removed = await t.db.query('DELETE FROM sessions WHERE id = ANY($1)', [[issued.sessionId, superseded.sessionId, committed.sessionId]])
      expect(removed.rowCount).toBe(3)
      const rows = (await t.db.query('SELECT id, session_id, status FROM activation_intents ORDER BY status')).rows
      expect(rows).toEqual([
        { id: done.intentId, session_id: null, status: 'committed' },
        { id: issuedId, session_id: null, status: 'issued' },
        { id: supersededId, session_id: null, status: 'superseded' },
      ])
      expect(await others()).toBe(before)
      // Re-attaching is never allowed, and an intent released by clean-up can still be superseded.
      const again = await addIdentity(t.db)
      await expect(t.db.query('UPDATE activation_intents SET session_id = $1', [again.sessionId])).rejects.toThrow('an activation intent cannot be moved to another session')
      expect((await t.db.query(`UPDATE activation_intents SET status = 'superseded' WHERE id = $1`, [issuedId])).rowCount).toBe(1)
    })

    it('session clean-up by the service itself still works with intents attached', async () => {
      const { instance } = await setup()
      const people = [await addIdentity(t.db), await addIdentity(t.db), await addIdentity(t.db)]
      const ids: string[] = []
      for (const [i, identity] of people.entries()) ids.push(await addIntent(t.db, { identity, instance, tokenId: 700 + i, familyId: 2, ward: 0, plot: i }))
      await t.db.query(`UPDATE activation_intents SET status = 'superseded' WHERE id = $1`, [ids[1]])
      const done = await activate(t.db, { identity: people[2], instance, tokenId: 800, familyId: 2, ward: 0, plot: 9 })
      const others = async () => JSON.stringify((await t.db.query('SELECT * FROM activation_intents ORDER BY id')).rows.map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => column !== 'session_id'))))
      const before = await others()

      // The real sign-in service, forty days from now: issuing a challenge runs its tidy(), which deletes
      // sessions that ended more than thirty days before. tidy() swallows its own errors, so the proof is the rows.
      const later = createAuthService({ db: t.db, publicOrigin: 'https://rarecity.example', now: () => new Date(Date.now() + 40 * 86_400_000) })
      await later.issueChallenge({ address: people[0].address, chainId: 4663 })
      expect(await count('sessions')).toBe(0)
      expect((await t.db.query('SELECT id, session_id, status FROM activation_intents ORDER BY status, id')).rows).toEqual(
        [
          { id: done.intentId, session_id: null, status: 'committed' },
          { id: ids[0], session_id: null, status: 'issued' },
          { id: ids[2], session_id: null, status: 'issued' },
          { id: ids[1], session_id: null, status: 'superseded' },
        ].sort((a, b) => a.status.localeCompare(b.status) || a.id.localeCompare(b.id)),
      )
      expect(await others()).toBe(before)
    })

    it('is committed only while the session that requested it is live, and only before it expires', async () => {
      const { instance } = await setup()
      const SESSION = 'an activation intent is committed only while the session that requested it is live'
      const input = (identity: Identity, tokenId: number, plot: number) => ({ identity, instance, tokenId, familyId: 2, ward: 0, plot })
      /** Issue an intent in its own transaction, as the service will, and return what is needed to commit it later. */
      const issue = async (identity: Identity, tokenId: number, plot: number, lifetimeMs = INTENT_TTL_MS) => {
        const issuedAt = new Date()
        const columns = intentColumns({ ...input(identity, tokenId, plot), override: { issued_at: issuedAt, expires_at: new Date(issuedAt.getTime() + lifetimeMs) } })
        await insertRow(t.db, 'activation_intents', columns)
        return { identity, columns, input: input(identity, tokenId, plot) }
      }
      const commit = (i: Awaited<ReturnType<typeof issue>>) => activate(t.db, i.input, { issued: i.columns })

      const revoked = await issue(await addIdentity(t.db), 812, 3)
      const deleted = await issue(await addIdentity(t.db), 813, 4)
      const shortSession = await issue(await addIdentity(t.db, { lifetimeMs: 1_500 }), 814, 5, 1_400)
      const shortIntent = await issue(await addIdentity(t.db), 815, 6, 1_400)
      const slowTransaction = await issue(await addIdentity(t.db), 816, 7, 1_400)
      const fine = await issue(await addIdentity(t.db), 817, 8)

      // Signed out on another tab between issue and commit.
      await t.db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [revoked.identity.sessionId])
      await expect(commit(revoked)).rejects.toThrow(SESSION)
      // A revoked session cannot be revived to let the commit through, nor an ended one extended.
      await expect(t.db.query('UPDATE sessions SET revoked_at = NULL WHERE id = $1', [revoked.identity.sessionId])).rejects.toThrow('a revoked session stays revoked')
      await expect(t.db.query(`UPDATE sessions SET revoked_at = now() + interval '1 year' WHERE id = $1`, [revoked.identity.sessionId])).rejects.toThrow('a revoked session stays revoked')
      await expect(t.db.query(`UPDATE sessions SET expires_at = now() + interval '1 year' WHERE id = $1`, [shortSession.identity.sessionId])).rejects.toThrow('a session keeps the credential and the lifetime it was opened with')
      await expect(commit(revoked)).rejects.toThrow(SESSION)

      // The session deleted between issue and commit: the intent is released, and can no longer be committed.
      await t.db.query('DELETE FROM sessions WHERE id = $1', [deleted.identity.sessionId])
      await expect(commit(deleted)).rejects.toThrow(SESSION)

      // A transaction opened while the intent was live, that only gets to the commit after it expired.
      const client = await t.db.connect()
      try {
        await client.query('BEGIN')
        await client.query('SELECT now()')
        await new Promise((r) => setTimeout(r, 1_700))
        await expect(client.query(`UPDATE activation_intents SET status = 'committed', committed_at = issued_at, signature = $2, property_id = $3 WHERE id = $1`, [slowTransaction.columns.id, randomBytes(65), randomUUID()])).rejects.toThrow('an expired activation intent cannot be committed')
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
      // By now the short session and the short intent have both run out, whatever time the writer claims.
      await expect(commit(shortSession)).rejects.toThrow(/an expired activation intent authorises nothing|committed only while the session/)
      await expect(t.db.query(`UPDATE activation_intents SET status = 'committed', committed_at = issued_at, signature = $2, property_id = $3 WHERE id = $1`, [shortSession.columns.id, randomBytes(65), randomUUID()])).rejects.toThrow(SESSION)
      await expect(commit(shortIntent)).rejects.toThrow('an expired activation intent authorises nothing')
      await expect(t.db.query(`UPDATE activation_intents SET status = 'committed', committed_at = issued_at, signature = $2, property_id = $3 WHERE id = $1`, [shortIntent.columns.id, randomBytes(65), randomUUID()])).rejects.toThrow('an expired activation intent cannot be committed')

      // Nothing of any refused attempt remains: no property, no era, no event, and the city did not move.
      expect([await count('properties'), await count('ownership_eras'), await count('city_events')]).toEqual([0, 0, 1])
      expect((await t.db.query('SELECT sequence FROM city')).rows).toEqual([{ sequence: '1' }])
      expect((await t.db.query(`SELECT count(*)::int AS n FROM activation_intents WHERE status = 'issued'`)).rows[0].n).toBe(6)
      // Superseding needs no session and no time left: it authorises nothing.
      for (const i of [revoked, deleted, shortSession, shortIntent]) expect((await t.db.query(`UPDATE activation_intents SET status = 'superseded' WHERE id = $1`, [i.columns.id])).rowCount).toBe(1)

      // And issued in one transaction, committed in a later one, with the session live and the intent in time: it commits.
      const done = await commit(fine)
      expect((await t.db.query('SELECT status, session_id, property_id FROM activation_intents WHERE id = $1', [done.intentId])).rows).toEqual([{ status: 'committed', session_id: fine.identity.sessionId, property_id: done.propertyId }])
      expect([await count('properties'), await count('ownership_eras'), await count('city_events')]).toEqual([1, 1, 2])
    })

    it('holds its session against revocation from the moment of the commit until the transaction ends', async () => {
      const { instance, identity } = await setup()
      const signOut = await t.db.connect()
      let blocked: unknown = null
      try {
        await signOut.query(`SET lock_timeout = '400ms'`)
        // The whole activation runs up to and including the intent's commit step. Before its transaction ends, a
        // sign-out arrives on another connection: it has to wait, so it cannot slip in between the check and the end.
        const done = await activate(t.db, { identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 }, {
          beforeTransactionEnds: async () => {
            blocked = await signOut.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [identity.sessionId]).then(
              () => 'the sign-out was not blocked',
              (err: Error) => err.message,
            )
          },
        })
        expect(blocked).toMatch(/lock timeout/)
        expect((await t.db.query('SELECT status FROM activation_intents WHERE id = $1', [done.intentId])).rows).toEqual([{ status: 'committed' }])
        // Once the activation is over the sign-out goes through, and it comes after the commit.
        expect((await signOut.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [identity.sessionId])).rowCount).toBe(1)
        const order = (await t.db.query<{ after: boolean }>('SELECT s.revoked_at > i.committed_at AS after FROM sessions s JOIN activation_intents i ON i.session_id = s.id')).rows
        expect(order).toEqual([{ after: true }])
      } finally {
        await signOut.query('RESET lock_timeout').catch(() => undefined)
        signOut.release()
      }
    })

    it('keeps a committed intent forever in production', async () => {
      const { instance, identity } = await setup('production')
      const done = await activate(t.db, { identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 })
      const abandoned = await addIntent(t.db, { identity, instance, tokenId: 813, familyId: 2, ward: 0, plot: 4 })
      await expect(t.db.query('DELETE FROM activation_intents WHERE id = $1', [done.intentId])).rejects.toThrow('a committed activation intent is permanent')
      // An intent that never committed is not history: it may be tidied away.
      expect((await t.db.query('DELETE FROM activation_intents WHERE id = $1', [abandoned])).rowCount).toBe(1)
    })
  })

  describe('properties', () => {
    it('one per Friend and one per plot, whoever asks', async () => {
      const { instance, identity } = await setup()
      await activate(t.db, { identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 })
      expect(await count('properties')).toBe(1)
      // Same Friend on another plot, by the same wallet or another.
      await expect(activate(t.db, { identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 9 })).rejects.toThrow(/p_one_per_friend|p_one_building/)
      await expect(activate(t.db, { identity: await addIdentity(t.db), instance, tokenId: 812, familyId: 2, ward: 0, plot: 9 })).rejects.toThrow(/p_one_per_friend|p_one_building/)
      // Another Friend on the same plot.
      await expect(activate(t.db, { identity: await addIdentity(t.db), instance, tokenId: 900, familyId: 2, ward: 0, plot: 3 })).rejects.toThrow(/p_one_per_plot/)
      // Nothing of the three refused attempts remains.
      expect([await count('properties'), await count('activation_intents'), await count('ownership_eras'), await count('city_events')]).toEqual([1, 1, 1, 2])
      expect((await t.db.query('SELECT sequence FROM city')).rows).toEqual([{ sequence: '2' }])
    })

    it('holds the family -> district table exactly', async () => {
      const { instance } = await setup()
      // Every family in its own district is accepted.
      for (let familyId = 0; familyId < 9; familyId++) await activate(t.db, { identity: await addIdentity(t.db), instance, tokenId: 100 + familyId, familyId, ward: 0, plot: 1 })
      const placed = (await t.db.query<{ family_id: number; district_id: string }>('SELECT family_id, district_id FROM properties ORDER BY family_id')).rows
      expect(placed.map((p) => p.district_id)).toEqual(['d8', 'd6', 'd4', 'd5', 'd7', 'd9', 'd3', 'd2', 'd1'])
      expect(placed.map((p) => p.district_id)).toEqual([...FAMILY_DISTRICTS])
      // Every other pairing is refused: for an intent by its own constraint...
      const identity = await addIdentity(t.db)
      const pairs: [number, string][] = []
      for (let familyId = 0; familyId < 9; familyId++) for (let d = 1; d <= 9; d++) if (`d${d}` !== FAMILY_DISTRICTS[familyId]) pairs.push([familyId, `d${d}`])
      pairs.push([9, 'd1'], [-1, 'd1'], [2, 'd10'], [2, 'd0'])
      expect(pairs).toHaveLength(76)
      for (const [family_id, district_id] of pairs)
        await expect(addIntent(t.db, { identity, instance, tokenId: 500, familyId: 2, ward: 0, plot: 2, override: { family_id, district_id, plot_id: `${district_id}-w0-p2` } }), `${family_id} -> ${district_id}`).rejects.toThrow(/ai_family_district/)
      // ...and for a property by its own, shown with the guard off so that nothing else can be what refuses it.
      const intent = intentColumns({ identity, instance, tokenId: 500, familyId: 2, ward: 0, plot: 2 })
      await insertRow(t.db, 'activation_intents', intent)
      await unguarded(t.db, async () => {
        for (const [family_id, district_id] of pairs)
          await expect(insertRow(t.db, 'properties', { ...propertyColumns(intent, 10), family_id, district_id, plot_id: `${district_id}-w0-p2` }), `${family_id} -> ${district_id}`).rejects.toThrow(/p_family_district/)
      })
      expect(await count('properties')).toBe(9)
    })

    it('must be exactly what its issued, unexpired intent authorised, beside its event, at the current sequence', async () => {
      const { instance, identity } = await setup()
      const intent = intentColumns({ identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 })
      await insertRow(t.db, 'activation_intents', intent)
      const NO_EVENT = 'a property must be recorded by a property.activated event at the sequence its city has just reached'
      const NOT_AUTHORISED = 'a property must be exactly what its issued intent authorised'
      // No event yet, then an event of another kind, at the current sequence.
      await expect(insertRow(t.db, 'properties', propertyColumns(intent, 2))).rejects.toThrow(NO_EVENT)
      await advance(t.db, 'something.else')
      await expect(insertRow(t.db, 'properties', propertyColumns(intent, 2))).rejects.toThrow(NO_EVENT)
      await advance(t.db, 'property.activated')
      // The right event, but not at the sequence the city is at now.
      await advance(t.db, 'test.later')
      await expect(insertRow(t.db, 'properties', propertyColumns(intent, 3))).rejects.toThrow(NO_EVENT)
      await advance(t.db, 'property.activated')

      const other = await addIdentity(t.db)
      const issuedAt = (intent.issued_at as Date).getTime()
      const wrong: [Record<string, unknown>, string | RegExp][] = [
        [{ token_id: '813', building_id: 'b-813' }, NOT_AUTHORISED],
        [{ plot: 4, plot_id: 'd4-w0-p4' }, NOT_AUTHORISED],
        [{ ward: 1, plot_id: 'd4-w1-p3' }, NOT_AUTHORISED],
        [{ plot_id: 'd4-w0-p9' }, NOT_AUTHORISED],
        [{ family_id: 3, district_id: 'd5', plot_id: 'd5-w0-p3' }, NOT_AUTHORISED],
        [{ chain_id: 1 }, NOT_AUTHORISED],
        [{ collection: `0x${'2'.repeat(40)}` }, NOT_AUTHORISED],
        [{ activated_by_user_id: other.userId }, NOT_AUTHORISED],
        [{ activated_by_wallet_id: other.walletId }, NOT_AUTHORISED],
        [{ activation_intent_id: 'f'.repeat(64) }, NOT_AUTHORISED],
        // Outside the intent's lifetime, in either direction.
        [{ activated_at: new Date(issuedAt - 1_000) }, NOT_AUTHORISED],
        [{ activated_at: new Date(issuedAt + INTENT_TTL_MS + 1_000) }, NOT_AUTHORISED],
        [{ activated_at: new Date('2029-01-01T00:00:00.000Z') }, NOT_AUTHORISED],
        // Verified at a block before the intent was even issued.
        [{ verified_block: 78_999_999 }, NOT_AUTHORISED],
        [{ activated_sequence: 1 }, NO_EVENT],
        [{ activated_sequence: 3 }, NO_EVENT],
        [{ activated_sequence: 50 }, NO_EVENT],
        [{ building_id: 'b-999' }, /p_building_shape/],
        [{ building_id: 'building-812' }, /p_building_shape/],
        [{ verified_block: -5 }, NOT_AUTHORISED],
      ]
      for (const [override, error] of wrong) await expect(insertRow(t.db, 'properties', { ...propertyColumns(intent, 5), ...override }), JSON.stringify(override)).rejects.toThrow(error)
      expect(await count('properties')).toBe(0)

      // A correct row still cannot be committed on its own: not without its intent committed to it and its first era.
      await expect(insertRow(t.db, 'properties', propertyColumns(intent, 5))).rejects.toThrow('a property cannot be committed without its activation intent being committed to it')
      expect(await count('properties')).toBe(0)
      // A superseded intent authorises nothing.
      await t.db.query(`UPDATE activation_intents SET status = 'superseded' WHERE id = $1`, [intent.id])
      await expect(insertRow(t.db, 'properties', propertyColumns(intent, 5))).rejects.toThrow(NOT_AUTHORISED)
    })

    it('is never left half-activated: no property without its committed intent and its first era', async () => {
      const { instance, identity } = await setup()
      const input = { identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 }
      const cityBefore = JSON.stringify((await t.db.query('SELECT sequence, state::text AS state, updated_at FROM city')).rows)
      await expect(activate(t.db, input, { skip: 'commit' })).rejects.toThrow('a property cannot be committed without its activation intent being committed to it')
      await expect(activate(t.db, input, { skip: 'era' })).rejects.toThrow('a property cannot be committed without its first ownership era')
      await expect(activate(t.db, input, { eraOwner: await addIdentity(t.db) })).rejects.toThrow('the first ownership era belongs to the wallet that activated the property')
      // Nor may the first era claim another moment or block than the activation's.
      for (const era of [{ started_at: new Date('1999-01-01T00:00:00.000Z') }, { start_block: 0 }]) await expect(activate(t.db, input, { era }), JSON.stringify(era)).rejects.toThrow('from the moment and block of the activation')
      for (const failAt of ['property', 'era', 'commit'] as const) await expect(activate(t.db, input, { failAt }), failAt).rejects.toThrow(/injected failure/)
      // Eight failed attempts, at every step: nothing of any of them remains.
      expect([await count('activation_intents'), await count('properties'), await count('ownership_eras'), await count('city_events')]).toEqual([0, 0, 0, 1])
      expect(JSON.stringify((await t.db.query('SELECT sequence, state::text AS state, updated_at FROM city')).rows)).toBe(cityBefore)
      await activate(t.db, input)
      expect([await count('activation_intents'), await count('properties'), await count('ownership_eras'), await count('city_events')]).toEqual([1, 1, 1, 2])
    })

    it('cannot exist in an ordinary demo fixture city', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const meta = await initializeCity(t.db, { state: createSeedState(), origin: 'demo-fixture', environment: 'staging' })
      const identity = await addIdentity(t.db)
      const input = { identity, instance: meta.instance, tokenId: 20_812, familyId: 2, ward: 1, plot: 0 }
      // The intent is refused first...
      await expect(activate(t.db, input)).rejects.toThrow('an activation intent can only be issued for a canonical or rehearsal city')
      // ...and if an intent somehow existed, the property would be refused on its own account.
      const intent = intentColumns(input)
      await unguarded(t.db, () => insertRow(t.db, 'activation_intents', intent))
      await advance(t.db, 'property.activated')
      await expect(insertRow(t.db, 'properties', propertyColumns(intent, 2))).rejects.toThrow('a property can only exist in a canonical or rehearsal city')
      expect(await count('properties')).toBe(0)
    })

    it('references the exact city installation and the exact event', async () => {
      const { instance, identity } = await setup()
      // An intent naming another installation of the same city id is refused: by the guard, and with the guard off by the composite key.
      await expect(addIntent(t.db, { identity, instance: randomUUID(), tokenId: 812, familyId: 2, ward: 0, plot: 3 })).rejects.toThrow('an activation intent can only be issued for a canonical or rehearsal city')
      await unguarded(t.db, async () => {
        await expect(addIntent(t.db, { identity, instance: randomUUID(), tokenId: 812, familyId: 2, ward: 0, plot: 3 })).rejects.toThrow(/ai_city/)
      })
      const done = await activate(t.db, { identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 })
      const fks = (await t.db.query<{ conname: string; def: string }>(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid IN ('properties'::regclass, 'activation_intents'::regclass) AND contype = 'f' AND conname IN ('p_city', 'p_event', 'ai_city', 'ai_property') ORDER BY conname`)).rows
      expect(fks).toEqual([
        { conname: 'ai_city', def: 'FOREIGN KEY (city_id, city_instance_id) REFERENCES city(id, instance_id)' },
        { conname: 'ai_property', def: 'FOREIGN KEY (property_id, id) REFERENCES properties(id, activation_intent_id)' },
        { conname: 'p_city', def: 'FOREIGN KEY (city_id, city_instance_id) REFERENCES city(id, instance_id)' },
        { conname: 'p_event', def: 'FOREIGN KEY (city_id, activated_sequence) REFERENCES city_events(city_id, sequence)' },
      ])
      // Those keys hold on their own: with every guard off, the installation cannot change under a property,
      // a property cannot name another installation, and its event and city cannot go.
      await unguarded(t.db, async () => {
        await expect(t.db.query('UPDATE city SET instance_id = gen_random_uuid()')).rejects.toThrow(/p_city|ai_city/)
        await expect(t.db.query('DELETE FROM city_events WHERE sequence = $1', [done.sequence])).rejects.toThrow(/p_event/)
        await expect(t.db.query('DELETE FROM city')).rejects.toThrow(/foreign key/)
        const intent = intentColumns({ identity: await addIdentity(t.db), instance, tokenId: 900, familyId: 2, ward: 0, plot: 9 })
        await insertRow(t.db, 'activation_intents', intent)
        await expect(insertRow(t.db, 'properties', { ...propertyColumns(intent, done.sequence + 5) })).rejects.toThrow(/p_event/)
        await expect(insertRow(t.db, 'properties', { ...propertyColumns(intent, done.sequence), city_instance_id: randomUUID() })).rejects.toThrow(/p_city|p_one_per_sequence/)
      })
    })

    it('every constraint on the table stands on its own, with the guard off', async () => {
      const { instance, identity } = await setup()
      const first = await activate(t.db, { identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 })
      expect(await constraints('properties', 'u')).toEqual(['p_id_intent', 'p_one_building', 'p_one_per_friend', 'p_one_per_intent', 'p_one_per_plot', 'p_one_per_sequence'])
      expect(await constraints('properties', 'c')).toEqual(['p_block_nonnegative', 'p_building_shape', 'p_canonical_chain', 'p_family_district', 'p_plot_shape', 'p_sequence_after_install', 'p_token_supported'])

      await unguarded(t.db, async () => {
        const intentFor = async (tokenId: number | string, plot: number) => {
          const intent = intentColumns({ identity: await addIdentity(t.db), instance, tokenId, familyId: 2, ward: 0, plot })
          await insertRow(t.db, 'activation_intents', intent)
          return intent
        }
        for (const sequence of [3, 4, 5, 6, 7, 8]) await t.db.query(`INSERT INTO city_events (city_id, sequence, type) VALUES ('main', $1, 'property.activated')`, [sequence])
        // A second, well-formed property. Then one row per uniqueness rule, each differing from an existing row in everything else.
        const second = await intentFor(900, 9)
        await expect(insertRow(t.db, 'properties', propertyColumns(second, first.sequence))).rejects.toThrow(/p_one_per_sequence/)
        await insertRow(t.db, 'properties', propertyColumns(second, 3))
        await expect(insertRow(t.db, 'properties', { ...propertyColumns(await intentFor(901, 10), 4), activation_intent_id: second.id })).rejects.toThrow(/p_one_per_intent/)
        await expect(insertRow(t.db, 'properties', propertyColumns(await intentFor(902, 3), 5))).rejects.toThrow(/p_one_per_plot/)
        // One Friend is one building id, so these two rules can only be broken together.
        await expect(insertRow(t.db, 'properties', propertyColumns(await intentFor(812, 12), 6))).rejects.toThrow(/p_one_per_friend|p_one_building/)

        const valid = await intentFor(903, 13)
        // A fractional or out-of-range token id is refused by the property table itself, whatever the building is called.
        for (const token of ['1.5', '812.1', '903.0', '903.5', '-1', '9007199254740992', 'NaN'])
          await expect(insertRow(t.db, 'properties', { ...propertyColumns(valid, 7), token_id: token, building_id: `b-${token}` }), token).rejects.toThrow(/p_token_supported/)
        const checks: [Record<string, unknown>, RegExp][] = [
          [{ plot_id: 'd4-w0-p99' }, /p_plot_shape/],
          [{ ward: -1, plot_id: 'd4-w-1-p13' }, /p_plot_shape/],
          [{ family_id: 3 }, /p_family_district/],
          [{ chain_id: 1 }, /p_canonical_chain/],
          [{ collection: `0x${'2'.repeat(40)}` }, /p_canonical_chain/],
          [{ token_id: '9007199254740992', building_id: 'b-9007199254740992' }, /p_token_supported/],
          [{ token_id: '-1', building_id: 'b--1' }, /p_token_supported/],
          [{ building_id: 'b-0903' }, /p_building_shape/],
          [{ activated_sequence: 1 }, /p_sequence_after_install/],
          [{ verified_block: -1 }, /p_block_nonnegative/],
        ]
        for (const [override, error] of checks) await expect(insertRow(t.db, 'properties', { ...propertyColumns(valid, 7), ...override }), JSON.stringify(override)).rejects.toThrow(error)
        await insertRow(t.db, 'properties', propertyColumns(valid, 7))
      })
      expect(await count('properties')).toBe(3)
      const column = (await t.db.query<{ data_type: string; numeric_scale: number | null }>(`SELECT data_type, numeric_scale FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'properties' AND column_name = 'token_id'`, [t.schema])).rows[0]
      expect(column).toEqual({ data_type: 'numeric', numeric_scale: null })
    })

    it('keeps a token id as the exact integer it is, from zero to the largest supported', async () => {
      const { instance } = await setup()
      // Real activations, guards on: the smallest id, an ordinary one, and the largest the city state can hold.
      for (const [tokenId, plot] of [['0', 1], ['812', 2], ['9007199254740991', 3]] as const) await activate(t.db, { identity: await addIdentity(t.db), instance, tokenId, familyId: 2, ward: 0, plot })
      const rows = (await t.db.query<{ token: string; building_id: string }>('SELECT token_id::text AS token, building_id FROM properties ORDER BY token_id')).rows
      expect(rows).toEqual([{ token: '0', building_id: 'b-0' }, { token: '812', building_id: 'b-812' }, { token: '9007199254740991', building_id: 'b-9007199254740991' }])
      // A fraction never reaches a property: the intent is refused first, and so is anything one above the limit.
      for (const tokenId of ['1.5', '812.1', '9007199254740992']) await expect(activate(t.db, { identity: await addIdentity(t.db), instance, tokenId, familyId: 2, ward: 0, plot: 9 }), tokenId).rejects.toThrow(/ai_token_supported/)
      expect(await count('properties')).toBe(3)
    })

    it('is immutable, and in production permanent', async () => {
      for (const environment of ['staging', 'production'] as const) {
        await fresh()
        const { instance, identity } = await setup(environment)
        const done = await activate(t.db, { identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 })
        const before = await snapshot(t.db, 'properties', 'id')
        for (const set of [`plot = 4, plot_id = 'd4-w0-p4'`, `token_id = 813, building_id = 'b-813'`, 'activated_at = now()', 'verified_block = 1', 'id = gen_random_uuid()', 'ward = ward'])
          await expect(t.db.query(`UPDATE properties SET ${set}`), `${environment}: ${set}`).rejects.toThrow('a property is permanent: it cannot be changed')
        await expect(t.db.query(`INSERT INTO properties SELECT * FROM properties ON CONFLICT (id) DO UPDATE SET verified_block = 1`)).rejects.toThrow(/a property is permanent: it cannot be changed|exactly what its issued intent/)
        expect(await snapshot(t.db, 'properties', 'id')).toBe(before)

        const removeAll = `WITH e AS (DELETE FROM ownership_eras RETURNING 1), i AS (DELETE FROM activation_intents RETURNING 1) DELETE FROM properties`
        if (environment === 'production') {
          await expect(t.db.query('DELETE FROM properties WHERE id = $1', [done.propertyId])).rejects.toThrow('a property is permanent: it cannot be removed')
          await expect(t.db.query('DELETE FROM ownership_eras')).rejects.toThrow('ownership history is permanent: an era cannot be removed')
          await expect(t.db.query(removeAll)).rejects.toThrow(/permanent/)
          expect([await count('properties'), await count('ownership_eras'), await count('activation_intents')]).toEqual([1, 1, 1])
        } else {
          // Staging data is disposable, but only together: alone, the era and the committed intent hold the property.
          await expect(t.db.query('DELETE FROM properties WHERE id = $1', [done.propertyId])).rejects.toThrow(/foreign key/)
          expect((await t.db.query(removeAll)).rowCount).toBe(1)
          expect([await count('properties'), await count('ownership_eras'), await count('activation_intents')]).toEqual([0, 0, 0])
        }
      }
    })
  })

  describe('ownership_eras', () => {
    /** Era 1 closes one hour and 1,000 blocks after it opened; a following era opens at that moment and block. */
    const HOUR = 3_600_000
    const CLOSE_BLOCK = 79_001_100
    const era = (done: { propertyId: string; at: Date }, identity: Identity | null, number: number, extra: Record<string, unknown> = {}) => ({
      id: randomUUID(),
      property_id: done.propertyId,
      era_number: number,
      owner_address: identity?.address ?? `0x${'ab'.repeat(20)}`,
      owner_wallet_id: identity?.walletId ?? null,
      owner_user_id: identity?.userId ?? null,
      started_at: new Date(done.at.getTime() + HOUR),
      start_reason: number === 1 ? 'activation' : 'transfer',
      start_block: CLOSE_BLOCK,
      ...extra,
    })
    const close = (id: string, set = `ended_at = started_at + interval '1 hour', end_reason = 'transfer', end_block = ${CLOSE_BLOCK}`) => t.db.query(`UPDATE ownership_eras SET ${set} WHERE id = $1`, [id])
    const AFTER_PREVIOUS = 'an ownership era opens only after the one before it has closed'

    it('opens one era at a time, in order, each after the last has closed', async () => {
      const { instance, identity } = await setup()
      const done = await activate(t.db, { identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 })
      const bob = await addIdentity(t.db)
      // While the first era is open, nothing can follow it.
      await expect(insertRow(t.db, 'ownership_eras', era(done, bob, 2))).rejects.toThrow(AFTER_PREVIOUS)
      await expect(insertRow(t.db, 'ownership_eras', era(done, bob, 1))).rejects.toThrow('ownership eras are numbered consecutively from 1')
      await expect(insertRow(t.db, 'ownership_eras', era(done, bob, 3))).rejects.toThrow('ownership eras are numbered consecutively from 1')
      await expect(insertRow(t.db, 'ownership_eras', era(done, bob, 0))).rejects.toThrow('ownership eras are numbered consecutively from 1')

      await close(done.eraId)
      // Uncontrolled: no open era. The next one cannot be an activation, start before the last ended, or arrive already closed.
      expect((await t.db.query('SELECT count(*)::int AS n FROM ownership_eras WHERE ended_at IS NULL')).rows[0].n).toBe(0)
      await expect(insertRow(t.db, 'ownership_eras', era(done, bob, 2, { start_reason: 'activation' }))).rejects.toThrow(/oe_first_is_activation/)
      await expect(insertRow(t.db, 'ownership_eras', era(done, bob, 2, { started_at: new Date(done.at.getTime() + HOUR - 1_000) }))).rejects.toThrow(AFTER_PREVIOUS)
      await expect(insertRow(t.db, 'ownership_eras', era(done, bob, 2, { start_block: CLOSE_BLOCK - 1 }))).rejects.toThrow(AFTER_PREVIOUS)
      await expect(insertRow(t.db, 'ownership_eras', era(done, bob, 2, { ended_at: new Date(done.at.getTime() + 2 * HOUR), end_reason: 'transfer', end_block: 79_200_000 }))).rejects.toThrow('an ownership era opens open: it is closed later, once')
      // The new owner's era opens, known to Rare City or not.
      await insertRow(t.db, 'ownership_eras', era(done, null, 2))
      await expect(insertRow(t.db, 'ownership_eras', era(done, bob, 3))).rejects.toThrow(AFTER_PREVIOUS)
      expect((await t.db.query('SELECT era_number, start_reason, ended_at IS NULL AS open, owner_user_id IS NULL AS unclaimed FROM ownership_eras ORDER BY era_number')).rows).toEqual([
        { era_number: 1, start_reason: 'activation', open: false, unclaimed: false },
        { era_number: 2, start_reason: 'transfer', open: true, unclaimed: true },
      ])
      // The one-open-era index holds on its own, with the guard off.
      await unguarded(t.db, async () => {
        await expect(insertRow(t.db, 'ownership_eras', era(done, bob, 3))).rejects.toThrow(/ownership_eras_one_open/)
        await expect(insertRow(t.db, 'ownership_eras', era(done, bob, 2, { ended_at: new Date(done.at.getTime() + 2 * HOUR), end_reason: 'transfer', end_block: 79_200_000 }))).rejects.toThrow(/oe_number_unique/)
      })
    })

    it('names one owner: the address, its wallet and that wallet\'s user', async () => {
      const { instance, identity } = await setup()
      const done = await activate(t.db, { identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 })
      await close(done.eraId)
      const bob = await addIdentity(t.db)
      const carol = await addIdentity(t.db)
      const ONE_OWNER = 'an ownership era names one owner'
      const mixed: Record<string, unknown>[] = [{ owner_user_id: carol.userId }, { owner_wallet_id: carol.walletId }, { owner_address: carol.address }, { owner_address: bob.address.toUpperCase().replace('0X', '0x') }, { owner_user_id: null }]
      for (const override of mixed) await expect(insertRow(t.db, 'ownership_eras', era(done, bob, 2, override)), JSON.stringify(override)).rejects.toThrow(ONE_OWNER)
      await expect(insertRow(t.db, 'ownership_eras', era(done, bob, 2, { owner_wallet_id: null }))).rejects.toThrow(/oe_identity_pair/)
      await expect(insertRow(t.db, 'ownership_eras', era(done, bob, 2, { owner_wallet_id: randomUUID() }))).rejects.toThrow(ONE_OWNER)
      await insertRow(t.db, 'ownership_eras', era(done, bob, 2))
      expect(await count('ownership_eras')).toBe(2)
    })

    it('refuses malformed eras by the table\'s own constraints', async () => {
      const { instance, identity } = await setup()
      const done = await activate(t.db, { identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 })
      await close(done.eraId)
      const bob = await addIdentity(t.db)
      expect(await constraints('ownership_eras', 'c')).toEqual(['oe_end_after_start', 'oe_end_reason_known', 'oe_end_together', 'oe_first_is_activation', 'oe_identity_pair', 'oe_number_positive', 'oe_owner_normalized', 'oe_start_block_nonnegative', 'oe_start_reason_known'])
      const later = new Date(done.at.getTime() + 2 * HOUR)
      await unguarded(t.db, async () => {
        const refused: [Record<string, unknown>, RegExp][] = [
          [{ owner_address: bob.address.toUpperCase().replace('0X', '0x') }, /oe_owner_normalized/],
          [{ owner_address: 'bob.eth' }, /oe_owner_normalized/],
          [{ owner_user_id: null }, /oe_identity_pair/],
          [{ owner_wallet_id: null }, /oe_identity_pair/],
          [{ start_reason: 'gift' }, /oe_start_reason_known/],
          [{ start_reason: 'activation' }, /oe_first_is_activation/],
          [{ era_number: 0 }, /oe_number_positive/],
          [{ start_block: -1 }, /oe_start_block_nonnegative/],
          [{ ended_at: later }, /oe_end_together/],
          [{ end_reason: 'transfer' }, /oe_end_together/],
          [{ end_block: 79_200_000 }, /oe_end_together/],
          [{ ended_at: later, end_reason: 'burned', end_block: 79_200_000 }, /oe_end_reason_known/],
          [{ ended_at: new Date(done.at.getTime() - HOUR), end_reason: 'transfer', end_block: 79_200_000 }, /oe_end_after_start/],
          [{ ended_at: later, end_reason: 'transfer', end_block: 1 }, /oe_end_after_start/],
          [{ property_id: randomUUID() }, /foreign key/],
        ]
        for (const [override, error] of refused) await expect(insertRow(t.db, 'ownership_eras', era(done, bob, 2, override)), JSON.stringify(override)).rejects.toThrow(error)
      })
      expect(await count('ownership_eras')).toBe(1)
    })

    it('can be closed exactly once, and changed in no other way', async () => {
      const { instance, identity } = await setup()
      const done = await activate(t.db, { identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 })
      const bob = await addIdentity(t.db)
      const before = await snapshot(t.db, 'ownership_eras', 'id')
      const OPENING = 'the opening facts of an ownership era cannot be changed'
      const rewrites = [
        `owner_address = '${bob.address}'`,
        `owner_wallet_id = '${bob.walletId}', owner_user_id = '${bob.userId}'`,
        `owner_wallet_id = NULL, owner_user_id = NULL`,
        'era_number = 2',
        `started_at = started_at - interval '1 day'`,
        'start_block = 1',
        `id = gen_random_uuid()`,
      ]
      for (const set of rewrites) await expect(close(done.eraId, set), set).rejects.toThrow(OPENING)
      // Closing while rewriting is refused too, and an update that closes nothing is not a change eras undergo.
      await expect(close(done.eraId, `owner_address = '${bob.address}', ended_at = now(), end_reason = 'transfer', end_block = 79100000`)).rejects.toThrow(OPENING)
      await expect(close(done.eraId, 'started_at = started_at')).rejects.toThrow('the only change to an ownership era is closing it')
      await expect(close(done.eraId, `ended_at = now()`)).rejects.toThrow(/oe_end_together/)
      expect(await snapshot(t.db, 'ownership_eras', 'id')).toBe(before)

      expect((await close(done.eraId)).rowCount).toBe(1)
      const closed = await snapshot(t.db, 'ownership_eras', 'id')
      await expect(close(done.eraId, `ended_at = ended_at + interval '1 day'`)).rejects.toThrow('an ownership era can only be closed once')
      await expect(close(done.eraId, `ended_at = NULL, end_reason = NULL, end_block = NULL`)).rejects.toThrow('an ownership era can only be closed once')
      await expect(close(done.eraId)).rejects.toThrow('an ownership era can only be closed once')
      expect(await snapshot(t.db, 'ownership_eras', 'id')).toBe(closed)
    })
  })

  it('the database pins the chain, collection and token range the engine supports', async () => {
    await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
    const definition = async (table: string, name: string) => (await t.db.query<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2`, [table, name])).rows[0].def
    for (const [table, prefix] of [['properties', 'p'], ['activation_intents', 'ai']] as const) {
      const chain = await definition(table, `${prefix}_canonical_chain`)
      expect(chain, table).toContain(`chain_id = ${CHAIN_ID}`)
      expect(chain, table).toContain(`'${COLLECTION}'`)
      const token = await definition(table, `${prefix}_token_supported`)
      expect(token, table).toContain(String(Number.MAX_SAFE_INTEGER))
      const family = await definition(table, `${prefix}_family_district`)
      // Postgres prints the pair list as "family_id = 0 AND district_id = 'd8' OR ...".
      const pairs = family.replace(/[\s()]|::text|::smallint/g, '')
      FAMILY_DISTRICTS.forEach((district, familyId) => expect(pairs, `${table} ${familyId}`).toContain(`family_id=${familyId}ANDdistrict_id='${district}'`))
      expect(pairs.match(/family_id=/g), table).toHaveLength(9)
    }
    expect([CHAIN_ID, COLLECTION, Number.MAX_SAFE_INTEGER, CITY_ID]).toEqual([4663, '0x14c49e6118f46525de9ab41a51cbaa3c6ebf181d', 9_007_199_254_740_991, 'main'])
  })
})
