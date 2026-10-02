import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { databaseStatus, loadMigrations, migrate } from '../src/db/migrations'
import { createPool } from '../src/db/pool'
import { silentLogger } from '../src/log'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'

const NOTES = 'CREATE TABLE notes (id bigint PRIMARY KEY, body text);'

describe.skipIf(NO_TEST_DATABASE)('migrations against a disposable Postgres', () => {
  const t = useTestSchema()
  const versions = async () => (await t.db.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version)
  const shippedVersions = async () => (await loadMigrations(MIGRATIONS_DIR)).map((m) => m.version)
  /** The file name `migrationsPlus` gave the nth extra migration. */
  const extraFile = async (dir: string, n: number) => (await readdir(dir)).find((f) => f.endsWith(`_extra_${n}.sql`))!

  it('applies every checked-in migration to an empty database and records it', async () => {
    const shipped = await loadMigrations(MIGRATIONS_DIR)
    const result = await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })
    expect(result).toEqual({ applied: shipped.map((m) => m.version), current: shipped.length })
    expect(await t.tables()).toEqual(['app_meta', 'auth_challenges', 'city', 'city_events', 'schema_migrations', 'sessions', 'users', 'wallets'])
    const rows = (await t.db.query('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version')).rows
    expect(rows.map((r) => [r.version, r.name, r.checksum])).toEqual(shipped.map((m) => [m.version, m.name, m.checksum]))
    expect(rows[0].applied_at).toBeInstanceOf(Date)
    expect((await t.db.query(`SELECT value FROM app_meta WHERE key = 'environment'`)).rows).toEqual([{ value: 'local' }])
  })

  it('is idempotent: a second run applies nothing', async () => {
    await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })
    const again = await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })
    expect(again.applied).toEqual([])
    expect(await versions()).toEqual(await shippedVersions())
  })

  it('upgrades a database that stopped at the foundation migration', async () => {
    // A P0-A database: only 0001 applied. The next deploy must add the rest and keep the stamp.
    const all = await loadMigrations(MIGRATIONS_DIR)
    await t.db.query(all[0].sql)
    await t.db.query('CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())')
    await t.db.query('INSERT INTO schema_migrations (version, name, checksum) VALUES (1, $1, $2)', [all[0].name, all[0].checksum])
    await t.db.query(`INSERT INTO app_meta (key, value) VALUES ('environment', 'staging')`)
    const result = await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
    expect(result.applied).toEqual(all.slice(1).map((m) => m.version))
    expect(await t.tables()).toEqual(expect.arrayContaining(['city', 'city_events']))
    expect((await t.db.query('SELECT count(*)::int AS n FROM city')).rows[0].n).toBe(0)
  })

  it('applies only what is new when a later migration is added', async () => {
    const before = await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })
    const dir = await t.migrationsPlus([NOTES])
    expect((await migrate(t.db, { dir, environment: 'local' })).applied).toEqual([before.current + 1])
    expect(await t.tables()).toContain('notes')
  })

  it('rolls a failing migration back completely and keeps the earlier ones', async () => {
    const dir = await t.migrationsPlus([
      'CREATE TABLE kept (id integer PRIMARY KEY);',
      'CREATE TABLE half_done (id integer PRIMARY KEY);\nINSERT INTO does_not_exist VALUES (1);',
      'CREATE TABLE never (id integer PRIMARY KEY);',
    ])
    const n = (await shippedVersions()).length
    await expect(migrate(t.db, { dir, environment: 'local' })).rejects.toThrow(new RegExp(`Migration ${n + 2} \\(extra_2\\) failed and was rolled back`))
    expect(await versions()).toEqual([...(await shippedVersions()), n + 1])
    const present = await t.tables()
    expect(present).toContain('kept')
    expect(present).not.toContain('half_done')
    expect(present).not.toContain('never')
    // The connection is left usable and the lock released: a fixed run completes.
    await writeFile(join(dir, await extraFile(dir, 2)), 'CREATE TABLE half_done (id integer PRIMARY KEY);')
    expect((await migrate(t.db, { dir, environment: 'local' })).applied).toEqual([n + 2, n + 3])
  })

  it('refuses to run when an applied migration was edited', async () => {
    const dir = await t.migrationsPlus([NOTES])
    const n = (await shippedVersions()).length
    await migrate(t.db, { dir, environment: 'local' })
    await writeFile(join(dir, await extraFile(dir, 1)), 'CREATE TABLE notes (id bigint PRIMARY KEY, extra text);')
    await expect(migrate(t.db, { dir, environment: 'local' })).rejects.toThrow(`Migration ${n + 1} (extra_1) was edited after it was applied`)
  })

  it('tolerates a database that is ahead of this build (rollback of the service)', async () => {
    const dir = await t.migrationsPlus([NOTES])
    const ahead = await migrate(t.db, { dir, environment: 'local' })
    const older = await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })
    expect(older).toEqual({ applied: [], current: ahead.current })
    expect(await databaseStatus(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })).toEqual({ database: 'ok', migrations: 'ok', environment: 'ok' })
  })

  it('pins the database to its environment and refuses any other, before changing anything', async () => {
    await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
    const dir = await t.migrationsPlus([NOTES])
    for (const environment of ['production', 'local'] as const)
      await expect(migrate(t.db, { dir, environment })).rejects.toThrow(`This database belongs to the "staging" environment; refusing to use it as "${environment}".`)
    expect(await versions()).toEqual(await shippedVersions())
    expect(await t.tables()).not.toContain('notes')
    expect((await migrate(t.db, { dir, environment: 'staging' })).applied).toHaveLength(1)
  })

  it('serialises concurrent runners so each migration is applied exactly once', async () => {
    const dir = await t.migrationsPlus([NOTES])
    const all = (await loadMigrations(dir)).map((m) => m.version)
    const results = await Promise.all([1, 2, 3, 4].map(() => migrate(t.db, { dir, environment: 'local' })))
    expect(results.map((r) => r.applied).sort((a, b) => b.length - a.length)).toEqual([all, [], [], []])
    expect(await versions()).toEqual(all)
  })

  it('reports readiness: pending before migrating, ok after, mismatch for another environment', async () => {
    const opts = { dir: MIGRATIONS_DIR, environment: 'local' as const }
    expect(await databaseStatus(t.db, opts)).toEqual({ database: 'ok', migrations: 'pending', environment: 'unknown' })
    await migrate(t.db, opts)
    expect(await databaseStatus(t.db, opts)).toEqual({ database: 'ok', migrations: 'ok', environment: 'ok' })
    expect(await databaseStatus(t.db, { ...opts, environment: 'production' })).toEqual({ database: 'ok', migrations: 'ok', environment: 'mismatch' })
    const dir = await t.migrationsPlus([NOTES])
    expect(await databaseStatus(t.db, { ...opts, dir })).toEqual({ database: 'ok', migrations: 'pending', environment: 'ok' })
  })

  it('reports an unreachable database without throwing', async () => {
    const dead = createPool('postgres://nobody:nothing@127.0.0.1:1/rarecity_test', silentLogger)
    try {
      expect(await databaseStatus(dead, { dir: MIGRATIONS_DIR, environment: 'local' })).toEqual({ database: 'unreachable', migrations: 'unknown', environment: 'unknown' })
    } finally {
      await dead.end()
    }
  })
})
