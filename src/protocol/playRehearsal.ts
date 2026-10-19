import { parseAssetKey } from '../world/asset'
import type { PlayErrorCode } from './play'

/**
 * Wire contract for the LOCAL PROPERTY REHEARSAL (P1-C2-B2B): a player of a play session places
 * a Tier 0 property, permanently, on the exact plot they chose, in a LOCAL deployment only.
 * Used by the server and the client. Portable: no browser or Node dependency.
 *
 * THIS IS NOT NFT OWNERSHIP. No contract can tell Rare City which NFTs a Proofy player holds, or
 * whether they meet a district's Proofy rule. So which test NFTs a player may place is written in a
 * local file the developer starts the server with (`LOCAL_PROPERTY_REHEARSAL_FILE`), keyed by the
 * Discord user id Proofy Play redeemed for the session. Nothing the browser says about an NFT is
 * believed: it names one of the NFTs the server lists for it, and the server checks that again.
 *
 * Both routes exist only when the server runs with APP_MODE=local AND that file; anywhere else they
 * are not there at all (404). The database refuses a property anywhere but a local database
 * (migration 0007), whatever any route does.
 *
 *   `GET  /v1/play/rehearsal/assets`       the test NFTs this session's player may place, marked as rehearsal data
 *   `POST /v1/play/rehearsal/activations`  `{ sessionRef, worldId, discordUserId, asset, plotId }`
 *
 * An activation names the session, world and player the page drew (refused with
 * `play_actor_mismatch` unless the browser's live session is exactly that one, and only once Play
 * answers that the installation is active now), one listed NFT by its CAIP-19 id and one exact plot.
 * The server judges everything else on the city as stored, under its lock: the NFT must be from one
 * of the world's collections and not placed yet, the plot one the engine offers now, and its district
 * without a Proofy rule (no contract can check one). The same player repeating it gets the same
 * property back (`fresh: false`); anyone else is refused.
 */
export const PLAY_REHEARSAL_ASSETS_ENDPOINT = '/v1/play/rehearsal/assets'
export const PLAY_REHEARSAL_ACTIVATIONS_ENDPOINT = '/v1/play/rehearsal/activations'

/** How every rehearsal answer marks itself: test data, never verified holdings. */
export interface RehearsalMark {
  kind: 'local-test-assets'
  verified: false
}

export const REHEARSAL_MARK: RehearsalMark = Object.freeze({ kind: 'local-test-assets', verified: false })

/** A test NFT a player may place in a rehearsal. `asset` is its CAIP-19 id (`eip155:1/erc721:0x…/812`). */
export interface RehearsalAsset {
  asset: string
  chain: string
  contract: string
  /** Canonical decimal uint256, the whole range. Never a number. */
  tokenId: string
}

/** `GET /v1/play/rehearsal/assets`. */
export interface RehearsalAssetsResponse {
  rehearsal: RehearsalMark
  assets: RehearsalAsset[]
}

/** `POST /v1/play/rehearsal/activations` request. Exactly these keys. */
export interface RehearsalActivationRequest {
  sessionRef: string
  worldId: string
  discordUserId: string
  asset: string
  plotId: string
}

/** A property as the rehearsal route answers with it. No session, no player: provenance stays on the server. */
export interface RehearsalProperty {
  id: string
  buildingId: string
  asset: string
  collection: string
  plotId: string
  districtKey: string
  ward: number
  plot: number
  /** The city sequence the activation produced. */
  sequence: number
  configVersion: number
  activatedAt: string
}

/** `POST /v1/play/rehearsal/activations`. `fresh` is false when this player had already placed this NFT on this plot. */
export interface RehearsalActivationResponse {
  rehearsal: RehearsalMark
  fresh: boolean
  /** The city's sequence after this call. */
  sequence: number
  property: RehearsalProperty
}

/** Refusals of the rehearsal routes, besides the play session's own (`PlayErrorCode`). */
export type RehearsalErrorCode =
  /** The NFT is not one the local rehearsal file lists for this player. */
  | 'rehearsal_asset_not_granted'
  | 'invalid_asset'
  /** The NFT is not from any collection of this city. */
  | 'asset_not_in_world'
  /** The NFT already has a property in this city (placed by someone else, or on another plot). */
  | 'asset_already_placed'
  /** Not a plot of this city. */
  | 'unknown_plot'
  /** The plot is taken, or not one the city offers now. */
  | 'plot_unavailable'
  /** The plot's district has a Proofy rule, which nothing can check yet. */
  | 'district_rule_unverified'
  /** This deployment or database does not write properties. */
  | 'mutations_held'
  /** The city moved during the activation; nothing was written. Try again. */
  | 'sequence_conflict'

export type RehearsalRouteErrorCode = RehearsalErrorCode | PlayErrorCode

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const PLOT_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-w(?:0|[1-9][0-9]{0,5})-p(?:0|[1-9][0-9]{0,5})$/
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

function parseMark(v: unknown): RehearsalMark | null {
  return isRecord(v) && v.kind === 'local-test-assets' && v.verified === false ? REHEARSAL_MARK : null
}

/** A rehearsal asset, canonical, or null. */
function parseRehearsalAsset(v: unknown): RehearsalAsset | null {
  if (!isRecord(v)) return null
  const asset = parseAssetKey(v.asset)
  if (!asset || v.chain !== asset.chain || v.contract !== asset.contract || v.tokenId !== asset.tokenId) return null
  return { asset: v.asset as string, chain: asset.chain, contract: asset.contract, tokenId: asset.tokenId }
}

export function parseRehearsalAssetsResponse(body: unknown): RehearsalAssetsResponse | null {
  if (!isRecord(body) || !parseMark(body.rehearsal) || !Array.isArray(body.assets) || body.assets.length > 1_000) return null
  const assets: RehearsalAsset[] = []
  for (const a of body.assets) {
    const parsed = parseRehearsalAsset(a)
    if (!parsed) return null
    assets.push(parsed)
  }
  return { rehearsal: REHEARSAL_MARK, assets }
}

export function parseRehearsalActivationResponse(body: unknown): RehearsalActivationResponse | null {
  if (!isRecord(body) || !parseMark(body.rehearsal) || typeof body.fresh !== 'boolean' || !nonNegInt(body.sequence) || !isRecord(body.property)) return null
  const p = body.property
  if (typeof p.id !== 'string' || !UUID.test(p.id) || p.buildingId !== `b-${p.id}` || !parseAssetKey(p.asset)) return null
  if (typeof p.collection !== 'string' || !KEY.test(p.collection) || typeof p.districtKey !== 'string' || !KEY.test(p.districtKey)) return null
  if (!nonNegInt(p.ward) || !nonNegInt(p.plot) || p.plotId !== `${p.districtKey}-w${p.ward}-p${p.plot}` || !PLOT_ID.test(p.plotId)) return null
  if (!nonNegInt(p.sequence) || p.sequence < 2 || !nonNegInt(p.configVersion) || typeof p.activatedAt !== 'string' || Number.isNaN(Date.parse(p.activatedAt))) return null
  return {
    rehearsal: REHEARSAL_MARK,
    fresh: body.fresh,
    sequence: body.sequence,
    property: {
      id: p.id,
      buildingId: p.buildingId,
      asset: p.asset as string,
      collection: p.collection,
      plotId: p.plotId,
      districtKey: p.districtKey,
      ward: p.ward,
      plot: p.plot,
      sequence: p.sequence,
      configVersion: p.configVersion,
      activatedAt: p.activatedAt,
    },
  }
}
