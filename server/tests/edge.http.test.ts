import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import type { AuthService } from '../src/auth/service'
import type { TrustedProxy } from '../src/clientKey'
import type { AppMode, ServerConfig } from '../src/config'
import { createLogger } from '../src/log'
import { createFixtureOwnershipProvider } from '../src/ownership/fixture'
import type { FriendsReader } from '../src/ownership/reader'
import { createRateLimiter } from '../src/rateLimit'
import { API_CSP, buildSecurityHeaders, documentCsp, PERMISSIONS_POLICY } from '../src/securityHeaders'
import { loadStaticSite, type StaticSite } from '../src/static'
import { TEST_ORIGIN, testConfig } from './testConfig'

const DEPLOYED_ORIGIN = 'https://rarecity.example'
const ADDRESSES = ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8']
/** Session cookie values the fake auth service knows, one per user. */
const token = (n: number) => String(n).padStart(43, 'T')
const userId = (n: number) => `7b0c1c7e-3c53-4d0e-9a52-${String(n).padStart(12, '0')}`

/** An auth service that counts what reaches it. Every call it sees is work a refused request must not cause. */
function fakeAuth() {
  const calls = { issueChallenge: [] as unknown[], verify: 0, logout: 0, viewer: 0 }
  const service: AuthService = {
    async issueChallenge(input) {
      calls.issueChallenge.push(input)
      return { nonce: 'a'.repeat(32), message: 'sign me', expiresAt: '2026-10-02T12:05:00.000Z' }
    },
    async verify() {
      calls.verify += 1
      return { token: token(1), expiresAt: new Date('2026-10-09T12:00:00.000Z'), maxAgeSeconds: 604_800, viewer: { authenticated: true, userId: userId(1), wallet: { address: ADDRESSES[0], chainId: 4663 }, session: { expiresAt: '2026-10-09T12:00:00.000Z' } } }
    },
    async logout() {
      calls.logout += 1
    },
    async viewer(presented) {
      calls.viewer += 1
      const n = presented && /^T*\d+$/.test(presented) ? Number(presented.replace(/^T+/, '')) : 0
      if (!n) return { authenticated: false }
      return { authenticated: true, userId: userId(n), wallet: { address: ADDRESSES[0], chainId: 4663 }, session: { expiresAt: '2026-10-09T12:00:00.000Z' } }
    },
  }
  return { service, calls }
}

/** The owned-Friends read, counting how often the (expensive) provider is asked. */
function countingFriends() {
  const provider = createFixtureOwnershipProvider()
  const state = { reads: 0 }
  const reader: FriendsReader = {
    source: provider.source,
    read(address) {
      state.reads += 1
      return provider.listOwnedFriends(address)
    },
  }
  return { reader, state }
}

let siteDir: string
let site: StaticSite
const servers: Server[] = []

beforeAll(async () => {
  siteDir = await mkdtemp(join(tmpdir(), 'rc-edge-'))
  await mkdir(join(siteDir, 'assets'), { recursive: true })
  await writeFile(join(siteDir, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/index-Dq3x9ZkP.js"></script></body></html>')
  await writeFile(join(siteDir, 'assets/index-Dq3x9ZkP.js'), 'console.log("rare city")')
  await writeFile(join(siteDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  site = (await loadStaticSite(siteDir))!
})
afterAll(async () => {
  await rm(siteDir, { recursive: true, force: true })
})
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
})

interface Started {
  base: string
  origin: string
  auth: ReturnType<typeof fakeAuth>
  friends: ReturnType<typeof countingFriends>
  lines: string[]
  advance(ms: number): void
}

async function start(options: { mode?: AppMode; trustedProxy?: TrustedProxy; config?: Partial<ServerConfig>; withSite?: boolean } = {}): Promise<Started> {
  const mode = options.mode ?? 'local'
  const origin = mode === 'local' ? TEST_ORIGIN : DEPLOYED_ORIGIN
  const config = testConfig({ mode, publicOrigin: origin, trustedProxy: options.trustedProxy ?? 'none', ...options.config })
  const auth = fakeAuth()
  const friends = countingFriends()
  const lines: string[] = []
  let at = 5_000_000
  const app = createApp({ config, db: null, migrationsDir: '/nonexistent', log: createLogger((l) => lines.push(l)), auth: auth.service, friends: friends.reader, site: options.withSite ? site : null, limiter: config.rateLimits ? createRateLimiter({ now: () => at }) : undefined })
  const server = createServer(app)
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, origin, auth, friends, lines, advance: (ms) => (at += ms) }
}

const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
const statuses = async (n: number, send: (i: number) => Promise<Response>) => {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push((await send(i)).status)
  return out
}
const count = (list: number[], status: number) => list.filter((s) => s === status).length
const CHALLENGE = '/v1/auth/challenge'
const VERIFY = '/v1/auth/verify'
const FRIENDS = '/v1/viewer/friends'

describe('rate limits: sign-in routes', () => {
  it('allow exactly ten a minute per client, then answer 429 without reaching the handler', async () => {
    for (const path of [CHALLENGE, VERIFY]) {
      const s = await start()
      const answers = await statuses(10, () => fetch(`${s.base}${path}`, post({ address: ADDRESSES[0], chainId: 4663 })))
      expect(answers, path).toEqual(Array(10).fill(200))
      const reached = () => s.auth.calls.issueChallenge.length + s.auth.calls.verify

      const refused = await fetch(`${s.base}${path}`, post({ address: ADDRESSES[0], chainId: 4663 }))
      expect([refused.status, await refused.text()], path).toEqual([429, '{"error":"rate_limited"}'])
      expect(refused.headers.get('retry-after')).toBe('60')
      expect(refused.headers.get('cache-control')).toBe('no-store')
      expect(refused.headers.get('content-type')).toBe('application/json; charset=utf-8')
      expect(refused.headers.get('connection')).toBe('close')
      expect(refused.headers.get('set-cookie')).toBeNull()
      for (const [name] of refused.headers) expect(name.startsWith('access-control-'), name).toBe(false)
      expect(reached()).toBe(10)

      // The wait is real and counts down; refused requests neither reach the handler nor extend it.
      s.advance(45_000)
      const later = await fetch(`${s.base}${path}`, post({}))
      expect([later.status, later.headers.get('retry-after')]).toEqual([429, '15'])
      s.advance(15_000)
      expect((await fetch(`${s.base}${path}`, post({ address: ADDRESSES[0], chainId: 4663 }))).status).toBe(200)
      expect(reached()).toBe(11)
    }
  })

  it('count the two routes separately, and do not limit sign-out', async () => {
    const s = await start()
    expect(count(await statuses(12, () => fetch(`${s.base}${CHALLENGE}`, post({}))), 200)).toBe(10)
    expect(count(await statuses(12, () => fetch(`${s.base}${VERIFY}`, post({}))), 200)).toBe(10)
    expect(await statuses(25, () => fetch(`${s.base}/v1/auth/logout`, post({})))).toEqual(Array(25).fill(200))
  })

  it('count a request whatever its body: malformed, oversized and non-JSON bodies cannot be used to probe for free', async () => {
    const s = await start()
    const junk: RequestInit[] = [post('{not json'), post('[]'), post(''), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }, post(JSON.stringify({ address: 'a'.repeat(5_000) }))]
    const answers = await statuses(10, (i) => fetch(`${s.base}${CHALLENGE}`, junk[i % junk.length]))
    expect(new Set(answers)).toEqual(new Set([400, 415, 413]))
    expect((await fetch(`${s.base}${CHALLENGE}`, post({ address: ADDRESSES[0], chainId: 4663 }))).status).toBe(429)
    expect(s.auth.calls.issueChallenge).toEqual([])
  })

  it('refuse another origin before counting, so a hostile page cannot spend a visitor\'s allowance', async () => {
    const s = await start()
    const hostile = await statuses(40, () => fetch(`${s.base}${CHALLENGE}`, post({}, { origin: 'https://evil.example' })))
    expect(hostile).toEqual(Array(40).fill(403))
    expect(count(await statuses(11, () => fetch(`${s.base}${CHALLENGE}`, post({}, { origin: s.origin }))), 200)).toBe(10)
  })

  it('are keyed by who asks, never by the address asked about: one wallet cannot be locked out by another client', async () => {
    const s = await start({ trustedProxy: 'railway' })
    const victim = ADDRESSES[0]
    const attacker = { 'x-real-ip': '198.51.100.66' }
    // The attacker asks for the victim's challenge until it is refused.
    const attack = await statuses(30, () => fetch(`${s.base}${CHALLENGE}`, post({ address: victim, chainId: 4663 }, attacker)))
    expect([count(attack, 200), count(attack, 429)]).toEqual([10, 20])
    // The victim, from its own network, signs in to that same address as if nothing had happened.
    const owner = { 'x-real-ip': '203.0.113.7' }
    expect(await statuses(10, () => fetch(`${s.base}${CHALLENGE}`, post({ address: victim, chainId: 4663 }, owner)))).toEqual(Array(10).fill(200))
    expect(await statuses(10, () => fetch(`${s.base}${VERIFY}`, post({ nonce: 'n', signature: 's' }, owner)))).toEqual(Array(10).fill(200))
    // And asking about many different addresses does not buy the attacker more requests.
    expect((await fetch(`${s.base}${CHALLENGE}`, post({ address: ADDRESSES[1], chainId: 4663 }, attacker))).status).toBe(429)
  })

  it('can be switched off for a local test run, and only through configuration', async () => {
    const s = await start({ config: { rateLimits: false } })
    expect(await statuses(40, () => fetch(`${s.base}${CHALLENGE}`, post({})))).toEqual(Array(40).fill(200))
  })
})

describe('rate limits: GET /v1/viewer/friends', () => {
  const as = (n: number, ip?: string) => ({ headers: { cookie: `rc_session=${token(n)}`, ...(ip ? { 'x-real-ip': ip } : {}) } })

  it('allows a signed-in user six reads a minute, wherever they come from, and refuses the seventh before the provider is asked', async () => {
    const s = await start({ trustedProxy: 'railway' })
    const answers = await statuses(9, (i) => fetch(`${s.base}${FRIENDS}`, as(1, `203.0.113.${i + 1}`)))
    expect(answers).toEqual([200, 200, 200, 200, 200, 200, 429, 429, 429])
    expect(s.friends.state.reads).toBe(6)

    const refused = await fetch(`${s.base}${FRIENDS}`, as(1, '203.0.113.200'))
    expect([refused.status, await refused.json()]).toEqual([429, { error: 'rate_limited' }])
    expect(refused.headers.get('retry-after')).toBe('60')
    expect(refused.headers.get('cache-control')).toBe('no-store')
    expect(refused.headers.get('vary')).toBe('Cookie')

    // Another user is not affected, even from a network the first one used.
    expect(await statuses(6, () => fetch(`${s.base}${FRIENDS}`, as(2, '203.0.113.1')))).toEqual(Array(6).fill(200))
    expect((await fetch(`${s.base}${FRIENDS}`, as(2, '203.0.113.1'))).status).toBe(429)
    expect(s.friends.state.reads).toBe(12)

    s.advance(60_000)
    expect((await fetch(`${s.base}${FRIENDS}`, as(1, '203.0.113.1'))).status).toBe(200)
  })

  it('allows a client thirty requests a minute across every user behind it', async () => {
    const s = await start({ trustedProxy: 'railway' })
    const shared = '198.51.100.10'
    // Five users behind one network, six reads each: all thirty are served.
    for (let user = 1; user <= 5; user++) expect(await statuses(6, () => fetch(`${s.base}${FRIENDS}`, as(user, shared))), `user ${user}`).toEqual(Array(6).fill(200))
    // A sixth user there is refused by the client ceiling, before its session is even looked up.
    const viewerLookups = s.auth.calls.viewer
    const sixth = await fetch(`${s.base}${FRIENDS}`, as(6, shared))
    expect([sixth.status, await sixth.json()]).toEqual([429, { error: 'rate_limited' }])
    expect(s.auth.calls.viewer).toBe(viewerLookups)
    expect(s.friends.state.reads).toBe(30)
    // From another network that same user is fine.
    expect((await fetch(`${s.base}${FRIENDS}`, as(6, '198.51.100.11'))).status).toBe(200)
  })

  it('still answers 401 to an anonymous visitor, and stops an anonymous flood before the session store', async () => {
    const s = await start()
    const answers = await statuses(35, () => fetch(`${s.base}${FRIENDS}`))
    expect([count(answers, 401), count(answers, 429)]).toEqual([30, 5])
    expect(s.auth.calls.viewer).toBe(30)
    expect(s.friends.state.reads).toBe(0)
    // Reading who is signed in is not limited by this.
    expect((await fetch(`${s.base}/v1/viewer`)).status).toBe(200)
  })
})

describe('client network: which header is believed', () => {
  it('none: only the socket peer counts, whatever a client says about itself', async () => {
    const s = await start({ trustedProxy: 'none' })
    const answers = await statuses(14, (i) => fetch(`${s.base}${CHALLENGE}`, post({}, { 'x-real-ip': `198.51.100.${i + 1}`, 'x-forwarded-for': `203.0.113.${i + 1}`, forwarded: `for=192.0.2.${i + 1}` })))
    expect([count(answers, 200), count(answers, 429)]).toEqual([10, 4])
  })

  it('railway: X-Real-IP separates clients, and X-Forwarded-For changes nothing', async () => {
    const s = await start({ trustedProxy: 'railway' })
    const a = await statuses(12, (i) => fetch(`${s.base}${CHALLENGE}`, post({}, { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': `198.51.100.${i + 1}` })))
    expect([count(a, 200), count(a, 429)]).toEqual([10, 2])
    const b = await statuses(10, () => fetch(`${s.base}${CHALLENGE}`, post({}, { 'x-real-ip': '203.0.113.8', 'x-forwarded-for': '203.0.113.7' })))
    expect(b).toEqual(Array(10).fill(200))
  })

  it('railway: one IPv6 /64 is one client, and a mapped address is its IPv4 self', async () => {
    const s = await start({ trustedProxy: 'railway' })
    const v6 = await statuses(12, (i) => fetch(`${s.base}${CHALLENGE}`, post({}, { 'x-real-ip': `2001:db8:12:3400::${(i + 1).toString(16)}` })))
    expect([count(v6, 200), count(v6, 429)]).toEqual([10, 2])
    expect((await fetch(`${s.base}${CHALLENGE}`, post({}, { 'x-real-ip': '2001:db8:12:3401::1' }))).status).toBe(200)

    const v4 = await statuses(12, (i) => fetch(`${s.base}${VERIFY}`, post({}, { 'x-real-ip': i % 2 ? '192.0.2.44' : '::ffff:192.0.2.44' })))
    expect([count(v4, 200), count(v4, 429)]).toEqual([10, 2])
  })

  it('railway: requests without a usable X-Real-IP share one strict bucket, with a warning that names nobody', async () => {
    const s = await start({ trustedProxy: 'railway' })
    const unusable: Record<string, string>[] = [{}, { 'x-forwarded-for': '203.0.113.7' }, { 'x-real-ip': 'unknown' }, { 'x-real-ip': '203.0.113.7, 198.51.100.1' }, { 'x-real-ip': '203.0.113.999' }, { 'x-real-ip': '203.0.113.7:443', 'x-forwarded-for': '198.51.100.20' }]
    const answers = await statuses(18, (i) => fetch(`${s.base}${CHALLENGE}`, post({}, unusable[i % unusable.length])))
    expect([count(answers, 200), count(answers, 429)]).toEqual([10, 8])
    // An identified client is untouched by the shared bucket being full.
    expect((await fetch(`${s.base}${CHALLENGE}`, post({}, { 'x-real-ip': '203.0.113.7' }))).status).toBe(200)

    await expect.poll(() => s.lines.filter((l) => l.includes('"request"')).length).toBe(19)
    const warnings = s.lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.level === 'warn')
    expect(warnings).toEqual([{ level: 'warn', time: expect.any(String), message: 'client network unavailable: requests are sharing one rate-limit bucket', trustedProxy: 'railway', requests: 1 }])
  })

  it('logs a keyed tag for the client, never its address', async () => {
    const s = await start({ trustedProxy: 'railway' })
    await fetch(`${s.base}/version`, { headers: { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.20' } })
    await fetch(`${s.base}/version`, { headers: { 'x-real-ip': '203.0.113.7' } })
    await fetch(`${s.base}/version`, { headers: { 'x-real-ip': '203.0.113.8' } })
    await fetch(`${s.base}/version`)
    await expect.poll(() => s.lines.length).toBe(4)
    const logged = s.lines.map((l) => JSON.parse(l) as { client: string; clientSource: string })
    expect(logged.map((l) => l.clientSource)).toEqual(['x-real-ip', 'x-real-ip', 'x-real-ip', 'fallback'])
    for (const line of logged) expect(line.client).toMatch(/^[0-9a-f]{8}$/)
    expect(logged[0].client).toBe(logged[1].client)
    expect(new Set(logged.map((l) => l.client)).size).toBe(3)
    const all = s.lines.join('')
    for (const address of ['203.0.113', '198.51.100', '127.0.0.1', 'ip4:', 'unidentified']) expect(all, address).not.toContain(address)

    // The tag is keyed per process: another process gives the same client a different one.
    const other = await start({ trustedProxy: 'railway' })
    await fetch(`${other.base}/version`, { headers: { 'x-real-ip': '203.0.113.7' } })
    await expect.poll(() => other.lines.length).toBe(1)
    expect((JSON.parse(other.lines[0]) as { client: string }).client).not.toBe(logged[0].client)
  })
})

describe('security headers', () => {
  const COMMON = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()', 'cross-origin-opener-policy': 'same-origin-allow-popups' }
  const DOCUMENT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'self'"
  const SECURITY = ['x-content-type-options', 'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy', 'strict-transport-security', 'content-security-policy', 'x-frame-options']
  const security = (res: Response) => Object.fromEntries(SECURITY.flatMap((name) => (res.headers.has(name) ? [[name, res.headers.get(name)]] : [])))

  it('builds exactly the policy the service documents, with no inline script, eval, subdomain or preload commitment', () => {
    for (const mode of ['local', 'staging', 'production'] as const) {
      const built = buildSecurityHeaders({ mode, frameAncestors: ['https://parent.example'], hstsMaxAge: 86_400 })
      const everything = JSON.stringify(built)
      for (const never of ['unsafe-inline', 'unsafe-eval', 'unsafe-hashes', 'includeSubDomains', 'preload', '*', 'http:', 'access-control']) expect(everything, never).not.toContain(never)
      expect(built.api['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'")
    }
    expect(PERMISSIONS_POLICY).toBe(COMMON['permissions-policy'])
    expect(API_CSP).toBe("default-src 'none'; frame-ancestors 'none'")
    expect(documentCsp({ mode: 'local', frameAncestors: [] })).toBe(DOCUMENT_CSP)
    expect(documentCsp({ mode: 'production', frameAncestors: [] })).toBe(`${DOCUMENT_CSP}; upgrade-insecure-requests`)
    expect(documentCsp({ mode: 'staging', frameAncestors: ['https://a.example', 'https://b.example:8443'] })).toBe(`${DOCUMENT_CSP} https://a.example https://b.example:8443; upgrade-insecure-requests`)
  })

  it('local: the app shell and the API are restricted, and nothing forces https on a developer machine', async () => {
    const s = await start({ withSite: true })
    const shell = await fetch(`${s.base}/`)
    expect(shell.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(security(shell)).toEqual({ ...COMMON, 'content-security-policy': DOCUMENT_CSP, 'x-frame-options': 'SAMEORIGIN' })
    expect(security(await fetch(`${s.base}/version`))).toEqual({ ...COMMON, 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'x-frame-options': 'DENY' })
  })

  it('staging and production: exact headers on the app shell, on client routes and on a revalidation', async () => {
    for (const [mode, hstsMaxAge] of [['staging', 31_536_000], ['production', 86_400]] as const) {
      const s = await start({ mode, withSite: true, config: { hstsMaxAge } })
      const expected = { ...COMMON, 'strict-transport-security': `max-age=${hstsMaxAge}`, 'content-security-policy': `${DOCUMENT_CSP}; upgrade-insecure-requests`, 'x-frame-options': 'SAMEORIGIN' }
      const shell = await fetch(`${s.base}/`)
      expect(security(shell), mode).toEqual(expected)
      expect(security(await fetch(`${s.base}/friend/812`)), mode).toEqual(expected)
      const revalidated = await fetch(`${s.base}/`, { headers: { 'if-none-match': shell.headers.get('etag')! } })
      expect([revalidated.status, security(revalidated)]).toEqual([304, expected])
    }
  })

  it('staging and production: every other answer carries the restrictive policy, whatever its status', async () => {
    for (const mode of ['staging', 'production'] as const) {
      const s = await start({ mode, withSite: true, config: { hstsMaxAge: 86_400 } })
      const expected = { ...COMMON, 'strict-transport-security': 'max-age=86400', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'x-frame-options': 'DENY' }
      const answers: [string, Response, number][] = [
        ['health', await fetch(`${s.base}/health`), 200],
        ['version', await fetch(`${s.base}/version`), 200],
        ['city', await fetch(`${s.base}/v1/city`), 503],
        ['viewer', await fetch(`${s.base}/v1/viewer`), 200],
        ['friends', await fetch(`${s.base}${FRIENDS}`), 401],
        ['script', await fetch(`${s.base}/assets/index-Dq3x9ZkP.js`), 200],
        ['image', await fetch(`${s.base}/favicon.svg`), 200],
        ['missing file', await fetch(`${s.base}/missing.js`), 404],
        ['unknown api path', await fetch(`${s.base}/v1/nope`), 404],
        ['wrong method', await fetch(`${s.base}/v1/city`, { method: 'DELETE' }), 405],
        ['bad path', await fetch(`${s.base}/%E0%A4%A`), 400],
        ['challenge', await fetch(`${s.base}${CHALLENGE}`, post({}, { origin: DEPLOYED_ORIGIN })), 200],
        ['other origin', await fetch(`${s.base}${CHALLENGE}`, post({}, { origin: 'https://evil.example' })), 403],
        ['malformed body', await fetch(`${s.base}${VERIFY}`, post('{', { origin: DEPLOYED_ORIGIN })), 400],
      ]
      for (const [name, res, status] of answers) expect([name, res.status, security(res)]).toEqual([name, status, expected])
      // A rate-limited answer too.
      await statuses(10, () => fetch(`${s.base}${CHALLENGE}`, post({})))
      const limited = await fetch(`${s.base}${CHALLENGE}`, post({}))
      expect([limited.status, security(limited)]).toEqual([429, expected])
    }
  })

  it('names a configured parent in frame-ancestors and drops X-Frame-Options, which cannot express one', async () => {
    const frameAncestors = ['https://rarefriends.example', 'https://www.rarefriends.example']
    const s = await start({ mode: 'production', withSite: true, config: { frameAncestors, hstsMaxAge: 86_400 } })
    const shell = await fetch(`${s.base}/`)
    expect(shell.headers.get('content-security-policy')).toBe(`${DOCUMENT_CSP} https://rarefriends.example https://www.rarefriends.example; upgrade-insecure-requests`)
    expect(shell.headers.has('x-frame-options')).toBe(false)
    expect((await fetch(`${s.base}/friend/812`)).headers.has('x-frame-options')).toBe(false)
    // Only the app is ever framed. Data and files still refuse every parent.
    const api = await fetch(`${s.base}/v1/viewer`)
    expect([api.headers.get('content-security-policy'), api.headers.get('x-frame-options')]).toEqual(["default-src 'none'; frame-ancestors 'none'", 'DENY'])
  })

  it('never takes a frame parent, or anything else, from the request', async () => {
    const s = await start({ mode: 'production', withSite: true, config: { hstsMaxAge: 86_400 } })
    // Sent with node:http: fetch would quietly replace the Host header with the real one.
    const res = await new Promise<Response>((done, fail) => {
      const { port } = new URL(s.base)
      const req = request({ host: '127.0.0.1', port, path: '/', method: 'GET', headers: { host: 'evil.example', origin: 'https://evil.example', referer: 'https://evil.example/frame', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' } }, (r) => {
        const chunks: Buffer[] = []
        r.on('data', (c: Buffer) => chunks.push(c))
        r.on('end', () => done(new Response(Buffer.concat(chunks), { status: r.statusCode, headers: Object.entries(r.headers).map(([k, v]) => [k, String(v)] as [string, string]) })))
      })
      req.on('error', fail)
      req.end()
    })
    expect(res.status).toBe(200)
    expect(security(res)).toEqual({ ...COMMON, 'strict-transport-security': 'max-age=86400', 'content-security-policy': `${DOCUMENT_CSP}; upgrade-insecure-requests`, 'x-frame-options': 'SAMEORIGIN' })
    for (const [name, value] of res.headers) {
      expect(name.startsWith('access-control-'), name).toBe(false)
      expect(value, name).not.toContain('evil.example')
    }
  })
})
