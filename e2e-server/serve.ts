/**
 * Runs the BUILT server app for the server-mode browser tests.
 *
 * It takes a disposable *_test database, creates a throwaway schema in it, then uses the
 * same commands a deploy would (`migrate`, the explicit fixture install, `main`). The
 * schema is the only thing it ever drops.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import pg from 'pg'
import { resolveTestDatabase } from '../server/tests/testDb.ts'
import { E2E_STATE_FILE, type E2EState } from './harness.ts'

const port = process.env.E2E_PORT ?? '4319'
const target = resolveTestDatabase({ ...process.env, REQUIRE_DB_TESTS: '1' })
if (!('url' in target)) throw new Error('unreachable')

const admin = new pg.Client({ connectionString: target.url })
await admin.connect()
// Schemas left behind by a run that was killed before it could clean up.
const stale = await admin.query<{ nspname: string }>(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'e2e\\_%'`)
for (const row of stale.rows) await admin.query(`DROP SCHEMA ${row.nspname} CASCADE`)
const schema = `e2e_${Date.now().toString(36)}`
await admin.query(`CREATE SCHEMA ${schema}`)

const url = new URL(target.url)
url.searchParams.set('options', `-c search_path=${schema}`)
const env = { ...process.env, APP_MODE: 'local', NODE_ENV: 'test', PORT: port, HOST: '127.0.0.1', DATABASE_URL: url.toString() }

for (const args of [['dist-server/migrate.js'], ['dist-server/seed-demo.js', '--non-canonical']]) {
  const result = spawnSync(process.execPath, args, { env, stdio: 'inherit' })
  if (result.status !== 0) {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
    throw new Error(`${args[0]} failed`)
  }
}

mkdirSync('test-artifacts', { recursive: true })
writeFileSync(E2E_STATE_FILE, JSON.stringify({ databaseUrl: url.toString(), schema } satisfies E2EState))

const server: ChildProcess = spawn(process.execPath, ['dist-server/main.js'], { env, stdio: 'inherit' })

let closing = false
async function shutdown(code: number) {
  if (closing) return
  closing = true
  server.kill('SIGTERM')
  await new Promise((done) => (server.exitCode === null ? server.once('exit', done) : done(null)))
  await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined)
  await admin.end().catch(() => undefined)
  process.exit(code)
}
process.on('SIGTERM', () => void shutdown(0))
process.on('SIGINT', () => void shutdown(0))
server.on('exit', (code) => void shutdown(code ?? 1))
