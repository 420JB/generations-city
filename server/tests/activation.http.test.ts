import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, describe, expect, it } from 'vitest'
import { createPropertyReader } from '../src/activation/properties'
import { propertyId } from '../src/activation/propertyId'
import { ActivationError, createActivationService, type ActivationService } from '../src/activation/service'
import { createApp } from '../src/app'
import { createAuthService, hashSessionToken, type AuthService, type LiveSession } from '../src/auth/service'
import { createCityReader, initializeCity } from '../src/city/store'
import type { Database } from '../src/db/pool'
import { migrate } from '../src/db/migrations'
import { createGenesisState, type ActivationIntentResponse } from '../src/engine'
import { MAX_BODY_BYTES } from '../src/http'
import { createLogger } from '../src/log'
import { createGenerationsOwnershipProvider } from '../src/ownership/generations'
import { createFriendsReader } from '../src/ownership/reader'
import { LIMITS } from '../src/rateLimit'
import { snapshot } from './activationFixtures'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'
import { fakeChain } from './fakeChain'
import { TEST_ORIGIN, testConfig } from './testConfig'

const INTENTS = '/v1/activation/intents'
const ACTIVATIONS = '/v1/activations'
const ROUTES = [INTENTS, ACTIVATIONS]
const TOKEN = 'T'.repeat(43)
const SESSION: LiveSession = { sessionId: '11111111-1111-4111-8111-111111111111', userId: '7b0c1c7e-3c53-4d0e-9a52-6a3f5d0f1a11', walletId: '22222222-2222-4222-8222-222222222222', address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', chainId: 4663, expiresAt: new Date('2026-10-09T12:00:00.000Z') }
const VIEWER = { authenticated: true as const, userId: SESSION.userId, wallet: { address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', chainId: 4663 }, session: { expiresAt: SESSION.expiresAt.toISOString() } }
/** The headers the service puts on every API answer, in local mode. Activation must not change one of them. */
const API_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()', 'cross-origin-opener-policy': 'same-origin-allow-popups', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'x-frame-options': 'DENY' }

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
})

async function listen(app: ReturnType<typeof createApp>) {
  const server = createServer(app)
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
const answer = async (res: Response) => [res.status, await res.json()] as const

/** An auth service that knows one cookie, and counts how often a session is looked up. */
function fakeAuth() {
  const calls = { session: 0, viewer: 0 }
  const service: AuthService = {
    issueChallenge: async () => ({ nonce: 'a'.repeat(32), message: 'sign me', expiresAt: '2026-10-02T12:05:00.000Z' }),
    verify: async () => ({ token: TOKEN, expiresAt: SESSION.expiresAt, maxAgeSeconds: 604_800, viewer: VIEWER }),
    logout: async () => undefined,
    async viewer(presented) {
      calls.viewer += 1
      return presented === TOKEN ? VIEWER : { authenticated: false }
    },
    async session(presented) {
      calls.session += 1
      return presented === TOKEN ? SESSION : null
    },
  }
  return { service, calls }
}

/** An activation service that records what reached it. Every call it sees is work a refused request must not cause. */
function fakeActivation() {
  const calls: { method: 'issueIntent' | 'commit'; session: LiveSession; input: unknown }[] = []
  let failWith: Error | null = null
  const service: ActivationService = {
    async issueIntent(session, input) {
      calls.push({ method: 'issueIntent', session, input })
      if (failWith) throw failWith
      return { intentId: 'c'.repeat(64), expiresAt: '2026-10-03T12:10:00.000Z', typedData: {} as ActivationIntentResponse['typedData'], digest: `0x${'d'.repeat(64)}` }
    },
    async commit(session, input) {
      calls.push({ method: 'commit', session, input })
      if (failWith) throw failWith
      return { status: 'committed', property: { id: propertyId('812'), tokenId: '812', buildingId: 'b-812', districtId: 'd4', ward: 0, plot: 7, plotId: 'd4-w0-p7', activatedAt: '2026-10-03T12:00:00.000Z', sequence: 2 }, city: { id: 'main', instance: 'd8fae2d7-7044-4faf-b36c-f4b700c3ba28' } }
    },
  }
  return { service, calls, fail: (err: Error | null) => (failWith = err) }
}

async function start(options: { enabled?: boolean; activation?: ActivationService | null; auth?: AuthService | null; lines?: string[]; rateLimits?: boolean } = {}) {
  const auth = fakeAuth()
  const activation = fakeActivation()
  const config = testConfig({ activationEnabled: options.enabled ?? true, rateLimits: options.rateLimits ?? false })
  const base = await listen(
    createApp({ config, db: null, migrationsDir: '/nonexistent', log: createLogger((l) => options.lines?.push(l)), auth: options.auth === undefined ? auth.service : options.auth, activation: options.activation === undefined ? activation.service : options.activation }),
  )
  return { base, auth, activation }
}

const COOKIE = { cookie: `rc_session=${TOKEN}` }
const BODIES: Record<string, unknown> = { [INTENTS]: { tokenId: '812', plotId: 'd4-w0-p7' }, [ACTIVATIONS]: { intentId: 'c'.repeat(64), signature: `0x${'e'.repeat(130)}` } }

describe('activation routes: the boundary', () => {
  it('hands the service the exact session and the parsed body, and answers privately', async () => {
    const s = await start()
    for (const path of ROUTES) {
      const res = await post(s.base, path, BODIES[path], COOKIE)
      expect(res.status, path).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('vary')).toBe('Cookie')
      expect(res.headers.get('set-cookie')).toBeNull()
      expect(res.headers.get('etag')).toBeNull()
    }
    expect(s.activation.calls).toEqual([
      { method: 'issueIntent', session: SESSION, input: BODIES[INTENTS] },
      { method: 'commit', session: SESSION, input: BODIES[ACTIVATIONS] },
    ])
    // The session came from the internal resolver, not from the public viewer.
    expect(s.auth.calls).toEqual({ session: 2, viewer: 0 })
  })

  it('accepts POST only: there is no GET that changes or reveals anything', async () => {
    const s = await start()
    for (const path of ROUTES)
      for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const res = await fetch(`${s.base}${path}`, { method, headers: COOKIE })
        expect([res.status, res.headers.get('allow')], `${method} ${path}`).toEqual([405, 'POST'])
        if (method !== 'HEAD') expect(await res.json()).toEqual({ error: 'method_not_allowed' })
      }
    // Near misses are not routes at all.
    for (const path of ['/v1/activation', '/v1/activation/intents/', '/v1/activations/', '/v1/activation/intents/abc', '/v1/activations/abc', '/v1/activation/commit']) expect((await post(s.base, path, {}, COOKIE)).status, path).not.toBe(200)
    expect(s.activation.calls).toEqual([])
    expect(s.auth.calls.session).toBe(0)
  })

  it('requires the request to come from this origin, before anything else happens', async () => {
    const s = await start()
    for (const path of ROUTES) {
      const foreign: Record<string, string>[] = [{ origin: 'https://evil.example' }, { origin: 'null' }, { origin: TEST_ORIGIN.replace('http:', 'https:') }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'none' }, { origin: TEST_ORIGIN, 'sec-fetch-site': 'cross-site' }]
      for (const headers of foreign)
        expect(await answer(await post(s.base, path, BODIES[path], { ...COOKIE, ...headers })), JSON.stringify(headers)).toEqual([403, { error: 'origin_mismatch' }])
      // From this origin it is accepted.
      expect((await post(s.base, path, BODIES[path], { ...COOKIE, origin: TEST_ORIGIN, 'sec-fetch-site': 'same-origin' })).status).toBe(200)
    }
    expect(s.activation.calls).toHaveLength(2)
    expect(s.auth.calls.session).toBe(2)
  })

  it('takes a JSON object within the size limit and nothing else', async () => {
    const s = await start()
    for (const path of ROUTES) {
      const form = await fetch(`${s.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...COOKIE }, body: 'tokenId=812&plotId=d4-w0-p7' })
      expect(await answer(form)).toEqual([415, { error: 'unsupported_media_type' }])
      expect(await answer(await fetch(`${s.base}${path}`, { method: 'POST', headers: { 'content-type': 'text/plain', ...COOKIE }, body: JSON.stringify(BODIES[path]) }))).toEqual([415, { error: 'unsupported_media_type' }])
      expect(await answer(await fetch(`${s.base}${path}`, { method: 'POST', headers: COOKIE, body: JSON.stringify(BODIES[path]) }))).toEqual([415, { error: 'unsupported_media_type' }])
      expect(await answer(await post(s.base, path, '{"tokenId":', COOKIE))).toEqual([400, { error: 'invalid_json' }])
      for (const body of ['[]', '"812"', '812', 'null', 'true']) expect(await answer(await post(s.base, path, body, COOKIE)), body).toEqual([400, { error: 'invalid_request' }])
      expect(await answer(await post(s.base, path, JSON.stringify({ tokenId: '812', plotId: 'x'.repeat(MAX_BODY_BYTES) }), COOKIE))).toEqual([413, { error: 'payload_too_large' }])
    }
    // None of them was a request the service, or even the session lookup, ever saw.
    expect(s.activation.calls).toEqual([])
    expect(s.auth.calls.session).toBe(0)
  })

  it('refuses an anonymous request before the service, and so before any chain read', async () => {
    const s = await start()
    const nobody: Record<string, string>[] = [{}, { cookie: 'rc_session=nope' }, { cookie: `other=${TOKEN}` }, { authorization: `Bearer ${TOKEN}` }]
    for (const path of ROUTES)
      for (const headers of nobody) {
        const res = await post(s.base, path, BODIES[path], headers)
        expect(await answer(res), JSON.stringify(headers)).toEqual([401, { error: 'not_authenticated' }])
        expect(res.headers.get('cache-control')).toBe('no-store')
      }
    expect(s.activation.calls).toEqual([])
  })

  it('with ACTIVATION_ENABLED off, refuses before the session is even looked up', async () => {
    const s = await start({ enabled: false })
    for (const path of ROUTES) {
      expect(await answer(await post(s.base, path, BODIES[path], COOKIE))).toEqual([403, { error: 'activation_disabled' }])
      expect(await answer(await post(s.base, path, BODIES[path]))).toEqual([403, { error: 'activation_disabled' }])
      expect(await answer(await post(s.base, path, { nonsense: true }, COOKIE))).toEqual([403, { error: 'activation_disabled' }])
    }
    expect(s.activation.calls).toEqual([])
    expect(s.auth.calls).toEqual({ session: 0, viewer: 0 })
    // Everything else the service does is untouched by the switch.
    expect(await (await fetch(`${s.base}/v1/viewer`, { headers: COOKIE })).json()).toEqual(VIEWER)
    expect((await fetch(`${s.base}/health`)).status).toBe(200)
  })

  it('says activation is unavailable when there is no database behind it, enabled or not', async () => {
    const s = await start({ activation: null })
    for (const path of ROUTES) {
      const res = await post(s.base, path, BODIES[path], COOKIE)
      expect(await answer(res)).toEqual([503, { error: 'activation_unavailable' }])
      expect(res.headers.get('retry-after')).toBe('30')
    }
    const noAuth = await start({ auth: null })
    expect(await answer(await post(noAuth.base, INTENTS, BODIES[INTENTS], COOKIE))).toEqual([503, { error: 'activation_unavailable' }])
    expect(noAuth.activation.calls).toEqual([])
  })

  it('answers each refusal with its own stable code and status, and nothing else', async () => {
    const s = await start()
    const expected: [ConstructorParameters<typeof ActivationError>[0], number][] = [
      ['activation_disabled', 403],
      ['not_authenticated', 401],
      ['invalid_request', 400],
      ['unsupported_chain', 400],
      ['city_not_activatable', 409],
      ['city_inconsistent', 503],
      ['friend_not_owned', 403],
      ['friend_already_activated', 409],
      ['ownership_unavailable', 503],
      ['ownership_inconsistent', 503],
      ['family_mismatch', 409],
      ['plot_invalid', 422],
      ['plot_unavailable', 409],
      ['intent_not_found', 404],
      ['intent_expired', 410],
      ['intent_superseded', 409],
      ['intent_session_mismatch', 403],
      ['signature_invalid', 403],
      ['activation_conflict', 409],
      ['activation_unavailable', 503],
    ]
    for (const [code, status] of expected) {
      s.activation.fail(new ActivationError(code))
      const res = await post(s.base, ACTIVATIONS, BODIES[ACTIVATIONS], COOKIE)
      expect([res.status, await res.text()], code).toEqual([status, JSON.stringify({ error: code })])
      // 503 is the only "try again": an authority that could not answer just now.
      expect(res.headers.get('retry-after'), code).toBe(status === 503 ? '10' : null)
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
    expect(new Set(expected.map(([code]) => code)).size).toBe(20)
  })

  it('tells the client nothing about an unexpected failure, and logs only its name', async () => {
    const lines: string[] = []
    const s = await start({ lines })
    s.activation.fail(Object.assign(new Error('connect ECONNREFUSED postgres://rarecity:hunter2@db.internal:5432 while calling https://rpc.example/v2/s3cr3t-key'), { code: 'ECONNREFUSED' }))
    for (const path of ROUTES) {
      const res = await post(s.base, path, BODIES[path], COOKIE)
      expect([res.status, await res.text()]).toEqual([503, JSON.stringify({ error: 'activation_unavailable' })])
      expect(res.headers.get('retry-after')).toBe('5')
    }
    const log = lines.join('\n')
    expect(log).toContain('activation request failed')
    expect(log).toContain('ECONNREFUSED')
    for (const secret of ['hunter2', 's3cr3t', 'rpc.example', 'db.internal', TOKEN]) expect(log).not.toContain(secret)
  })

  it('carries the same security headers as every other API answer, and never a CORS header', async () => {
    const s = await start()
    const responses = [
      await post(s.base, INTENTS, BODIES[INTENTS], COOKIE),
      await post(s.base, ACTIVATIONS, BODIES[ACTIVATIONS], COOKIE),
      await post(s.base, INTENTS, BODIES[INTENTS]),
      await post(s.base, INTENTS, BODIES[INTENTS], { ...COOKIE, origin: 'https://evil.example' }),
      await fetch(`${s.base}${INTENTS}`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } }),
      await fetch(`${s.base}/version`),
    ]
    for (const res of responses) {
      for (const [name, value] of Object.entries(API_HEADERS)) expect(res.headers.get(name), `${res.url} ${name}`).toBe(value)
      expect(res.headers.has('strict-transport-security')).toBe(false)
      for (const name of [...res.headers.keys()]) expect(name.startsWith('access-control-'), name).toBe(false)
    }
    // A preflight from another site is simply not answered as one.
    expect(responses[4].status).toBe(405)
  })

  it('never puts a session id, a wallet row id or the cookie value in an answer', async () => {
    const s = await start()
    for (const path of ROUTES) {
      const text = await (await post(s.base, path, BODIES[path], COOKIE)).text()
      for (const secret of [SESSION.sessionId, SESSION.walletId, TOKEN]) expect(text).not.toContain(secret)
    }
  })
})

describe('activation routes: rate limits', () => {
  it('declares its limits beside the others, and leaves those as they were', () => {
    expect(LIMITS).toEqual({
      authChallenge: { client: [{ limit: 10, windowMs: 60_000 }] },
      authVerify: { client: [{ limit: 10, windowMs: 60_000 }] },
      friends: { client: [{ limit: 30, windowMs: 60_000 }], user: [{ limit: 6, windowMs: 60_000 }] },
      activationIntent: { client: [{ limit: 10, windowMs: 60_000 }], user: [{ limit: 6, windowMs: 60_000 }] },
      activationCommit: { client: [{ limit: 10, windowMs: 60_000 }], user: [{ limit: 6, windowMs: 60_000 }] },
    })
  })

  it('limits by client network before the body is read and before the session is looked up', async () => {
    for (const path of ROUTES) {
      const s = await start({ rateLimits: true })
      // Ten anonymous requests are counted, though none gets anywhere.
      for (let i = 0; i < 10; i++) expect((await post(s.base, path, BODIES[path])).status).toBe(401)
      const sessionLookups = s.auth.calls.session
      // The eleventh is refused whoever sends it and whatever it carries, including a body that would have been refused anyway.
      for (const [body, headers] of [[BODIES[path], COOKIE], ['{"broken":', COOKIE], [{ a: 'x'.repeat(MAX_BODY_BYTES) }, {}]] as const) {
        const res = await post(s.base, path, body, headers)
        expect(await answer(res)).toEqual([429, { error: 'rate_limited' }])
        expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
        expect(res.headers.get('connection')).toBe('close')
      }
      expect(s.auth.calls.session).toBe(sessionLookups)
      expect(s.activation.calls).toEqual([])
    }
  })

  it('limits by user before the service, and so before any chain read', async () => {
    for (const path of ROUTES) {
      const s = await start({ rateLimits: true })
      for (let i = 0; i < 6; i++) expect((await post(s.base, path, BODIES[path], COOKIE)).status, `${path} ${i}`).toBe(200)
      const res = await post(s.base, path, BODIES[path], COOKIE)
      expect(await answer(res)).toEqual([429, { error: 'rate_limited' }])
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
      // Six reached the service; the seventh did not.
      expect(s.activation.calls).toHaveLength(6)
    }
  })

  it('keeps the two routes, and a request from another origin, out of each other\'s count', async () => {
    const s = await start({ rateLimits: true })
    for (let i = 0; i < 6; i++) expect((await post(s.base, INTENTS, BODIES[INTENTS], COOKIE)).status).toBe(200)
    // Issuing six intents has not used up any of the commit allowance.
    expect((await post(s.base, ACTIVATIONS, BODIES[ACTIVATIONS], COOKIE)).status).toBe(200)
    // A hostile page cannot spend a visitor's allowance: its requests are refused before they are counted.
    const fresh = await start({ rateLimits: true })
    for (let i = 0; i < 30; i++) expect((await post(fresh.base, INTENTS, BODIES[INTENTS], { ...COOKIE, origin: 'https://evil.example' })).status).toBe(403)
    expect((await post(fresh.base, INTENTS, BODIES[INTENTS], COOKIE)).status).toBe(200)
  })

  it('does not count against an oversized upload it never reads', async () => {
    const s = await start()
    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(s.base)
      const req = request({ host: url.hostname, port: url.port, path: INTENTS, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(50 * 1024 * 1024), cookie: `rc_session=${TOKEN}` } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.write('{"tokenId":"812"')
    })
    expect(status).toBe(413)
    expect(s.activation.calls).toEqual([])
  })
})

describe.skipIf(NO_TEST_DATABASE)('activation over HTTP against a disposable Postgres', () => {
  const t = useTestSchema()
  const wallet = () => privateKeyToAccount(generatePrivateKey())

  /** The whole service as `main.ts` wires it, over a fake chain, with activation switched as the test says. */
  async function serve(options: { enabled?: boolean; rateLimits?: boolean; db?: Database } = {}) {
    await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })
    const city = await initializeCity(t.db, { state: createGenesisState(), origin: 'demo-fixture', rehearsal: true, environment: 'local' })
    const chain = fakeChain()
    const lines: string[] = []
    const log = createLogger((l) => lines.push(l))
    const db = options.db ?? t.db
    const ownership = createGenerationsOwnershipProvider({ transport: chain.transport })
    const enabled = options.enabled ?? true
    const base = await listen(
      createApp({
        config: testConfig({ activationEnabled: enabled, rateLimits: options.rateLimits ?? false }),
        db,
        migrationsDir: MIGRATIONS_DIR,
        log,
        city: createCityReader(db),
        auth: createAuthService({ db, publicOrigin: TEST_ORIGIN }),
        friends: createFriendsReader(ownership, { ttlMs: 0 }),
        activation: createActivationService({ db, ownership, publicOrigin: TEST_ORIGIN, enabled, log }),
        properties: createPropertyReader(db),
      }),
    )
    async function signIn(account = wallet()) {
      const challenge = (await (await post(base, '/v1/auth/challenge', { address: account.address, chainId: 4663 })).json()) as { nonce: string; message: string }
      const res = await post(base, '/v1/auth/verify', { nonce: challenge.nonce, signature: await account.signMessage({ message: challenge.message }) })
      const cookie = res.headers.get('set-cookie')!.split(';')[0]
      return { account, cookie, token: cookie.split('=')[1], viewer: (await res.json()) as { userId: string } }
    }
    return { base, chain, lines, city, signIn }
  }

  const permanent = async () => [await snapshot(t.db, 'city', 'id'), await snapshot(t.db, 'city_events', 'sequence'), await snapshot(t.db, 'properties', 'id'), await snapshot(t.db, 'ownership_eras', 'id'), await snapshot(t.db, 'activation_intents', 'id')].join('\n')

  it('activates a Friend end to end: sign in, intent, signature, commit, retry, and the city and My Friends show it', async () => {
    const s = await serve()
    const me = await s.signIn()
    s.chain.mint(me.account.address, 812n)
    s.chain.mint(me.account.address, 1204n)
    s.chain.families.set(1204n, 0)
    const headers = { cookie: me.cookie, origin: TEST_ORIGIN, 'sec-fetch-site': 'same-origin' }
    const friends = async () => (await (await fetch(`${s.base}/v1/viewer/friends`, { headers: { cookie: me.cookie } })).json()) as { friends: unknown[] }
    const cityBefore = await fetch(`${s.base}/v1/city`)

    // Before: both Friends are owned and neither has a property. null means "none", from the property rows.
    expect((await friends()).friends).toEqual([
      { tokenId: '812', family: { id: 2, name: 'Family' }, property: null },
      { tokenId: '1204', family: { id: 0, name: 'Skeleton' }, property: null },
    ])

    const issued = await post(s.base, INTENTS, { tokenId: '812', plotId: 'd4-w0-p7' }, headers)
    expect(issued.status).toBe(200)
    const intent = (await issued.json()) as ActivationIntentResponse
    expect(Object.keys(intent)).toEqual(['intentId', 'expiresAt', 'typedData', 'digest'])
    expect(intent.typedData.message).toMatchObject({ site: TEST_ORIGIN, wallet: me.account.address, tokenId: '812', familyId: 2, familyName: 'Family', districtId: 'd4', plotId: 'd4-w0-p7', cityInstance: s.city.instance })

    // The wallet signs exactly what it was handed, as JSON.
    const signature = await me.account.signTypedData(intent.typedData as never)
    const committed = await post(s.base, ACTIVATIONS, { intentId: intent.intentId, signature }, headers)
    expect(committed.status).toBe(200)
    const result = await committed.json()
    expect(result).toEqual({ status: 'committed', property: { id: propertyId('812'), tokenId: '812', buildingId: 'b-812', districtId: 'd4', ward: 0, plot: 7, plotId: 'd4-w0-p7', activatedAt: expect.any(String), sequence: 2 }, city: { id: 'main', instance: s.city.instance } })

    // The answer was lost; the same request again gets the same answer and changes nothing.
    const before = await permanent()
    const retry = await post(s.base, ACTIVATIONS, { intentId: intent.intentId, signature }, headers)
    expect([retry.status, await retry.json()]).toEqual([200, result])
    expect(await permanent()).toBe(before)

    // The shared city moved one step and shows the building; its ETag changed with it.
    const cityAfter = await fetch(`${s.base}/v1/city`)
    const body = (await cityAfter.json()) as { city: { sequence: number }; state: { buildings: Record<string, { ownerId: string }> } }
    expect([body.city.sequence, Object.keys(body.state.buildings)]).toEqual([2, ['b-812']])
    expect(body.state.buildings['b-812'].ownerId).toBe(me.viewer.userId)
    expect(cityAfter.headers.get('etag')).toBe(`"${s.city.instance}.2"`)
    expect(cityBefore.headers.get('etag')).toBe(`"${s.city.instance}.1"`)

    // My Friends now says which Friend has a property, with public facts only.
    expect((await friends()).friends).toEqual([
      { tokenId: '812', family: { id: 2, name: 'Family' }, property: { id: propertyId('812'), buildingId: 'b-812', districtId: 'd4', ward: 0, plot: 7, plotId: 'd4-w0-p7', activatedAt: (result as { property: { activatedAt: string } }).property.activatedAt } },
      { tokenId: '1204', family: { id: 0, name: 'Skeleton' }, property: null },
    ])

    // Nothing that went over the wire names the session, a row id, or the credential.
    const session = (await t.db.query('SELECT id, wallet_id FROM sessions')).rows[0]
    const wire = JSON.stringify([intent, result, await friends(), body])
    for (const secret of [me.token, hashSessionToken(me.token).toString('hex'), session.id, session.wallet_id]) expect(wire).not.toContain(secret)
    for (const res of [issued, committed, retry]) expect(res.headers.get('set-cookie')).toBeNull()
    // And the log names neither the credential, the signature, nor the intent.
    const log = s.lines.join('\n')
    for (const secret of [me.token, signature.slice(2), intent.intentId, intent.digest.slice(2)]) expect(log).not.toContain(secret)
    expect(log).toContain('property activated')
  })

  it('accepts exactly the two request shapes and refuses anything more before the chain', async () => {
    const s = await serve()
    const me = await s.signIn()
    s.chain.mint(me.account.address, 812n)
    const headers = { cookie: me.cookie }
    const rpc = s.chain.requests.length
    for (const body of [{ tokenId: '812', plotId: 'd4-w0-p7', familyId: 2 }, { tokenId: '812', plotId: 'd4-w0-p7', districtId: 'd4' }, { tokenId: 812, plotId: 'd4-w0-p7' }, { tokenId: '0812', plotId: 'd4-w0-p7' }, { tokenId: '812.0', plotId: 'd4-w0-p7' }, { tokenId: '1e3', plotId: 'd4-w0-p7' }, { tokenId: '0x32c', plotId: 'd4-w0-p7' }, { tokenId: ' 812', plotId: 'd4-w0-p7' }, { tokenId: '+812', plotId: 'd4-w0-p7' }, { tokenId: '9007199254740992', plotId: 'd4-w0-p7' }, { tokenId: '812' }, {}])
      expect(await answer(await post(s.base, INTENTS, body, headers)), JSON.stringify(body)).toEqual([400, { error: 'invalid_request' }])
    for (const body of [{ intentId: 'c'.repeat(64) }, { intentId: 'c'.repeat(64), signature: `0x${'e'.repeat(130)}`, typedData: {} }, { intentId: 'C'.repeat(64), signature: `0x${'e'.repeat(130)}` }, { intentId: 'c'.repeat(64), signature: 'e'.repeat(130) }])
      expect(await answer(await post(s.base, ACTIVATIONS, body, headers)), JSON.stringify(body)).toEqual([400, { error: 'invalid_request' }])
    expect(s.chain.requests.length).toBe(rpc)
    expect((await t.db.query('SELECT count(*)::int AS n FROM activation_intents')).rows[0].n).toBe(0)
  })

  it('answers refusals over HTTP with their codes, and never with the provider\'s words', async () => {
    const s = await serve()
    const me = await s.signIn()
    const stranger = await s.signIn()
    s.chain.mint(me.account.address, 812n)
    const mine = { cookie: me.cookie }
    expect(await answer(await post(s.base, INTENTS, { tokenId: '812', plotId: 'd4-w0-p7' }, { cookie: stranger.cookie }))).toEqual([403, { error: 'friend_not_owned' }])
    expect(await answer(await post(s.base, INTENTS, { tokenId: '812', plotId: 'd5-w0-p0' }, mine))).toEqual([422, { error: 'plot_invalid' }])
    expect(await answer(await post(s.base, ACTIVATIONS, { intentId: 'c'.repeat(64), signature: `0x${'e'.repeat(130)}` }, mine))).toEqual([404, { error: 'intent_not_found' }])

    const intent = (await (await post(s.base, INTENTS, { tokenId: '812', plotId: 'd4-w0-p7' }, mine)).json()) as ActivationIntentResponse
    expect(await answer(await post(s.base, ACTIVATIONS, { intentId: intent.intentId, signature: await stranger.account.signTypedData(intent.typedData as never) }, mine))).toEqual([403, { error: 'signature_invalid' }])
    expect(await answer(await post(s.base, ACTIVATIONS, { intentId: intent.intentId, signature: await me.account.signTypedData(intent.typedData as never) }, { cookie: stranger.cookie }))).toEqual([404, { error: 'intent_not_found' }])

    s.chain.fail = (m) => (m === 'eth_call' ? new Error('fetch failed https://rpc.example/v2/s3cr3t-key') : undefined)
    const down = await post(s.base, ACTIVATIONS, { intentId: intent.intentId, signature: await me.account.signTypedData(intent.typedData as never) }, mine)
    expect([down.status, await down.text(), down.headers.get('retry-after')]).toEqual([503, JSON.stringify({ error: 'ownership_unavailable' }), '10'])
    expect(s.lines.join('\n')).not.toMatch(/s3cr3t|rpc\.example/)

    // Signed out, the same cookie is nobody.
    s.chain.fail = () => undefined
    await post(s.base, '/v1/auth/logout', {}, mine)
    expect(await answer(await post(s.base, ACTIVATIONS, { intentId: intent.intentId, signature: await me.account.signTypedData(intent.typedData as never) }, mine))).toEqual([401, { error: 'not_authenticated' }])
    expect((await t.db.query('SELECT count(*)::int AS n FROM properties')).rows[0].n).toBe(0)
  })

  it('stops a user over their limit before the chain is read', async () => {
    const s = await serve({ rateLimits: true })
    const me = await s.signIn()
    s.chain.mint(me.account.address, 812n)
    for (let i = 0; i < 6; i++) expect((await post(s.base, INTENTS, { tokenId: '812', plotId: 'd4-w0-p7' }, { cookie: me.cookie })).status).toBe(200)
    const rpc = s.chain.requests.length
    expect(await answer(await post(s.base, INTENTS, { tokenId: '812', plotId: 'd4-w0-p8' }, { cookie: me.cookie }))).toEqual([429, { error: 'rate_limited' }])
    expect(s.chain.requests.length).toBe(rpc)
    // Six identical requests were one intent.
    expect((await t.db.query('SELECT count(*)::int AS n FROM activation_intents')).rows[0].n).toBe(1)
  })

  it('with activation off: no chain read, no row, no change, and everything else works as before', async () => {
    const s = await serve({ enabled: false })
    const me = await s.signIn()
    s.chain.mint(me.account.address, 812n)
    const before = await permanent()
    const rpc = s.chain.requests.length
    for (const [path, body] of [[INTENTS, { tokenId: '812', plotId: 'd4-w0-p7' }], [ACTIVATIONS, { intentId: 'c'.repeat(64), signature: `0x${'e'.repeat(130)}` }]] as const) {
      expect(await answer(await post(s.base, path, body, { cookie: me.cookie }))).toEqual([403, { error: 'activation_disabled' }])
      expect(await answer(await post(s.base, path, body))).toEqual([403, { error: 'activation_disabled' }])
    }
    expect(s.chain.requests.length).toBe(rpc)
    expect(await permanent()).toBe(before)

    // Reads and sign-in are exactly what they were.
    expect(await (await fetch(`${s.base}/v1/viewer`, { headers: { cookie: me.cookie } })).json()).toMatchObject({ authenticated: true, userId: me.viewer.userId })
    expect((await fetch(`${s.base}/v1/city`)).headers.get('etag')).toBe(`"${s.city.instance}.1"`)
    expect(await (await fetch(`${s.base}/v1/viewer/friends`, { headers: { cookie: me.cookie } })).json()).toMatchObject({ source: 'robinhood-chain', friends: [{ tokenId: '812', family: { id: 2, name: 'Family' }, property: null }] })
    expect((await fetch(`${s.base}/ready`)).status).toBe(200)
    expect(await (await post(s.base, '/v1/auth/logout', {}, { cookie: me.cookie })).json()).toEqual({ authenticated: false })
  })

  it('leaves the annotation out, rather than say "none", when the property rows cannot be read', async () => {
    // A database whose property reads fail, and nothing else.
    const broken: Database = {
      query: ((...args: unknown[]) => (typeof args[0] === 'string' && args[0].includes('FROM properties') ? Promise.reject(new Error('relation properties is on fire')) : (t.db.query as (...a: unknown[]) => unknown)(...args))) as Database['query'],
      connect: () => t.db.connect(),
      end: () => t.db.end(),
    }
    const s = await serve({ db: broken })
    const me = await s.signIn()
    s.chain.mint(me.account.address, 812n)
    const res = await fetch(`${s.base}/v1/viewer/friends`, { headers: { cookie: me.cookie } })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { friends: unknown[] }).friends).toEqual([{ tokenId: '812', family: { id: 2, name: 'Family' } }])
    expect(s.lines.some((l) => l.includes('friend property annotation failed'))).toBe(true)
    expect(s.lines.join('\n')).not.toContain('on fire')
  })
})
