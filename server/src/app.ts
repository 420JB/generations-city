import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { gzipSync } from 'node:zlib'
import { AuthError, type AuthService } from './auth/service'
import type { CityReader } from './city/store'
import type { ServerConfig } from './config'
import { databaseStatus, type DatabaseStatus } from './db/migrations'
import type { Database } from './db/pool'
import {
  ANONYMOUS_VIEWER_RESPONSE,
  AUTH_CHALLENGE_ENDPOINT,
  AUTH_LOGOUT_ENDPOINT,
  AUTH_VERIFY_ENDPOINT,
  CITY_ENDPOINT,
  FRIENDS_ENDPOINT,
  isCityStateShape,
  STATE_VERSION,
  VIEWER_ENDPOINT,
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
  /** The built client, served from this origin. null = API only. */
  site?: StaticSite | null
  /** How long /ready waits for the database before answering not-ready. */
  readyTimeoutMs?: number
}

const READY_TIMEOUT_MS = 4_000
/** Paths that belong to the service. They never fall through to the client app. */
const RESERVED = ['/health', '/ready', '/version', '/v1']

const isReserved = (path: string) => RESERVED.some((p) => path === p || path.startsWith(`${p}/`))
const acceptsGzip = (req: IncomingMessage) => /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
/** If-None-Match may list several tags, and a proxy that recompresses marks them weak (W/"..."). */
const matchesEtag = (req: IncomingMessage, etag: string) =>
  String(req.headers['if-none-match'] ?? '')
    .split(',')
    .some((tag) => tag.trim().replace(/^W\//, '') === etag)

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

/**
 * The HTTP surface of the service: diagnostics, the public city read, identity, and (when
 * a client build is present) the Rare City app itself.
 *
 * The city is shared and read-only: nothing here changes it. Reads are GET/HEAD and never
 * look at a request body. The only requests that change anything are the three sign-in
 * POSTs, and they change sessions, never the city.
 */
export function createApp(deps: AppDeps): RequestListener {
  const { config, log, city = null, site = null, auth = null, friends = null } = deps
  const cookie = sessionCookie(config.mode)
  /** The serialised city for the sequence last served, so an unchanged city is not rebuilt per request. */
  let cached: (StaticFile & { etag: string }) | null = null

  const cityError = (res: ServerResponse, code: CityErrorCode) => send(res, 503, { error: code }, { 'retry-after': '5' })
  const identityError = (res: ServerResponse, status: number, code: IdentityErrorCode, headers: Record<string, string | string[]> = {}) => send(res, status, { error: code }, { ...PRIVATE, ...headers })

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
  async function serveFriends(req: IncomingMessage, res: ServerResponse) {
    if (!auth) return identityError(res, 401, 'not_authenticated')
    let viewer
    try {
      viewer = await auth.viewer(cookie.read(req))
    } catch (err) {
      log.error('viewer read failed', errorFields(err))
      return identityError(res, 503, 'viewer_unavailable', { 'retry-after': '5' })
    }
    if (!viewer.authenticated) return identityError(res, 401, 'not_authenticated')
    if (!friends) return identityError(res, 503, 'ownership_unavailable', { 'retry-after': '30' })
    try {
      const owned = await friends.read(viewer.wallet.address)
      const body: FriendsResponse = {
        wallet: viewer.wallet,
        source: friends.source,
        asOfBlock: owned.blockNumber.toString(),
        friends: owned.friends.map((f) => ({ tokenId: f.tokenId.toString(), family: f.family })),
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

  /** The requests that change something. Each runs only after the same-origin rule and the body limits have passed. */
  const posts: Record<string, (req: IncomingMessage, res: ServerResponse, service: AuthService, body: Record<string, unknown>) => Promise<void>> = {
    async [AUTH_CHALLENGE_ENDPOINT](_req, res, service, body) {
      send(res, 200, await service.issueChallenge(body), PRIVATE)
    },
    async [AUTH_VERIFY_ENDPOINT](req, res, service, body) {
      const opened = await service.verify(body, cookie.read(req))
      // The credential leaves the service exactly here, in a cookie script cannot read. It is never in a body or a log.
      send(res, 200, opened.viewer, { ...PRIVATE, 'set-cookie': cookie.set(opened.token, opened.maxAgeSeconds) })
    },
    async [AUTH_LOGOUT_ENDPOINT](req, res, service) {
      await service.logout(cookie.read(req))
      send(res, 200, ANONYMOUS_VIEWER_RESPONSE, { ...PRIVATE, 'set-cookie': cookie.clear() })
    },
  }

  async function servePost(req: IncomingMessage, res: ServerResponse, path: string) {
    try {
      assertSameOrigin(req, config.publicOrigin)
      const body = await readJsonBody(req)
      if (!auth) return identityError(res, 503, 'auth_unavailable', { 'retry-after': '30' })
      await posts[path](req, res, auth, body)
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.code }, err.close ? { ...PRIVATE, connection: 'close' } : PRIVATE)
      if (err instanceof AuthError) return identityError(res, err.status, err.code)
      // Anything else is the database or a bug. The client learns only that sign-in is unavailable.
      log.error('auth request failed', { path, ...errorFields(err) })
      return identityError(res, 503, 'auth_unavailable', { 'retry-after': '5' })
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse, path: string) {
    if (Object.hasOwn(posts, path)) {
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' }, { allow: 'POST', connection: 'close' })
      return servePost(req, res, path)
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
        return serveFriends(req, res)
    }
    // Service paths never fall through to the client, so a wrong API path is an honest 404.
    if (!site || isReserved(path)) return send(res, 404, { error: 'not_found' })
    const file = site.file(path)
    if (file) return sendCached(req, res, file)
    // A missing file is a 404; anything else is a client-side route and gets the app shell.
    if (path.slice(path.lastIndexOf('/') + 1).includes('.')) return send(res, 404, { error: 'not_found' })
    return sendCached(req, res, site.index)
  }

  return (req, res) => {
    const started = performance.now()
    let path: string
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    } catch {
      return send(res, 400, { error: 'bad_request' })
    }
    route(req, res, path)
      .catch((err: unknown) => {
        log.error('request failed', { method: req.method, path, ...errorFields(err) })
        if (!res.headersSent) send(res, 500, { error: 'internal_error' })
        else res.end()
      })
      .finally(() => {
        // Platform health probes hit /health every few seconds; a 200 there is not worth a line.
        if (path === '/health' && res.statusCode === 200) return
        log.info('request', { method: req.method, path, status: res.statusCode, ms: Math.round(performance.now() - started) })
      })
  }
}
