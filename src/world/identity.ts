/**
 * IDENTITY GRAMMARS FOR CONFIGURABLE WORLDS.
 *
 * Pure and portable. Every check here takes untyped input and answers yes or no: nothing
 * is trimmed, lower-cased or otherwise repaired, so two spellings never name one thing.
 * (The one exception is `canonicalAddress`, which exists to produce the canonical form.)
 */

/** The legacy Rare Friends world. Its property ids were frozen with this exact text in them (V1). */
export const LEGACY_RARE_CITY_WORLD_ID = 'rare-city'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * A world id is supplied by a trusted caller, never derived here. It is either the legacy
 * Rare Friends world (`rare-city`) or a world's `worlds.id` (migration 0005): a UUID in
 * canonical lowercase text. Nothing else is a world id, so two brands' worlds can only
 * share an id by sharing a `worlds` row.
 */
export function isWorldId(value: unknown): value is string {
  return typeof value === 'string' && (value === LEGACY_RARE_CITY_WORLD_ID || UUID.test(value))
}

/** A brand world's id: a canonical lowercase UUID. `rare-city` is reserved for the legacy fixture and is not one. */
export function isBrandWorldId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

/** Longest permanent key. The legacy keys (`d1`..`d9`) are two characters. */
export const MAX_KEY_LENGTH = 32

const KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/**
 * A permanent configuration key (district, collection, layout): lowercase letters and
 * digits in hyphen-separated words, starting with a letter. `d4`, `north`, `harbor-front`.
 * A key names something forever; labels, colours and art are presentation and live elsewhere.
 */
export function isPermanentKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_KEY_LENGTH && KEY.test(value)
}

/** `0`, or a digit 1-9 followed by digits. 2^256 - 1 has 78 digits. */
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]{0,77})$/
export const MAX_UINT256 = (1n << 256n) - 1n

/**
 * The one canonical base-10 spelling of a uint256, or null. Accepts only a string: a JSON
 * number has already lost precision above 2^53 by the time it arrives. No sign, leading
 * zero, exponent, hex prefix, separator or whitespace is accepted.
 */
export function parseUint256(value: unknown): string | null {
  if (typeof value !== 'string' || !CANONICAL_DECIMAL.test(value)) return null
  return BigInt(value) <= MAX_UINT256 ? value : null
}

/** `eip155:<chain id>` (CAIP-2). Only EVM chains for now; the chain id is a positive safe integer. */
const EIP155 = /^eip155:([1-9][0-9]{0,15})$/

export interface ChainRef {
  namespace: 'eip155'
  /** The EIP-155 chain id. */
  chainId: number
  /** Canonical CAIP-2 text, e.g. `eip155:4663`. */
  text: string
}

export function parseChainRef(value: unknown): ChainRef | null {
  if (typeof value !== 'string') return null
  const match = EIP155.exec(value)
  if (!match) return null
  const chainId = Number(match[1])
  return Number.isSafeInteger(chainId) ? { namespace: 'eip155', chainId, text: value } : null
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/**
 * A contract address in its canonical identity form: `0x` and 40 LOWERCASE hex digits, or
 * null. Mixed case is accepted and lowered; an EIP-55 checksum is not verified here, so a
 * caller that takes addresses from people (not from trusted configuration) checks it first.
 */
export function canonicalAddress(value: unknown): `0x${string}` | null {
  return typeof value === 'string' && ADDRESS.test(value) ? (value.toLowerCase() as `0x${string}`) : null
}
