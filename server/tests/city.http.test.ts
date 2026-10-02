import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { createSeedState } from '../../src/game/seed'
import { createApp } from '../src/app'
import type { CityReader, CityRecord } from '../src/city/store'
import type { ServerConfig } from '../src/config'
import { parseCityResponse, type CityMeta, type GameState } from '../src/engine'
import { createLogger, silentLogger, type Logger } from '../src/log'
import { testConfig } from './testConfig'

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../migrations')
const STAGING: ServerConfig = testConfig({ mode: 'staging', databaseUrl: 'postgres://user:hunter2@db/rarecity' })
const META: CityMeta = { id: 'main', instance: '11111111-2222-3333-4444-555555555555', sequence: 1, stateVersion: 5, canonical: false, origin: 'demo-fixture', updatedAt: '2026-10-02T00:00:00.000Z' }

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
})

async function start(city: CityReader | null, config: ServerConfig = STAGING, log: Logger = silentLogger): Promise<string> {
  const server = createServer(createApp({ config, db: null, migrationsDir: MIGRATIONS_DIR, log, city }))
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** An in-memory city that counts how often its state is read. */
function fakeCity(initial: CityRecord | null) {
  const store = { record: initial, reads: 0, metas: 0 }
  const reader: CityReader = {
    meta: async () => {
      store.metas += 1
      return store.record?.meta ?? null
    },
    read: async () => {
      store.reads += 1
      return store.record
    },
  }
  return { store, reader }
}

describe('GET /v1/city', () => {
  it('returns the authoritative city with explicit, stable metadata', async () => {
    const state = createSeedState()
    const res = await fetch(`${await start(fakeCity({ meta: META, state }).reader)}/v1/city`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(res.headers.get('etag')).toBe(`"${META.instance}.1"`)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['city', 'server', 'state'])
    expect(body.city).toEqual(META)
    expect(body.server).toEqual({ mode: 'staging' })
    expect(JSON.stringify(body.state)).toBe(JSON.stringify(state))
    expect(parseCityResponse(body).ok).toBe(true)
  })

  it('is one document for every caller: it never says who is looking, whatever the request claims', async () => {
    const base = await start(fakeCity({ meta: META, state: createSeedState() }).reader)
    const bodies: string[] = []
    for (const headers of [{}, { cookie: 'rc_session=demo-player; __Host-rc_session=demo-player' }, { authorization: 'Bearer demo-player' }, { 'x-user-id': 'demo-player' }]) {
      const res = await fetch(`${base}/v1/city`, { headers })
      const text = await res.text()
      expect(JSON.parse(text)).not.toHaveProperty('viewer')
      expect(res.headers.get('set-cookie')).toBeNull()
      bodies.push(text)
    }
    expect(new Set(bodies).size).toBe(1)
  })

  it('answers 304 to a matching ETag, exact or weakened by a proxy, and 200 otherwise', async () => {
    const base = await start(fakeCity({ meta: META, state: createSeedState() }).reader)
    const etag = (await fetch(`${base}/v1/city`)).headers.get('etag')!
    for (const value of [etag, `W/${etag}`, `"other", ${etag}`]) {
      const res = await fetch(`${base}/v1/city`, { headers: { 'if-none-match': value } })
      expect(res.status).toBe(304)
      expect(await res.text()).toBe('')
    }
    expect((await fetch(`${base}/v1/city`, { headers: { 'if-none-match': '"other"' } })).status).toBe(200)
  })

  it('compresses when asked and serves the same bytes either way', async () => {
    const base = await start(fakeCity({ meta: META, state: createSeedState() }).reader)
    const plain = await (await fetch(`${base}/v1/city`, { headers: { 'accept-encoding': 'identity' } })).arrayBuffer()
    // Raw socket-level read: fetch would transparently decompress.
    const gz = await new Promise<{ encoding: string | undefined; body: Buffer }>((done, fail) => {
      import('node:http').then(({ get }) =>
        get(`${base}/v1/city`, { headers: { 'accept-encoding': 'gzip' } }, (r) => {
          const chunks: Buffer[] = []
          r.on('data', (c: Buffer) => chunks.push(c))
          r.on('end', () => done({ encoding: r.headers['content-encoding'], body: Buffer.concat(chunks) }))
        }).on('error', fail),
      )
    })
    expect(gz.encoding).toBe('gzip')
    expect(gz.body.length).toBeLessThan(plain.byteLength / 4)
    expect(gunzipSync(gz.body).equals(Buffer.from(plain))).toBe(true)
  })

  it('reads the state once per sequence, and again as soon as the sequence moves', async () => {
    const { store, reader } = fakeCity({ meta: META, state: createSeedState() })
    const base = await start(reader)
    for (let i = 0; i < 4; i++) expect((await fetch(`${base}/v1/city`)).status).toBe(200)
    expect(store.reads).toBe(1)
    expect(store.metas).toBe(4)

    store.record = { meta: { ...META, sequence: 2 }, state: { ...createSeedState(), clock: 42 } }
    const body = (await (await fetch(`${base}/v1/city`)).json()) as { city: CityMeta; state: GameState }
    expect(body.city.sequence).toBe(2)
    expect(body.state.clock).toBe(42)
    expect(store.reads).toBe(2)

    // A reinstalled city restarts at sequence 1 under a new instance: never mistaken for the old one.
    store.record = { meta: { ...META, instance: '99999999-2222-3333-4444-555555555555' }, state: { ...createSeedState(), clock: 7 } }
    const fresh = (await (await fetch(`${base}/v1/city`)).json()) as { state: GameState }
    expect(fresh.state.clock).toBe(7)
  })

  it('supports HEAD', async () => {
    const res = await fetch(`${await start(fakeCity({ meta: META, state: createSeedState() }).reader)}/v1/city`, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBe(`"${META.instance}.1"`)
    expect(await res.text()).toBe('')
  })
})

describe('GET /v1/city when there is no servable city', () => {
  const expect503 = async (base: string, error: string) => {
    const res = await fetch(`${base}/v1/city`)
    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('retry-after')).toBe('5')
    expect(await res.json()).toEqual({ error })
  }

  it('says so when the city has not been initialised', async () => {
    await expect503(await start(fakeCity(null).reader), 'city_not_initialized')
  })

  it('says unavailable when the service has no database at all', async () => {
    await expect503(await start(null, { ...STAGING, mode: 'local', databaseUrl: null }), 'city_unavailable')
  })

  it('refuses a stored state that fails validation, without serving any of it', async () => {
    const lines: string[] = []
    for (const state of [{ version: 5 }, null, 'nope', [], { ...createSeedState(), buildings: { 'b-1': { ownerBuilt: 'lots' } } }]) {
      await expect503(await start(fakeCity({ meta: META, state }).reader, STAGING, createLogger((l) => lines.push(l))), 'city_state_invalid')
    }
    expect(lines.filter((l) => l.includes('stored city state failed validation'))).toHaveLength(5)
  })

  it('refuses a stored state of another version', async () => {
    await expect503(await start(fakeCity({ meta: { ...META, stateVersion: 4 }, state: { ...createSeedState(), version: 4 } }).reader), 'city_state_unsupported')
  })

  it('is 503 without leaking anything when the database fails', async () => {
    const lines: string[] = []
    const boom = () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED postgres://user:hunter2@db/rarecity'), { code: 'ECONNREFUSED' }))
    const base = await start({ meta: boom, read: boom }, STAGING, createLogger((l) => lines.push(l)))
    const res = await fetch(`${base}/v1/city`)
    const text = await res.text()
    expect(res.status).toBe(503)
    expect(JSON.parse(text)).toEqual({ error: 'city_unavailable' })
    expect(text + lines.join('')).not.toContain('hunter2')
    expect(lines.join('')).toContain('city read failed')
  })

  it('recovers on the next request once the city is back', async () => {
    const { store, reader } = fakeCity(null)
    const base = await start(reader)
    expect((await fetch(`${base}/v1/city`)).status).toBe(503)
    store.record = { meta: META, state: createSeedState() }
    expect((await fetch(`${base}/v1/city`)).status).toBe(200)
  })
})

describe('the API is read-only', () => {
  it('refuses every mutating method on every /v1 path and never touches the city', async () => {
    const { store, reader } = fakeCity({ meta: META, state: createSeedState() })
    const base = await start(reader)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      for (const path of ['/v1/city', '/v1/commands', '/v1/city/contribute', '/v1/events']) {
        const res = await fetch(`${base}${path}`, { method, body: ['POST', 'PUT', 'PATCH'].includes(method) ? JSON.stringify({ type: 'contribute', buildingId: 'b-812', amount: 38 }) : undefined })
        expect(res.status, `${method} ${path}`).toBe(405)
        expect(res.headers.get('allow')).toBe('GET, HEAD')
      }
    }
    expect(store.reads + store.metas).toBe(0)
  })

  it('does not wait for or read a request body', async () => {
    const base = await start(fakeCity({ meta: META, state: createSeedState() }).reader)
    const { request } = await import('node:http')
    // Promise a huge body, send a few bytes, and never finish: the refusal must arrive anyway.
    const res = await new Promise<{ status: number; connection: string | undefined }>((done, fail) => {
      const req = request(`${base}/v1/city`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 500_000_000 } }, (r) => {
        done({ status: r.statusCode ?? 0, connection: r.headers.connection })
        req.destroy()
      })
      req.on('error', fail)
      req.write('{"type":"contribute"')
    })
    expect(res).toEqual({ status: 405, connection: 'close' })
  })

  it('answers unknown /v1 paths with a JSON 404', async () => {
    const base = await start(fakeCity({ meta: META, state: createSeedState() }).reader)
    for (const path of ['/v1', '/v1/', '/v1/city/', '/v1/city/extra', '/v1/events', '/v1/commands', '/v2/city']) {
      const res = await fetch(`${base}${path}`)
      expect(res.status, path).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
    }
  })
})
