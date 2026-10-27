import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { HostedPreviewConfig } from './config'

/**
 * THE HOSTED PREVIEW ACCESS GATE (LOCAL_HOSTED_PREVIEW=true only). HTTP Basic authentication in front of everything
 * the process serves: the Play page, its scripts, styles and media, every API route and every path that does not
 * exist. Browsers send it on every same-origin request by themselves, scripts and `fetch` included, and on the
 * cross-site navigation from Proofy Play's launch, which a SameSite cookie would not survive.
 *
 * It is checked before any routing, on the same decoded path the router then uses, and everything is gated but the
 * two probes in PUBLIC_PROBES, for GET and HEAD only. It says nothing about who is playing: it is never a play session
 * and never game authority, and it never sees or sets a cookie.
 *
 * Only the password's SHA-256 is configured. The password is a randomly generated secret (`hosted-preview/README.md`),
 * so a plain hash is enough, and it costs nothing per request. Both the user name and the password are compared in
 * constant time, always both, and neither is ever logged or echoed.
 */
export type PreviewVerdict = 'allowed' | 'missing' | 'invalid'

export interface PreviewGate {
  check(req: Pick<IncomingMessage, 'headers'>): PreviewVerdict
}

/** The only unauthenticated answers: liveness and readiness, which say nothing about the game. */
export const PUBLIC_PROBES: readonly string[] = ['/health', '/ready']

export const isPublicProbe = (method: string | undefined, path: string) => (method === 'GET' || method === 'HEAD') && PUBLIC_PROBES.includes(path)

/** The realm a browser shows. Fixed text: nothing in it comes from configuration or a request. */
export const PREVIEW_CHALLENGE = 'Basic realm="Districts private preview", charset="UTF-8"'

/** Longer than any user name and password this gate accepts, base64-encoded. */
const MAX_CREDENTIALS_LENGTH = 512
const BASIC = /^Basic +([A-Za-z0-9+/]+={0,2})$/i

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest()

export function createPreviewGate(access: HostedPreviewConfig): PreviewGate {
  const user = sha256(access.accessUser)
  const password = Buffer.from(access.accessPasswordSha256)
  if (password.length !== 32) throw new Error('the preview access password hash must be 32 bytes')
  return {
    check(req) {
      const header = req.headers.authorization
      if (header === undefined || header === '') return 'missing'
      if (typeof header !== 'string' || header.length > MAX_CREDENTIALS_LENGTH) return 'invalid'
      const match = BASIC.exec(header)
      if (!match) return 'invalid'
      const bytes = Buffer.from(match[1], 'base64')
      // One spelling only: Node's decoder skips what it cannot use, so anything but the canonical encoding is refused.
      if (bytes.toString('base64') !== match[1]) return 'invalid'
      const decoded = bytes.toString('utf8')
      const colon = decoded.indexOf(':')
      if (colon < 0) return 'invalid'
      // Both compared, always, in constant time over equal-length digests: neither answer says which part was wrong.
      const userOk = timingSafeEqual(sha256(decoded.slice(0, colon)), user)
      const passwordOk = timingSafeEqual(sha256(decoded.slice(colon + 1)), password)
      return userOk && passwordOk ? 'allowed' : 'invalid'
    },
  }
}
