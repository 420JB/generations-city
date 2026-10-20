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
 *   `GET  /v1/play/rehearsal/ticket`       the player's live district ticket in this city, or none (read only)
 *   `POST /v1/play/rehearsal/entry`        `{ sessionRef, worldId, discordUserId }`: enter the claim flow: the player's
 *                                          live ticket, or a new one from the city's rotation if the file lists an
 *                                          unplaced NFT of this city for them
 *   `POST /v1/play/rehearsal/assignment`   `{ …actor, ticketId, asset }`: the NFT the player selected; an explicit
 *                                          (local fixture) rule for it swaps the fallback ticket for a rule ticket
 *   `POST /v1/play/rehearsal/release`      `{ …actor, ticketId }`: leave the claim flow; the slot is reused
 *   `POST /v1/play/rehearsal/activations`  `{ sessionRef, worldId, discordUserId, asset, plotId, geometryFingerprint, ticketId }`
 *
 * DISTRICT TICKETS (P1-C2-D1). The player does not choose their district: entering the claim flow
 * assigns one (a ticket from the city's citywide round-robin rotation, or, for an NFT a local
 * fixture rule assigns, that rule's district), and the player chooses the exact plot inside it. A
 * ticket is provisional: nothing permanent happens until an activation consumes it. Eligibility for
 * a ticket here is the local file, NEVER verified Proofy Core eligibility.
 *
 * An activation names the session, world and player the page drew (refused with
 * `play_actor_mismatch` unless the browser's live session is exactly that one, and only once Play
 * answers that the installation is active now), one listed NFT by its CAIP-19 id, one exact plot, and the
 * layout geometry fingerprint of the city the plot was chosen on (`PlayWorld.definition.geometryFingerprint`).
 * The server judges everything else on the city as stored, under its lock: the NFT must be from one
 * of the world's collections and not placed yet, the plot one the engine offers now, and its district
 * without a Proofy rule (no contract can check one). The city's governing geometry must be the one the
 * page drew, and before a city's first property (which fixes its districts for good) Proofy Play must
 * still have exactly the governing configuration active; otherwise `config_superseded` (409) and
 * nothing is written. The same player repeating it gets the same
 * property back (`fresh: false`); anyone else is refused.
 */
export const PLAY_REHEARSAL_ASSETS_ENDPOINT = '/v1/play/rehearsal/assets'
export const PLAY_REHEARSAL_ACTIVATIONS_ENDPOINT = '/v1/play/rehearsal/activations'
export const PLAY_REHEARSAL_TICKET_ENDPOINT = '/v1/play/rehearsal/ticket'
export const PLAY_REHEARSAL_ENTRY_ENDPOINT = '/v1/play/rehearsal/entry'
export const PLAY_REHEARSAL_ASSIGNMENT_ENDPOINT = '/v1/play/rehearsal/assignment'
export const PLAY_REHEARSAL_RELEASE_ENDPOINT = '/v1/play/rehearsal/release'

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

/** The actor a page names: the session, world and player it drew. */
export interface RehearsalActorRequest {
  sessionRef: string
  worldId: string
  discordUserId: string
}

/** `POST /v1/play/rehearsal/activations` request. Exactly these keys. */
export interface RehearsalActivationRequest extends RehearsalActorRequest {
  asset: string
  plotId: string
  /** The layout geometry fingerprint of the city the plot was chosen on, as the page drew it. */
  geometryFingerprint: string
  /** The district ticket the plot was chosen under. */
  ticketId: string
}

/** `POST /v1/play/rehearsal/assignment` request. Exactly these keys. */
export interface RehearsalAssignmentRequest extends RehearsalActorRequest {
  ticketId: string
  asset: string
}

/** `POST /v1/play/rehearsal/release` request. Exactly these keys. */
export interface RehearsalReleaseRequest extends RehearsalActorRequest {
  ticketId: string
}

/**
 * A district ticket, as its holder is told it: which district the server assigned, on what basis, until when. No other
 * player, session or slot holder appears in it.
 */
export interface RehearsalTicket {
  /** The ticket's nonce: an activation names it. A reissued slot is a new ticket with a new id. */
  id: string
  /** `fallback`: the city's citywide round-robin rotation. `rule`: an explicit (local fixture) rule for one NFT. */
  kind: 'fallback' | 'rule'
  districtKey: string
  /** A fallback ticket's slot: its ordinal in the city's rotation (from 0), the generation of this issuance, the rotation epoch. */
  slot: { ordinal: number; generation: number; epoch: number } | null
  /** A rule ticket's rule ids and the NFT it is for. */
  rule: { ref: string; asset: string } | null
  /** The governing configuration version and layout geometry it was issued on. */
  configVersion: number
  layoutGeometryFingerprint: string
  issuedAt: string
  expiresAt: string
}

/**
 * The ticket routes' answer. `ticket` is the player's live ticket after the call (null: none, or released). `fresh`: a
 * ticket was issued by this call (entry), or the assignment changed it.
 */
export interface RehearsalTicketResponse {
  rehearsal: RehearsalMark
  ticket: RehearsalTicket | null
  fresh: boolean
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
  /** The district ticket this call consumed; null when nothing was written (a repeat). */
  consumedTicket: string | null
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
  /** The local file lists no unplaced NFT of this city for the player: no district ticket was issued. */
  | 'not_eligible'
  /** Every district of this city has a Proofy rule: there is no default district to assign. */
  | 'no_default_district'
  /** The named district ticket is not the player's live ticket in this city (unknown, released or already used). */
  | 'ticket_not_live'
  /** The district ticket's lease ran out. Enter again for a district. */
  | 'ticket_expired'
  /** The city's districts changed after the ticket was issued; it was replaced (or must be requested again). */
  | 'ticket_superseded'
  /** The plot is not in the district the ticket assigns. */
  | 'plot_outside_assignment'
  /** An explicit rule assigns this NFT's district: select it first, so the server issues that rule's ticket. */
  | 'district_rule_applies'
  /** Explicit rules for this NFT name different districts, and no precedence is approved: it cannot be placed. */
  | 'district_rule_ambiguous'
  /** The rule ticket was issued for another NFT. */
  | 'ticket_asset_mismatch'

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

const HASH = /^[0-9a-f]{64}$/
const isInstant = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))

/** A district ticket, exactly, or null. */
function parseRehearsalTicket(v: unknown): RehearsalTicket | null {
  if (!isRecord(v) || typeof v.id !== 'string' || !UUID.test(v.id) || (v.kind !== 'fallback' && v.kind !== 'rule') || typeof v.districtKey !== 'string' || !KEY.test(v.districtKey)) return null
  if (!nonNegInt(v.configVersion) || v.configVersion < 1 || typeof v.layoutGeometryFingerprint !== 'string' || !HASH.test(v.layoutGeometryFingerprint) || !isInstant(v.issuedAt) || !isInstant(v.expiresAt)) return null
  let slot: RehearsalTicket['slot'] = null
  let rule: RehearsalTicket['rule'] = null
  if (v.kind === 'fallback') {
    const s = v.slot
    if (!isRecord(s) || !nonNegInt(s.ordinal) || !nonNegInt(s.generation) || s.generation < 1 || !nonNegInt(s.epoch) || s.epoch < 1 || v.rule !== null) return null
    slot = { ordinal: s.ordinal, generation: s.generation, epoch: s.epoch }
  } else {
    const r = v.rule
    if (!isRecord(r) || typeof r.ref !== 'string' || r.ref.length === 0 || r.ref.length > 200 || !parseAssetKey(r.asset) || v.slot !== null) return null
    rule = { ref: r.ref, asset: r.asset as string }
  }
  return { id: v.id, kind: v.kind, districtKey: v.districtKey, slot, rule, configVersion: v.configVersion, layoutGeometryFingerprint: v.layoutGeometryFingerprint, issuedAt: v.issuedAt, expiresAt: v.expiresAt }
}

export function parseRehearsalTicketResponse(body: unknown): RehearsalTicketResponse | null {
  if (!isRecord(body) || !parseMark(body.rehearsal) || typeof body.fresh !== 'boolean') return null
  if (body.ticket === null) return { rehearsal: REHEARSAL_MARK, ticket: null, fresh: body.fresh }
  const ticket = parseRehearsalTicket(body.ticket)
  return ticket ? { rehearsal: REHEARSAL_MARK, ticket, fresh: body.fresh } : null
}

export function parseRehearsalActivationResponse(body: unknown): RehearsalActivationResponse | null {
  if (!isRecord(body) || !parseMark(body.rehearsal) || typeof body.fresh !== 'boolean' || !nonNegInt(body.sequence) || !isRecord(body.property)) return null
  if (!(body.consumedTicket === null || (typeof body.consumedTicket === 'string' && UUID.test(body.consumedTicket)))) return null
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
    consumedTicket: body.consumedTicket,
  }
}
