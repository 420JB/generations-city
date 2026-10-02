import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import { createPool } from '../src/db/pool'
import { silentLogger } from '../src/log'
import { resolveTestDatabase, testSchemaName } from './testDb'

export const MIGRATIONS_DIR = resolve(import.meta.dirname, '../migrations')

const target = resolveTestDatabase(process.env)
/** Database suites run only against a disposable *_test database; otherwise they skip (loudly, see globalSetup). */
export const NO_TEST_DATABASE = 'skip' in target

export interface TestSchema {
  /** A pool whose search path is this test's own empty schema. */
  db: pg.Pool
  schema: string
  /** A temp directory holding every shipped migration plus `extra` ones numbered after them. */
  migrationsPlus(extra: string[]): Promise<string>
  tables(): Promise<string[]>
}

/** Call inside a `describe`: every test gets an empty schema, and dropping it is the only cleanup. */
export function useTestSchema(): TestSchema {
  const url = 'url' in target ? target.url : ''
  let admin: pg.Pool
  const dirs: string[] = []
  const ctx = {
    async migrationsPlus(extra: string[]) {
      const dir = await mkdtemp(join(tmpdir(), 'rc-migrations-'))
      dirs.push(dir)
      const shipped = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
      await Promise.all(shipped.map((f) => copyFile(join(MIGRATIONS_DIR, f), join(dir, f))))
      await Promise.all(extra.map((sql, i) => writeFile(join(dir, `${String(shipped.length + i + 1).padStart(4, '0')}_extra_${i + 1}.sql`), sql)))
      return dir
    },
    async tables() {
      const { rows } = await ctx.db.query<{ tablename: string }>('SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename', [ctx.schema])
      return rows.map((r) => r.tablename)
    },
  } as TestSchema

  beforeAll(() => {
    admin = new pg.Pool({ connectionString: url, max: 1 })
  })
  afterAll(async () => {
    await admin.end()
  })
  beforeEach(async () => {
    ctx.schema = testSchemaName()
    await admin.query(`CREATE SCHEMA ${ctx.schema}`)
    ctx.db = createPool(url, silentLogger, { searchPath: ctx.schema })
  })
  afterEach(async () => {
    await ctx.db.end()
    await admin.query(`DROP SCHEMA ${ctx.schema} CASCADE`)
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  })
  return ctx
}
