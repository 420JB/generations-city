import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadMigrations } from '../src/db/migrations'
import { resolveTestDatabase } from './testDb'

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../migrations')

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function dirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rc-migrations-'))
  dirs.push(dir)
  await Promise.all(Object.entries(files).map(([name, sql]) => writeFile(join(dir, name), sql)))
  return dir
}

describe('checked-in migrations', () => {
  it('load in order with stable checksums', async () => {
    const a = await loadMigrations(MIGRATIONS_DIR)
    const b = await loadMigrations(MIGRATIONS_DIR)
    expect(a.length).toBeGreaterThan(0)
    expect(a.map((m) => m.version)).toEqual(a.map((_, i) => i + 1))
    expect(a[0]).toMatchObject({ version: 1, name: 'foundation' })
    expect(a.map((m) => m.checksum)).toEqual(b.map((m) => m.checksum))
    expect(a[0].checksum).toMatch(/^[0-9a-f]{64}$/)
  })

  it('contain nothing destructive', async () => {
    const destructive = /\b(drop\s+(table|schema|database|column|index|type)|truncate|delete\s+from|alter\s+table\s+\S+\s+drop)\b/i
    for (const file of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql'))) {
      const sql = (await readFile(join(MIGRATIONS_DIR, file), 'utf8')).replace(/--.*$/gm, '')
      expect(destructive.test(sql), `${file} contains a destructive statement`).toBe(false)
    }
  })
})

describe('migration file rules', () => {
  it('ignores non-SQL files and normalises line endings before hashing', async () => {
    const lf = await loadMigrations(await dirWith({ '0001_a.sql': 'CREATE TABLE a (id integer);\n', 'README.md': 'notes' }))
    const crlf = await loadMigrations(await dirWith({ '0001_a.sql': 'CREATE TABLE a (id integer);\r\n' }))
    expect(lf).toHaveLength(1)
    expect(crlf[0].checksum).toBe(lf[0].checksum)
  })

  it('rejects bad names, gaps, duplicates and a sequence that does not start at 0001', async () => {
    await expect(loadMigrations(await dirWith({ 'first.sql': 'SELECT 1;' }))).rejects.toThrow(/must be named/)
    await expect(loadMigrations(await dirWith({ '0001_Add-Users.sql': 'SELECT 1;' }))).rejects.toThrow(/must be named/)
    await expect(loadMigrations(await dirWith({ '0001_a.sql': 'SELECT 1;', '0003_c.sql': 'SELECT 1;' }))).rejects.toThrow(/out of sequence: expected version 0002/)
    await expect(loadMigrations(await dirWith({ '0001_a.sql': 'SELECT 1;', '0001_b.sql': 'SELECT 1;' }))).rejects.toThrow(/out of sequence/)
    await expect(loadMigrations(await dirWith({ '0002_b.sql': 'SELECT 1;' }))).rejects.toThrow(/expected version 0001/)
  })

  it('rejects empty migrations and ones that manage their own transaction', async () => {
    await expect(loadMigrations(await dirWith({ '0001_a.sql': '-- nothing yet\n' }))).rejects.toThrow(/is empty/)
    for (const sql of ['BEGIN;\nCREATE TABLE a (id integer);\nCOMMIT;', 'CREATE TABLE a (id integer);\n  commit ;', 'START TRANSACTION;\nSELECT 1;'])
      await expect(loadMigrations(await dirWith({ '0001_a.sql': sql }))).rejects.toThrow(/transaction control/)
    // A plpgsql body's BEGIN ... END is not transaction control.
    const fn = 'CREATE FUNCTION f() RETURNS integer AS $$\nBEGIN\n  RETURN 1;\nEND;\n$$ LANGUAGE plpgsql;'
    await expect(loadMigrations(await dirWith({ '0001_a.sql': fn }))).resolves.toHaveLength(1)
  })
})

describe('test database guard', () => {
  it('skips with a reason when no test database is configured', () => {
    expect(resolveTestDatabase({})).toEqual({ skip: 'TEST_DATABASE_URL is not set' })
    expect(resolveTestDatabase({ DATABASE_URL: 'postgres://u:p@prod/rarecity' })).toEqual({ skip: 'TEST_DATABASE_URL is not set' })
  })

  it('fails instead of skipping when database tests are required', () => {
    expect(() => resolveTestDatabase({ REQUIRE_DB_TESTS: '1' })).toThrow(/REQUIRE_DB_TESTS/)
  })

  it('refuses the application database and any database not named *_test', () => {
    const prod = 'postgres://u:p@prod/rarecity'
    expect(() => resolveTestDatabase({ TEST_DATABASE_URL: prod, DATABASE_URL: prod })).toThrow(/must not be the same/)
    expect(() => resolveTestDatabase({ TEST_DATABASE_URL: prod })).toThrow(/ends in "_test"/)
    expect(() => resolveTestDatabase({ TEST_DATABASE_URL: 'postgres://u:p@prod/rarecity_test', DATABASE_URL: 'postgres://u:p@prod/rarecity_test' })).toThrow(/must not be the same/)
    expect(() => resolveTestDatabase({ TEST_DATABASE_URL: 'mysql://u:p@h/x_test' })).toThrow(/valid postgres/)
    expect(resolveTestDatabase({ TEST_DATABASE_URL: 'postgres://u:p@127.0.0.1:54329/rarecity_test' })).toEqual({ url: 'postgres://u:p@127.0.0.1:54329/rarecity_test' })
  })
})
