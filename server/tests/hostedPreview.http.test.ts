import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import type { AuthService } from '../src/auth/service'
import type { ServerConfig } from '../src/config'
import { createLogger } from '../src/log'
import { createPlayLaunchService } from '../src/play/launch'
import { createPlaySessionService } from '../src/play/session'
import { createPreviewGate, PREVIEW_CHALLENGE } from '../src/previewGate'
import { createRateLimiter } from '../src/rateLimit'
import { documentCsp } from '../src/securityHeaders'
import { loadStaticSite, type StaticSite } from '../src/static'
import { ADA, DOC_A, fakePlay, GUILD_A, INSTALLATION_A, memorySessions, memoryWorlds } from './fakePlay'
import { testConfig } from './testConfig'

/**
 * THE HOSTED PREVIEW EDGE, over real sockets: the access gate in front of every path and method, the deployed transport
 * rules a local process gets in the profile, and that the gate is never game authority. Raw requests (node:http, not
 * fetch) so paths reach the server exactly as written, unnormalized.
 */
const ORIGIN = 'https://districts-preview.example'
const USER = 'preview'
const PASSWORD = 'k3Qx-preview-password-generated-at-random-9f2c'
const HASH = createHash('sha256').update(PASSWORD).digest()
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
const GOOD = basic(USER, PASSWORD)
const JS = '/assets/index-CeqHFpL0.js'
const CSS = '/assets/index-K34oW2_y.css'
const SHELL = '<!doctype html><title>Districts</title><div id="root">PLAY SHELL</div>'

let siteDir: string
let site: StaticSite
beforeAll(async () => {
  siteDir = await mkdtemp(join(tmpdir(), 'rc-preview-site-'))
  await mkdir(join(siteDir, 'assets'))
  await mkdir(join(siteDir, 'brand-media/samples'), { recursive: true })
  await writeFile(join(siteDir, 'index.html'), SHELL)
  await writeFile(join(siteDir, JS), 'console.log("PLAY BUNDLE")')
  await writeFile(join(siteDir, CSS), 'body{color:red}/*PLAY STYLE*/')
  await writeFile(join(siteDir, 'brand-media/samples/logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg">PLAY MEDIA</svg>')
  site = (await loadStaticSite(siteDir, { privateCache: true }))!
})
afterAll(async () => {
  await rm(siteDir, { recursive: true, force: true })
})

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

const previewConfig = (patch: Partial<ServerConfig> = {}) =>
  testConfig({ publicOrigin: ORIGIN, trustedProxy: 'railway', rateLimits: true, hstsMaxAge: 31_536_000, ownership: 'robinhood', hostedPreview: { accessUser: USER, accessPasswordSha256: HASH }, ...patch })

/** A wallet auth service that must never be reached in a preview. */
function untouchableAuth() {
  const calls: string[] = []
  const no = (name: string) => async () => {
    calls.push(name)
    throw new Error(`${name} reached in a preview`)
  }
  const service: AuthService = { issueChallenge: no('issueChallenge'), verify: no('verify'), logout: no('logout'), viewer: no('viewer'), session: no('session') }
  return { service, calls }
}

async function boot(patch: Partial<ServerConfig> = {}) {
  const logs: string[] = []
  const log = createLogger((line) => logs.push(line))
  const p = fakePlay()
  p.install(INSTALLATION_A, GUILD_A)
  p.publish(INSTALLATION_A, DOC_A)
  const w = memoryWorlds()
  const s = memorySessions()
  const playLaunch = createPlayLaunchService({ play: p.play, environment: 'dev', gameKey: 'rare-city', worlds: w.store })
  const playSessions = createPlaySessionService({ store: s.store, worlds: w.store, play: p.play, environment: 'dev', gameKey: 'rare-city', log, installationCacheMs: 0 })
  const auth = untouchableAuth()
  const config = previewConfig(patch)
  const server = createServer(createApp({ config, db: null, migrationsDir: '/nonexistent', log, site, playLaunch, playSessions, auth: auth.service, limiter: createRateLimiter() }))
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return { port, logs, p, auth }
}

interface Answer {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

/** One raw request: the path is sent exactly as given. */
function ask(port: number, method: string, path: string, headers: Record<string, string | string[]> = {}, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { 'x-real-ip': '203.0.113.7', ...headers }, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const json = { 'content-type': 'application/json' }
const PLAY_CONTENT = ['PLAY SHELL', 'PLAY BUNDLE', 'PLAY STYLE', 'PLAY MEDIA', 'rare-city-server']

function expectRefused(a: Answer, label: string) {
  expect(a.status, label).toBe(401)
  expect(a.headers['www-authenticate'], label).toBe(PREVIEW_CHALLENGE)
  expect(a.headers['cache-control'], label).toBe('no-store')
  expect(a.headers['content-security-policy'], label).toBe("default-src 'none'; frame-ancestors 'none'")
  expect(a.headers['strict-transport-security'], label).toBe('max-age=31536000')
  expect(a.headers['set-cookie'], label).toBeUndefined()
  if (a.body) expect(JSON.parse(a.body), label).toEqual({ error: 'preview_access_required' })
  for (const text of PLAY_CONTENT) expect(a.body, label).not.toContain(text)
}

describe('hosted preview access gate', () => {
  it('refuses every document, asset, API route, fallback and unknown path without the credential', async () => {
    const { port, auth } = await boot()
    const paths = ['/', '/index.html', JS, CSS, '/brand-media/samples/logo.svg', '/play', '/some/spa/route', '/missing.js', '/assets/', '/version', '/v1/city', '/v1/viewer', '/v1/play/city', '/v1/play/rehearsal/assets', '/v1/play/rehearsal/legacy?property=x', '/v1/nope', '/favicon.ico']
    for (const path of paths) for (const method of ['GET', 'HEAD']) expectRefused(await ask(port, method, path), `${method} ${path}`)
    // Every other method, with a body that is never read: closed, refused before routing.
    for (const path of ['/', '/v1/play/session', '/v1/play/rehearsal/constructions', '/v1/auth/challenge', '/health', '/ready', JS])
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const a = await ask(port, method, path, json, JSON.stringify({ runToken: 'x' }))
        expectRefused(a, `${method} ${path}`)
        expect(a.headers.connection, `${method} ${path}`).toBe('close')
      }
    expect(auth.calls).toEqual([])
  })

  it('cannot be bypassed by path spelling, encoding, absolute URLs or forwarding headers', async () => {
    const { port } = await boot()
    const spellings = [
      '//health', '/health/', '/HEALTH', '/health/.', '/health/../index.html', '/health/..%2Findex.html', '/health%2F..%2Findex.html', '/./index.html', '/%2e/index.html',
      '/%2e%2e/index.html', '/%2E%2E/%2E%2E/index.html', '/assets%2Findex-CeqHFpL0.js', '/%61ssets/index-CeqHFpL0.js', '/ready/../', '/health/x', '/healthz', '/ready.json',
      '/health%00', '/health%20', '/%2fhealth', '\\health', '/health;x', 'http://evil.example/index.html', `http://localhost${JS}`, '/v1/../index.html', '/v1/%2e%2e/', '*',
    ]
    for (const path of spellings) {
      const a = await ask(port, 'GET', path)
      // A path that cannot be decoded is refused unread (400: the service's own, or Node's HTTP parser's, with no body);
      // every other one is behind the gate.
      if (a.status === 400) expect(a.body === '' ? {} : JSON.parse(a.body), path).toEqual(a.body === '' ? {} : { error: 'bad_request' })
      else expectRefused(a, path)
      for (const text of PLAY_CONTENT) expect(a.body, path).not.toContain(text)
    }
    const forwarded = {
      'x-forwarded-for': '127.0.0.1',
      'x-forwarded-host': 'localhost',
      'x-forwarded-proto': 'https',
      forwarded: 'for=127.0.0.1;proto=https',
      'x-original-url': '/health',
      'x-rewrite-url': '/health',
      'x-http-method-override': 'GET',
      'x-real-ip': '127.0.0.1',
      'x-forwarded-user': USER,
      'x-remote-user': USER,
      cookie: '__Host-rc_play=anything; rc_preview=1',
    }
    for (const path of ['/', JS, '/v1/play/city']) expectRefused(await ask(port, 'GET', path, forwarded), `forwarded ${path}`)
  })

  it('refuses missing and malformed credentials alike', async () => {
    const { port } = await boot()
    const wrong = [
      '', 'Basic', 'Basic ', 'Bearer x', `Bearer ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`, 'Basic !!!!', 'Basic a', `Basic ${Buffer.from(USER).toString('base64')}`,
      basic(USER, ''), basic('', PASSWORD), basic(USER, `${PASSWORD} `), basic(`${USER} `, PASSWORD), basic(USER.toUpperCase(), PASSWORD), basic(USER, PASSWORD.toUpperCase()), basic(PASSWORD, USER),
      basic(USER, createHash('sha256').update(PASSWORD).digest('hex')), `${GOOD}x`, `${GOOD}=`, `Digest ${GOOD.slice(6)}`, `Basic ${'A'.repeat(600)}`, `Basic  ${GOOD.slice(6)}=`,
    ]
    for (const authorization of wrong) expectRefused(await ask(port, 'GET', '/', { authorization }), JSON.stringify(authorization))
  })

  it('lets the two health probes through, for reads only, and nothing else', async () => {
    const { port } = await boot()
    for (const method of ['GET', 'HEAD']) {
      expect((await ask(port, method, '/health')).status).toBe(200)
      expect((await ask(port, method, '/ready')).status).toBe(200)
      // The same endpoint, spelled with an escape: the router answers exactly what the gate admitted.
      expect((await ask(port, method, '/%68ealth')).status).toBe(200)
    }
    const health = await ask(port, 'GET', '/health')
    expect(JSON.parse(health.body)).toEqual({ status: 'ok' })
    const ready = await ask(port, 'GET', '/ready')
    expect(Object.keys(JSON.parse(ready.body)).sort()).toEqual(['checks', 'status'])
    for (const text of PLAY_CONTENT) expect(health.body + ready.body).not.toContain(text)
  })

  it('serves the real game shell and its assets with the credential, privately cached, under the strict CSP', async () => {
    const { port } = await boot()
    const auth = { authorization: GOOD }
    const shell = await ask(port, 'GET', '/', auth)
    expect(shell.status).toBe(200)
    expect(shell.body).toBe(SHELL)
    expect(shell.headers['content-security-policy']).toBe(documentCsp({ mode: 'local', frameAncestors: [], secure: true }))
    expect(shell.headers['content-security-policy']).toContain("script-src 'self'")
    expect(shell.headers['content-security-policy']).toMatch(/upgrade-insecure-requests$/)
    expect(shell.headers['strict-transport-security']).toBe('max-age=31536000')
    expect(shell.headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(shell.headers['cache-control']).toBe('private, no-cache')
    // The scheme is case-insensitive (RFC 9110); the credential is not.
    expect((await ask(port, 'GET', '/', { authorization: `basic ${GOOD.slice(6)}` })).status).toBe(200)
    const script = await ask(port, 'GET', JS, auth)
    expect(script.status).toBe(200)
    expect(script.body).toContain('PLAY BUNDLE')
    expect(script.headers['cache-control']).toBe('private, max-age=31536000, immutable')
    expect((await ask(port, 'GET', CSS, auth)).headers['cache-control']).toBe('private, max-age=31536000, immutable')
    expect((await ask(port, 'GET', '/brand-media/samples/logo.svg', auth)).headers['cache-control']).toBe('private, max-age=3600')
    // The client-side fallback and an honest 404 behind the gate, as without it.
    expect((await ask(port, 'GET', '/some/spa/route', auth)).body).toBe(SHELL)
    expect((await ask(port, 'GET', '/missing.js', auth)).status).toBe(404)
    expect((await ask(port, 'GET', '/v1/nope', auth)).status).toBe(404)
    expect((await ask(port, 'HEAD', '/', auth)).body).toBe('')
    expect(JSON.parse((await ask(port, 'GET', '/version', auth)).body)).toMatchObject({ mode: 'local' })
  })

  it('limits wrong credentials per client network (X-Real-IP only), never a correct one, and never by a spoofable header', async () => {
    const { port } = await boot()
    const wrong = { authorization: basic(USER, 'guess') }
    for (let i = 0; i < 20; i++) expect((await ask(port, 'GET', '/', { ...wrong, 'x-forwarded-for': `198.51.100.${i}` })).status).toBe(401)
    const limited = await ask(port, 'GET', '/', wrong)
    expect(limited.status).toBe(429)
    expect(JSON.parse(limited.body)).toEqual({ error: 'rate_limited' })
    expect(limited.headers['www-authenticate']).toBeUndefined()
    // Changing every header the client controls but the edge's own: still the same bucket.
    expect((await ask(port, 'GET', '/', { ...wrong, 'x-forwarded-for': '10.0.0.1', forwarded: 'for=10.0.0.2' })).status).toBe(429)
    // A correct credential from that same network still passes, and a first visit (no credential) is never counted.
    expect((await ask(port, 'GET', '/', { authorization: GOOD })).status).toBe(200)
    expect((await ask(port, 'GET', '/')).status).toBe(401)
    // Another client network, as Railway's edge reports it, has its own bucket.
    expect((await ask(port, 'GET', '/', { ...wrong, 'x-real-ip': '203.0.113.8' })).status).toBe(401)
    // A request whose edge address is unusable joins the one shared fallback bucket, never one it names.
    for (let i = 0; i < 20; i++) expect((await ask(port, 'GET', '/', { ...wrong, 'x-real-ip': `not-an-ip-${i}` })).status).toBe(401)
    expect((await ask(port, 'GET', '/', { ...wrong, 'x-real-ip': 'still-not-an-ip' })).status).toBe(429)
  })
})

describe('hosted preview: the gate is never game authority', () => {
  it('a gate credential alone opens no play session, reads no city and reaches no wallet route', async () => {
    const { port, auth } = await boot()
    const a = { authorization: GOOD }
    const city = await ask(port, 'GET', '/v1/play/city', a)
    expect(city.status).toBe(401)
    expect(JSON.parse(city.body)).toEqual({ error: 'play_session_required' })
    // Wallet sign-in, the owned-Friends read and activation are not wired in a preview, whatever the caller built.
    const challenge = await ask(port, 'POST', '/v1/auth/challenge', { ...a, ...json, origin: ORIGIN }, JSON.stringify({ address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', chainId: 4663 }))
    expect(challenge.status).toBe(503)
    expect(JSON.parse(challenge.body)).toEqual({ error: 'auth_unavailable' })
    expect(JSON.parse((await ask(port, 'GET', '/v1/viewer', a)).body)).toEqual({ authenticated: false })
    expect(JSON.parse((await ask(port, 'GET', '/v1/viewer/friends', a)).body)).toEqual({ error: 'not_authenticated' })
    const intent = await ask(port, 'POST', '/v1/activation/intents', { ...a, ...json, origin: ORIGIN }, '{}')
    expect(JSON.parse(intent.body)).toEqual({ error: 'activation_disabled' })
    expect(auth.calls).toEqual([])
  })

  it('a Play launch through the gate sets a Secure __Host- session cookie; the origin and CSRF rules still apply', async () => {
    const { port, p } = await boot()
    const a = { authorization: GOOD }
    const launch = (headers: Record<string, string>) => ask(port, 'POST', '/v1/play/session', { ...a, ...json, ...headers }, JSON.stringify({ runToken: p.launch(INSTALLATION_A, 'Ada', { player: ADA }) }))
    // Another origin, or a cross-site fetch, is refused before Play is asked.
    const foreign: Record<string, string>[] = [{ origin: 'https://evil.example' }, { origin: 'http://districts-preview.example' }, { origin: ORIGIN, 'sec-fetch-site': 'cross-site' }, { origin: ORIGIN, 'sec-fetch-site': 'same-site' }]
    for (const headers of foreign) {
      const refused = await launch(headers)
      expect(refused.status, JSON.stringify(headers)).toBe(403)
      expect(JSON.parse(refused.body)).toEqual({ error: 'origin_mismatch' })
      expect(refused.headers['set-cookie']).toBeUndefined()
    }
    const opened = await launch({ origin: ORIGIN, 'sec-fetch-site': 'same-origin' })
    expect(opened.status).toBe(200)
    expect(opened.headers['cache-control']).toBe('no-store')
    const [cookie] = opened.headers['set-cookie']!
    expect(cookie).toMatch(/^__Host-rc_play=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=\d+$/)
    const session = cookie.split(';')[0]
    // The cookie without the gate is still refused at the gate; with both, the session's city is served.
    expectRefused(await ask(port, 'GET', '/v1/play/city', { cookie: session }), 'cookie without gate')
    const city = await ask(port, 'GET', '/v1/play/city', { ...a, cookie: session })
    expect(city.status).toBe(200)
    expect(city.headers['cache-control']).toBe('no-store')
    // A plain-named cookie, as local mode would set, is not this profile's session.
    expect((await ask(port, 'GET', '/v1/play/city', { ...a, cookie: `rc_play=${session.split('=')[1]}` })).status).toBe(401)
    const out = await ask(port, 'POST', '/v1/play/logout', { ...a, ...json, origin: ORIGIN, cookie: session }, '{}')
    expect(out.headers['set-cookie']).toEqual(['__Host-rc_play=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0'])
  })

  it('never logs or answers with the credential, the password or its hash', async () => {
    const { port, logs } = await boot()
    await ask(port, 'GET', '/', { authorization: GOOD })
    await ask(port, 'GET', JS, { authorization: GOOD })
    await ask(port, 'GET', '/', { authorization: basic(USER, 'guess') })
    await ask(port, 'GET', '/?password=x')
    const refused = await ask(port, 'POST', '/v1/play/session', { authorization: basic(USER, 'guess'), ...json }, '{}')
    const text = logs.join('\n') + refused.body + JSON.stringify(refused.headers)
    for (const secret of [PASSWORD, HASH.toString('hex'), HASH.toString('base64'), GOOD.slice(6), Buffer.from(`${USER}:guess`).toString('base64'), 'guess']) expect(text).not.toContain(secret)
    // The request log has the path and status of a refusal, never its query.
    expect(logs.some((l) => l.includes('"status":401') && l.includes('"path":"/"'))).toBe(true)
    expect(text).not.toContain('password=x')
  })
})

describe('preview gate unit', () => {
  it('checks both parts every time and refuses a hash of the wrong length', () => {
    const gate = createPreviewGate({ accessUser: USER, accessPasswordSha256: HASH })
    expect(gate.check({ headers: { authorization: GOOD } })).toBe('allowed')
    expect(gate.check({ headers: {} })).toBe('missing')
    expect(gate.check({ headers: { authorization: basic('x', PASSWORD) } })).toBe('invalid')
    expect(gate.check({ headers: { authorization: basic(USER, 'x') } })).toBe('invalid')
    // A password containing a colon is the part after the first one, as RFC 7617 says.
    const colon = createPreviewGate({ accessUser: USER, accessPasswordSha256: createHash('sha256').update('a:b').digest() })
    expect(colon.check({ headers: { authorization: basic(USER, 'a:b') } })).toBe('allowed')
    expect(() => createPreviewGate({ accessUser: USER, accessPasswordSha256: Buffer.alloc(16) })).toThrow()
  })

  it('an ordinary local process has no gate, and its cookies and headers are as they were', async () => {
    const logs: string[] = []
    const server = createServer(createApp({ config: testConfig(), db: null, migrationsDir: '/nonexistent', log: createLogger((l) => logs.push(l)), site }))
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const shell = await ask(port, 'GET', '/')
    expect(shell.status).toBe(200)
    expect(shell.headers['strict-transport-security']).toBeUndefined()
    expect(shell.headers['content-security-policy']).not.toContain('upgrade-insecure-requests')
    expect(shell.headers['www-authenticate']).toBeUndefined()
    const out = await ask(port, 'POST', '/v1/play/logout', { ...json, origin: testConfig().publicOrigin }, '{}')
    expect(out.headers['set-cookie']).toEqual(['rc_play=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'])
  })
})
