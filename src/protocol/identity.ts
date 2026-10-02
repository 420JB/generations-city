import { familyById, type Family } from '../config/rareFriends'

/**
 * Wire contract for identity: who is looking, how a wallet signs in, and which Friends the
 * signed-in wallet owns. Used by both the server and the client. Portable: no browser or
 * Node dependency.
 *
 * Identity is deliberately not part of `/v1/city`. The city is one shared document; the
 * viewer is assembled per request from the session cookie and is never cached.
 */
export const VIEWER_ENDPOINT = '/v1/viewer'
export const FRIENDS_ENDPOINT = '/v1/viewer/friends'
export const AUTH_CHALLENGE_ENDPOINT = '/v1/auth/challenge'
export const AUTH_VERIFY_ENDPOINT = '/v1/auth/verify'
export const AUTH_LOGOUT_ENDPOINT = '/v1/auth/logout'

export interface WalletRef {
  /** EIP-55 checksummed. */
  address: string
  chainId: number
}

/** `GET /v1/viewer`, and the body of a successful verify or logout. */
export type ViewerResponse =
  | { authenticated: false }
  | {
      authenticated: true
      /** Stable server user id. Not a wallet address. */
      userId: string
      /** The wallet that signed in to this session. */
      wallet: WalletRef
      session: { expiresAt: string }
    }

export type AuthenticatedViewer = Extract<ViewerResponse, { authenticated: true }>

export const ANONYMOUS_VIEWER_RESPONSE: ViewerResponse = { authenticated: false }

/** `POST /v1/auth/challenge` request. */
export interface ChallengeRequest {
  address: string
  chainId: number
}

/** `POST /v1/auth/challenge` response: the exact text the wallet must sign. */
export interface ChallengeResponse {
  nonce: string
  message: string
  expiresAt: string
}

/** `POST /v1/auth/verify` request. The message is not sent back: the server signs off on its own copy. */
export interface VerifyRequest {
  nonce: string
  signature: string
}

export interface OwnedFriendDto {
  /** Decimal string: token ids are uint256 and do not fit a JSON number. */
  tokenId: string
  family: Family
}

/** `GET /v1/viewer/friends`. */
export interface FriendsResponse {
  wallet: WalletRef
  /** Where the answer came from. `fixture` is a deterministic test provider, never real ownership. */
  source: 'robinhood-chain' | 'fixture'
  /** Block the ownership was read at, as a decimal string. */
  asOfBlock: string
  friends: OwnedFriendDto[]
}

/** Error bodies are `{ "error": <code> }`. */
export type IdentityErrorCode =
  | 'invalid_request'
  | 'invalid_json'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'origin_mismatch'
  | 'unsupported_chain'
  | 'challenge_invalid'
  | 'signature_invalid'
  | 'not_authenticated'
  | 'auth_unavailable'
  | 'viewer_unavailable'
  | 'ownership_unavailable'
  | 'ownership_too_large'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/

function isWalletRef(value: unknown): value is WalletRef {
  if (!value || typeof value !== 'object') return false
  const w = value as Partial<WalletRef>
  return typeof w.address === 'string' && ADDRESS.test(w.address) && typeof w.chainId === 'number' && Number.isSafeInteger(w.chainId) && w.chainId > 0
}

/** Validate a viewer body that arrived as untyped JSON. null = not the contract. */
export function parseViewerResponse(value: unknown): ViewerResponse | null {
  if (!value || typeof value !== 'object') return null
  const v = value as { authenticated?: unknown; userId?: unknown; wallet?: unknown; session?: unknown }
  if (v.authenticated === false) return ANONYMOUS_VIEWER_RESPONSE
  if (v.authenticated !== true) return null
  if (typeof v.userId !== 'string' || !UUID.test(v.userId) || !isWalletRef(v.wallet)) return null
  const expiresAt = (v.session as { expiresAt?: unknown } | undefined)?.expiresAt
  if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) return null
  return { authenticated: true, userId: v.userId, wallet: { address: v.wallet.address, chainId: v.wallet.chainId }, session: { expiresAt } }
}

export function parseChallengeResponse(value: unknown): ChallengeResponse | null {
  if (!value || typeof value !== 'object') return null
  const c = value as Partial<ChallengeResponse>
  if (typeof c.nonce !== 'string' || !c.nonce || typeof c.message !== 'string' || !c.message || typeof c.expiresAt !== 'string') return null
  return { nonce: c.nonce, message: c.message, expiresAt: c.expiresAt }
}

/** Validate a friends body. A family the client does not know is a malformed answer, not a new family. */
export function parseFriendsResponse(value: unknown): FriendsResponse | null {
  if (!value || typeof value !== 'object') return null
  const f = value as Partial<FriendsResponse>
  if (!isWalletRef(f.wallet) || (f.source !== 'robinhood-chain' && f.source !== 'fixture')) return null
  if (typeof f.asOfBlock !== 'string' || !DECIMAL.test(f.asOfBlock) || !Array.isArray(f.friends)) return null
  const friends: OwnedFriendDto[] = []
  for (const item of f.friends as unknown[]) {
    if (!item || typeof item !== 'object') return null
    const { tokenId, family } = item as { tokenId?: unknown; family?: { id?: unknown; name?: unknown } }
    if (typeof tokenId !== 'string' || !DECIMAL.test(tokenId)) return null
    const known = familyById(family?.id)
    if (!known || known.name !== family?.name) return null
    friends.push({ tokenId, family: known })
  }
  return { wallet: { address: f.wallet.address, chainId: f.wallet.chainId }, source: f.source, asOfBlock: f.asOfBlock, friends }
}
