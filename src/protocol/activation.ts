import { DISTRICT_IDS, type DistrictId } from '../config/districts'

/**
 * Wire contract for permanent Friend activation: turning a Rare Friend the signed-in wallet
 * owns into a permanent Rare City property on one exact plot. Used by the server and, later,
 * the client. Portable: no browser or Node dependency.
 *
 * Two requests, both `POST`:
 *
 *   1. `POST /v1/activation/intents`  the server writes the one EIP-712 message that would
 *      authorise this activation, stores it, and returns it to be signed;
 *   2. `POST /v1/activations`         the wallet's signature over exactly that message.
 *
 * The browser never sends the signed fields back and never names a family, a district or a
 * city: the server already knows what it asked the wallet to sign.
 *
 * Nothing here moves RF or an NFT. Activation is a signature, never a transaction.
 */
export const ACTIVATION_INTENTS_ENDPOINT = '/v1/activation/intents'
export const ACTIVATIONS_ENDPOINT = '/v1/activations'

/** `POST /v1/activation/intents` request. Exactly these two keys. */
export interface ActivationIntentRequest {
  /** Canonical base-10 text. See `parseCanonicalTokenId`. */
  tokenId: string
  /** `<district>-w<ward>-p<plot>`. See `parsePlotId`. */
  plotId: string
}

/** `POST /v1/activations` request. Exactly these two keys. */
export interface ActivationCommitRequest {
  /** 64 lowercase hex characters: the id the intent was issued under. */
  intentId: string
  /** `0x` and 130 hex characters: the wallet's 65-byte signature of the intent's typed data. */
  signature: string
}

/**
 * THE V1 `PropertyActivation` MESSAGE. FROZEN: a change to the domain, the field list, a
 * field's type or order, or the statement's spelling changes what wallets sign, and is a
 * new version, never an edit.
 */
export const ACTIVATION_DOMAIN_NAME = 'Rare City'
export const ACTIVATION_DOMAIN_VERSION = '1'
export const ACTIVATION_PRIMARY_TYPE = 'PropertyActivation'
/** The sentence a wallet shows. Its exact spelling is part of the signed message. */
export const ACTIVATION_STATEMENT = 'Activate this Rare Friend as a permanent Rare City property.'

/**
 * The domain has a name, a version and a chain, and nothing else. There is deliberately no
 * `verifyingContract`: no contract verifies these signatures (the Rare City server does),
 * and the Generations NFT contract is not an EIP-712 verifier.
 */
export const ACTIVATION_TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
  ],
  PropertyActivation: [
    { name: 'intentId', type: 'bytes32' },
    { name: 'site', type: 'string' },
    { name: 'statement', type: 'string' },
    { name: 'wallet', type: 'address' },
    { name: 'collection', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'familyId', type: 'uint8' },
    { name: 'familyName', type: 'string' },
    { name: 'cityId', type: 'string' },
    { name: 'cityInstance', type: 'string' },
    { name: 'districtId', type: 'string' },
    { name: 'ward', type: 'uint32' },
    { name: 'plot', type: 'uint32' },
    { name: 'plotId', type: 'string' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const

/**
 * The typed data as JSON, in the shape a wallet's `eth_signTypedData_v4` takes. `uint256`
 * and `uint64` values are decimal strings, because they do not all fit a JSON number.
 */
export interface ActivationTypedData {
  domain: { name: string; version: string; chainId: number }
  types: typeof ACTIVATION_TYPES
  primaryType: typeof ACTIVATION_PRIMARY_TYPE
  message: {
    /** `0x` and the 64 hex characters of the intent id. */
    intentId: string
    /** The origin the intent was issued for, e.g. `https://rarecity.example`. */
    site: string
    statement: string
    /** EIP-55 checksummed. */
    wallet: string
    /** EIP-55 checksummed. The Rare Friends Generations contract: what is owned, not what verifies. */
    collection: string
    tokenId: string
    familyId: number
    familyName: string
    cityId: string
    /** The exact installation of the city. A signature for one installation is nothing in another. */
    cityInstance: string
    districtId: string
    ward: number
    plot: number
    plotId: string
    /** Unix time in MILLISECONDS, by the database clock. */
    issuedAt: string
    /** Unix time in MILLISECONDS. Never more than ten minutes after `issuedAt`, never after the session ends. */
    expiresAt: string
  }
}

/** `POST /v1/activation/intents` response. */
export interface ActivationIntentResponse {
  intentId: string
  /** ISO 8601. The same instant as `typedData.message.expiresAt`. */
  expiresAt: string
  typedData: ActivationTypedData
  /** The EIP-712 hash of `typedData`. Public: anyone holding the typed data can compute it. */
  digest: string
}

/** What a Friend's property is, in public terms. Also the My Friends annotation. */
export interface FriendPropertyDto {
  id: string
  buildingId: string
  districtId: string
  ward: number
  plot: number
  plotId: string
  /** ISO 8601. */
  activatedAt: string
}

/** `POST /v1/activations` response, for a first commit and for every retry of it alike. */
export interface ActivationCommitResponse {
  status: 'committed'
  property: FriendPropertyDto & {
    tokenId: string
    /** The city sequence this activation produced. It never changes afterwards. */
    sequence: number
  }
  city: { id: string; instance: string }
}

/** Error bodies are `{ "error": <code> }`. */
export type ActivationErrorCode =
  | 'activation_disabled'
  | 'not_authenticated'
  | 'invalid_request'
  | 'unsupported_chain'
  | 'city_not_activatable'
  | 'city_inconsistent'
  | 'friend_not_owned'
  | 'friend_already_activated'
  | 'ownership_unavailable'
  | 'ownership_inconsistent'
  | 'family_mismatch'
  | 'plot_invalid'
  | 'plot_unavailable'
  | 'intent_not_found'
  | 'intent_expired'
  | 'intent_superseded'
  | 'intent_session_mismatch'
  | 'signature_invalid'
  | 'activation_conflict'
  | 'activation_unavailable'

/** The largest Friend id the city state can hold: it keeps a Friend id as a JavaScript number. */
export const MAX_ACTIVATION_TOKEN_ID = Number.MAX_SAFE_INTEGER

/** `0`, or a digit 1-9 followed by digits. Sixteen digits is enough for 2^53 - 1. */
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]{0,15})$/

/**
 * THE CANONICAL TOKEN ID PARSER. A Friend id is accepted only as the one base-10 spelling
 * of a whole number from 0 to 2^53 - 1: `0`, or digits with no leading zero. Everything
 * else is refused, never repaired: a sign, a leading zero, a decimal point, an exponent, a
 * hex prefix, whitespace, a separator, and anything that is not a string at all (so a JSON
 * number is refused too). Postgres would read `'0x10'`, `'1e3'` and `'0812'` as integers
 * and round `'1.5'`; none of them reaches it.
 */
export function parseCanonicalTokenId(input: unknown): bigint | null {
  if (typeof input !== 'string' || !CANONICAL_DECIMAL.test(input)) return null
  const value = BigInt(input)
  return value <= BigInt(MAX_ACTIVATION_TOKEN_ID) ? value : null
}

export interface ParsedPlot {
  districtId: DistrictId
  ward: number
  plot: number
  /** The canonical spelling: exactly the text that was parsed. */
  plotId: string
}

/** A known district, then a ward and a plot each written canonically and below one million. */
const PLOT_ID = /^(d[1-9])-w(0|[1-9][0-9]{0,5})-p(0|[1-9][0-9]{0,5})$/

/**
 * Parse `<district>-w<ward>-p<plot>`. Only the canonical spelling is a plot id, so two
 * texts never name one plot. Whether the plot exists and is free is the allocator's
 * question, not this one's.
 */
export function parsePlotId(input: unknown): ParsedPlot | null {
  if (typeof input !== 'string') return null
  const match = PLOT_ID.exec(input)
  if (!match || !(DISTRICT_IDS as readonly string[]).includes(match[1])) return null
  return { districtId: match[1] as DistrictId, ward: Number(match[2]), plot: Number(match[3]), plotId: input }
}
