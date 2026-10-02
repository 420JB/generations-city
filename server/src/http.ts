import type { IncomingMessage } from 'node:http'
import type { AppMode } from './config'

/**
 * The small amount of HTTP the service needs beyond node:http: a bounded JSON body
 * reader, the session cookie, and the same-origin rule for requests that change anything.
 */

/** A request the service refuses, as the status and `{ "error": code }` it answers with. */
export class HttpError extends Error {
  readonly status: number
  readonly code: string
  /** Close the connection after answering, so an unread body is never consumed. */
  readonly close: boolean
  constructor(status: number, code: string, close = false) {
    super(code)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.close = close
  }
}

/** Sign-in bodies are a few hundred bytes. Nothing the service accepts is larger than this. */
export const MAX_BODY_BYTES = 4_096
const BODY_TIMEOUT_MS = 10_000

/**
 * Read a JSON object body. Refuses anything that is not `application/json`, anything
 * larger than `limit` (before reading it when the length is declared), a body that stalls,
 * and anything that does not parse to an object.
 */
export async function readJsonBody(req: IncomingMessage, limit = MAX_BODY_BYTES, timeoutMs = BODY_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const type = String(req.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (type !== 'application/json') throw new HttpError(415, 'unsupported_media_type', true)
  const declared = req.headers['content-length']
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new HttpError(413, 'payload_too_large', true)

  const chunks: Buffer[] = []
  let size = 0
  await new Promise<void>((resolve, reject) => {
    let done = false
    const settle = (err?: Error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve()
    }
    const timer = setTimeout(() => settle(new HttpError(408, 'request_timeout', true)), timeoutMs)
    // The listeners stay attached after settling: a late socket error must still have somewhere to go.
    req.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      // A body that lied about its length, or declared none: stop keeping it the moment it is too long.
      if (size > limit) return settle(new HttpError(413, 'payload_too_large', true))
      chunks.push(chunk)
    })
    req.on('end', () => settle())
    req.on('error', () => settle(new HttpError(400, 'bad_request', true)))
    req.on('aborted', () => settle(new HttpError(400, 'bad_request', true)))
  })

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid_json')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'invalid_request')
  return parsed as Record<string, unknown>
}

/**
 * THE CSRF RULE. Every request that changes anything must pass this before its handler runs.
 *
 * A browser attaches `Origin` to every cross-origin request and to every same-origin POST,
 * and modern browsers add `Sec-Fetch-Site`. A request carrying either must show it came
 * from this service's own pages. Together with a `SameSite=Strict` session cookie, bodies
 * that must be `application/json` (which a cross-site form cannot send), and the service
 * never emitting a CORS header, another site has no way to act with a visitor's session.
 *
 * A request with neither header is not a browser acting for someone else (curl, a test).
 */
export function assertSameOrigin(req: IncomingMessage, publicOrigin: string): void {
  const origin = req.headers.origin
  if (origin !== undefined && origin !== publicOrigin) throw new HttpError(403, 'origin_mismatch', true)
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin') throw new HttpError(403, 'origin_mismatch', true)
}

/**
 * The session cookie. Outside local mode it is `__Host-` prefixed, which a browser only
 * accepts when it is Secure, has Path=/ and has no Domain: it cannot be set or overwritten
 * from another host or over plain HTTP. Local mode serves http://, where Secure cookies
 * are not reliably stored, so there it is a plain host-only cookie.
 */
export interface SessionCookie {
  name: string
  /** `Set-Cookie` value that stores the credential for `maxAgeSeconds`. */
  set(token: string, maxAgeSeconds: number): string
  /** `Set-Cookie` value that removes it. */
  clear(): string
  /** The credential the request carries, or null. */
  read(req: IncomingMessage): string | null
}

const strip = (value: string) => value.replace(/^[ \t]+|[ \t]+$/g, '')

export function sessionCookie(mode: AppMode): SessionCookie {
  const secure = mode !== 'local'
  const name = secure ? '__Host-rc_session' : 'rc_session'
  const attributes = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
  return {
    name,
    set: (token, maxAgeSeconds) => `${name}=${token}; ${attributes}; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    clear: () => `${name}=; ${attributes}; Max-Age=0`,
    read(req) {
      const header = req.headers.cookie
      if (!header) return null
      for (const part of header.split(';')) {
        const eq = part.indexOf('=')
        // Only the separators HTTP allows are stripped. Anything else next to the name makes it a different
        // cookie: `String.trim` would also drop characters a browser treats as part of the name, and with
        // them the protection of the `__Host-` prefix.
        if (eq > 0 && strip(part.slice(0, eq)) === name) return strip(part.slice(eq + 1)) || null
      }
      return null
    },
  }
}
