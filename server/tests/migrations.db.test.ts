import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { databaseStatus, loadMigrations, migrate } from '../src/db/migrations'
import { createPool } from '../src/db/pool'
import { silentLogger } from '../src/log'
import { resolveTestDatabase, testSchemaName } from './testDb'

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../migrations')
const FOUNDATION = '0001_foundation.sql'

const target = resolveTestDatabase(process.env)

// A skip must be loud: this runs only when the suite below does not.
it.runIf('skip' in target)('database tests are skipped, and say why', () => {
  // Written straight to stderr: the test runner hides console output from passing tests.
  process.stderr.write(`\n[db tests] SKIPPED: ${'skip' in target ? target.skip : ''}. Point TEST_DATABASE_URL at a disposable *_test database to run them (see server/README.md).\n`)
})

describe.skipIf('skip' in target)('migrations against a disposable Postgres', () => {
  const url = 'url' in target ? target.url : ''
  let admin: pg.Pool
  let db: pg.Pool
  let schema: string
  const dirs: string[] = []

  beforeAll(() => {
    admin = new pg.Pool({ connectionString: url, max: 1 })
  })
  afterAll(async () => {
    await admin.end()
  })

  // Every test gets an empty schema of its own; dropping it is the only cleanup.
  beforeEach(async () => {
    schema = testSchemaName()
    await admin.query(`CREATE SCHEMA ${schema}`)
    db = createPool(url, silentLogger, { searchPath: schema })
  })
  afterEach(async () => {
    await db.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  })

  /** The real foundation migration plus extra files, in a temp directory. */
  async function dirWith(extra: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'rc-migrations-'))
    dirs.push(dir)
    await copyFile(join(MIGRATIONS_DIR, FOUNDATION), join(dir, FOUNDATION))
    await Promise.all(Object.entries(extra).map(([name, sql]) => writeFile(join(dir, name), sql)))
    return dir
  }

  const tables = async () => (await db.query<{ tablename: string }>('SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename', [schema])).rows.map((r) => r.tablename)
  const versions = async () => (await db.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version)

  it('applies every checked-in migration to an empty database and records it', async () => {
    const shipped = await loadMigrations(MIGRATIONS_DIR)
    const result = await migrate(db, { dir: MIGRATIONS_DIR, environment: 'local' })
    expect(result).toEqual({ applied: shipped.map((m) => m.version), current: shipped.length })
    expect(await tables()).toEqual(expect.arrayContaining(['app_meta', 'schema_migrations']))
    const rows = (await db.query('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version')).rows
    expect(rows.map((r) => [r.version, r.name, r.checksum])).toEqual(shipped.map((m) => [m.version, m.name, m.checksum]))
    expect(rows[0].applied_at).toBeInstanceOf(Date)
    expect((await db.query(`SELECT value FROM app_meta WHERE key = 'environment'`)).rows).toEqual([{ value: 'local' }])
  })

  it('is idempotent: a second run applies nothing', async () => {
    await migrate(db, { dir: MIGRATIONS_DIR, environment: 'local' })
    const again = await migrate(db, { dir: MIGRATIONS_DIR, environment: 'local' })
    expect(again.applied).toEqual([])
    expect(await versions()).toEqual((await loadMigrations(MIGRATIONS_DIR)).map((m) => m.version))
  })

  it('applies only what is new when a later migration is added', async () => {
    await migrate(db, { dir: MIGRATIONS_DIR, environment: 'local' })
    const dir = await dirWith({ '0002_notes.sql': 'CREATE TABLE notes (id bigint PRIMARY KEY, body text NOT NULL);' })
    expect((await migrate(db, { dir, environment: 'local' })).applied).toEqual([2])
    expect(await tables()).toContain('notes')
  })

  it('rolls a failing migration back completely and keeps the earlier ones', async () => {
    const dir = await dirWith({
      '0002_ok.sql': 'CREATE TABLE kept (id integer PRIMARY KEY);',
      '0003_broken.sql': 'CREATE TABLE half_done (id integer PRIMARY KEY);\nINSERT INTO does_not_exist VALUES (1);',
      '0004_never.sql': 'CREATE TABLE never (id integer PRIMARY KEY);',
    })
    await expect(migrate(db, { dir, environment: 'local' })).rejects.toThrow(/Migration 3 \(broken\) failed and was rolled back/)
    expect(await versions()).toEqual([1, 2])
    const present = await tables()
    expect(present).toContain('kept')
    expect(present).not.toContain('half_done')
    expect(present).not.toContain('never')
    // The connection is left usable and the lock released: a fixed run completes.
    await writeFile(join(dir, '0003_broken.sql'), 'CREATE TABLE half_done (id integer PRIMARY KEY);')
    expect((await migrate(db, { dir, environment: 'local' })).applied).toEqual([3, 4])
  })

  it('refuses to run when an applied migration was edited', async () => {
    const dir = await dirWith({ '0002_notes.sql': 'CREATE TABLE notes (id bigint PRIMARY KEY);' })
    await migrate(db, { dir, environment: 'local' })
    await writeFile(join(dir, '0002_notes.sql'), 'CREATE TABLE notes (id bigint PRIMARY KEY, extra text);')
    await expect(migrate(db, { dir, environment: 'local' })).rejects.toThrow(/Migration 2 \(notes\) was edited after it was applied/)
  })

  it('tolerates a database that is ahead of this build (rollback of the service)', async () => {
    const dir = await dirWith({ '0002_notes.sql': 'CREATE TABLE notes (id bigint PRIMARY KEY);' })
    await migrate(db, { dir, environment: 'local' })
    const older = await migrate(db, { dir: MIGRATIONS_DIR, environment: 'local' })
    expect(older).toEqual({ applied: [], current: 2 })
    expect(await databaseStatus(db, { dir: MIGRATIONS_DIR, environment: 'local' })).toEqual({ database: 'ok', migrations: 'ok', environment: 'ok' })
  })

  it('pins the database to its environment and refuses any other, before changing anything', async () => {
    await migrate(db, { dir: MIGRATIONS_DIR, environment: 'staging' })
    const dir = await dirWith({ '0002_notes.sql': 'CREATE TABLE notes (id bigint PRIMARY KEY);' })
    for (const environment of ['production', 'local'] as const)
      await expect(migrate(db, { dir, environment })).rejects.toThrow(`This database belongs to the "staging" environment; refusing to use it as "${environment}".`)
    expect(await versions()).toEqual([1])
    expect(await tables()).not.toContain('notes')
    expect((await migrate(db, { dir, environment: 'staging' })).applied).toEqual([2])
  })

  it('serialises concurrent runners so each migration is applied exactly once', async () => {
    const dir = await dirWith({ '0002_notes.sql': 'CREATE TABLE notes (id bigint PRIMARY KEY);' })
    const results = await Promise.all([1, 2, 3, 4].map(() => migrate(db, { dir, environment: 'local' })))
    expect(results.map((r) => r.applied).sort((a, b) => b.length - a.length)).toEqual([[1, 2], [], [], []])
    expect(await versions()).toEqual([1, 2])
  })

  it('reports readiness: pending before migrating, ok after, mismatch for another environment', async () => {
    const opts = { dir: MIGRATIONS_DIR, environment: 'local' as const }
    expect(await databaseStatus(db, opts)).toEqual({ database: 'ok', migrations: 'pending', environment: 'unknown' })
    await migrate(db, opts)
    expect(await databaseStatus(db, opts)).toEqual({ database: 'ok', migrations: 'ok', environment: 'ok' })
    expect(await databaseStatus(db, { ...opts, environment: 'production' })).toEqual({ database: 'ok', migrations: 'ok', environment: 'mismatch' })
    const dir = await dirWith({ '0002_notes.sql': 'CREATE TABLE notes (id bigint PRIMARY KEY);' })
    expect(await databaseStatus(db, { ...opts, dir })).toEqual({ database: 'ok', migrations: 'pending', environment: 'ok' })
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
