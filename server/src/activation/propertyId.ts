import { createHash } from 'node:crypto'
import { RARE_FRIENDS_CHAIN } from '../engine'

/**
 * DETERMINISTIC PERMANENT IDENTITY.
 *
 * A property's id is derived from what the property permanently is: this world, this
 * chain, this collection, this Friend. It is never random and never depends on which
 * installation of the city it was activated in, so a Rare City database that is restored
 * or rebuilt gives the same Friend the same property id.
 *
 * V1, FROZEN. The preimage is this exact UTF-8 text:
 *
 *   rare-city:property:v1|world=rare-city|chain=4663|collection=0x14c49e6118f46525de9ab41a51cbaa3c6ebf181d|token=<canonical-decimal-token-id>
 *
 * It is hashed with SHA-256. The first 16 bytes of the hash become a UUID: the version
 * nibble is set to 8 (RFC 9562's version for custom, application-defined UUIDs) and the
 * variant bits to `10`. The result is written in the canonical lowercase 8-4-4-4-12 form.
 *
 * The city instance is deliberately absent. A different Proofy World would use a different
 * `world=` key and so get a different id for the same Friend.
 */
export const PROPERTY_WORLD = 'rare-city'

const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/

/** The UUID made of the first 16 bytes of SHA-256(`preimage`), marked version 8, RFC variant. */
function uuidV8(preimage: string): string {
  const bytes = createHash('sha256').update(preimage, 'utf8').digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The exact text a property id is the hash of. `tokenId` must already be canonical decimal. */
export function propertyIdPreimage(tokenId: string): string {
  if (!CANONICAL_DECIMAL.test(tokenId)) throw new Error('A property id is derived from a canonical decimal token id.')
  return `rare-city:property:v1|world=${PROPERTY_WORLD}|chain=${RARE_FRIENDS_CHAIN.chainId}|collection=${RARE_FRIENDS_CHAIN.generations.toLowerCase()}|token=${tokenId}`
}

/** The permanent id of the property of Rare Friend `tokenId`. */
export function propertyId(tokenId: string): string {
  return uuidV8(propertyIdPreimage(tokenId))
}

/**
 * The id of an ownership era: derived the same way from the property and the era's number,
 * so a rebuilt history gives every era the id it had.
 *
 *   rare-city:ownership-era:v1|property=<property-uuid>|era=<era-number>
 */
export function ownershipEraId(property: string, eraNumber: number): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(property) || !Number.isSafeInteger(eraNumber) || eraNumber < 1) throw new Error('An ownership era id is derived from a property id and a positive era number.')
  return uuidV8(`rare-city:ownership-era:v1|property=${property}|era=${eraNumber}`)
}
