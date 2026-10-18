import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeCity } from '../src/city/store'
import { verifyCity } from '../src/city/verify'
import type { AppMode } from '../src/config'
import { loadMigrations, migrate } from '../src/db/migrations'
import { createGenesisState } from '../src/engine'
import { activate, addIdentity, addIntent, intentColumns, insertRow, propertyColumns, snapshot } from './activationFixtures'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'

const WORLD_TABLES = ['world_config_adoptions', 'world_config_versions', 'world_play_bindings', 'worlds']
const WORLD_FUNCTIONS = ['app_meta_world_guard', 'city_world_founding_guard', 'legacy_activation_world_guard', 'world_config_adoptions_guard', 'world_config_versions_guard', 'world_play_bindings_guard', 'world_require_binding', 'worlds_guard']
/** Every table that existed before 0005: the legacy Rare Friends store and identity. */
const LEGACY = { app_meta: 'key', city: 'id', city_events: 'city_id, sequence', activation_intents: 'id', properties: 'id', ownership_eras: 'id', users: 'id', wallets: 'id', sessions: 'id', auth_challenges: 'nonce' }

const PLAY_ENV: Record<AppMode, string> = { local: 'test', staging: 'staging', production: 'live' }
const GAME = 'rare-city'
const LEVELS = ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'] as const
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const guildId = () => String(100_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1e15)))

/**
 * Golden vectors from Proofy Play's own canonicalJson / canonicalHash
 * (proofy-play 4c457aa, packages/contract/src/canonical.ts), run on the JavaScript values named.
 * They pin what "Play's canonical text" and "Play's configHash" mean; this repository has no
 * canonicalizer of its own yet (the importer that will need one is not built).
 */
const PLAY_VECTORS: { name: string; canonical: string; hash: string }[] = [
  {
    // { version: 1, contract: 'test-config/1' }
    name: 'key order',
    canonical: '{"contract":"test-config/1","version":1}',
    hash: 'b35a4a1c34151fe738cfd0f0a9f9a0b143e07837ce7563d59ccb579a1eb7673e',
  },
  {
    // { name: 'Café ☕', nested: { z: 1, a: [3, 2, 1] }, list: [{ b: true, a: null }] }
    name: 'nested objects and arrays',
    canonical: '{"list":[{"a":null,"b":true}],"name":"Café ☕","nested":{"a":[3,2,1],"z":1}}',
    hash: '22871d01c376c376a55b1b505ae45a849f158e9708f430d9e75a43f2cff06c10',
  },
  {
    // { '～': 1, '😀': 2, z: 3, 'é': 4, A: 5, a: 6, _: 7, '10': 8, '9': 9, '': 10 }: by UTF-16 code unit 😀 (D83D) sorts before ～ (FF5E),
    // although by code point or by UTF-8 byte it sorts after.
    name: 'keys sorted by UTF-16 code unit',
    canonical: '{"":10,"10":8,"9":9,"A":5,"_":7,"a":6,"z":3,"é":4,"😀":2,"～":1}',
    hash: 'bd0992825adb3ddc9f7b2d7bb8382627e441ed7406a1fb7689ef95f6775a5a9d',
  },
  {
    // { a: 1.0, b: -0, c: 1e21, d: 0.1, e: 5e-7, f: 123456789012, g: -1.5e-10, h: 2.5e+3 }
    name: 'numbers as JavaScript writes them',
    canonical: '{"a":1,"b":0,"c":1e+21,"d":0.1,"e":5e-7,"f":123456789012,"g":-1.5e-10,"h":2500}',
    hash: 'b77f3c4ade6ae2418142a9d70fcdc07c80e1e150c2283ad82ca19d92673ee54c',
  },
  {
    // { s: 'quote" back\\ slash/ nl\n tab\t ctrl\u0001 del\u007f ls\u2028 é ☕ 😀' }: DEL and LINE SEPARATOR are written raw.
    name: 'string escapes',
    canonical: String.raw`{"s":"quote\" back\\ slash/ nl\n tab\t ctrl\u0001 del` + '\u007f ls\u2028 é ☕ 😀"}',
    hash: '0d4ede2413e5cc87c9b8363106ca1bc96e74161b533d46f67383d899d2354fca',
  },
  {
    // { b: 1, a: undefined, c: [], d: {} }
    name: 'undefined members dropped',
    canonical: '{"b":1,"c":[],"d":{}}',
    hash: '509be0f80715190ea00b2b4aeede69bb5607ad55b7965171916753bb1f8bf5f0',
  },
]

interface World {
  worldId: string
  cityId: string
  instance: string
  installationId: string
  guildId: string
}

interface BindingInput {
  playEnvironment?: string
  game?: string
  installationId?: string
  guildId?: string
}

describe.skipIf(NO_TEST_DATABASE)('migration 0005: world core schema against a disposable Postgres', () => {
  const t = useTestSchema()
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  })
  const count = async (table: string) => (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n
  const versions = async () => (await t.db.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version)
  const functions = async () => (await t.db.query<{ proname: string; config: string[] | null }>(`SELECT p.proname, p.proconfig AS config FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = $1 AND p.proname = ANY($2) ORDER BY p.proname`, [t.schema, WORLD_FUNCTIONS])).rows
  const legacySnapshot = async () => Object.fromEntries(await Promise.all(Object.entries(LEGACY).map(async ([table, order]) => [table, await snapshot(t.db, table, order)])))
  const stamp = async () => (await t.db.query<{ value: string }>(`SELECT value FROM app_meta WHERE key = 'environment'`)).rows[0]?.value

  /** A copy of the shipped migrations up to and including `last`, optionally with 0005 replaced. */
  async function migrationsThrough(last: number, replace0005?: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'rc-worlds-'))
    dirs.push(dir)
    for (const file of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()) {
      const version = Number(file.slice(0, 4))
      if (version > last) continue
      if (version === 5 && replace0005 !== undefined) await writeFile(join(dir, file), replace0005)
      else await copyFile(join(MIGRATIONS_DIR, file), join(dir, file))
    }
    return dir
  }

  /** A fresh city row that may hold properties: canonical in production, a rehearsal elsewhere. */
  async function addCity(db: pg.Pool | pg.PoolClient, environment: AppMode, options: { id?: string; kind?: 'activatable' | 'fixture' } = {}): Promise<{ cityId: string; instance: string }> {
    const cityId = options.id ?? `w-${randomUUID()}`
    const state = JSON.stringify(createGenesisState())
    const canonical = environment === 'production' && options.kind !== 'fixture'
    const rehearsal = !canonical && options.kind !== 'fixture'
    const row = await db.query<{ instance_id: string }>(
      `INSERT INTO city (id, canonical, origin, state_version, sequence, state, activation_rehearsal) VALUES ($1, $2, $3, 5, 1, $4::json, $5) RETURNING instance_id`,
      [cityId, canonical, canonical ? 'genesis' : 'demo-fixture', state, rehearsal],
    )
    return { cityId, instance: row.rows[0].instance_id }
  }

  const insertWorld = (db: pg.Pool | pg.PoolClient, worldId: string, cityId: string, instance: string) => db.query('INSERT INTO worlds (id, city_id, city_instance_id) VALUES ($1, $2, $3)', [worldId, cityId, instance])

  const insertBinding = (db: pg.Pool | pg.PoolClient, world: World, playEnvironment: string, game = GAME) =>
    db.query('INSERT INTO world_play_bindings (world_id, play_environment, play_game_key, play_installation_id, discord_guild_id) VALUES ($1, $2, $3, $4, $5)', [world.worldId, playEnvironment, game, world.installationId, world.guildId])

  /** City, world and binding as the provisioning step will write them, inside a transaction the caller owns. */
  async function provision(client: pg.PoolClient, environment: AppMode, binding: BindingInput = {}): Promise<World> {
    const { cityId, instance } = await addCity(client, environment)
    const world = { worldId: randomUUID(), cityId, instance, installationId: binding.installationId ?? randomUUID(), guildId: binding.guildId ?? guildId() }
    await insertWorld(client, world.worldId, cityId, instance)
    await insertBinding(client, world, binding.playEnvironment ?? PLAY_ENV[environment], binding.game)
    return world
  }

  /** One world, provisioned and committed in one transaction. */
  async function addWorld(environment: AppMode, binding: BindingInput = {}): Promise<World> {
    return inTransaction((client) => provision(client, environment, binding))
  }

  async function inTransaction<T>(work: (client: pg.PoolClient) => Promise<T>, begin = 'BEGIN'): Promise<T> {
    const client = await t.db.connect()
    try {
      await client.query(begin)
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
  }

  /** Two (or more) connections of their own, for tests that interleave transactions. */
  async function connections(n: number): Promise<{ clients: pg.PoolClient[]; pids: number[]; release: () => Promise<void> }> {
    const clients = await Promise.all(Array.from({ length: n }, () => t.db.connect()))
    const pids = await Promise.all(clients.map(async (c) => (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid))
    return {
      clients,
      pids,
      release: async () => {
        for (const c of clients) {
          await c.query('ROLLBACK').catch(() => undefined)
          c.release()
        }
      },
    }
  }

  /** Resolves once backend `pid` is waiting for a lock, so the next step is known to happen while it waits. */
  async function waitingForLock(pid: number): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const row = (await t.db.query<{ wait: string | null }>('SELECT wait_event_type AS wait FROM pg_stat_activity WHERE pid = $1', [pid])).rows[0]
      if (row?.wait === 'Lock') return
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`backend ${pid} never waited for a lock`)
  }

  /** A query's outcome, captured so it can stay pending while the test does something else. */
  const outcome = (query: Promise<unknown>) => query.then(() => 'ok' as const, (err: unknown) => err as Error & { code?: string })

  function configRow(world: World, version: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const config = JSON.stringify({ contract: 'test-config/1', version })
    return { world_id: world.worldId, version, play_installation_id: world.installationId, schema_version: 1, config_hash: sha256(config), config_canonical: config, verdict: 'accepted', rejection: null, judged_by: 'test-validator/1', ...overrides }
  }

  async function addConfig(world: World, version: number, overrides: Record<string, unknown> = {}): Promise<void> {
    const row = configRow(world, version, overrides)
    const names = Object.keys(row)
    await t.db.query(`INSERT INTO world_config_versions (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row))
  }

  const adopt = (world: World, seq: number, version: number) => t.db.query('INSERT INTO world_config_adoptions (world_id, adoption_seq, version) VALUES ($1, $2, $3)', [world.worldId, seq, version])

  /**
   * The Rare Friends rehearsal city as staging holds it: sequence 3, two permanent properties with an
   * open era each, three events, three intents of which two are committed.
   */
  async function populateLegacyCity(): Promise<void> {
    const meta = await initializeCity(t.db, { state: createGenesisState(), origin: 'demo-fixture', rehearsal: true, environment: 'staging' })
    const a = await addIdentity(t.db)
    const b = await addIdentity(t.db)
    await activate(t.db, { identity: a, instance: meta.instance, tokenId: 345260, familyId: 0, ward: 0, plot: 0 })
    const stale = await addIntent(t.db, { identity: b, instance: meta.instance, tokenId: 812, familyId: 2, ward: 0, plot: 1 })
    await t.db.query(`UPDATE activation_intents SET status = 'superseded' WHERE id = $1`, [stale])
    await activate(t.db, { identity: b, instance: meta.instance, tokenId: 812, familyId: 2, ward: 0, plot: 3 })
  }

  /** The columns of a legacy Rare Friends intent naming `cityId` instead of the Rare Friends city. */
  const intentIn = (identity: Awaited<ReturnType<typeof addIdentity>>, cityId: string, instance: string) => intentColumns({ identity, instance, tokenId: 812, familyId: 2, ward: 0, plot: 1, override: { city_id: cityId } })

  // These are 0005's own tests: they apply the migrations up to and including it, whatever comes after.
  describe('applying the migration', () => {
    it('builds a fresh database 0001 -> 0005 with the four world tables and no rows', async () => {
      const result = await migrate(t.db, { dir: await migrationsThrough(5), environment: 'staging' })
      expect(result).toEqual({ applied: [1, 2, 3, 4, 5], current: 5 })
      expect(await t.tables()).toEqual(expect.arrayContaining(WORLD_TABLES))
      for (const table of WORLD_TABLES) expect(await count(table), table).toBe(0)
      expect((await loadMigrations(MIGRATIONS_DIR)).slice(0, 5).map((m) => `${m.version}:${m.name}`)).toEqual(['1:foundation', '2:city', '3:identity', '4:activation', '5:world_core'])
    })

    it('is a no-op when run again', async () => {
      const through5 = await migrationsThrough(5)
      await migrate(t.db, { dir: through5, environment: 'staging' })
      const before = await legacySnapshot()
      expect(await migrate(t.db, { dir: through5, environment: 'staging' })).toEqual({ applied: [], current: 5 })
      expect(await versions()).toEqual([1, 2, 3, 4, 5])
      expect(await legacySnapshot()).toEqual(before)
    })

    it('upgrades a populated 0004 database and leaves every existing row exactly as it was', async () => {
      await migrate(t.db, { dir: await migrationsThrough(4), environment: 'staging' })
      await populateLegacyCity()
      const report = await verifyCity(t.db)
      expect(report).toMatchObject({ ok: true, city: { id: 'main', sequence: 3, mode: 'rehearsal' }, counts: { properties: 2, eras: 2, openEras: 2, events: 3, intents: 3, committedIntents: 2 } })
      const before = await legacySnapshot()
      const cityText = (await t.db.query('SELECT state::text AS state FROM city')).rows
      const applied = (await t.db.query('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version')).rows

      const through5 = await migrationsThrough(5)
      expect(await migrate(t.db, { dir: through5, environment: 'staging' })).toEqual({ applied: [5], current: 5 })

      expect(await legacySnapshot()).toEqual(before)
      expect((await t.db.query('SELECT state::text AS state FROM city')).rows).toEqual(cityText)
      expect((await t.db.query('SELECT version, checksum, applied_at FROM schema_migrations WHERE version <= 4 ORDER BY version')).rows).toEqual(applied)
      for (const table of WORLD_TABLES) expect(await count(table), table).toBe(0)
      expect(await verifyCity(t.db)).toEqual(report)
      expect((await migrate(t.db, { dir: through5, environment: 'staging' })).applied).toEqual([])
      expect(await legacySnapshot()).toEqual(before)
    })

    it('leaves nothing behind when the migration fails part-way', async () => {
      await migrate(t.db, { dir: await migrationsThrough(4), environment: 'staging' })
      const tablesBefore = await t.tables()
      const triggers = async () => (await t.db.query(`SELECT tgrelid::regclass::text AS rel, tgname FROM pg_trigger WHERE tgrelid = ANY(ARRAY['app_meta', 'city', 'activation_intents', 'properties']::regclass[]) AND NOT tgisinternal ORDER BY 1, 2`)).rows
      const triggersBefore = await triggers()
      const real = (await readFile(join(MIGRATIONS_DIR, '0005_world_core.sql'), 'utf8')).replace(/\r\n/g, '\n')
      const broken = await migrationsThrough(5, `${real}\nINSERT INTO does_not_exist VALUES (1);\n`)
      await expect(migrate(t.db, { dir: broken, environment: 'staging' })).rejects.toThrow(/Migration 5 \(world_core\) failed and was rolled back/)
      expect(await versions()).toEqual([1, 2, 3, 4])
      expect(await t.tables()).toEqual(tablesBefore)
      expect(await triggers()).toEqual(triggersBefore)
      expect(await functions()).toEqual([])
      expect((await migrate(t.db, { dir: await migrationsThrough(5), environment: 'staging' })).applied).toEqual([5])
      expect((await functions()).map((f) => f.proname)).toEqual(WORLD_FUNCTIONS)
      expect((await triggers()).map((r) => r.tgname)).toEqual(expect.arrayContaining(['activation_intents_world_guard', 'app_meta_world_guard', 'city_world_founding_guard', 'properties_world_guard']))
    })

    it('pins every new guard function to its own schema, with temporary tables searched last', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const rows = await functions()
      expect(rows.map((r) => r.proname)).toEqual(WORLD_FUNCTIONS)
      for (const r of rows) expect(r.config, r.proname).toEqual([`search_path=${t.schema}, pg_temp`])
    })
  })

  describe('worlds', () => {
    it('is founded on a fresh city that may hold properties, together with its binding', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const world = await addWorld('staging')
      expect((await t.db.query('SELECT id, city_id, city_instance_id FROM worlds')).rows).toEqual([{ id: world.worldId, city_id: world.cityId, city_instance_id: world.instance }])
      expect(await count('world_play_bindings')).toBe(1)
    })

    it('never exists without its Play binding', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      await expect(
        inTransaction(async (client) => {
          const { cityId, instance } = await addCity(client, 'staging')
          await insertWorld(client, randomUUID(), cityId, instance)
        }),
      ).rejects.toThrow('a world cannot exist without its Play binding')
      expect(await count('worlds')).toBe(0)
      expect(await count('city')).toBe(0)
    })

    it('refuses the Rare Friends city, a plain fixture, a used city, an existing city, a missing city and a second world on one city', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      await populateLegacyCity()
      const main = (await t.db.query<{ instance_id: string }>(`SELECT instance_id FROM city WHERE id = 'main'`)).rows[0].instance_id
      const insert = (cityId: string, instance: string) => insertWorld(t.db, randomUUID(), cityId, instance)
      await expect(insert('main', main)).rejects.toThrow('the Rare Friends city is not a world')
      const fixture = await addCity(t.db, 'staging', { kind: 'fixture' })
      await expect(insert(fixture.cityId, fixture.instance)).rejects.toThrow('a world can only be a canonical or rehearsal city')
      const used = await addCity(t.db, 'staging')
      await t.db.query(`INSERT INTO city_events (city_id, sequence, type) VALUES ($1, 1, 'city.initialized')`, [used.cityId])
      await t.db.query(`UPDATE city SET sequence = 2, state = state WHERE id = $1`, [used.cityId])
      await expect(insert(used.cityId, used.instance)).rejects.toThrow('an existing city cannot be taken over')
      // Still at sequence 1, but installed by another, earlier transaction.
      const existing = await addCity(t.db, 'staging')
      await expect(inTransaction((client) => insertWorld(client, randomUUID(), existing.cityId, existing.instance))).rejects.toThrow('a world is founded on a city installed in the same transaction')
      // Installed inside a savepoint of the provisioning transaction is not "the same transaction" either.
      await expect(
        inTransaction(async (client) => {
          await client.query('SAVEPOINT s')
          const nested = await addCity(client, 'staging')
          await client.query('RELEASE SAVEPOINT s')
          await insertWorld(client, randomUUID(), nested.cityId, nested.instance)
        }),
      ).rejects.toThrow('installed in the same transaction')
      await expect(insert(`w-${randomUUID()}`, randomUUID())).rejects.toMatchObject({ code: '23503' })
      const fresh = await addCity(t.db, 'staging')
      await expect(insert(fresh.cityId, randomUUID())).rejects.toMatchObject({ code: '23503' })
      await expect(
        inTransaction(async (client) => {
          const world = await provision(client, 'staging')
          await insertWorld(client, randomUUID(), world.cityId, world.instance)
        }),
      ).rejects.toThrow(/worlds_one_per_city/)
      expect(await count('worlds')).toBe(0)
    })

    it('is immutable and never removed, in every environment, nor is its city', async () => {
      for (const environment of ['local', 'staging', 'production'] as const) {
        await t.db.query(`DROP SCHEMA ${t.schema} CASCADE; CREATE SCHEMA ${t.schema}`)
        await migrate(t.db, { dir: MIGRATIONS_DIR, environment })
        const world = await addWorld(environment)
        const other = await addWorld(environment)
        await expect(t.db.query('UPDATE worlds SET city_id = $2, city_instance_id = $3 WHERE id = $1', [world.worldId, other.cityId, other.instance]), environment).rejects.toThrow('a world is permanent: it cannot be changed')
        await expect(t.db.query('UPDATE worlds SET created_at = now() WHERE id = $1', [world.worldId]), environment).rejects.toThrow('a world is permanent')
        await expect(t.db.query('UPDATE worlds SET id = $2 WHERE id = $1', [world.worldId, randomUUID()]), environment).rejects.toThrow('a world is permanent')
        await expect(t.db.query('DELETE FROM world_play_bindings WHERE world_id = $1', [world.worldId]), environment).rejects.toThrow('a world binding is permanent: it cannot be removed')
        await expect(t.db.query('DELETE FROM worlds WHERE id = $1', [world.worldId]), environment).rejects.toThrow(/a world is permanent: it cannot be removed|23503/)
        // Together, in one transaction, is refused just the same.
        await expect(
          inTransaction(async (client) => {
            await client.query('DELETE FROM world_play_bindings WHERE world_id = $1', [world.worldId])
            await client.query('DELETE FROM worlds WHERE id = $1', [world.worldId])
          }),
          environment,
        ).rejects.toThrow('a world binding is permanent: it cannot be removed')
        // The world's city cannot be removed from under it (in production the city guard refuses first).
        await expect(t.db.query('DELETE FROM city WHERE id = $1', [world.cityId]), environment).rejects.toThrow(environment === 'production' ? 'a production city cannot be removed' : /worlds_city/)
        expect(await count('worlds'), environment).toBe(2)
        expect(await count('world_play_bindings'), environment).toBe(2)
      }
    })
  })

  describe('the Rare Friends activation tables and a world\'s city', () => {
    it('refuses a legacy activation intent that names a world\'s city, through raw SQL', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const world = await addWorld('staging')
      const identity = await addIdentity(t.db)
      await expect(insertRow(t.db, 'activation_intents', intentIn(identity, world.cityId, world.instance))).rejects.toThrow("a world's city holds no Rare Friends activation records (activation_intents)")
      expect(await count('activation_intents')).toBe(0)
    })

    it('refuses a legacy property that names a world\'s city, even with an intent there', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const world = await addWorld('staging')
      const identity = await addIdentity(t.db)
      // An intent the intent guard would refuse, put in place with that one guard off, so the property guard is tested on its own.
      const intent = intentIn(identity, world.cityId, world.instance)
      await t.db.query('ALTER TABLE activation_intents DISABLE TRIGGER activation_intents_world_guard')
      try {
        await insertRow(t.db, 'activation_intents', intent)
      } finally {
        await t.db.query('ALTER TABLE activation_intents ENABLE TRIGGER activation_intents_world_guard')
      }
      await expect(
        inTransaction(async (client) => {
          await client.query('UPDATE city SET sequence = 2 WHERE id = $1', [world.cityId])
          await client.query(`INSERT INTO city_events (city_id, sequence, type) VALUES ($1, 2, 'property.activated')`, [world.cityId])
          await insertRow(client, 'properties', propertyColumns(intent, 2))
        }),
      ).rejects.toThrow("a world's city holds no Rare Friends activation records (properties)")
      expect(await count('properties')).toBe(0)
    })

    it('refuses to make a world of a city that already holds a legacy activation intent', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const identity = await addIdentity(t.db)
      await expect(
        inTransaction(async (client) => {
          const { cityId, instance } = await addCity(client, 'staging')
          await insertRow(client, 'activation_intents', intentIn(identity, cityId, instance))
          await insertWorld(client, randomUUID(), cityId, instance)
        }),
      ).rejects.toThrow('a city that holds Rare Friends activation records cannot become a world')
      expect(await count('worlds')).toBe(0)
    })

    it('race: a world still being provisioned is invisible to a legacy insert, and refuses it once committed', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const identity = await addIdentity(t.db)
      const { clients: [provisioner, legacy], release } = await connections(2)
      try {
        await provisioner.query('BEGIN')
        const world = await provision(provisioner, 'staging')
        // Before the commit the city does not exist for anyone else.
        await expect(insertRow(legacy, 'activation_intents', intentIn(identity, world.cityId, world.instance))).rejects.toThrow('an activation intent can only be issued for a canonical or rehearsal city')
        await provisioner.query('COMMIT')
        // From the commit on, the city and its world are seen together.
        await expect(insertRow(legacy, 'activation_intents', intentIn(identity, world.cityId, world.instance))).rejects.toThrow("a world's city holds no Rare Friends activation records")
        await legacy.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
        await expect(insertRow(legacy, 'activation_intents', intentIn(identity, world.cityId, world.instance))).rejects.toThrow("a world's city holds no Rare Friends activation records")
      } finally {
        await release()
      }
      expect(await count('activation_intents')).toBe(0)
      expect(await count('worlds')).toBe(1)
    })

    it('race: a legacy intent being written holds its city, and a world claimed on that city waits for it and is refused', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const identity = await addIdentity(t.db)
      const city = await addCity(t.db, 'staging')
      const { clients: [legacy, provisioner], pids, release } = await connections(2)
      try {
        await legacy.query('BEGIN')
        await insertRow(legacy, 'activation_intents', intentIn(identity, city.cityId, city.instance))
        await provisioner.query('BEGIN')
        const claim = outcome(insertWorld(provisioner, randomUUID(), city.cityId, city.instance))
        await waitingForLock(pids[1])
        await legacy.query('COMMIT')
        expect(String(await claim)).toMatch('an existing city cannot be taken over')
      } finally {
        await release()
      }
      expect(await count('worlds')).toBe(0)
      expect(await count('activation_intents')).toBe(1)
    })
  })

  describe('an existing city is never taken for a new one', () => {
    /** Has a world ever been registered on a city that holds a legacy intent? */
    const worldsHoldingIntents = async () => (await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM worlds w JOIN activation_intents i ON i.city_id = w.city_id')).rows[0].n
    const touch = (db: pg.Pool | pg.PoolClient, cityId: string) => db.query('UPDATE city SET updated_at = updated_at WHERE id = $1', [cityId])
    const ADVANCE_ONLY = 'a city at sequence 1 changes only by advancing its sequence'

    it('H1b: a city at sequence 1 cannot be updated without advancing, so an old city never looks freshly installed', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const existing = await addCity(t.db, 'staging')
      for (const set of ['updated_at = updated_at', 'updated_at = now()', 'created_at = now()', 'state = state', 'sequence = sequence', 'sequence = 1', 'state_version = state_version'])
        await expect(t.db.query(`UPDATE city SET ${set} WHERE id = $1`, [existing.cityId]), set).rejects.toThrow(ADVANCE_ONLY)
      await expect(
        t.db.query(`INSERT INTO city (id, canonical, origin, state_version, sequence, state, activation_rehearsal) VALUES ($1, false, 'demo-fixture', 5, 1, $2::json, true) ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at`, [existing.cityId, JSON.stringify(createGenesisState())]),
      ).rejects.toThrow(ADVANCE_ONLY)
      // The takeover itself: a metadata-only update, then the world, in one transaction.
      await expect(
        inTransaction(async (client) => {
          await touch(client, existing.cityId)
          const world = { worldId: randomUUID(), ...existing, installationId: randomUUID(), guildId: guildId() }
          await insertWorld(client, world.worldId, existing.cityId, existing.instance)
          await insertBinding(client, world, 'staging')
        }),
      ).rejects.toThrow(ADVANCE_ONLY)
      // With the refused update swallowed by a savepoint, the claim is still an old city's.
      await expect(
        inTransaction(async (client) => {
          await client.query('SAVEPOINT s')
          await touch(client, existing.cityId).catch(() => undefined)
          await client.query('ROLLBACK TO SAVEPOINT s')
          await insertWorld(client, randomUUID(), existing.cityId, existing.instance)
        }),
      ).rejects.toThrow('a world is founded on a city installed in the same transaction')
      // A city inserted inside a savepoint cannot be made to look top-level by touching it afterwards.
      await expect(
        inTransaction(async (client) => {
          await client.query('SAVEPOINT s')
          const nested = await addCity(client, 'staging')
          await client.query('RELEASE SAVEPOINT s')
          await touch(client, nested.cityId)
        }),
      ).rejects.toThrow(ADVANCE_ONLY)
      expect(await count('worlds')).toBe(0)
      expect((await t.db.query('SELECT sequence FROM city WHERE id = $1', [existing.cityId])).rows).toEqual([{ sequence: '1' }])
    })

    it('1 -> 2 -> 1: a city advances once and never goes back, and a city that has advanced is not a world', async () => {
      // 0005's rules alone: from 0007 on, a world's city advances only by activating a property (worldProperties.db.test.ts).
      await migrate(t.db, { dir: await migrationsThrough(6), environment: 'staging' })
      const city = await addCity(t.db, 'staging')
      // The legitimate first change of a city: sequence 1 to 2.
      await t.db.query('UPDATE city SET sequence = 2 WHERE id = $1', [city.cityId])
      await expect(t.db.query('UPDATE city SET sequence = 1 WHERE id = $1', [city.cityId])).rejects.toThrow('a city sequence moves forward one step at a time')
      // In one transaction too: installed, advanced, sent back.
      await expect(
        inTransaction(async (client) => {
          const fresh = await addCity(client, 'staging')
          await client.query('UPDATE city SET sequence = 2 WHERE id = $1', [fresh.cityId])
          await client.query('UPDATE city SET sequence = 1 WHERE id = $1', [fresh.cityId])
        }),
      ).rejects.toThrow('a city sequence moves forward one step at a time')
      // Installed and advanced in this transaction: written by it, but no longer newly installed.
      await expect(
        inTransaction(async (client) => {
          const fresh = await addCity(client, 'staging')
          await client.query('UPDATE city SET sequence = 2 WHERE id = $1', [fresh.cityId])
          await insertWorld(client, randomUUID(), fresh.cityId, fresh.instance)
        }),
      ).rejects.toThrow('a world is founded on a newly installed city')
      // Under 0005 a world's city makes its first change like any other city.
      const world = await addWorld('staging')
      await t.db.query('UPDATE city SET sequence = 2 WHERE id = $1', [world.cityId])
      await t.db.query(`INSERT INTO city_events (city_id, sequence, type) VALUES ($1, 2, 'world.test')`, [world.cityId])
      expect((await t.db.query('SELECT sequence FROM city WHERE id = $1', [world.cityId])).rows).toEqual([{ sequence: '2' }])
      expect(await count('worlds')).toBe(1)
    })

    for (const provisionerLevel of LEVELS)
      for (const legacyLevel of LEVELS)
        it(`H1c: an intent committed after a ${provisionerLevel} provisioner's snapshot (legacy ${legacyLevel}) never ends up in a world`, async () => {
          await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
          const { clients: [provisioner, legacy], release } = await connections(2)
          try {
            for (const path of ['touch first', 'plain claim'] as const) {
              const city = await addCity(t.db, 'staging')
              const identity = await addIdentity(t.db)
              await provisioner.query(`BEGIN ISOLATION LEVEL ${provisionerLevel}`)
              await provisioner.query('SELECT count(*) FROM worlds')
              await legacy.query(`BEGIN ISOLATION LEVEL ${legacyLevel}`)
              await insertRow(legacy, 'activation_intents', intentIn(identity, city.cityId, city.instance))
              await legacy.query('COMMIT')
              const claim = path === 'touch first' ? touch(provisioner, city.cityId) : insertWorld(provisioner, randomUUID(), city.cityId, city.instance)
              await expect(claim, path).rejects.toThrow(path === 'touch first' ? ADVANCE_ONLY : 'an existing city cannot be taken over')
              await provisioner.query('ROLLBACK')
            }
          } finally {
            await release()
          }
          expect(await count('activation_intents')).toBe(2)
          expect(await count('worlds')).toBe(0)
          expect(await worldsHoldingIntents()).toBe(0)
        })

    for (const provisionerLevel of LEVELS)
      it(`H1d: a legacy intent still being written on an old city: a ${provisionerLevel} provisioner can neither touch nor claim that city`, async () => {
        await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
        const city = await addCity(t.db, 'staging')
        const identity = await addIdentity(t.db)
        const { clients: [legacy, provisioner], pids, release } = await connections(2)
        try {
          await legacy.query('BEGIN')
          await insertRow(legacy, 'activation_intents', intentIn(identity, city.cityId, city.instance))
          // The touch does not wait (it does not conflict with the intent's key-share lock); it is refused outright.
          await provisioner.query(`BEGIN ISOLATION LEVEL ${provisionerLevel}`)
          await provisioner.query('SELECT count(*) FROM worlds')
          await expect(touch(provisioner, city.cityId)).rejects.toThrow(ADVANCE_ONLY)
          await provisioner.query('ROLLBACK')
          // The plain claim waits for the intent, then is refused.
          await provisioner.query(`BEGIN ISOLATION LEVEL ${provisionerLevel}`)
          await provisioner.query('SELECT count(*) FROM worlds')
          const claim = outcome(insertWorld(provisioner, randomUUID(), city.cityId, city.instance))
          await waitingForLock(pids[1])
          await legacy.query('COMMIT')
          expect(String(await claim)).toMatch('an existing city cannot be taken over')
        } finally {
          await release()
        }
        expect(await count('activation_intents')).toBe(1)
        expect(await count('worlds')).toBe(0)
        expect(await worldsHoldingIntents()).toBe(0)
      })

    for (const legacyLevel of LEVELS)
      it(`H1f: a ${legacyLevel} legacy writer whose snapshot predates a world registration cannot write into a world's city`, async () => {
        await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
        const old = await addCity(t.db, 'staging')
        // Created before the legacy snapshots below, which must see them.
        const [first, second] = [await addIdentity(t.db), await addIdentity(t.db)]
        const { clients: [legacy], release } = await connections(1)
        try {
          // A takeover of an old city fails while the legacy snapshot is held, so that city stays a plain one and takes the intent.
          await legacy.query(`BEGIN ISOLATION LEVEL ${legacyLevel}`)
          await legacy.query('SELECT count(*) FROM city')
          await expect(inTransaction(async (client) => {
            await touch(client, old.cityId)
            await insertWorld(client, randomUUID(), old.cityId, old.instance)
          })).rejects.toThrow(ADVANCE_ONLY)
          await expect(inTransaction((client) => insertWorld(client, randomUUID(), old.cityId, old.instance))).rejects.toThrow('an existing city cannot be taken over')
          await insertRow(legacy, 'activation_intents', intentIn(first, old.cityId, old.instance))
          await legacy.query('COMMIT')

          // A genuine world registered and committed while the legacy snapshot is held.
          await legacy.query(`BEGIN ISOLATION LEVEL ${legacyLevel}`)
          await legacy.query('SELECT count(*) FROM city')
          const world = await addWorld('staging')
          await expect(insertRow(legacy, 'activation_intents', intentIn(second, world.cityId, world.instance))).rejects.toThrow(
            legacyLevel === 'READ COMMITTED' ? "a world's city holds no Rare Friends activation records" : 'an activation intent can only be issued for a canonical or rehearsal city',
          )
          await legacy.query('ROLLBACK')
        } finally {
          await release()
        }
        expect(await count('worlds')).toBe(1)
        expect(await count('activation_intents')).toBe(1)
        expect(await worldsHoldingIntents()).toBe(0)
      })

    it('provisioning worlds alongside Rare Friends activation and a refused stamp change completes without deadlock', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      await populateLegacyCity()
      await addWorld('staging')
      const instance = (await t.db.query<{ instance_id: string }>(`SELECT instance_id FROM city WHERE id = 'main'`)).rows[0].instance_id
      // As the service does it: each intent issued in its own transaction, then committed under the city lock.
      const inputs = [
        { identity: await addIdentity(t.db), instance, tokenId: 1000, familyId: 8, ward: 0, plot: 2 },
        { identity: await addIdentity(t.db), instance, tokenId: 1001, familyId: 7, ward: 0, plot: 5 },
      ]
      const issued = inputs.map((input) => intentColumns(input))
      for (const intent of issued) await insertRow(t.db, 'activation_intents', intent)
      const work = await Promise.allSettled([
        activate(t.db, inputs[0], { issued: issued[0] }),
        ...[1, 2, 3, 4].map(() => addWorld('staging')),
        activate(t.db, inputs[1], { issued: issued[1] }),
        t.db.query(`UPDATE app_meta SET value = 'local' WHERE key = 'environment'`),
      ])
      const failures = work.flatMap((r, i) => (r.status === 'rejected' ? [[i, String(r.reason)]] : []))
      // Only the stamp change is refused, and nothing failed by deadlock or serialization.
      expect(failures).toEqual([[6, expect.stringContaining('keeps its environment stamp')]])
      expect(await count('worlds')).toBe(5)
      expect(await count('properties')).toBe(4)
      expect(await stamp()).toBe('staging')
    })
  })

  describe('world_play_bindings', () => {
    it('binds only to the Play environment this database serves', async () => {
      for (const [environment, allowed] of [
        ['local', ['dev', 'test']],
        ['staging', ['staging']],
        ['production', ['live']],
      ] as const) {
        await t.db.query(`DROP SCHEMA ${t.schema} CASCADE; CREATE SCHEMA ${t.schema}`)
        await migrate(t.db, { dir: MIGRATIONS_DIR, environment })
        for (const playEnvironment of ['dev', 'test', 'staging', 'live']) {
          const attempt = addWorld(environment, { playEnvironment })
          if ((allowed as readonly string[]).includes(playEnvironment)) await expect(attempt, `${environment}/${playEnvironment}`).resolves.toBeDefined()
          else await expect(attempt, `${environment}/${playEnvironment}`).rejects.toThrow('a world binding must be for the Play environment this database serves')
        }
        // Not one of Play's environment names at all (the CHECK behind this is tested with the guards off).
        await expect(addWorld(environment, { playEnvironment: 'production' })).rejects.toThrow('a world binding must be for the Play environment')
      }
    })

    it('refuses every binding in a database without an environment stamp', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })
      await t.db.query(`DELETE FROM app_meta WHERE key = 'environment'`)
      for (const playEnvironment of ['dev', 'test', 'staging', 'live']) await expect(addWorld('local', { playEnvironment })).rejects.toThrow('a world binding must be for the Play environment')
    })

    it('a temporary app_meta cannot change which environment a guard sees', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const client = await t.db.connect()
      try {
        await client.query(`CREATE TEMP TABLE app_meta (key text, value text); INSERT INTO pg_temp.app_meta VALUES ('environment', 'production')`)
        await client.query('BEGIN')
        const { cityId, instance } = await addCity(client, 'staging')
        const worldId = randomUUID()
        await client.query(`INSERT INTO ${t.schema}.worlds (id, city_id, city_instance_id) VALUES ($1, $2, $3)`, [worldId, cityId, instance])
        await expect(client.query(`INSERT INTO ${t.schema}.world_play_bindings (world_id, play_environment, play_game_key, play_installation_id, discord_guild_id) VALUES ($1, 'live', $2, $3, $4)`, [worldId, GAME, randomUUID(), guildId()])).rejects.toThrow('a world binding must be for the Play environment this database serves')
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }
    })

    it('holds one world per installation and one per (environment, game, guild)', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const world = await addWorld('staging')
      await expect(addWorld('staging', { installationId: world.installationId })).rejects.toThrow(/wpb_one_per_installation/)
      await expect(addWorld('staging', { guildId: world.guildId })).rejects.toThrow(/wpb_one_per_guild/)
      // The same server may install a different game.
      await expect(addWorld('staging', { guildId: world.guildId, game: 'another-game' })).resolves.toBeDefined()
      // Simultaneous provisions for one server, or for one installation: exactly one world each.
      const guild = guildId()
      const byGuild = await Promise.allSettled([1, 2, 3, 4].map(() => addWorld('staging', { guildId: guild })))
      expect(byGuild.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect((await t.db.query('SELECT count(*)::int AS n FROM world_play_bindings WHERE discord_guild_id = $1', [guild])).rows[0].n).toBe(1)
      const installation = randomUUID()
      const byInstallation = await Promise.allSettled([1, 2, 3, 4].map(() => addWorld('staging', { installationId: installation })))
      expect(byInstallation.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      // A failed provision leaves nothing behind: not a world, not a binding, not a city.
      expect(await count('worlds')).toBe(4)
      expect(await count('world_play_bindings')).toBe(4)
      expect(await count('city')).toBe(4)
    })

    it('never changes: a reinstall or a change of plan keeps the same world', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const world = await addWorld('staging')
      const other = await addWorld('staging')
      for (const [column, value] of [
        ['world_id', other.worldId],
        ['play_environment', 'dev'],
        ['play_game_key', 'another-game'],
        ['play_installation_id', randomUUID()],
        ['discord_guild_id', guildId()],
        ['bound_at', new Date()],
      ] as const)
        await expect(t.db.query(`UPDATE world_play_bindings SET ${column} = $2 WHERE world_id = $1`, [world.worldId, value]), column).rejects.toThrow('a world binding is permanent')
      // Nor by removing it and binding the world again (staging, not only production).
      await expect(
        inTransaction(async (client) => {
          await client.query('DELETE FROM world_play_bindings WHERE world_id = $1', [world.worldId])
          await insertBinding(client, { ...world, installationId: randomUUID(), guildId: guildId() }, 'staging')
        }),
      ).rejects.toThrow('a world binding is permanent: it cannot be removed')
      // Nothing about a plan or trial is stored, so upgrading has nothing to rewrite.
      const columns = (await t.db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2) ORDER BY column_name`, [t.schema, WORLD_TABLES])).rows.map((r) => r.column_name)
      expect(columns.filter((c) => /plan|trial|tier|paid|subscription|status/.test(c))).toEqual([])
      expect((await t.db.query('SELECT world_id, play_installation_id, discord_guild_id FROM world_play_bindings WHERE world_id = $1', [world.worldId])).rows).toEqual([{ world_id: world.worldId, play_installation_id: world.installationId, discord_guild_id: world.guildId }])
    })

    it('refuses malformed bindings and a binding without its world', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      await expect(addWorld('staging', { game: 'Rare City' })).rejects.toThrow(/wpb_game_key_shape/)
      await expect(addWorld('staging', { game: 'r' })).rejects.toThrow(/wpb_game_key_shape/)
      await expect(addWorld('staging', { guildId: '12345' })).rejects.toThrow(/wpb_guild_id_shape/)
      await expect(addWorld('staging', { guildId: '1234567890123456x' })).rejects.toThrow(/wpb_guild_id_shape/)
      await expect(t.db.query(`INSERT INTO world_play_bindings (world_id, play_environment, play_game_key, play_installation_id, discord_guild_id) VALUES ($1, 'staging', $2, $3, $4)`, [randomUUID(), GAME, randomUUID(), guildId()])).rejects.toMatchObject({ code: '23503' })
      expect(await count('worlds')).toBe(0)
    })

    it('keeps the environment stamp fixed once any binding exists', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })
      // Before any binding a non-production stamp may still change, as it always could.
      await t.db.query(`UPDATE app_meta SET value = 'staging' WHERE key = 'environment'`)
      await t.db.query(`UPDATE app_meta SET value = 'local' WHERE key = 'environment'`)
      await addWorld('local')
      await expect(t.db.query(`UPDATE app_meta SET value = 'staging' WHERE key = 'environment'`)).rejects.toThrow('a database that holds world bindings keeps its environment stamp')
      await expect(t.db.query(`UPDATE app_meta SET key = 'environment-old' WHERE key = 'environment'`)).rejects.toThrow('keeps its environment stamp')
      await expect(t.db.query(`DELETE FROM app_meta WHERE key = 'environment'`)).rejects.toThrow('keeps its environment stamp')
      await expect(t.db.query(`INSERT INTO app_meta (key, value) VALUES ('environment', 'staging') ON CONFLICT (key) DO UPDATE SET value = excluded.value`)).rejects.toThrow('keeps its environment stamp')
      // Other facts about the database are unaffected.
      await t.db.query(`INSERT INTO app_meta (key, value) VALUES ('note', 'a')`)
      await t.db.query(`UPDATE app_meta SET value = 'b' WHERE key = 'note'`)
      await t.db.query(`DELETE FROM app_meta WHERE key = 'note'`)
      expect(await stamp()).toBe('local')
    })
  })

  describe('the environment stamp and a binding, concurrently', () => {
    it('a binding being written makes a stamp change wait, and the change is then refused', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const { clients: [provisioner, operator], pids, release } = await connections(2)
      try {
        await provisioner.query('BEGIN')
        await provision(provisioner, 'staging')
        const change = outcome(operator.query(`UPDATE app_meta SET value = 'local' WHERE key = 'environment'`))
        await waitingForLock(pids[1])
        await provisioner.query('COMMIT')
        expect(String(await change)).toMatch('a database that holds world bindings keeps its environment stamp')
        const removal = outcome(operator.query(`DELETE FROM app_meta WHERE key = 'environment'`))
        expect(String(await removal)).toMatch('keeps its environment stamp')
      } finally {
        await release()
      }
      expect(await stamp()).toBe('staging')
      expect((await t.db.query('SELECT play_environment FROM world_play_bindings')).rows).toEqual([{ play_environment: 'staging' }])
    })

    it('a stamp change being written makes a binding wait, and the binding then sees the new stamp', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const { clients: [operator, provisioner], pids, release } = await connections(2)
      try {
        await operator.query('BEGIN')
        await operator.query(`UPDATE app_meta SET value = 'local' WHERE key = 'environment'`)
        await provisioner.query('BEGIN')
        const { cityId, instance } = await addCity(provisioner, 'staging')
        const world = { worldId: randomUUID(), cityId, instance, installationId: randomUUID(), guildId: guildId() }
        await insertWorld(provisioner, world.worldId, cityId, instance)
        const binding = outcome(insertBinding(provisioner, world, 'staging'))
        await waitingForLock(pids[1])
        await operator.query('COMMIT')
        expect(String(await binding)).toMatch('a world binding must be for the Play environment this database serves')
      } finally {
        await release()
      }
      expect(await stamp()).toBe('local')
      expect(await count('world_play_bindings')).toBe(0)
      expect(await count('worlds')).toBe(0)
    })

    it('outside READ COMMITTED: the stamp cannot be changed at all, and a binding behind a committed change fails to serialize', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      for (const level of ['REPEATABLE READ', 'SERIALIZABLE']) {
        await expect(inTransaction((c) => c.query(`UPDATE app_meta SET value = 'local' WHERE key = 'environment'`), `BEGIN ISOLATION LEVEL ${level}`), level).rejects.toThrow('the environment stamp can only be changed in a READ COMMITTED transaction')
        await expect(inTransaction((c) => c.query(`DELETE FROM app_meta WHERE key = 'environment'`), `BEGIN ISOLATION LEVEL ${level}`), level).rejects.toThrow('READ COMMITTED')
      }
      expect(await stamp()).toBe('staging')

      const { clients: [provisioner], release } = await connections(1)
      try {
        await provisioner.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
        await provisioner.query('SELECT count(*) FROM worlds')
        // The stamp moves (no binding exists yet) after the provisioner's snapshot was taken.
        await t.db.query(`UPDATE app_meta SET value = 'local' WHERE key = 'environment'`)
        await expect(provision(provisioner, 'staging')).rejects.toMatchObject({ code: '40001' })
      } finally {
        await release()
      }
      expect(await count('world_play_bindings')).toBe(0)
    })
  })

  describe('world_config_versions', () => {
    it('stores Play\'s canonical text under Play\'s own configHash (golden vectors from Play\'s canonicalJson)', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const world = await addWorld('staging')
      for (const [i, v] of PLAY_VECTORS.entries()) {
        // The vector is self-consistent: Play's hash is the SHA-256 of Play's text as UTF-8.
        expect(sha256(v.canonical), v.name).toBe(v.hash)
        await addConfig(world, i + 1, { config_canonical: v.canonical, config_hash: v.hash })
      }
      await addConfig(world, PLAY_VECTORS.length + 1, { verdict: 'rejected', rejection: { code: 'district_removed', district: 'd2' } })
      const rows = (await t.db.query('SELECT version, config_canonical, config_hash, verdict, rejection FROM world_config_versions ORDER BY version')).rows
      expect(rows.slice(0, PLAY_VECTORS.length).map((r) => [r.config_canonical, r.config_hash])).toEqual(PLAY_VECTORS.map((v) => [v.canonical, v.hash]))
      expect(rows.map((r) => r.verdict)).toEqual([...PLAY_VECTORS.map(() => 'accepted'), 'rejected'])
      expect(rows[rows.length - 1].rejection).toEqual({ code: 'district_removed', district: 'd2' })
      // Postgres cannot stand in for Play's canonicalizer: jsonb orders keys by length and spaces its output.
      const rendered = (await t.db.query<{ text: string }>('SELECT ($1::jsonb)::text AS text', [PLAY_VECTORS[2].canonical])).rows[0].text
      expect(rendered).not.toBe(PLAY_VECTORS[2].canonical)
    })

    it('refuses any other rendering of a Play document under Play\'s configHash', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const world = await addWorld('staging')
      const [order, nested, utf16, numbers] = PLAY_VECTORS
      const renderings: [string, string, string][] = [
        ['insertion order', '{"version":1,"contract":"test-config/1"}', order.hash],
        ['whitespace', '{ "contract": "test-config/1", "version": 1 }', order.hash],
        ['trailing newline', `${order.canonical}\n`, order.hash],
        ['nested key order', '{"list":[{"b":true,"a":null}],"name":"Café ☕","nested":{"z":1,"a":[3,2,1]}}', nested.hash],
        ['code point key order', '{"":10,"10":8,"9":9,"A":5,"_":7,"a":6,"z":3,"é":4,"～":1,"😀":2}', utf16.hash],
        ['escaped non-ASCII', '{"list":[{"a":null,"b":true}],"name":"Caf\\u00e9 \\u2615","nested":{"a":[3,2,1],"z":1}}', nested.hash],
        ['number spelling', '{"a":1.0,"b":-0,"c":1E21,"d":0.1,"e":5e-7,"f":123456789012,"g":-1.5e-10,"h":2.5e3}', numbers.hash],
        ['jsonb rendering', (await t.db.query<{ text: string }>('SELECT ($1::jsonb)::text AS text', [utf16.canonical])).rows[0].text, utf16.hash],
      ]
      for (const [name, text, hash] of renderings) await expect(addConfig(world, 1, { config_canonical: text, config_hash: hash }), name).rejects.toThrow('a configuration version must match its hash')
      expect(await count('world_config_versions')).toBe(0)
    })

    it('does not itself prove the text is canonical: that is the importer\'s duty', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const world = await addWorld('staging')
      // Self-consistent but not Play's canonical form (unsorted, spaced, a repeated key). The database accepts it;
      // its hash then cannot equal the configHash Play published, which is what the importer must compare.
      const text = '{ "z": 1, "a": 2, "a": 3 }'
      await addConfig(world, 1, { config_canonical: text, config_hash: sha256(text) })
      expect((await t.db.query('SELECT config_canonical FROM world_config_versions')).rows).toEqual([{ config_canonical: text }])
    })

    it('refuses a copy that does not match its hash, or is malformed, or is larger than Play allows', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const world = await addWorld('staging')
      await expect(addConfig(world, 1, { config_hash: sha256(String(configRow(world, 1).config_canonical)).toUpperCase() })).rejects.toThrow('a configuration version must match its hash')
      await expect(addConfig(world, 1, { config_canonical: '[]', config_hash: sha256('[]') })).rejects.toThrow(/wcv_config_is_object/)
      await expect(addConfig(world, 1, { config_canonical: '{"a":', config_hash: sha256('{"a":') })).rejects.toMatchObject({ code: '22P02' })
      // Play's limit is 64 KiB of canonical JSON as UTF-8: exactly that is accepted, one byte more is not.
      const sized = (bytes: number) => `{"blob":"${'x'.repeat(bytes - 11)}"}`
      expect(Buffer.byteLength(sized(65_536))).toBe(65_536)
      await expect(addConfig(world, 1, { config_canonical: sized(65_537), config_hash: sha256(sized(65_537)) })).rejects.toThrow('larger than Play allows')
      const multibyte = `{"blob":"${'é'.repeat(32_763)}"}`
      expect(Buffer.byteLength(multibyte)).toBe(65_537)
      await expect(addConfig(world, 1, { config_canonical: multibyte, config_hash: sha256(multibyte) })).rejects.toThrow('larger than Play allows')
      await expect(addConfig(world, 0)).rejects.toThrow(/wcv_version_positive/)
      await expect(addConfig(world, 1, { schema_version: 0 })).rejects.toThrow(/wcv_schema_positive/)
      await expect(addConfig(world, 1, { verdict: 'pending' })).rejects.toThrow(/wcv_verdict_known/)
      await expect(addConfig(world, 1, { verdict: 'rejected' })).rejects.toThrow(/wcv_rejection_shape/)
      await expect(addConfig(world, 1, { rejection: { code: 'x' } })).rejects.toThrow(/wcv_rejection_shape/)
      await expect(addConfig(world, 1, { verdict: 'rejected', rejection: JSON.stringify(['x']) })).rejects.toThrow(/wcv_rejection_shape/)
      await expect(addConfig(world, 1, { judged_by: '' })).rejects.toThrow(/wcv_judged_by_shape/)
      expect(await count('world_config_versions')).toBe(0)
      await addConfig(world, 1, { config_canonical: sized(65_536), config_hash: sha256(sized(65_536)) })
      expect(await count('world_config_versions')).toBe(1)
    })

    it('belongs to its own world: another world\'s installation is refused, and versions are numbered per world', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const a = await addWorld('staging')
      const b = await addWorld('staging')
      await expect(addConfig(a, 1, { play_installation_id: b.installationId })).rejects.toThrow(/wcv_world_installation/)
      await expect(addConfig(a, 1, { play_installation_id: randomUUID() })).rejects.toThrow(/wcv_world_installation/)
      await expect(addConfig({ ...a, worldId: randomUUID() }, 1)).rejects.toThrow(/wcv_world_installation/)
      await addConfig(a, 1)
      await addConfig(b, 1)
      await expect(addConfig(a, 1)).rejects.toMatchObject({ code: '23505' })
      expect(await count('world_config_versions')).toBe(2)
    })

    it('is immutable, and in production permanent', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const world = await addWorld('staging')
      await addConfig(world, 1)
      for (const set of [`verdict = 'rejected', rejection = '{"code":"x"}'`, `config_canonical = '{}', config_hash = '${sha256('{}')}'`, 'version = 2', 'recorded_at = now()'])
        await expect(t.db.query(`UPDATE world_config_versions SET ${set} WHERE world_id = $1`, [world.worldId]), set).rejects.toThrow('a configuration version is permanent: it cannot be changed')
      expect((await t.db.query('DELETE FROM world_config_versions WHERE world_id = $1', [world.worldId])).rowCount).toBe(1)

      await t.db.query(`DROP SCHEMA ${t.schema} CASCADE; CREATE SCHEMA ${t.schema}`)
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'production' })
      const live = await addWorld('production')
      await addConfig(live, 1)
      await expect(t.db.query('DELETE FROM world_config_versions')).rejects.toThrow('a production copy cannot be removed')
    })
  })

  describe('world_config_adoptions', () => {
    it('adopts accepted versions in a consecutive, per-world order, including an earlier version again', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const a = await addWorld('staging')
      const b = await addWorld('staging')
      for (const v of [1, 2, 3]) await addConfig(a, v)
      await addConfig(b, 1)
      await adopt(a, 1, 1)
      await adopt(a, 2, 3)
      // Play can re-activate an earlier version; that is a new adoption, not a rewrite.
      await adopt(a, 3, 1)
      await adopt(b, 1, 1)
      expect((await t.db.query('SELECT adoption_seq, version FROM world_config_adoptions WHERE world_id = $1 ORDER BY adoption_seq', [a.worldId])).rows).toEqual([
        { adoption_seq: 1, version: 1 },
        { adoption_seq: 2, version: 3 },
        { adoption_seq: 3, version: 1 },
      ])
      await expect(adopt(a, 5, 2)).rejects.toThrow('adoptions are numbered consecutively from 1 for each world')
      await expect(adopt(a, 3, 2)).rejects.toThrow('adoptions are numbered consecutively')
      await expect(adopt(b, 0, 1)).rejects.toThrow('adoptions are numbered consecutively')
    })

    it('adopts only an accepted version of its own world', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const a = await addWorld('staging')
      const b = await addWorld('staging')
      await addConfig(a, 1)
      await addConfig(a, 2, { verdict: 'rejected', rejection: { code: 'incompatible' } })
      await expect(adopt(a, 1, 2)).rejects.toThrow('only an accepted configuration version can be adopted')
      await expect(adopt(a, 1, 9)).rejects.toMatchObject({ code: '23503' })
      // World b has no version 1 of its own; world a's does not count.
      await expect(adopt(b, 1, 1)).rejects.toMatchObject({ code: '23503' })
      await expect(t.db.query('INSERT INTO world_config_adoptions (world_id, adoption_seq, version) VALUES ($1, 1, 1)', [randomUUID()])).rejects.toMatchObject({ code: '23503' })
      expect(await count('world_config_adoptions')).toBe(0)
    })

    it('is append-only, and in production permanent', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const world = await addWorld('staging')
      await addConfig(world, 1)
      await addConfig(world, 2)
      await adopt(world, 1, 1)
      await expect(t.db.query('UPDATE world_config_adoptions SET version = 2 WHERE world_id = $1', [world.worldId])).rejects.toThrow('an adoption cannot be changed')
      await expect(t.db.query('UPDATE world_config_adoptions SET adopted_at = now() WHERE world_id = $1', [world.worldId])).rejects.toThrow('an adoption cannot be changed')
      // An adopted version's copy cannot be removed from under its adoption.
      await expect(t.db.query('DELETE FROM world_config_versions WHERE world_id = $1 AND version = 1', [world.worldId])).rejects.toMatchObject({ code: '23503' })

      await t.db.query(`DROP SCHEMA ${t.schema} CASCADE; CREATE SCHEMA ${t.schema}`)
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'production' })
      const live = await addWorld('production')
      await addConfig(live, 1)
      await adopt(live, 1, 1)
      await expect(t.db.query('DELETE FROM world_config_adoptions')).rejects.toThrow('a production adoption cannot be removed')
    })
  })

  it('every constraint on the world tables stands on its own, with the guards off', async () => {
    await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
    const world = await addWorld('staging')
    const tables = ['app_meta', 'city', ...WORLD_TABLES]
    for (const table of tables) await t.db.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`)
    try {
      const bind = (playEnvironment: string, game: string, guild: string) =>
        t.db.query(`INSERT INTO world_play_bindings (world_id, play_environment, play_game_key, play_installation_id, discord_guild_id) VALUES ($1, $2, $3, $4, $5)`, [world.worldId, playEnvironment, game, randomUUID(), guild])
      await t.db.query('DELETE FROM world_play_bindings')
      await expect(bind('production', GAME, guildId())).rejects.toThrow(/wpb_environment_known/)
      await expect(bind('staging', 'Rare City', guildId())).rejects.toThrow(/wpb_game_key_shape/)
      await expect(bind('staging', GAME, '12345')).rejects.toThrow(/wpb_guild_id_shape/)
      await bind('staging', GAME, world.guildId)
      const installation = (await t.db.query<{ play_installation_id: string }>('SELECT play_installation_id FROM world_play_bindings')).rows[0].play_installation_id
      const bound = { ...world, installationId: installation }
      await expect(addConfig(bound, 1, { config_hash: sha256('{}').toUpperCase() })).rejects.toThrow(/wcv_hash_shape/)
      await expect(addConfig(bound, 1, { config_canonical: '[]' })).rejects.toThrow(/wcv_config_is_object/)
      await expect(addConfig(bound, 0)).rejects.toThrow(/wcv_version_positive/)
      await expect(addConfig(bound, 1, { verdict: 'rejected' })).rejects.toThrow(/wcv_rejection_shape/)
      await addConfig(bound, 1)
      await expect(t.db.query('INSERT INTO world_config_adoptions (world_id, adoption_seq, version) VALUES ($1, 0, 1)', [world.worldId])).rejects.toThrow(/wca_seq_positive/)
      await expect(t.db.query('INSERT INTO world_config_adoptions (world_id, adoption_seq, version) VALUES ($1, 1, 2)', [world.worldId])).rejects.toThrow(/wca_version/)
      await expect(insertWorld(t.db, randomUUID(), world.cityId, world.instance)).rejects.toThrow(/worlds_one_per_city/)
    } finally {
      for (const table of tables) await t.db.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`)
    }
  })

  it('worlds beside the Rare Friends city leave its rows, its verification and its activation untouched', async () => {
    await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
    await populateLegacyCity()
    const report = await verifyCity(t.db)
    const before = await legacySnapshot()
    const a = await addWorld('staging')
    const b = await addWorld('staging')
    await addConfig(a, 1)
    await adopt(a, 1, 1)
    await addConfig(b, 1, { verdict: 'rejected', rejection: { code: 'x' } })
    const after = await legacySnapshot()
    // Only the two new world city rows were added; every legacy row is byte-identical.
    for (const table of Object.keys(LEGACY).filter((k) => k !== 'city')) expect(after[table], table).toBe(before[table])
    const legacyCity = async () => JSON.stringify((await t.db.query(`SELECT id, instance_id, sequence, state::text AS state FROM city WHERE id = 'main'`)).rows)
    expect(JSON.parse(after.city).filter((c: { id: string }) => c.id === 'main')).toEqual(JSON.parse(before.city))
    // The Rare Friends city verifies exactly as before. The two worlds here are bare rows written by hand (a legacy
    // state, no founding event, a test document), not worlds the store founded, and the world-aware verifier says so.
    const verified = await verifyCity(t.db)
    expect({ city: verified.city, counts: verified.counts }).toEqual({ city: report.city, counts: report.counts })
    expect(verified.worlds.map((w) => w.id).sort()).toEqual([a.worldId, b.worldId].sort())
    expect([...new Set(verified.violations.map((v) => v.category))]).toEqual(['worlds'])
    expect(verified.violations.filter((v) => v.category !== 'worlds')).toEqual([])
    const main = await legacyCity()
    // The legacy city still activates exactly as before, through the guards that refuse a world's city.
    const identity = await addIdentity(t.db)
    const instance = (await t.db.query<{ instance_id: string }>(`SELECT instance_id FROM city WHERE id = 'main'`)).rows[0].instance_id
    const done = await activate(t.db, { identity, instance, tokenId: 1000, familyId: 8, ward: 0, plot: 2 })
    expect(done.sequence).toBe(4)
    expect(await legacyCity()).not.toBe(main)
  })
})
