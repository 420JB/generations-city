/**
 * Runs the BUILT server app for the server-mode browser tests. Three servers:
 *
 * - the familiar demo-fixture city, on E2E_PORT;
 * - an EMPTY activation rehearsal city (genesis state), on E2E_PORT + 1;
 * - another empty rehearsal city with ACTIVATION_ENABLED=true, on E2E_PORT + 2, which is
 *   the only one where a Friend can be activated (activation.spec.ts).
 *
 * It takes a disposable *_test database, creates a throwaway schema per server, then uses
 * the same commands a deploy would (`migrate`, an explicit city install, `main`). Those
 * schemas are the only thing it ever drops.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import pg from 'pg'
import { resolveTestDatabase } from '../server/tests/testDb.ts'
import { E2E_STATE_FILE, type E2EState } from './harness.ts'

const port = process.env.E2E_PORT ?? '4319'
const emptyPort = String(Number(port) + 1)
const livePort = String(Number(port) + 2)
const target = resolveTestDatabase({ ...process.env, REQUIRE_DB_TESTS: '1' })
if (!('url' in target)) throw new Error('unreachable')

const admin = new pg.Client({ connectionString: target.url })
await admin.connect()
// Schemas left behind by a run that was killed before it could clean up.
const stale = await admin.query<{ nspname: string }>(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'e2e\\_%'`)
for (const row of stale.rows) await admin.query(`DROP SCHEMA ${row.nspname} CASCADE`)
const schema = `e2e_${Date.now().toString(36)}`
const emptySchema = `${schema}_empty`
const liveSchema = `${schema}_live`
const schemas = [schema, emptySchema, liveSchema]
for (const name of schemas) await admin.query(`CREATE SCHEMA ${name}`)
const dropSchemas = async () => {
  for (const name of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`).catch(() => undefined)
}

const url = new URL(target.url)
url.searchParams.set('options', `-c search_path=${schema}`)
const emptyUrl = new URL(target.url)
emptyUrl.searchParams.set('options', `-c search_path=${emptySchema}`)
const liveUrl = new URL(target.url)
liveUrl.searchParams.set('options', `-c search_path=${liveSchema}`)
// Ownership comes from the deterministic fixture provider: these tests never touch a chain or a real wallet.
// Rate limits are off: every test is the same client and signs in far faster than a visitor would. Only local
// mode accepts that, and the limits have their own tests in server/tests.
const env = { ...process.env, APP_MODE: 'local', NODE_ENV: 'test', PORT: port, HOST: '127.0.0.1', DATABASE_URL: url.toString(), PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, OWNERSHIP_PROVIDER: 'fixture', ROBINHOOD_RPC_URL: 'http://127.0.0.1:1/unused', RATE_LIMITS: 'off', TRUSTED_PROXY: 'none', FRAME_ANCESTORS: '', HSTS_MAX_AGE: '' }

const emptyEnv = { ...env, PORT: emptyPort, DATABASE_URL: emptyUrl.toString(), PUBLIC_ORIGIN: `http://127.0.0.1:${emptyPort}` }
// The one server with activation switched on. Its ownership is still the fixture and its city a throwaway.
const liveEnv = { ...env, PORT: livePort, DATABASE_URL: liveUrl.toString(), PUBLIC_ORIGIN: `http://127.0.0.1:${livePort}`, ACTIVATION_ENABLED: 'true' }

// The empty city is installed by a test helper: the operator's rehearsal installer only runs on staging.
const steps: [string, string[], NodeJS.ProcessEnv][] = [
  [process.execPath, ['dist-server/migrate.js'], env],
  [process.execPath, ['dist-server/seed-demo.js', '--non-canonical'], env],
  [process.execPath, ['dist-server/migrate.js'], emptyEnv],
  ['node_modules/.bin/tsx', ['server/tests/installEmptyCity.ts'], emptyEnv],
  [process.execPath, ['dist-server/migrate.js'], liveEnv],
  ['node_modules/.bin/tsx', ['server/tests/installEmptyCity.ts'], liveEnv],
]
for (const [command, args, runEnv] of steps) {
  const result = spawnSync(command, args, { env: runEnv, stdio: 'inherit' })
  if (result.status !== 0) {
    await dropSchemas()
    await admin.end()
    throw new Error(`${args[0]} failed`)
  }
}

mkdirSync('test-artifacts', { recursive: true })
writeFileSync(E2E_STATE_FILE, JSON.stringify({ databaseUrl: url.toString(), schema, activationDatabaseUrl: liveUrl.toString() } satisfies E2EState))

const servers: ChildProcess[] = [env, emptyEnv, liveEnv].map((serverEnv) => spawn(process.execPath, ['dist-server/main.js'], { env: serverEnv, stdio: 'inherit' }))

let closing = false
async function shutdown(code: number) {
  if (closing) return
  closing = true
  for (const server of servers) server.kill('SIGTERM')
  await Promise.all(servers.map((server) => new Promise((done) => (server.exitCode === null ? server.once('exit', done) : done(null)))))
  await dropSchemas()
  await admin.end().catch(() => undefined)
  process.exit(code)
}
process.on('SIGTERM', () => void shutdown(0))
process.on('SIGINT', () => void shutdown(0))
for (const server of servers) server.on('exit', (code) => void shutdown(code ?? 1))
