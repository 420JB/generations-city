import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { gzipSync } from 'node:zlib'

/**
 * Serves the built Rare City client from the same origin as the API.
 *
 * The site is a fixed list of files found under one directory at start-up. A request is
 * answered by looking its path up in that list; no filesystem path is ever built from
 * request input, so there is nothing to traverse out of.
 */
export interface StaticFile {
  body: Buffer
  gzip: Buffer | null
  contentType: string
  cacheControl: string
  etag: string
}

export interface StaticSite {
  /** The file published at this URL path, if any. */
  file(path: string): StaticFile | undefined
  /** The app shell, returned for client-side routes. */
  index: StaticFile
  size: number
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.map', '.svg', '.txt'])
/** Vite names bundled assets `name-<hash>.ext`; those never change and can be cached forever. */
const HASHED_ASSET = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/
const MAX_FILES = 2_000

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const rel = `${prefix}/${entry.name}`
    // Regular files and directories only: a symlink could point anywhere on the machine.
    if (entry.isDirectory()) out.push(...(await listFiles(root, rel)))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

/** Load the site from `dir`. Returns null when there is no built client there. */
export async function loadStaticSite(dir: string): Promise<StaticSite | null> {
  let paths: string[]
  try {
    paths = await listFiles(dir)
  } catch {
    return null
  }
  if (!paths.includes('/index.html')) return null
  if (paths.length > MAX_FILES) throw new Error(`Refusing to serve ${paths.length} files from the client directory (limit ${MAX_FILES}).`)

  const files = new Map<string, StaticFile>()
  for (const path of paths) {
    const body = await readFile(join(dir, path))
    const ext = extname(path).toLowerCase()
    files.set(path, {
      body,
      gzip: COMPRESSIBLE.has(ext) && body.length > 1_024 ? gzipSync(body) : null,
      contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream',
      cacheControl: path === '/index.html' ? 'no-cache' : HASHED_ASSET.test(path) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
      etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`,
    })
  }
  return { file: (path) => files.get(path), index: files.get('/index.html')!, size: files.size }
}
