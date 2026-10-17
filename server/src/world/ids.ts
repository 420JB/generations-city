import { randomBytes } from 'node:crypto'

/**
 * A UUIDv7 (RFC 9562): 48 bits of Unix milliseconds, then random bits, with the version and
 * variant set. `worlds.id` is one (migration 0005), generated here and never derived from
 * anything, so no installation, guild or configuration can predict or choose it.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16)
  let ms = BigInt(now)
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ms & 0xffn)
    ms >>= 8n
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
