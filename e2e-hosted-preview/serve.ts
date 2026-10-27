/**
 * Starts the Districts server for the hosted preview browser tests EXACTLY as a hosted preview runs it, on one machine:
 *
 *   1. as a LOCAL Proofy Play's operator: register `rare-city` with the preview's https:// launch URL and mint a DEV
 *      service credential (a hosted DEV Play's operator does this once);
 *   2. migrate the DISPOSABLE preview database (PREVIEW_DATABASE_URL, a `*_test` database) and register the schema, both
 *      with the full preview environment, as a Railway pre-deploy command would;
 *   3. start the BUILT server (`node dist-server/main.js`, `npm run build:preview` first) with LOCAL_HOSTED_PREVIEW=true,
 *      the committed synthetic world (`hosted-preview/rehearsal-controller-<PREVIEW_CONTROLLER>.json`, a or b), a test
 *      access credential and TRUSTED_PROXY=railway;
 *   4. put the edge stand-in (`edge.ts`: TLS, X-Real-IP overwritten) in front of it at https://localhost:<page port>.
 *
 * Nothing resets the database: a second run (controller b, after a restart) meets the first run's city, as a restarted
 * preview does. Start from empty databases (README.md).
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { operator, playUrl } from '../e2e-city-play/play.ts'
import { startEdge } from './edge.ts'
import { ACCESS_PASSWORD, ACCESS_USER, EDGE_PORT, SERVER_PORT } from './preview.ts'

const repo = resolve(import.meta.dirname, '..')
const origin = `https://localhost:${EDGE_PORT}`
const databaseUrl = process.env.PREVIEW_DATABASE_URL ?? ''
if (!/^postgres(ql)?:\/\/[^/]+\/[^/?]*_test(\?|$)/.test(databaseUrl)) throw new Error('PREVIEW_DATABASE_URL must name a disposable *_test database.')
const variant = process.env.PREVIEW_CONTROLLER ?? 'a'
if (variant !== 'a' && variant !== 'b') throw new Error('PREVIEW_CONTROLLER is a or b.')

const registered = await operator('POST', '/v1/operator/games', { key: 'rare-city', name: 'Rare City', launchUrl: `${origin}/`, status: 'active', maxAuthority: 'server_authoritative', minAcceptAuthority: 'server_authoritative' })
if (registered.status !== 201 && !(registered.status === 409 && registered.body.error?.code === 'game_key_conflict')) throw new Error(`could not register rare-city: ${registered.status}`)
const minted = await operator('POST', '/v1/operator/games/rare-city/credentials', {})
if (minted.status !== 201) throw new Error(`could not mint a credential: ${minted.status}`)

const env: Record<string, string | undefined> = {
  ...process.env,
  LOCAL_HOSTED_PREVIEW: 'true',
  APP_MODE: 'local',
  NODE_ENV: 'production',
  PORT: String(SERVER_PORT),
  HOST: '127.0.0.1',
  PUBLIC_ORIGIN: origin,
  TRUSTED_PROXY: 'railway',
  DATABASE_URL: databaseUrl,
  PLAY_API_URL: playUrl(),
  PLAY_SERVICE_CREDENTIAL: minted.body.secret as string,
  LOCAL_PROPERTY_REHEARSAL_FILE: resolve(repo, `hosted-preview/rehearsal-controller-${variant}.json`),
  PREVIEW_ACCESS_USER: ACCESS_USER,
  PREVIEW_ACCESS_PASSWORD_SHA256: createHash('sha256').update(ACCESS_PASSWORD).digest('hex'),
}
// Nothing of the local test suites' own environment may leak into the profile.
for (const name of ['OWNERSHIP_PROVIDER', 'RATE_LIMITS', 'ACTIVATION_ENABLED', 'FRAME_ANCESTORS', 'HSTS_MAX_AGE', 'CITY_PLAY_DATABASE_URL', 'TEST_DATABASE_URL']) delete env[name]

for (const script of ['dist-server/migrate.js', 'dist-server/play-schema.js']) {
  const run = spawnSync('node', [script], { cwd: repo, env, encoding: 'utf8' })
  process.stdout.write(run.stdout)
  if (run.status !== 0) throw new Error(`${script} failed: ${run.stderr}`)
}

const server = spawn('node', ['dist-server/main.js'], { cwd: repo, env, stdio: 'inherit' })
const edge = await startEdge({ port: EDGE_PORT, upstreamPort: SERVER_PORT })
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    edge.close()
    server.kill(signal)
  })
server.on('exit', (code) => {
  edge.close()
  process.exit(code ?? 0)
})
