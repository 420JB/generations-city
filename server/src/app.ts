import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { gzipSync } from 'node:zlib'
import type { CityReader } from './city/store'
import type { ServerConfig } from './config'
import { databaseStatus, type DatabaseStatus } from './db/migrations'
import type { Database } from './db/pool'
import { ANONYMOUS_VIEWER, CITY_ENDPOINT, isCityStateShape, STATE_VERSION, type CityErrorCode, type CityMeta, type CityResponse } from './engine'
import { errorFields, type Logger } from './log'
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

function end(res: ServerResponse, status: number, headers: Record<string, string | number>, body?: Buffer | string) {
  res.writeHead(status, { 'x-content-type-options': 'nosniff', ...headers })
  res.end(res.req.method === 'HEAD' ? undefined : body)
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
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

/**
 * The HTTP surface of the service: diagnostics, the public city read, and (when a client
 * build is present) the Rare City app itself. Everything is GET/HEAD. There are no
 * mutation endpoints, and no request body is ever read.
 */
export function createApp(deps: AppDeps): RequestListener {
  const { config, log, city = null, site = null } = deps
  /** The serialised city for the sequence last served, so an unchanged city is not rebuilt per request. */
  let cached: (StaticFile & { etag: string }) | null = null

  const cityError = (res: ServerResponse, code: CityErrorCode) => send(res, 503, { error: code }, { 'retry-after': '5' })

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
        const response: CityResponse = { city: record.meta, viewer: ANONYMOUS_VIEWER, server: { mode: config.mode }, state: record.state }
        const body = Buffer.from(JSON.stringify(response))
        cached = { body, gzip: gzipSync(body), contentType: 'application/json; charset=utf-8', cacheControl: 'no-cache', etag: cityEtag(record.meta) }
      }
    } catch (err) {
      log.error('city read failed', errorFields(err))
      return cityError(res, 'city_unavailable')
    }
    sendCached(req, res, cached)
  }

  async function route(req: IncomingMessage, res: ServerResponse, path: string) {
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
