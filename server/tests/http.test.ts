import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import type { ServerConfig } from '../src/config'
import type { Database } from '../src/db/pool'
import { createLogger, silentLogger } from '../src/log'

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../migrations')
const LOCAL: ServerConfig = { mode: 'local', port: 0, host: '127.0.0.1', databaseUrl: null, commit: null }

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
})

async function start(config: ServerConfig, db: Database | null, log = silentLogger, migrationsDir = MIGRATIONS_DIR): Promise<string> {
  const server = createServer(createApp({ config, db, migrationsDir, log, readyTimeoutMs: 100 }))
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** A database whose every query fails the way an unreachable Postgres does. */
function unreachableDb(): Database {
  const refuse = () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED postgres://user:hunter2@db/rarecity'), { code: 'ECONNREFUSED' }))
  return { query: refuse, connect: refuse, end: () => Promise.resolve() } as unknown as Database
}

describe('GET /health', () => {
  it('is a fixed liveness answer that does not depend on the database', async () => {
    for (const db of [null, unreachableDb()]) {
      const res = await fetch(`${await start(LOCAL, db)}/health`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.text()).toBe('{"status":"ok"}')
    }
  })

  it('answers HEAD without a body', async () => {
    const res = await fetch(`${await start(LOCAL, null)}/health`, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })
})

describe('GET /ready', () => {
  it('is ready in local mode when no database is configured, and says so', async () => {
    const res = await fetch(`${await start(LOCAL, null)}/ready`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ready', checks: { database: 'not-configured' } })
  })

  it('is 503 when the configured database is unreachable, without leaking why', async () => {
    const lines: string[] = []
    const config: ServerConfig = { ...LOCAL, mode: 'staging', databaseUrl: 'postgres://user:hunter2@db/rarecity' }
    const res = await fetch(`${await start(config, unreachableDb(), createLogger((l) => lines.push(l)))}/ready`)
    expect(res.status).toBe(503)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ status: 'not-ready', checks: { database: 'unreachable', migrations: 'unknown', environment: 'unknown' } })
    expect(text + lines.join('')).not.toContain('hunter2')
  })

  it('is 503 when the database never answers', async () => {
    const hang = () => new Promise<never>(() => {})
    const db = { query: hang, connect: hang, end: () => Promise.resolve() } as unknown as Database
    const res = await fetch(`${await start({ ...LOCAL, mode: 'staging' }, db)}/ready`)
    expect(res.status).toBe(503)
    expect(((await res.json()) as { checks: { database: string } }).checks.database).toBe('unreachable')
  })

  it('is 503, not a crash, when the migrations directory is missing', async () => {
    const lines: string[] = []
    const base = await start({ ...LOCAL, mode: 'staging' }, unreachableDb(), createLogger((l) => lines.push(l)), '/nonexistent/migrations')
    const res = await fetch(`${base}/ready`)
    expect(res.status).toBe(503)
    expect(((await res.json()) as { checks: { database: string } }).checks.database).toBe('unknown')
    expect(lines.join('')).toContain('readiness check failed')
  })
})

describe('GET /version', () => {
  it('reports the service, mode and deployed commit', async () => {
    const res = await fetch(`${await start({ ...LOCAL, commit: '8efb47b' }, null)}/version`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ service: 'rare-city-server', mode: 'local', commit: '8efb47b' })
  })
})

describe('everything else', () => {
  it('is 404 for unknown paths', async () => {
    const base = await start(LOCAL, null)
    for (const path of ['/', '/api/city', '/health/', '/ready/x']) {
      const res = await fetch(`${base}${path}`)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
    }
  })

  it('exposes no mutation surface: every non-GET method is refused', async () => {
    const base = await start(LOCAL, null)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const path of ['/health', '/ready', '/version', '/api/commands']) {
        const res = await fetch(`${base}${path}`, { method, body: method === 'DELETE' ? undefined : '{}' })
        expect(res.status).toBe(405)
        expect(res.headers.get('allow')).toBe('GET, HEAD')
      }
    }
  })

  it('logs requests as JSON lines, except healthy liveness probes', async () => {
    const lines: string[] = []
    const base = await start(LOCAL, null, createLogger((l) => lines.push(l)))
    await fetch(`${base}/health`)
    await fetch(`${base}/version?x=1`)
    await expect.poll(() => lines.length).toBe(1)
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'info', message: 'request', method: 'GET', path: '/version', status: 200 })
  })
})
