/**
 * Starts the Rare City server for the Proofy Play browser tests, connected to a LOCAL Proofy
 * Play exactly as a deployment would be:
 *
 *   1. as Play's operator: register the `rare-city` game (launch URL = the local launch page)
 *      and a second game, `other-game`, whose run tokens Rare City must refuse; mint Rare
 *      City a fresh service credential;
 *   2. as Rare City: register its configuration schema (`npm run play:register-schema:dev`);
 *   3. start the server (`server/src/main.ts`) with PLAY_API_URL and that credential.
 *
 * No database: opening a city from Play reads Play only.
 */
import { spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { operator, playUrl } from './play.ts'

const repo = resolve(import.meta.dirname, '..')
const port = process.env.CITY_PLAY_SERVER_PORT ?? '4351'
const pagePort = process.env.CITY_PLAY_PAGE_PORT ?? '4352'
const launchUrl = `http://localhost:${pagePort}/`

for (const game of [
  { key: 'rare-city', name: 'Rare City', launchUrl },
  { key: 'other-game', name: 'Other Game', launchUrl: 'http://localhost:9/other-game' },
]) {
  const a = await operator('POST', '/v1/operator/games', { ...game, status: 'active', maxAuthority: 'server_authoritative', minAcceptAuthority: 'server_authoritative' })
  if (a.status === 201) continue
  // Already registered by an earlier run: it must still launch here, or the tests would follow Play elsewhere.
  if (a.status === 409 && a.body.error?.code === 'game_key_conflict') continue
  throw new Error(`could not register ${game.key}: ${a.status} ${JSON.stringify(a.body)}`)
}
const minted = await operator('POST', '/v1/operator/games/rare-city/credentials', {})
if (minted.status !== 201) throw new Error(`could not mint a credential: ${minted.status}`)
const credential = minted.body.secret as string

const env = { ...process.env, APP_MODE: 'local', NODE_ENV: 'test', PORT: port, HOST: '127.0.0.1', PUBLIC_ORIGIN: `http://localhost:${pagePort}`, OWNERSHIP_PROVIDER: 'fixture', ROBINHOOD_RPC_URL: 'http://127.0.0.1:1/unused', RATE_LIMITS: 'off', TRUSTED_PROXY: 'none', DATABASE_URL: '', PLAY_API_URL: playUrl(), PLAY_SERVICE_CREDENTIAL: credential }

const registered = spawnSync('node_modules/.bin/tsx', ['server/src/play-schema-cli.ts'], { cwd: repo, env, encoding: 'utf8' })
process.stdout.write(registered.stdout)
if (registered.status !== 0) throw new Error(`schema registration failed: ${registered.stderr}`)

const server = spawn('node_modules/.bin/tsx', ['server/src/main.ts'], { cwd: repo, env, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.kill(signal))
server.on('exit', (code) => process.exit(code ?? 0))
