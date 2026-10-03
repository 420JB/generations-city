import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { AuthError, type AuthService } from '../src/auth/service'
import type { AppMode } from '../src/config'
import { assertSameOrigin, HttpError, MAX_BODY_BYTES, readJsonBody, sessionCookie } from '../src/http'
import { createLogger } from '../src/log'
import { createFixtureOwnershipProvider } from '../src/ownership/fixture'
import { createFriendsReader } from '../src/ownership/reader'
import { TEST_ORIGIN, testConfig } from './testConfig'

const TOKEN = 'T'.repeat(43)
const VIEWER = { authenticated: true as const, userId: '7b0c1c7e-3c53-4d0e-9a52-6a3f5d0f1a11', wallet: { address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', chainId: 4663 }, session: { expiresAt: '2026-10-09T12:00:00.000Z' } }

/** An auth service that records what reached it and can be told to fail. */
function fakeAuth() {
  const calls: { method: string; args: unknown[] }[] = []
  let failWith: Error | null = null
  const run = async <T>(method: string, args: unknown[], value: T): Promise<T> => {
    calls.push({ method, args })
    if (failWith) throw failWith
    return value
  }
  const service: AuthService = {
    issueChallenge: (input) => run('issueChallenge', [input], { nonce: 'a'.repeat(32), message: 'sign me', expiresAt: '2026-10-02T12:05:00.000Z' }),
    verify: (input, presented) => run('verify', [input, presented], { token: TOKEN, expiresAt: new Date('2026-10-09T12:00:00.000Z'), maxAgeSeconds: 604_800, viewer: VIEWER }),
    logout: (presented) => run('logout', [presented], undefined),
    viewer: (presented) => run('viewer', [presented], presented === TOKEN ? VIEWER : { authenticated: false as const }),
    session: (presented) => run('session', [presented], null),
  }
  return { service, calls, fail: (err: Error | null) => (failWith = err) }
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
})

async function start(options: { auth?: AuthService | null; mode?: AppMode; lines?: string[]; friends?: boolean; rateLimits?: boolean } = {}) {
  const config = testConfig({ mode: options.mode ?? 'local', publicOrigin: (options.mode ?? 'local') === 'local' ? TEST_ORIGIN : 'https://rarecity.example', rateLimits: options.rateLimits ?? true })
  const app = createApp({ config, db: null, migrationsDir: '/nonexistent', log: createLogger((l) => options.lines?.push(l)), auth: options.auth ?? null, friends: options.friends === false ? null : createFriendsReader(createFixtureOwnershipProvider()) })
  const server = createServer(app)
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const POSTS = ['/v1/auth/challenge', '/v1/auth/verify', '/v1/auth/logout']
const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })

describe('GET /v1/viewer', () => {
  it('is anonymous, uncacheable and per-cookie when nobody is signed in', async () => {
    const { service } = fakeAuth()
    const res = await fetch(`${await start({ auth: service })}/v1/viewer`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ authenticated: false })
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('vary')).toBe('Cookie')
    expect(res.headers.get('etag')).toBeNull()
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('returns the session viewer with only the fields the client needs', async () => {
    const { service, calls } = fakeAuth()
    const res = await fetch(`${await start({ auth: service })}/v1/viewer`, { headers: { cookie: `theme=dark; rc_session=${TOKEN}; x=1` } })
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual(VIEWER)
    expect(Object.keys(body)).toEqual(['authenticated', 'userId', 'wallet', 'session'])
    expect(calls).toEqual([{ method: 'viewer', args: [TOKEN] }])
  })

  it('is anonymous for everyone when the service has no database, whatever cookie is sent', async () => {
    const res = await fetch(`${await start()}/v1/viewer`, { headers: { cookie: `rc_session=${TOKEN}` } })
    expect([res.status, await res.json()]).toEqual([200, { authenticated: false }])
  })

  it('supports HEAD and refuses every other method', async () => {
    const base = await start({ auth: fakeAuth().service })
    const head = await fetch(`${base}/v1/viewer`, { method: 'HEAD' })
    expect([head.status, await head.text()]).toEqual([200, ''])
    for (const path of ['/v1/viewer', '/v1/viewer/friends'])
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const res = await fetch(`${base}${path}`, { method, body: ['POST', 'PUT', 'PATCH'].includes(method) ? '{}' : undefined })
        expect(res.status, `${method} ${path}`).toBe(405)
        expect(res.headers.get('allow')).toBe('GET, HEAD')
      }
  })

  it('is 503, not anonymous and not a crash, when the session store cannot be read', async () => {
    const lines: string[] = []
    const { service, fail } = fakeAuth()
    const base = await start({ auth: service, lines })
    fail(Object.assign(new Error('connect ECONNREFUSED postgres://user:hunter2@db/rarecity'), { code: 'ECONNREFUSED' }))
    for (const path of ['/v1/viewer', '/v1/viewer/friends']) {
      const res = await fetch(`${base}${path}`, { headers: { cookie: `rc_session=${TOKEN}` } })
      const text = await res.text()
      expect([res.status, JSON.parse(text)], path).toEqual([503, { error: 'viewer_unavailable' }])
      // The cookie is left alone: the session may be perfectly good.
      expect(res.headers.get('set-cookie')).toBeNull()
      expect(text + lines.join('')).not.toContain('hunter2')
    }
  })

  it('answers unknown identity paths with a JSON 404', async () => {
    const base = await start({ auth: fakeAuth().service })
    for (const path of ['/v1/viewer/', '/v1/viewer/friends/', '/v1/viewer/friends/812', '/v1/auth', '/v1/auth/', '/v1/auth/login', '/v1/friends', '/v1/session']) {
      const res = await fetch(`${base}${path}`)
      expect([res.status, await res.json()], path).toEqual([404, { error: 'not_found' }])
    }
  })
})

describe('GET /v1/viewer/friends', () => {
  it('is 401 for an anonymous visitor and never consults the ownership provider', async () => {
    const res = await fetch(`${await start({ auth: fakeAuth().service })}/v1/viewer/friends`)
    expect([res.status, await res.json()]).toEqual([401, { error: 'not_authenticated' }])
    expect(res.headers.get('cache-control')).toBe('no-store')
    const noDb = await fetch(`${await start()}/v1/viewer/friends`, { headers: { cookie: `rc_session=${TOKEN}` } })
    expect([noDb.status, await noDb.json()]).toEqual([401, { error: 'not_authenticated' }])
  })

  it('returns token ids as strings with their family, for the session wallet', async () => {
    const res = await fetch(`${await start({ auth: fakeAuth().service })}/v1/viewer/friends`, { headers: { cookie: `rc_session=${TOKEN}` } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      wallet: VIEWER.wallet,
      source: 'fixture',
      asOfBlock: '0',
      friends: [
        { tokenId: '812', family: { id: 2, name: 'Family' } },
        { tokenId: '1204', family: { id: 0, name: 'Skeleton' } },
        { tokenId: '4471', family: { id: 7, name: 'Sparkling' } },
      ],
    })
  })

  it('is 503 when no ownership provider is configured', async () => {
    const res = await fetch(`${await start({ auth: fakeAuth().service, friends: false })}/v1/viewer/friends`, { headers: { cookie: `rc_session=${TOKEN}` } })
    expect([res.status, await res.json()]).toEqual([503, { error: 'ownership_unavailable' }])
  })
})

describe('sign-in endpoints: request hardening', () => {
  it('accept only POST', async () => {
    const { service, calls } = fakeAuth()
    const base = await start({ auth: service })
    for (const path of POSTS)
      for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const res = await fetch(`${base}${path}`, { method })
        expect(res.status, `${method} ${path}`).toBe(405)
        expect(res.headers.get('allow')).toBe('POST')
      }
    expect(calls).toEqual([])
  })

  it('pass a well-formed JSON object to the handler, with or without a charset', async () => {
    const { service, calls } = fakeAuth()
    const base = await start({ auth: service })
    for (const type of ['application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON']) {
      const res = await fetch(`${base}/v1/auth/challenge`, json({ address: '0xabc', chainId: 4663 }, { 'content-type': type }))
      expect(res.status, type).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
    expect(calls).toHaveLength(3)
    expect(calls[0]).toEqual({ method: 'issueChallenge', args: [{ address: '0xabc', chainId: 4663 }] })
  })

  it('answer malformed JSON with a fixed 400 and never reach the handler', async () => {
    const { service, calls } = fakeAuth()
    // Thirteen bodies per route, more than a client is allowed in a minute; the limit has its own tests (edge.http.test.ts).
    const base = await start({ auth: service, rateLimits: false })
    for (const path of POSTS) {
      for (const body of ['', '{', '{"nonce":', 'nonce=abc', "{'nonce': 1}", '\u0000', '{"a":1}trailing']) {
        const res = await fetch(`${base}${path}`, json(body))
        expect([res.status, await res.json()], JSON.stringify(body)).toEqual([400, { error: 'invalid_json' }])
      }
      for (const body of ['null', '[]', '[{"nonce":"a"}]', '"text"', '42', 'true']) {
        const res = await fetch(`${base}${path}`, json(body))
        expect([res.status, await res.json()], body).toEqual([400, { error: 'invalid_request' }])
      }
    }
    expect(calls).toEqual([])
  })

  it('refuse any body that is not application/json', async () => {
    const { service, calls } = fakeAuth()
    const base = await start({ auth: service })
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp', 'text/json', '']) {
      const res = await fetch(`${base}/v1/auth/verify`, { method: 'POST', headers: type ? { 'content-type': type } : {}, body: Buffer.from('{"nonce":"a"}') })
      expect([res.status, await res.json()], type).toEqual([415, { error: 'unsupported_media_type' }])
    }
    expect(calls).toEqual([])
  })

  it('refuse an oversized body from its declared length, without reading it', async () => {
    const { service, calls } = fakeAuth()
    const base = await start({ auth: service })
    // Promise a huge body, send a few bytes, and never finish: the refusal must arrive anyway.
    const res = await new Promise<{ status: number; connection: string | undefined; body: string }>((done, fail) => {
      const req = request(`${base}/v1/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 500_000_000 } }, (r) => {
        let body = ''
        r.on('data', (c: Buffer) => (body += c.toString()))
        r.on('end', () => {
          done({ status: r.statusCode ?? 0, connection: r.headers.connection, body })
          req.destroy()
        })
      })
      req.on('error', fail)
      req.write('{"nonce":"')
    })
    expect(res).toEqual({ status: 413, connection: 'close', body: '{"error":"payload_too_large"}' })
    expect(calls).toEqual([])
  })

  it('refuse an oversized body that declared no length, as soon as it is too long', async () => {
    const { service, calls } = fakeAuth()
    const base = await start({ auth: service })
    const status = await new Promise<number>((done, fail) => {
      const req = request(`${base}/v1/auth/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (r) => {
        r.resume()
        done(r.statusCode ?? 0)
        req.destroy()
      })
      req.on('error', (err) => ((err as NodeJS.ErrnoException).code === 'ECONNRESET' || (err as NodeJS.ErrnoException).code === 'EPIPE' ? undefined : fail(err)))
      req.write(`{"address":"${'a'.repeat(MAX_BODY_BYTES)}`)
      req.write('a'.repeat(MAX_BODY_BYTES))
    })
    expect(status).toBe(413)
    expect(calls).toEqual([])

    // A body just inside the limit still gets through; one just past it does not.
    expect((await fetch(`${base}/v1/auth/challenge`, json({ address: 'a'.repeat(MAX_BODY_BYTES - 40), chainId: 4663 }))).status).toBe(200)
    expect((await fetch(`${base}/v1/auth/challenge`, json({ address: 'a'.repeat(MAX_BODY_BYTES), chainId: 4663 }))).status).toBe(413)
  })

  it('answer 503 when there is no database to keep sessions in', async () => {
    const base = await start()
    for (const path of POSTS) {
      const res = await fetch(`${base}${path}`, json({}))
      expect([res.status, await res.json()], path).toEqual([503, { error: 'auth_unavailable' }])
    }
  })

  it('map refusals to their status and code, and never leak an internal error', async () => {
    const lines: string[] = []
    const { service, fail } = fakeAuth()
    const base = await start({ auth: service, lines })
    for (const [status, code] of [[400, 'invalid_request'], [400, 'unsupported_chain'], [401, 'challenge_invalid'], [401, 'signature_invalid']] as const) {
      fail(new AuthError(status, code))
      const res = await fetch(`${base}/v1/auth/verify`, json({}))
      expect([res.status, await res.json()]).toEqual([status, { error: code }])
      expect(res.headers.get('set-cookie')).toBeNull()
    }
    fail(Object.assign(new TypeError("Cannot read properties of undefined (reading 'rows') at postgres://user:hunter2@db/rarecity"), { code: 'XX000' }))
    for (const path of POSTS) {
      const res = await fetch(`${base}${path}`, json({}))
      const text = await res.text()
      expect([res.status, text], path).toEqual([503, '{"error":"auth_unavailable"}'])
    }
    const log = lines.join('')
    expect(log).toContain('auth request failed')
    expect(log).toContain('TypeError')
    for (const leak of ['hunter2', 'Cannot read', 'at postgres']) expect(log).not.toContain(leak)
  })
})

describe('sign-in endpoints: same-origin rule', () => {
  it('accept this origin and refuse every other, before the body is read or the handler runs', async () => {
    const { service, calls } = fakeAuth()
    const base = await start({ auth: service })
    for (const path of POSTS) {
      expect((await fetch(`${base}${path}`, json({}, { origin: TEST_ORIGIN, 'sec-fetch-site': 'same-origin' }))).status, path).toBe(200)
      expect((await fetch(`${base}${path}`, json({}))).status, path).toBe(200)
    }
    const before = calls.length
    for (const path of POSTS) {
      const refused: Record<string, string>[] = [
        { origin: 'https://evil.example' },
        { origin: 'http://127.0.0.1:8788' },
        { origin: 'https://127.0.0.1:8787' },
        { origin: 'http://localhost:8787' },
        { origin: 'null' },
        { origin: `${TEST_ORIGIN}.evil.example` },
        { 'sec-fetch-site': 'cross-site' },
        { 'sec-fetch-site': 'same-site' },
        { 'sec-fetch-site': 'none' },
        { origin: TEST_ORIGIN, 'sec-fetch-site': 'cross-site' },
      ]
      for (const headers of refused) {
        // Even a malformed body is not looked at: the origin is refused first.
        const res = await fetch(`${base}${path}`, json('{not json', headers))
        expect([res.status, await res.json()], JSON.stringify(headers)).toEqual([403, { error: 'origin_mismatch' }])
        expect(res.headers.get('set-cookie')).toBeNull()
      }
    }
    expect(calls).toHaveLength(before)
  })

  it('never grant cross-origin access: no CORS header on any answer, and no preflight is honoured', async () => {
    const { service } = fakeAuth()
    const base = await start({ auth: service })
    const answers = [
      await fetch(`${base}/v1/viewer`, { headers: { origin: 'https://evil.example' } }),
      await fetch(`${base}/v1/viewer/friends`, { headers: { origin: 'https://evil.example', cookie: `rc_session=${TOKEN}` } }),
      await fetch(`${base}/v1/auth/verify`, json({}, { origin: 'https://evil.example' })),
      await fetch(`${base}/v1/auth/verify`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } }),
      await fetch(`${base}/v1/auth/logout`, json({}, { origin: TEST_ORIGIN })),
    ]
    expect(answers.map((r) => r.status)).toEqual([200, 200, 403, 405, 200])
    for (const res of answers) for (const [name] of res.headers) expect(name.startsWith('access-control-'), name).toBe(false)
  })
})

describe('the session cookie', () => {
  it('is set by verify and cleared by logout, with the right attributes for the mode', async () => {
    const { service, calls } = fakeAuth()
    const local = await start({ auth: service })
    const verified = await fetch(`${local}/v1/auth/verify`, json({ nonce: 'n', signature: 's' }, { cookie: 'rc_session=old-session' }))
    expect(verified.headers.get('set-cookie')).toBe(`rc_session=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`)
    expect(await verified.json()).toEqual(VIEWER)
    // The session the browser arrived with is handed to the service so it can be retired.
    expect(calls.at(-1)).toEqual({ method: 'verify', args: [{ nonce: 'n', signature: 's' }, 'old-session'] })
    const out = await fetch(`${local}/v1/auth/logout`, json({}, { cookie: `rc_session=${TOKEN}` }))
    expect(out.headers.get('set-cookie')).toBe('rc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
    expect(calls.at(-1)).toEqual({ method: 'logout', args: [TOKEN] })

    for (const mode of ['staging', 'production'] as const) {
      const base = await start({ auth: service, mode })
      const res = await fetch(`${base}/v1/auth/verify`, json({}, { origin: 'https://rarecity.example' }))
      expect(res.headers.get('set-cookie'), mode).toBe(`__Host-rc_session=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=604800`)
      expect(await fetch(`${base}/v1/viewer`, { headers: { cookie: `__Host-rc_session=${TOKEN}` } }).then((r) => r.json())).toMatchObject({ authenticated: true })
      // The unprefixed name is not a session outside local mode.
      expect(await fetch(`${base}/v1/viewer`, { headers: { cookie: `rc_session=${TOKEN}` } }).then((r) => r.json())).toEqual({ authenticated: false })
    }
  })

  it('is read by exact name only', () => {
    const cookie = sessionCookie('local')
    const req = (header?: string) => ({ headers: header === undefined ? {} : { cookie: header } }) as IncomingMessage
    expect(cookie.read(req())).toBeNull()
    expect(cookie.read(req('rc_session=abc'))).toBe('abc')
    expect(cookie.read(req('a=1;  rc_session=abc ; b=2'))).toBe('abc')
    expect(cookie.read(req('xrc_session=abc; rc_session_old=def; __Host-rc_session=ghi'))).toBeNull()
    expect(cookie.read(req('a=1;\trc_session=abc\t;b=2'))).toBe('abc')
    expect(cookie.read(req('rc_session='))).toBeNull()
    expect(cookie.read(req('rc_session'))).toBeNull()
    expect(sessionCookie('production').read(req('rc_session=abc; __Host-rc_session=ghi'))).toBe('ghi')
    // A name that only looks like the session cookie once exotic whitespace is stripped is a different cookie:
    // a browser would let another host set it, where it would never let it set a real `__Host-` cookie.
    for (const lookalike of ['\u00a0', '\u000b', '\u000c', '\u2000', '\ufeff', '\r', '\n']) {
      expect(sessionCookie('production').read(req(`${lookalike}__Host-rc_session=planted`)), JSON.stringify(lookalike)).toBeNull()
      expect(sessionCookie('production').read(req(`${lookalike}__Host-rc_session=planted; __Host-rc_session=real`))).toBe('real')
      expect(cookie.read(req(`rc_session${lookalike}=planted`))).toBeNull()
    }
    expect(sessionCookie('staging').name).toBe('__Host-rc_session')
  })
})

describe('request helpers', () => {
  const incoming = (headers: Record<string, string>) => Object.assign(new PassThrough(), { headers }) as unknown as IncomingMessage & PassThrough

  it('gives up on a body that stalls', async () => {
    const req = incoming({ 'content-type': 'application/json' })
    req.write('{"nonce":')
    await expect(readJsonBody(req, MAX_BODY_BYTES, 20)).rejects.toMatchObject({ status: 408, code: 'request_timeout', close: true })
  })

  it('reads a body that arrives in pieces, and refuses one that outgrows its declared length', async () => {
    const req = incoming({ 'content-type': 'application/json', 'content-length': '13' })
    const reading = readJsonBody(req)
    req.write('{"a":')
    req.end('"bcde"}')
    expect(await reading).toEqual({ a: 'bcde' })

    const liar = incoming({ 'content-type': 'application/json', 'content-length': '10' })
    const refused = readJsonBody(liar, 64)
    liar.write('x'.repeat(65))
    await expect(refused).rejects.toMatchObject({ status: 413 })
    for (const length of ['-1', '1e3', 'abc', '99999999999999999999']) await expect(readJsonBody(incoming({ 'content-type': 'application/json', 'content-length': length })), length).rejects.toBeInstanceOf(HttpError)
  })

  it('applies the same-origin rule to exactly the configured origin', () => {
    const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage
    expect(() => assertSameOrigin(req({}), TEST_ORIGIN)).not.toThrow()
    expect(() => assertSameOrigin(req({ origin: TEST_ORIGIN, 'sec-fetch-site': 'same-origin' }), TEST_ORIGIN)).not.toThrow()
    const refused: Record<string, string>[] = [{ origin: `${TEST_ORIGIN}/` }, { origin: TEST_ORIGIN.toUpperCase() }, { origin: '' }, { 'sec-fetch-site': '' }]
    for (const headers of refused)
      expect(() => assertSameOrigin(req(headers), TEST_ORIGIN), JSON.stringify(headers)).toThrow(HttpError)
  })
})
