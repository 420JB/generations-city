import type { IncomingMessage } from 'node:http'
import { isIPv4, isIPv6 } from 'node:net'

/**
 * Which network a request came from, for rate limiting only.
 *
 * The answer depends on what stands in front of the process, and that is configuration,
 * never something a request can say about itself:
 *
 * - `none`     nothing is trusted. The key is the socket's peer address.
 * - `railway`  the process is only reachable through Railway's edge, which reports the
 *              client in `X-Real-IP`. That header is the only one read.
 *
 * `X-Forwarded-For` is never read in any mode. When the trusted source has no usable
 * address, the request is not guessed at from another header: it joins one shared bucket.
 *
 * A key is never an identity and never authorises anything.
 */
export type TrustedProxy = 'none' | 'railway'

export const TRUSTED_PROXIES: readonly TrustedProxy[] = ['none', 'railway']

export interface ClientKey {
  /** Normalised network: `ip4:<address>`, `ip6:<first four groups>`, or the shared fallback. */
  key: string
  source: 'socket' | 'x-real-ip' | 'fallback'
}

/** Every request whose network could not be established shares this one key. */
export const FALLBACK_CLIENT: ClientKey = { key: 'unidentified', source: 'fallback' }

const HEX_GROUP = /^[0-9a-f]{1,4}$/i

/** The eight 16-bit groups of an IPv6 address that `isIPv6` has already accepted, without a zone. */
function ipv6Groups(address: string): number[] | null {
  let text = address
  const tail: number[] = []
  // A dotted IPv4 tail (`::ffff:192.0.2.1`) stands for the last two groups.
  const lastColon = text.lastIndexOf(':')
  const last = text.slice(lastColon + 1)
  if (last.includes('.')) {
    if (!isIPv4(last)) return null
    const [a, b, c, d] = last.split('.').map(Number)
    tail.push((a << 8) | b, (c << 8) | d)
    text = text.slice(0, lastColon + 1)
    // Keep a `::` that ended at the IPv4 tail; drop a single separating colon.
    if (!text.endsWith('::')) text = text.slice(0, -1)
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const parse = (part: string) => (part === '' ? [] : part.split(':'))
  const head = parse(halves[0])
  const rest = halves.length === 2 ? parse(halves[1]) : []
  if (![...head, ...rest].every((g) => HEX_GROUP.test(g))) return null
  const known = head.length + rest.length + tail.length
  if (halves.length === 1 ? known !== 8 : known > 7) return null
  return [...head.map((g) => parseInt(g, 16)), ...Array<number>(8 - known).fill(0), ...rest.map((g) => parseInt(g, 16)), ...tail]
}

/**
 * One spelling per network.
 *
 * - IPv4 is its dotted form (`isIPv4` already refuses leading zeros and other variants).
 * - An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) is that IPv4 address, so one client is
 *   one key whichever socket family carried it.
 * - IPv6 is its /64: a single subscriber is routinely handed a whole /64, so the low 64
 *   bits are not a client.
 *
 * Returns null for anything that is not exactly one IP address.
 */
export function normalizeClientAddress(raw: string): string | null {
  if (isIPv4(raw)) return `ip4:${raw}`
  if (raw.includes('%') || !isIPv6(raw)) return null
  const groups = ipv6Groups(raw)
  if (!groups) return null
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff
  if (mapped) return `ip4:${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`
  return `ip6:${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}`
}

type RequestLike = { headers: IncomingMessage['headers']; socket: { remoteAddress?: string } }

/** The network key for this request under the configured trust. Never throws. */
export function clientKey(req: RequestLike, trust: TrustedProxy): ClientKey {
  if (trust === 'railway') {
    // Node joins a repeated header with ", ", which is not an address: a doubled header is unusable, not a choice.
    const header = req.headers['x-real-ip']
    const key = typeof header === 'string' ? normalizeClientAddress(header.trim()) : null
    return key ? { key, source: 'x-real-ip' } : FALLBACK_CLIENT
  }
  // A link-local peer carries a zone (`fe80::1%en0`); the zone is local to this machine and not part of the address.
  const peer = req.socket.remoteAddress?.split('%')[0]
  const key = peer ? normalizeClientAddress(peer) : null
  return key ? { key, source: 'socket' } : FALLBACK_CLIENT
}
