import { createHmac, randomBytes } from 'node:crypto'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { gzipSync } from 'node:zlib'
import type { PropertyReader } from './activation/properties'
import { ActivationError, type ActivationService } from './activation/service'
import { AuthError, type AuthService, type LiveSession } from './auth/service'
import type { CityReader } from './city/store'
import { clientKey, type ClientKey } from './clientKey'
import type { ServerConfig } from './config'
import { databaseStatus, type DatabaseStatus } from './db/migrations'
import type { Database } from './db/pool'
import {
  ACTIVATION_INTENTS_ENDPOINT,
  ACTIVATIONS_ENDPOINT,
  ANONYMOUS_VIEWER_RESPONSE,
  AUTH_CHALLENGE_ENDPOINT,
  AUTH_LOGOUT_ENDPOINT,
  AUTH_VERIFY_ENDPOINT,
  CITY_ENDPOINT,
  FRIENDS_ENDPOINT,
  isCityStateShape,
  STATE_VERSION,
  VIEWER_ENDPOINT,
  type ActivationErrorCode,
  type CityErrorCode,
  type CityMeta,
  type CityResponse,
  type FriendsResponse,
  type IdentityErrorCode,
} from './engine'
import { assertSameOrigin, HttpError, readJsonBody, sessionCookie } from './http'
import { errorFields, type Logger } from './log'
import { OwnershipError } from './ownership/provider'
import type { FriendsReader } from './ownership/reader'
import { createRateLimiter, LIMITS, unlimited, type RateLimiter, type RateRule } from './rateLimit'
import { buildSecurityHeaders } from './securityHeaders'
import type { StaticFile, StaticSite } from './static'

export const SERVICE_NAME = 'rare-city-server'

export interface AppDeps {
  config: ServerConfig
  /** null when no database is configured (APP_MODE=local only). */
  db: Database | null
  migrationsDir: string
  log: Logger
  /** The shared city's read side. null when there is no database to read it from. */
  city?: CityReader | null
  /** Wallet sign-in and sessions. null when there is no database to keep them in. */
  auth?: AuthService | null
  /** Owned-Friends reads for the signed-in wallet. null = not available. */
  friends?: FriendsReader | null
  /** Permanent Friend activation. null when there is no database to write it to. It also needs `config.activationEnabled`. */
  activation?: ActivationService | null
  /** Which Friends already have a property, for the My Friends annotation. null = not available. */
  properties?: PropertyReader | null
  /** The built client, served from this origin. null = API only. */
  site?: StaticSite | null
  /** How long /ready waits for the database before answering not-ready. */
  readyTimeoutMs?: number
  /** Request limits. Defaults to an in-memory limiter, or none when `config.rateLimits` is off. */
  limiter?: RateLimiter
}

const READY_TIMEOUT_MS = 4_000
/** At most one warning per this long about requests whose client network could not be established. */
const FALLBACK_WARNING_EVERY_MS = 60_000
/** Paths that belong to the service. They never fall through to the client app. */
const RESERVED = ['/health', '/ready', '/version', '/v1']

const isReserved = (path: string) => RESERVED.some((p) => path === p || path.startsWith(`${p}/`))
const acceptsGzip = (req: IncomingMessage) => /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
/** If-None-Match may list several tags, and a proxy that recompresses marks them weak (W/"..."). */
const matchesEtag = (req: IncomingMessage, etag: string) =>
  String(req.headers['if-none-match'] ?? '')
    .split(',')
    .some((tag) => tag.trim().replace(/^W\//, '') === etag)

/** Every answer leaves through here. The security headers were put on the response before routing began. */
function end(res: ServerResponse, status: number, headers: Record<string, string | number | string[]>, body?: Buffer | string) {
  res.writeHead(status, { 'x-content-type-options': 'nosniff', ...headers })
  res.end(res.req.method === 'HEAD' ? undefined : body)
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  const payload = JSON.stringify(body)
  end(res, status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store', ...headers }, payload)
}

/** Send a prepared body, honouring If-None-Match and gzip. */
function sendCached(req: IncomingMessage, res: ServerResponse, file: { body: Buffer; gzip: Buffer | null; contentType: string; cacheControl: string; etag: string }) {
  const headers: Record<string, string | number> = { 'content-type': file.contentType, 'cache-control': file.cacheControl, etag: file.etag, vary: 'Accept-Encoding' }
  if (matchesEtag(req, file.etag)) return end(res, 304, headers)
  const gzip = file.gzip && acceptsGzip(req) ? file.gzip : null
  if (gzip) headers['content-encoding'] = 'gzip'
  const body = gzip ?? file.body
  end(res, 200, { ...headers, 'content-length': body.length }, body)
}

/** Resolve with `fallback` if `work` has not settled within `ms`; rejections pass through. */
function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    work.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

interface Readiness {
  status: 'ready' | 'not-ready'
  checks: {
    database: DatabaseStatus['database'] | 'not-configured' | 'unknown'
    migrations?: DatabaseStatus['migrations']
    environment?: DatabaseStatus['environment']
  }
}

async function readiness({ config, db, migrationsDir, log, readyTimeoutMs = READY_TIMEOUT_MS }: AppDeps): Promise<Readiness> {
  // Without a database (local only) the shell itself is all there is to be ready.
  if (!db) return { status: 'ready', checks: { database: 'not-configured' } }
  const unreachable: DatabaseStatus = { database: 'unreachable', migrations: 'unknown', environment: 'unknown' }
  let checks: DatabaseStatus
  try {
    checks = await withTimeout(databaseStatus(db, { dir: migrationsDir, environment: config.mode }), readyTimeoutMs, unreachable)
  } catch (err) {
    // Not a database answer at all (for example the migrations directory is missing from the image).
    log.error('readiness check failed', errorFields(err))
    return { status: 'not-ready', checks: { database: 'unknown', migrations: 'unknown', environment: 'unknown' } }
  }
  const ready = checks.database === 'ok' && checks.migrations === 'ok' && checks.environment === 'ok'
  return { status: ready ? 'ready' : 'not-ready', checks }
}

/** The `ETag` of a city: which installation, at which sequence. */
const cityEtag = (meta: CityMeta) => `"${meta.instance}.${meta.sequence}"`

/** Per-viewer answers: never stored by anything between the service and the browser. */
const PRIVATE = { 'cache-control': 'no-store', vary: 'Cookie' }

/** What a mutating handler is given. Everything in it has already passed the common boundary. */
interface PostContext {
  req: IncomingMessage
  res: ServerResponse
  /** The parsed JSON object. Its contents are still untrusted. */
  body: Record<string, unknown>
  client: ClientKey
}

/**
 * A request that changes something. Declaring a route here is the only way to accept one:
 * the boundary in `servePost` runs before `handle`, in this order: POST only, the
 * same-origin rule, the client rate limit, then a JSON object body within the size limit.
 */
interface PostRoute {
  /** Client-network limits, counted before the body is read. null = not limited. */
  limit: readonly RateRule[] | null
  /** What the client is told, and what is logged, when the handler fails unexpectedly. */
  failure: { code: IdentityErrorCode | ActivationErrorCode; log: string }
  handle(ctx: PostContext): Promise<void>
}

/**
 * The HTTP surface of the service: diagnostics, the public city read, identity, and (when
 * a client build is present) the Rare City app itself.
 *
 * Reads are GET/HEAD and never look at a request body. The requests that change anything
 * are POSTs declared in `posts`: the three sign-in routes, which change sessions and never
 * the city, and the two activation routes, which are the only way the city itself changes
 * and which refuse outright unless `config.activationEnabled` is set.
 */
export function createApp(deps: AppDeps): RequestListener {
  const { config, log, city = null, site = null, auth = null, friends = null, activation = null, properties = null } = deps
  const cookie = sessionCookie(config.mode)
  const security = buildSecurityHeaders(config)
  const limiter = deps.limiter ?? (config.rateLimits ? createRateLimiter() : unlimited)
  /** Keys the client tag in the request log. Random per process, so a tag cannot be turned back into an address. */
  const tagKey = randomBytes(32)
  const clientTag = (client: ClientKey) => createHmac('sha256', tagKey).update(client.key).digest('hex').slice(0, 8)
  /** The serialised city for the sequence last served, so an unchanged city is not rebuilt per request. */
  let cached: (StaticFile & { etag: string }) | null = null
  let unidentified = 0
  let warnedAt = Number.NEGATIVE_INFINITY

  const cityError = (res: ServerResponse, code: CityErrorCode) => send(res, 503, { error: code }, { 'retry-after': '5' })
  const identityError = (res: ServerResponse, status: number, code: IdentityErrorCode | ActivationErrorCode, headers: Record<string, string | string[]> = {}) => send(res, status, { error: code }, { ...PRIVATE, ...headers })

  /**
   * Count this request against `rules` for `key`. Answers 429 and returns false when it is over the limit.
   * `close` ends the connection, for a refusal sent before an attached body has been read.
   */
  function withinLimit(res: ServerResponse, scope: string, key: string, rules: readonly RateRule[], close = false): boolean {
    const decision = limiter.take(scope, key, rules)
    if (decision.allowed) return true
    identityError(res, 429, 'rate_limited', { 'retry-after': String(decision.retryAfterSeconds), ...(close ? { connection: 'close' } : {}) })
    return false
  }

  /** The client-network limit for a route. Requests with no usable network share one bucket, and that is said in the log. */
  function withinClientLimit(res: ServerResponse, scope: string, client: ClientKey, rules: readonly RateRule[], close = false): boolean {
    if (client.source === 'fallback') {
      unidentified += 1
      const at = performance.now()
      if (at - warnedAt >= FALLBACK_WARNING_EVERY_MS) {
        log.warn('client network unavailable: requests are sharing one rate-limit bucket', { trustedProxy: config.trustedProxy, requests: unidentified })
        warnedAt = at
        unidentified = 0
      }
    }
    return withinLimit(res, `${scope}:client`, client.key, rules, close)
  }

  /** The app shell is a document: it gets the document policy in place of the one every other answer carries. */
  function sendDocument(req: IncomingMessage, res: ServerResponse, file: StaticFile) {
    res.removeHeader('x-frame-options')
    for (const [name, value] of Object.entries(security.document)) res.setHeader(name, value)
    sendCached(req, res, file)
  }

  async function serveCity(req: IncomingMessage, res: ServerResponse) {
    if (!city) return cityError(res, 'city_unavailable')
    let meta: CityMeta | null
    try {
      meta = await city.meta()
      if (!meta) return cityError(res, 'city_not_initialized')
      if (cached?.etag !== cityEtag(meta)) {
        const record = await city.read()
        if (!record) return cityError(res, 'city_not_initialized')
        // The stored state is untyped until proven otherwise; nothing unvalidated is served.
        if (record.meta.stateVersion !== STATE_VERSION) {
          log.error('city state version is not the one this build serves', { stored: record.meta.stateVersion, supported: STATE_VERSION })
          return cityError(res, 'city_state_unsupported')
        }
        if (!isCityStateShape(record.state)) {
          log.error('stored city state failed validation', { sequence: record.meta.sequence })
          return cityError(res, 'city_state_invalid')
        }
        // Meta and state come from the same row, so the sequence always describes this state.
        // One body for every caller: it never says who is looking, so it is safe to share.
        const response: CityResponse = { city: record.meta, server: { mode: config.mode }, state: record.state }
        const body = Buffer.from(JSON.stringify(response))
        cached = { body, gzip: gzipSync(body), contentType: 'application/json; charset=utf-8', cacheControl: 'no-cache', etag: cityEtag(record.meta) }
      }
    } catch (err) {
      log.error('city read failed', errorFields(err))
      return cityError(res, 'city_unavailable')
    }
    sendCached(req, res, cached)
  }

  /** Who the session cookie belongs to. Built for this request alone; nothing about it is ever cached. */
  async function serveViewer(req: IncomingMessage, res: ServerResponse) {
    // Without a database there are no sessions, so everyone is anonymous.
    if (!auth) return send(res, 200, ANONYMOUS_VIEWER_RESPONSE, PRIVATE)
    const presented = cookie.read(req)
    try {
      const viewer = await auth.viewer(presented)
      // A cookie that is no longer a session (expired, revoked, garbage) is cleared rather than sent forever.
      return send(res, 200, viewer, presented && !viewer.authenticated ? { ...PRIVATE, 'set-cookie': cookie.clear() } : PRIVATE)
    } catch (err) {
      log.error('viewer read failed', errorFields(err))
      return identityError(res, 503, 'viewer_unavailable', { 'retry-after': '5' })
    }
  }

  /** The Friends the signed-in wallet owns, read from the ownership provider. Never from the request. */
  async function serveFriends(req: IncomingMessage, res: ServerResponse, client: ClientKey) {
    // Before the session is looked up: an anonymous flood is stopped without touching the database.
    if (!withinClientLimit(res, FRIENDS_ENDPOINT, client, LIMITS.friends.client)) return
    if (!auth) return identityError(res, 401, 'not_authenticated')
    let viewer
    try {
      viewer = await auth.viewer(cookie.read(req))
    } catch (err) {
      log.error('viewer read failed', errorFields(err))
      return identityError(res, 503, 'viewer_unavailable', { 'retry-after': '5' })
    }
    if (!viewer.authenticated) return identityError(res, 401, 'not_authenticated')
    // Keyed by who is asking, from the session. Before the provider: a refused request costs no chain read.
    if (!withinLimit(res, `${FRIENDS_ENDPOINT}:user`, viewer.userId, LIMITS.friends.user)) return
    if (!friends) return identityError(res, 503, 'ownership_unavailable', { 'retry-after': '30' })
    try {
      const owned = await friends.read(viewer.wallet.address)
      // Which of them already have a property, from the normalized rows. A read that fails leaves the
      // annotation out altogether: "unknown" is never reported as "none".
      let activated: Awaited<ReturnType<PropertyReader['forFriends']>> | null = null
      if (properties) {
        try {
          activated = await properties.forFriends(owned.friends.map((f) => f.tokenId))
        } catch (err) {
          log.warn('friend property annotation failed', errorFields(err))
        }
      }
      const body: FriendsResponse = {
        wallet: viewer.wallet,
        source: friends.source,
        asOfBlock: owned.blockNumber.toString(),
        friends: owned.friends.map((f) => {
          const tokenId = f.tokenId.toString()
          return activated ? { tokenId, family: f.family, property: activated.get(tokenId) ?? null } : { tokenId, family: f.family }
        }),
      }
      return send(res, 200, body, PRIVATE)
    } catch (err) {
      const reason = err instanceof OwnershipError ? err.reason : 'unavailable'
      log.warn('owned friends read failed', { reason, ...errorFields(err instanceof OwnershipError && err.cause ? err.cause : err) })
      // "Could not tell" is its own answer. It is never an empty list.
      if (reason === 'too-large') return identityError(res, 422, 'ownership_too_large')
      return identityError(res, 503, 'ownership_unavailable', { 'retry-after': '10' })
    }
  }

  /** A sign-in route: the common boundary, then the auth service if there is one to ask. */
  const signIn = (limit: PostRoute['limit'], handle: (service: AuthService, ctx: PostContext) => Promise<void>): PostRoute => ({
    limit,
    failure: { code: 'auth_unavailable', log: 'auth request failed' },
    async handle(ctx) {
      if (!auth) return identityError(ctx.res, 503, 'auth_unavailable', { 'retry-after': '30' })
      await handle(auth, ctx)
    },
  })

  /**
   * An activation route: the common boundary, then, in this order and before any chain read:
   * the feature gate, the exact live session behind the cookie, and the per-user limit.
   *
   * The handler is given the SESSION (the database rows), not the public viewer: an
   * activation is tied to one exact session, and a viewer does not say which one it is.
   */
  const activationRoute = (path: string, limits: { client: readonly RateRule[]; user: readonly RateRule[] }, handle: (service: ActivationService, session: LiveSession, body: Record<string, unknown>) => Promise<unknown>): PostRoute => ({
    limit: limits.client,
    failure: { code: 'activation_unavailable', log: 'activation request failed' },
    async handle({ req, res, body }) {
      // Off means off: no session lookup, no database read, no chain read.
      if (!config.activationEnabled) return identityError(res, 403, 'activation_disabled')
      if (!auth || !activation) return identityError(res, 503, 'activation_unavailable', { 'retry-after': '30' })
      const session = await auth.session(cookie.read(req))
      if (!session) return identityError(res, 401, 'not_authenticated')
      // Keyed by who is asking, from the session. Before the service: a refused request costs no chain read.
      if (!withinLimit(res, `${path}:user`, session.userId, limits.user)) return
      send(res, 200, await handle(activation, session, body), PRIVATE)
    },
  })

  /** The requests that change something. Each handler runs only after the boundary in `servePost` has passed. */
  const posts: Record<string, PostRoute> = {
    // Limited by who is asking, never by the address being asked about: nobody can use up another wallet's sign-in.
    [AUTH_CHALLENGE_ENDPOINT]: signIn(LIMITS.authChallenge.client, async (service, { res, body }) => {
      send(res, 200, await service.issueChallenge(body), PRIVATE)
    }),
    [AUTH_VERIFY_ENDPOINT]: signIn(LIMITS.authVerify.client, async (service, { req, res, body }) => {
      const opened = await service.verify(body, cookie.read(req))
      // The credential leaves the service exactly here, in a cookie script cannot read. It is never in a body or a log.
      send(res, 200, opened.viewer, { ...PRIVATE, 'set-cookie': cookie.set(opened.token, opened.maxAgeSeconds) })
    }),
    [AUTH_LOGOUT_ENDPOINT]: signIn(null, async (service, { req, res }) => {
      await service.logout(cookie.read(req))
      send(res, 200, ANONYMOUS_VIEWER_RESPONSE, { ...PRIVATE, 'set-cookie': cookie.clear() })
    }),
    [ACTIVATION_INTENTS_ENDPOINT]: activationRoute(ACTIVATION_INTENTS_ENDPOINT, LIMITS.activationIntent, (service, session, body) => service.issueIntent(session, body)),
    [ACTIVATIONS_ENDPOINT]: activationRoute(ACTIVATIONS_ENDPOINT, LIMITS.activationCommit, (service, session, body) => service.commit(session, body)),
  }

  /**
   * THE BOUNDARY for every request that changes something. In order, before the handler:
   * the same-origin rule, the route's client rate limit, then the body (JSON only, an
   * object, within the size limit). A request refused at any step has done no work beyond it.
   */
  async function servePost(req: IncomingMessage, res: ServerResponse, path: string, client: ClientKey) {
    const route = posts[path]
    try {
      assertSameOrigin(req, config.publicOrigin)
      // Counted before the body is read, so a malformed or oversized body is still a counted request.
      if (route.limit && !withinClientLimit(res, path, client, route.limit, true)) return
      const body = await readJsonBody(req)
      await route.handle({ req, res, body, client })
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.code }, err.close ? { ...PRIVATE, connection: 'close' } : PRIVATE)
      if (err instanceof AuthError) return identityError(res, err.status, err.code)
      // A refusal the activation service decided on. A 503 among them is an authority that could not answer just now.
      if (err instanceof ActivationError) return identityError(res, err.status, err.code, err.status === 503 ? { 'retry-after': '10' } : {})
      // Anything else is the database or a bug. The client learns only that the route is unavailable.
      log.error(route.failure.log, { path, ...errorFields(err) })
      return identityError(res, 503, route.failure.code, { 'retry-after': '5' })
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse, path: string, client: ClientKey) {
    if (Object.hasOwn(posts, path)) {
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' }, { allow: 'POST', connection: 'close' })
      return servePost(req, res, path, client)
    }
    // Refused before anything is read; closing the connection means an attached body is never consumed.
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD', connection: 'close' })
    switch (path) {
      case '/health':
        // Liveness: the process is up. Deliberately independent of the database.
        return send(res, 200, { status: 'ok' })
      case '/ready': {
        const result = await readiness(deps)
        return send(res, result.status === 'ready' ? 200 : 503, result)
      }
      case '/version':
        return send(res, 200, { service: SERVICE_NAME, mode: config.mode, commit: config.commit })
      case CITY_ENDPOINT:
        return serveCity(req, res)
      case VIEWER_ENDPOINT:
        return serveViewer(req, res)
      case FRIENDS_ENDPOINT:
        return serveFriends(req, res, client)
    }
    // Service paths never fall through to the client, so a wrong API path is an honest 404.
    if (!site || isReserved(path)) return send(res, 404, { error: 'not_found' })
    const file = site.file(path)
    if (file) return file === site.index ? sendDocument(req, res, file) : sendCached(req, res, file)
    // A missing file is a 404; anything else is a client-side route and gets the app shell.
    if (path.slice(path.lastIndexOf('/') + 1).includes('.')) return send(res, 404, { error: 'not_found' })
    return sendDocument(req, res, site.index)
  }

  return (req, res) => {
    const started = performance.now()
    // Before anything can answer: every response carries the restrictive policy unless it is the app shell.
    for (const [name, value] of Object.entries(security.api)) res.setHeader(name, value)
    const client = clientKey(req, config.trustedProxy)
    let path: string
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    } catch {
      return send(res, 400, { error: 'bad_request' })
    }
    route(req, res, path, client)
      .catch((err: unknown) => {
        log.error('request failed', { method: req.method, path, ...errorFields(err) })
        if (!res.headersSent) send(res, 500, { error: 'internal_error' })
        else res.end()
      })
      .finally(() => {
        // Platform health probes hit /health every few seconds; a 200 there is not worth a line.
        if (path === '/health' && res.statusCode === 200) return
        // `client` is a keyed tag of the client network, not the address: enough to tell two clients apart in one process's log.
        log.info('request', { method: req.method, path, status: res.statusCode, ms: Math.round(performance.now() - started), client: clientTag(client), clientSource: client.source })
      })
  }
}
