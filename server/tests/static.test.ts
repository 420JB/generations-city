import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import type { ServerConfig } from '../src/config'
import { silentLogger } from '../src/log'
import { loadStaticSite, type StaticSite } from '../src/static'
import { testConfig } from './testConfig'

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../migrations')
const LOCAL: ServerConfig = testConfig({ commit: 'abc123' })
const INDEX = '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/index-Dq3x9ZkP.js"></script></body></html>'
const BUNDLE = `console.log(${JSON.stringify('rare city '.repeat(400))})`

let root: string
let outside: string
let site: StaticSite
const servers: Server[] = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'rc-site-'))
  outside = await mkdtemp(join(tmpdir(), 'rc-outside-'))
  await mkdir(join(root, 'assets/families'), { recursive: true })
  await writeFile(join(root, 'index.html'), INDEX)
  await writeFile(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  await writeFile(join(root, 'assets/index-Dq3x9ZkP.js'), BUNDLE)
  await writeFile(join(root, 'assets/index-B6lyHuOD.css'), 'body{margin:0}')
  await writeFile(join(root, 'assets/families/family-1.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  await writeFile(join(root, 'data.bin'), Buffer.from([0, 1, 2, 3]))
  await writeFile(join(root, '.env'), 'SECRET=in-site-dir')
  await writeFile(join(outside, 'secret.txt'), 'TOP SECRET OUTSIDE')
  await symlink(join(outside, 'secret.txt'), join(root, 'linked.txt'))
  await symlink(outside, join(root, 'linked-dir'))
  site = (await loadStaticSite(root))!
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
})

async function start(withSite: StaticSite | null = site): Promise<string> {
  const server = createServer(createApp({ config: LOCAL, db: null, migrationsDir: MIGRATIONS_DIR, log: silentLogger, site: withSite }))
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** Send a path exactly as written (fetch would normalise dot segments away). */
async function raw(base: string, path: string): Promise<{ status: number; body: string }> {
  const { request } = await import('node:http')
  const { port } = new URL(base)
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => done({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', fail)
    req.end()
  })
}

describe('loading the site', () => {
  it('lists regular files only: no dotfiles, no symlinks', () => {
    expect(site.size).toBe(6)
    for (const path of ['/index.html', '/favicon.svg', '/assets/index-Dq3x9ZkP.js', '/assets/index-B6lyHuOD.css', '/assets/families/family-1.svg', '/data.bin']) expect(site.file(path), path).toBeDefined()
    for (const path of ['/.env', '/linked.txt', '/linked-dir/secret.txt', '/assets', '/']) expect(site.file(path), path).toBeUndefined()
  })

  it('is absent when there is no built client', async () => {
    expect(await loadStaticSite(join(root, 'does-not-exist'))).toBeNull()
    expect(await loadStaticSite(join(root, 'assets'))).toBeNull()
  })
})

describe('same-origin app', () => {
  it('serves the app shell at / without letting it be cached blindly', async () => {
    const res = await fetch(`${await start()}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await res.text()).toBe(INDEX)
  })

  it('serves hashed bundles as immutable and other files with a short lifetime', async () => {
    const base = await start()
    const js = await fetch(`${base}/assets/index-Dq3x9ZkP.js`)
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await js.text()).toBe(BUNDLE)
    const css = await fetch(`${base}/assets/index-B6lyHuOD.css`)
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(css.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    const svg = await fetch(`${base}/assets/families/family-1.svg`)
    expect(svg.headers.get('content-type')).toBe('image/svg+xml')
    expect(svg.headers.get('cache-control')).toBe('public, max-age=3600')
    const bin = await fetch(`${base}/data.bin`)
    expect(bin.headers.get('content-type')).toBe('application/octet-stream')
    expect(Buffer.from(await bin.arrayBuffer())).toEqual(Buffer.from([0, 1, 2, 3]))
  })

  it('revalidates with ETags and answers HEAD', async () => {
    const base = await start()
    const etag = (await fetch(`${base}/favicon.svg`)).headers.get('etag')!
    expect((await fetch(`${base}/favicon.svg`, { headers: { 'if-none-match': etag } })).status).toBe(304)
    const head = await fetch(`${base}/assets/index-Dq3x9ZkP.js`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })

  it('falls back to the app shell for client routes only', async () => {
    const base = await start()
    for (const path of ['/city', '/friend/812', '/a/b/c', '/assets']) {
      const res = await fetch(`${base}${path}`)
      expect(res.status, path).toBe(200)
      expect(await res.text(), path).toBe(INDEX)
    }
    for (const path of ['/missing.js', '/assets/nope.css', '/assets/families/nope.svg', '/favicon.ico', '/index.htm']) {
      const res = await fetch(`${base}${path}`)
      expect(res.status, path).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
    }
  })

  it('never swallows service paths: diagnostics and API 404s stay JSON', async () => {
    const base = await start()
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: 'ok' })
    expect(await (await fetch(`${base}/ready`)).json()).toEqual({ status: 'ready', checks: { database: 'not-configured' } })
    expect(await (await fetch(`${base}/version`)).json()).toEqual({ service: 'rare-city-server', mode: 'local', commit: 'abc123' })
    for (const path of ['/health/', '/health/x', '/ready/x', '/version/1', '/v1', '/v1/', '/v1/nope', '/v1/city/x']) {
      const res = await fetch(`${base}${path}`)
      expect(res.status, path).toBe(404)
      expect(res.headers.get('content-type'), path).toBe('application/json; charset=utf-8')
    }
    const city = await fetch(`${base}/v1/city`)
    expect(city.status).toBe(503)
    expect(await city.json()).toEqual({ error: 'city_unavailable' })
  })

  it('refuses writes to app paths too', async () => {
    const base = await start()
    for (const path of ['/', '/index.html', '/assets/index-Dq3x9ZkP.js', '/city']) expect((await fetch(`${base}${path}`, { method: 'POST', body: 'x' })).status).toBe(405)
  })

  it('cannot be walked out of: no traversal, no dotfiles, no symlinks', async () => {
    const base = await start()
    const attempts = [
      '/../package.json',
      '/../../etc/passwd',
      '/assets/../../package.json',
      '/assets/..%2f..%2fpackage.json',
      '/..%2f..%2fetc%2fpasswd',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/assets/%2e%2e/%2e%2e/server/src/main.ts',
      '/....//....//etc/passwd',
      '/.env',
      '/linked.txt',
      '/linked-dir/secret.txt',
      '//etc/passwd',
      '/assets\\..\\..\\package.json',
      '/index.html%00.js',
    ]
    for (const path of attempts) {
      const res = await raw(base, path)
      expect(res.body, path).not.toContain('SECRET')
      expect(res.body, path).not.toContain('root:')
      expect(res.body, path).not.toContain('"name"')
      // Either an honest 404, or the app shell for something that parses as a client route.
      expect([404, 400].includes(res.status) || res.body === INDEX, `${path} -> ${res.status}`).toBe(true)
    }
  })

  it('answers a malformed path with 400, not a crash', async () => {
    const res = await raw(await start(), '/%E0%A4%A')
    expect(res.status).toBe(400)
  })
})

describe('API-only service', () => {
  it('serves no pages when no client build is present', async () => {
    const base = await start(null)
    for (const path of ['/', '/index.html', '/city']) expect((await fetch(`${base}${path}`)).status, path).toBe(404)
    expect((await fetch(`${base}/health`)).status).toBe(200)
  })
})
