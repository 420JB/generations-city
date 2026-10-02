import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import type { ServerConfig } from './config'
import { databaseStatus, type DatabaseStatus } from './db/migrations'
import type { Database } from './db/pool'
import { errorFields, type Logger } from './log'

export const SERVICE_NAME = 'rare-city-server'

export interface AppDeps {
  config: ServerConfig
  /** null when no database is configured (APP_MODE=local only). */
  db: Database | null
  migrationsDir: string
  log: Logger
  /** How long /ready waits for the database before answering not-ready. */
  readyTimeoutMs?: number
}

const READY_TIMEOUT_MS = 4_000

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(res.req.method === 'HEAD' ? undefined : payload)
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

/**
 * The HTTP surface of the service. This slice exposes diagnostics only: there are no
 * city reads and no mutation endpoints yet.
 */
export function createApp(deps: AppDeps): RequestListener {
  const { config, log } = deps

  async function route(req: IncomingMessage, res: ServerResponse, path: string) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD' })
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
      default:
        return send(res, 404, { error: 'not_found' })
    }
  }

  return (req, res) => {
    const started = performance.now()
    let path: string
    try {
      path = new URL(req.url ?? '/', 'http://localhost').pathname
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
