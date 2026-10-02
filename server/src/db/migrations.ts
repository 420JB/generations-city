import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { PoolClient } from 'pg'
import type { AppMode } from '../config'
import type { Database } from './pool'

/**
 * Plain SQL migrations.
 *
 * Files are `NNNN_snake_case_name.sql`, numbered 0001, 0002, ... with no gaps or repeats.
 * They are forward-only: each runs once, in order, inside its own transaction together
 * with its `schema_migrations` row, so a failing migration leaves nothing behind. An
 * applied file must never be edited; its checksum is verified on every run.
 */
export interface Migration {
  version: number
  name: string
  sql: string
  checksum: string
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationError'
  }
}

const FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/
/** The runner owns the transaction; a migration that manages its own would escape it. */
const TRANSACTION_CONTROL = /^\s*(begin|commit|rollback|start\s+transaction)\b\s*(?:transaction|work)?\s*;/im
/** Serializes concurrent runners (two deploys, or a deploy and a developer). */
const ADVISORY_LOCK_KEY = 7_266_001

/** npm scripts and the deployed commands all run from the repository root. */
export function defaultMigrationsDir(): string {
  return resolve(process.cwd(), 'server/migrations')
}

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '')
}

export async function loadMigrations(dir: string): Promise<Migration[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  const migrations: Migration[] = []
  for (const file of entries) {
    const match = FILE_PATTERN.exec(file)
    if (!match) throw new MigrationError(`Migration file "${file}" must be named NNNN_snake_case_name.sql.`)
    const version = Number(match[1])
    const expected = migrations.length + 1
    if (version !== expected) throw new MigrationError(`Migration "${file}" is out of sequence: expected version ${String(expected).padStart(4, '0')}.`)
    // Normalised line endings keep the checksum identical across checkouts.
    const sql = (await readFile(join(dir, file), 'utf8')).replace(/\r\n/g, '\n')
    if (!stripComments(sql).trim()) throw new MigrationError(`Migration "${file}" is empty.`)
    if (TRANSACTION_CONTROL.test(stripComments(sql))) throw new MigrationError(`Migration "${file}" must not contain transaction control; the runner wraps it in one.`)
    migrations.push({ version, name: match[2], sql, checksum: createHash('sha256').update(sql).digest('hex') })
  }
  return migrations
}

interface AppliedRow {
  version: number
  checksum: string
}

/** Compare what the database has applied with what this build ships. Throws on any divergence. */
function pendingAfter(applied: AppliedRow[], migrations: Migration[]): Migration[] {
  applied.forEach((row, i) => {
    if (row.version !== i + 1) throw new MigrationError(`schema_migrations has a gap before version ${row.version}.`)
    const known = migrations[i]
    // A database ahead of this build is expected during a rollback; it is not an error.
    if (known && known.checksum !== row.checksum) throw new MigrationError(`Migration ${known.version} (${known.name}) was edited after it was applied.`)
  })
  return migrations.slice(applied.length)
}

export interface MigrateResult {
  applied: number[]
  /** Highest version recorded in the database after this run. */
  current: number
}

/**
 * Apply every pending migration, then stamp the database with the environment it belongs
 * to. A database stamped for one environment refuses to be migrated as another, which
 * stops a staging or local process from being pointed at the production database.
 */
export async function migrate(db: Database, options: { dir: string; environment: AppMode }): Promise<MigrateResult> {
  const migrations = await loadMigrations(options.dir)
  const client = await db.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY])
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version    integer     PRIMARY KEY,
          name       text        NOT NULL,
          checksum   text        NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`)
      const { rows } = await client.query<AppliedRow>('SELECT version, checksum FROM schema_migrations ORDER BY version')
      const pending = pendingAfter(rows, migrations)

      // Refuse before changing anything if this database belongs to another environment.
      if (rows.length > 0) await assertEnvironment(client, options.environment)

      const applied: number[] = []
      for (const m of pending) {
        await client.query('BEGIN')
        try {
          await client.query(m.sql)
          await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [m.version, m.name, m.checksum])
          await client.query('COMMIT')
        } catch (err) {
          // Best effort: if the connection itself died, the server has already rolled back.
          await client.query('ROLLBACK').catch(() => undefined)
          throw new MigrationError(`Migration ${m.version} (${m.name}) failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`)
        }
        applied.push(m.version)
      }

      await client.query(`INSERT INTO app_meta (key, value) VALUES ('environment', $1) ON CONFLICT (key) DO NOTHING`, [options.environment])
      await assertEnvironment(client, options.environment)
      return { applied, current: Math.max(rows.length, migrations.length) }
    } finally {
      // Best effort: a session-level lock is released anyway when the connection closes.
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined)
    }
  } finally {
    client.release()
  }
}

async function assertEnvironment(client: PoolClient, environment: AppMode) {
  const { rows } = await client.query<{ value: string }>(`SELECT value FROM app_meta WHERE key = 'environment'`)
  const stamped = rows[0]?.value
  if (stamped !== undefined && stamped !== environment)
    throw new MigrationError(`This database belongs to the "${stamped}" environment; refusing to use it as "${environment}".`)
}

export interface DatabaseStatus {
  database: 'ok' | 'unreachable'
  migrations: 'ok' | 'pending' | 'unknown'
  environment: 'ok' | 'mismatch' | 'unknown'
}

/** Read-only readiness probe: reachable, fully migrated, and stamped for this environment. */
export async function databaseStatus(db: Database, options: { dir: string; environment: AppMode }): Promise<DatabaseStatus> {
  const migrations = await loadMigrations(options.dir)
  try {
    await db.query('SELECT 1')
  } catch {
    return { database: 'unreachable', migrations: 'unknown', environment: 'unknown' }
  }
  try {
    const applied = await db.query<{ count: string }>('SELECT count(*) AS count FROM schema_migrations')
    const stamp = await db.query<{ value: string }>(`SELECT value FROM app_meta WHERE key = 'environment'`)
    return {
      database: 'ok',
      migrations: Number(applied.rows[0].count) >= migrations.length ? 'ok' : 'pending',
      environment: stamp.rows[0]?.value === options.environment ? 'ok' : 'mismatch',
    }
  } catch (err) {
    // 42P01 = undefined_table: the database is reachable but has never been migrated.
    if ((err as { code?: string }).code === '42P01') return { database: 'ok', migrations: 'pending', environment: 'unknown' }
    return { database: 'unreachable', migrations: 'unknown', environment: 'unknown' }
  }
}
