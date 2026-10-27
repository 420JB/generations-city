import { parseAssetKey } from '../world/asset'
import { DESIGN_CATALOGS, DESIGN_SLOTS, isCatalogChoice, type DesignCatalog, type DesignChoice, type PropertyDesign } from '../world/design'
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
 *
 * CONSTRUCTION (P1-C2-E3A, Tier 2 in P1-C2-E3B). LOCAL TEST CONSTRUCTION ONLY: one fixed step of a
 * provisional, versioned local recipe (now Tier 0 to Tier 2), paid in valueless `local-test-credit`
 * units the local file grants. Every construction names the recipe that computed it.
 *
 *   `GET  /v1/play/rehearsal/construction?property=<id>`  a property's construction as this session's
 *                                          player may see it: tier, progress, the viewer's test credits,
 *                                          investment by the current owner, previous owners and patrons,
 *                                          history (no other player is named), and what the viewer may do
 *   `POST /v1/play/rehearsal/constructions`  `{ sessionRef, worldId, discordUserId, propertyId, role, actionId }`
 *   `GET  /v1/play/rehearsal/architect`    this session's player's own construction record in this city
 *                                          (P1-C2-E3B): owner units (current and earlier control eras), patron
 *                                          units, and the properties they founded, control now or built into.
 *                                          Descriptive statistics only: no rank, level, XP or reward.
 *
 * The page names a property, a role (`owner` only when the local file names this player as the NFT's
 * current controller; `patron` otherwise) and a fresh UUID per press. Never an amount, a price, a
 * tier or a state: the server computes the step and its cost, and answers what committed. The same
 * press again answers the same construction (`fresh: false`) and costs nothing more. Founding a
 * property does not make its founder its owner here, and the local file's controller is TEST DATA,
 * never verified NFT ownership.
 *
 * ARCHITECT DESIGN (P1-C2-E4A, P1-C2-E4B, P1-C2-E4C, P1-E6). FREE, LOCAL TEST CONTROL ONLY: a property's
 * facade finish, roof silhouette, window treatment, exterior lighting treatment, entrance treatment,
 * landscaping treatment and exterior color, identifiers from a versioned catalog (`src/world/design.ts`),
 * each one the standard renderer draws. Never a color value, markup, URL, position or upload: an
 * exterior color is a NAME the catalog lists. Every design names its catalog and carries all seven
 * slots: a slot its catalog does not have is null (`windows`, `lighting`, `entrance`, `landscaping` and
 * `color` for `architect-design-v1`; `entrance`, `landscaping` and `color` for `architect-design-v2`;
 * `color` for `architect-design-v3`).
 *
 *   `GET  /v1/play/rehearsal/appearance`   the saved design of every property of this session's city
 *                                          that has one (the rest are drawn with the catalog's default)
 *   `GET  /v1/play/rehearsal/design?property=<id>`  one property's design as this session's player may see
 *                                          it: the saved revision, its history (no other player is
 *                                          named), and whom the local file names as its controller
 *   `POST /v1/play/rehearsal/designs`      `{ sessionRef, worldId, discordUserId, propertyId, actionId,
 *                                          baseRevision, catalog, facade, roof, windows, lighting,
 *                                          entrance, landscaping, color }` (an earlier page's save, without
 *                                          the slots its catalog did not have, is answered as exactly
 *                                          that save if it was recorded, and refused `design_retired` if
 *                                          it was not)
 *
 * Only the player the local file names as the NFT's CURRENT controller may save; founding the property,
 * a patron's construction or an earlier control authorize nothing. A save names the revision it was
 * made on (`design_stale` if the property moved on) and a fresh UUID per press: the same press again
 * answers the design it saved (`fresh: false`), and the id can never save a different design. A design
 * stays with the property when its controller changes, costs nothing, builds nothing and advances no
 * city sequence.
 *
 * PROPERTY LEGACY (P1-C2-E5A). READ ONLY, from the records above and nothing else:
 *
 *   `GET  /v1/play/rehearsal/legacy?property=<id>`  one property's history as this session's player may see
 *                                          it: its founding (the player, someone else, or never recorded),
 *                                          whom the local file names as its controller now, every control
 *                                          era the construction records saw (owner and patron units in each;
 *                                          current or earlier; the player's own or not), lifetime investment
 *                                          by the current controller, previous controllers and patrons, the
 *                                          player's own part in it, and its design revisions attributed only
 *                                          by relation (the player or not; the controller named now, or
 *                                          earlier control). No other player is named. A design is never a
 *                                          construction unit, and no rank, level, XP or reward exists.
 */
export const PLAY_REHEARSAL_ASSETS_ENDPOINT = '/v1/play/rehearsal/assets'
export const PLAY_REHEARSAL_ACTIVATIONS_ENDPOINT = '/v1/play/rehearsal/activations'
export const PLAY_REHEARSAL_TICKET_ENDPOINT = '/v1/play/rehearsal/ticket'
export const PLAY_REHEARSAL_ENTRY_ENDPOINT = '/v1/play/rehearsal/entry'
export const PLAY_REHEARSAL_ASSIGNMENT_ENDPOINT = '/v1/play/rehearsal/assignment'
export const PLAY_REHEARSAL_RELEASE_ENDPOINT = '/v1/play/rehearsal/release'
export const PLAY_REHEARSAL_CONSTRUCTION_ENDPOINT = '/v1/play/rehearsal/construction'
export const PLAY_REHEARSAL_CONSTRUCTIONS_ENDPOINT = '/v1/play/rehearsal/constructions'
export const PLAY_REHEARSAL_ARCHITECT_ENDPOINT = '/v1/play/rehearsal/architect'
export const PLAY_REHEARSAL_APPEARANCE_ENDPOINT = '/v1/play/rehearsal/appearance'
export const PLAY_REHEARSAL_DESIGN_ENDPOINT = '/v1/play/rehearsal/design'
export const PLAY_REHEARSAL_DESIGNS_ENDPOINT = '/v1/play/rehearsal/designs'
export const PLAY_REHEARSAL_LEGACY_ENDPOINT = '/v1/play/rehearsal/legacy'

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

/**
 * `POST /v1/play/rehearsal/assignment` request. Exactly these keys. `ticketId` null names the ticket the player holds, or,
 * in a city whose every district is restricted (entry answered `awaiting: "asset"`), none: the selected NFT's rule decides.
 */
export interface RehearsalAssignmentRequest extends RehearsalActorRequest {
  ticketId: string | null
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
  /**
   * A rule ticket on a RESTRICTED district: the district's Proofy verification rule, and where the positive answer came
   * from. Always `local-fixture` here: local test data standing in for Proofy Core, never a verified answer.
   */
  authorization: { verificationRuleId: number; source: 'local-fixture' } | null
  /** The governing configuration version and layout geometry it was issued on. */
  configVersion: number
  layoutGeometryFingerprint: string
  issuedAt: string
  expiresAt: string
}

/**
 * The ticket routes' answer. `ticket` is the player's live ticket after the call (null: none, or released). `fresh`: a
 * ticket was issued by this call (entry), or the assignment changed it. `awaiting: "asset"` (entry only, ticket null):
 * every district of this city is restricted, so the district depends on the NFT; select it to be assigned its district.
 */
export interface RehearsalTicketResponse {
  rehearsal: RehearsalMark
  ticket: RehearsalTicket | null
  fresh: boolean
  awaiting: 'asset' | null
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

/** Who builds: the NFT's current controller (as the local file names them), or anyone else. */
export type ConstructionRole = 'owner' | 'patron'

/** `POST /v1/play/rehearsal/constructions` request. Exactly these keys. */
export interface RehearsalConstructionRequest extends RehearsalActorRequest {
  propertyId: string
  role: ConstructionRole
  /** A fresh UUID per press: the same press again is the same construction. */
  actionId: string
}

/** What a viewer may do on a property now, as the server judged it when it answered. */
export type ConstructionStanding = { kind: 'ready' | 'insufficient'; role: ConstructionRole; units: number } | { kind: 'complete' }

/** `GET /v1/play/rehearsal/construction`: a property's construction as this session's player may see it. Every amount is local test units. */
export interface RehearsalConstructionView {
  rehearsal: RehearsalMark
  resource: 'local-test-credit'
  /** The recipe that computes every step. Provisional local tuning, not a price or a tier policy. */
  recipe: { key: string; unitsPerAction: number; tierThresholds: number[]; provisional: true }
  property: { propertyId: string; buildingId: string; tier: number; built: number; nextTierAt: number | null; maxTier: number }
  /** Whom the local file names as the NFT's current controller: this player, someone else, or nobody. Never verified. */
  control: 'viewer' | 'other' | 'unknown'
  standing: ConstructionStanding
  credits: { available: number; recorded: number; pending: number }
  investment: { currentOwner: number; previousOwners: number; community: number; total: number }
  /** What this player has built in this city, as an owner (their own progression) and as a patron. */
  viewer: { ownerUnits: number; patronUnits: number }
  /** How many different players have built here as an owner and as a patron. Nobody is named. */
  contributors: { owners: number; patrons: number }
  /** Newest first, each with the recipe that computed it. `by` says only whether it was this player. */
  history: { sequence: number; recipe: string; role: ConstructionRole; units: number; tierAfter: number; by: 'viewer' | 'other'; era: number | null; at: string }[]
  historyCount: number
}

/** One property in the player's Architect activity. */
export interface RehearsalArchitectProperty {
  propertyId: string
  buildingId: string
  asset: string
  collection: string
  districtKey: string
  plotId: string
  ward: number
  plot: number
  /** This player is its original activator: a permanent record, never ownership. */
  founded: boolean
  /** Whom the local file names as the NFT's current controller. Never verified. */
  control: 'viewer' | 'other' | 'unknown'
  tier: number
  built: number
  nextTierAt: number | null
  standing: ConstructionStanding
  yours: { ownerUnits: number; currentEraOwnerUnits: number; earlierEraOwnerUnits: number; patronUnits: number; actions: number; tiersCompleted: number; lastSequence: number | null }
}

/** `GET /v1/play/rehearsal/architect`: this session's player's own LOCAL TEST construction record in this city. */
export interface RehearsalArchitectView {
  rehearsal: RehearsalMark
  resource: 'local-test-credit'
  recipe: { key: string; unitsPerAction: number; tierThresholds: number[]; provisional: true }
  credits: { available: number; recorded: number; pending: number }
  totals: {
    ownerUnits: number
    currentEraOwnerUnits: number
    earlierEraOwnerUnits: number
    patronUnits: number
    ownerActions: number
    patronActions: number
    tiersCompleted: number
    propertiesDeveloped: number
    propertiesDevelopedAsOwner: number
  }
  /** Most recent activity first. */
  properties: RehearsalArchitectProperty[]
  propertyCount: number
}

/** A construction as the route answers with it. No session and no player: provenance stays on the server. */
export interface RehearsalConstruction {
  sequence: number
  propertyId: string
  actionId: string
  /** The recipe that computed it, as recorded: a repeated press answers its own record, whatever recipe is current now. */
  recipe: string
  role: ConstructionRole
  era: number | null
  units: number
  builtBefore: number
  builtAfter: number
  tierBefore: number
  tierAfter: number
  constructedAt: string
}

/** `POST /v1/play/rehearsal/constructions`. `fresh` is false when this press had already built: nothing more was spent. */
export interface RehearsalConstructionResponse {
  rehearsal: RehearsalMark
  resource: 'local-test-credit'
  fresh: boolean
  /** The city's sequence after this call. */
  sequence: number
  /** The player's recorded test credit balance after this call. */
  balance: number
  construction: RehearsalConstruction
  /**
   * The property's construction as read after this call, or null when that read failed after the construction was
   * written: the construction above is still exactly what was built, and the page reads the view again itself.
   */
  view: RehearsalConstructionView | null
}

/** A design catalog as the server answers it: exactly one this build has (`DESIGN_CATALOGS`). */
export interface RehearsalDesignCatalog {
  key: string
  facades: string[]
  roofs: string[]
  windows: string[]
  lighting: string[]
  entrances: string[]
  landscaping: string[]
  colors: string[]
  default: PropertyDesign
}

/** One property's saved design, as the whole city draws it (null for each slot its catalog does not have). */
export interface RehearsalCityDesign extends DesignChoice {
  propertyId: string
  buildingId: string
  revision: number
  catalog: string
}

/** `GET /v1/play/rehearsal/appearance`: every saved design of this city, in activation order. A property not listed is drawn with the catalog's default. */
export interface RehearsalAppearanceResponse {
  rehearsal: RehearsalMark
  catalog: RehearsalDesignCatalog
  designs: RehearsalCityDesign[]
}

/** `GET /v1/play/rehearsal/design`: one property's design as this session's player may see it. */
export interface RehearsalDesignView {
  rehearsal: RehearsalMark
  /** The catalog a save chooses from now. */
  catalog: RehearsalDesignCatalog
  property: { propertyId: string; buildingId: string }
  /** The latest saved revision, or null: drawn with the catalog's default. */
  saved: (DesignChoice & { revision: number; catalog: string; atCitySequence: number; at: string }) | null
  /** Whom the local file names as the NFT's current controller: this player, someone else, or nobody. Never verified. */
  control: 'viewer' | 'other' | 'unknown'
  /** Whether this local server's file has any data for this city (without it nobody can save). */
  open: boolean
  /** Newest first. `by` says only whether it was this player. */
  history: (DesignChoice & { revision: number; catalog: string; by: 'viewer' | 'other'; at: string })[]
  historyCount: number
}

/** `POST /v1/play/rehearsal/designs` request. Exactly these keys. */
export interface RehearsalDesignRequest extends RehearsalActorRequest {
  propertyId: string
  /** A fresh UUID per press: the same press again is the same save. */
  actionId: string
  /** The revision the design was chosen on: 0 for a property never designed. */
  baseRevision: number
  catalog: string
  facade: string
  roof: string
  /** Absent only in a save an earlier page (catalog v1) kept: sent again exactly as it was first sent. */
  windows?: string
  lighting?: string
  /** Absent only in a save an earlier page (catalog v1 or v2) kept: sent again exactly as it was first sent. */
  entrance?: string
  landscaping?: string
  /** Absent only in a save an earlier page (catalog v1, v2 or v3) kept: sent again exactly as it was first sent. */
  color?: string
}

/** A saved design as the route answers with it. No session and no player. */
export interface RehearsalDesign extends DesignChoice {
  propertyId: string
  buildingId: string
  revision: number
  actionId: string
  catalog: string
  atCitySequence: number
  designedAt: string
}

/** `POST /v1/play/rehearsal/designs`. `fresh` is false when this press had already saved: nothing more was written. */
export interface RehearsalDesignResponse {
  rehearsal: RehearsalMark
  fresh: boolean
  design: RehearsalDesign
  /** The property's design as read after this call, or null when that read failed after the save was written. */
  view: RehearsalDesignView | null
}

/** One control era of a property, as its legacy says it: nobody is named, only whether it is current and the viewer's. */
export interface RehearsalLegacyEra {
  era: number
  /** Its controller is the one the local file names now. */
  current: boolean
  /** Its controller is this player. */
  yours: boolean
  ownerUnits: number
  patronUnits: number
  actions: number
  tierBefore: number
  tierAfter: number
  firstSequence: number
  lastSequence: number
}

/** One saved design revision, as a property's legacy says it. */
export interface RehearsalLegacyRevision extends DesignChoice {
  revision: number
  catalog: string
  by: 'viewer' | 'other'
  /** Saved by the controller the local file names now, or under earlier control. */
  savedBy: 'current-controller' | 'earlier-controller'
  atCitySequence: number
  at: string
}

/** `GET /v1/play/rehearsal/legacy`: one property's legacy as this session's player may see it. Every amount is local test units. */
export interface RehearsalPropertyLegacy {
  rehearsal: RehearsalMark
  resource: 'local-test-credit'
  recipe: { key: string; unitsPerAction: number; tierThresholds: number[]; provisional: true }
  property: { propertyId: string; buildingId: string; tier: number; built: number; nextTierAt: number | null; maxTier: number; activatedSequence: number; foundingOrder: number }
  /** Its original activator: this player, someone else (never named), or never recorded. Permanent; never control. */
  founding: 'viewer' | 'other' | 'unrecorded'
  /** Whether this local server's file has any data for this city. */
  open: boolean
  /** Whom the local file names as the NFT's current controller. Never verified. */
  control: 'viewer' | 'other' | 'unknown'
  investment: { currentController: number; previousControllers: number; community: number; total: number }
  /** What this player built on this property: their own record, apart from the property's total. */
  yours: { ownerUnits: number; currentEraOwnerUnits: number; earlierEraOwnerUnits: number; patronUnits: number; actions: number }
  /** Newest first. */
  eras: RehearsalLegacyEra[]
  eraCount: number
  /** Patron units built while no controller was named. */
  unattributed: { patronUnits: number; actions: number }
  contributors: { owners: number; patrons: number }
  /** Newest first. */
  designs: RehearsalLegacyRevision[]
  designCount: number
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
  /** The district is restricted (a Proofy rule) and there is no answer to its rule for this player (missing, unknown or conflicting). */
  | 'district_rule_unverified'
  /** The district is restricted (a Proofy rule) and its rule answered that this player does not qualify. */
  | 'district_rule_unqualified'
  /** This deployment or database does not write properties. */
  | 'mutations_held'
  /** The city moved during the activation; nothing was written. Try again. */
  | 'sequence_conflict'
  /** The local file lists no unplaced NFT of this city for the player: no district ticket was issued. */
  | 'not_eligible'
  /** Every district of this city is restricted, and no explicit rule places this NFT (or any of the player's) in one. */
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
  /** Explicit rules for this NFT agree, but there are too many for its district ticket to record them all: it cannot be placed. */
  | 'district_rule_ref_too_long'
  /** The rule ticket was issued for another NFT. */
  | 'ticket_asset_mismatch'
  /** Not a property of this city. */
  | 'unknown_property'
  /** Construction is not open in this city: this local server's file has no construction test data for its Discord server. */
  | 'construction_not_open'
  /** The property stands at the highest tier the local test recipe builds. */
  | 'construction_complete'
  /** An owner construction, and the local file names someone else as the NFT's current controller. */
  | 'not_current_controller'
  /** An owner construction, and the local file names nobody as the NFT's current controller. */
  | 'control_unverified'
  /** A patron construction by the player the local file names as the NFT's current controller. */
  | 'controller_builds_as_owner'
  /** The player's local test credits do not cover the step. Nothing was built or spent. */
  | 'insufficient_test_credits'
  /** The press's id already names another construction. */
  | 'action_conflict'
  /**
   * The construction request failed in a way that does not say whether it was written (a lost database answer, a
   * failed commit). Ask again with the same press id: it returns that construction if it was built, and builds it once if not.
   */
  | 'construction_unconfirmed'
  /** Property design is not open in this city: this local server's file has no test data for its Discord server. */
  | 'design_not_open'
  /** Not exactly a design of a catalog this server has. Nothing was saved. */
  | 'design_unsupported'
  /** A design of an earlier catalog that was never saved: new designs are chosen from the current catalog. Nothing was saved. */
  | 'design_retired'
  /** The property's design changed after the revision this save was made on. Nothing was saved. */
  | 'design_stale'
  /** The save is exactly the property's current design. Nothing was saved. */
  | 'design_unchanged'
  /**
   * The design request failed in a way that does not say whether it was written. Ask again with the same press: it
   * returns that design if it was saved, and saves it once if not.
   */
  | 'design_unconfirmed'

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
  let authorization: RehearsalTicket['authorization'] = null
  if (v.authorization !== null) {
    const a = v.authorization
    if (v.kind !== 'rule' || !isRecord(a) || !nonNegInt(a.verificationRuleId) || a.verificationRuleId < 1 || a.source !== 'local-fixture') return null
    authorization = { verificationRuleId: a.verificationRuleId, source: 'local-fixture' }
  }
  return { id: v.id, kind: v.kind, districtKey: v.districtKey, slot, rule, authorization, configVersion: v.configVersion, layoutGeometryFingerprint: v.layoutGeometryFingerprint, issuedAt: v.issuedAt, expiresAt: v.expiresAt }
}

export function parseRehearsalTicketResponse(body: unknown): RehearsalTicketResponse | null {
  if (!isRecord(body) || !parseMark(body.rehearsal) || typeof body.fresh !== 'boolean' || (body.awaiting !== null && body.awaiting !== 'asset')) return null
  if (body.ticket === null) return { rehearsal: REHEARSAL_MARK, ticket: null, fresh: body.fresh, awaiting: body.awaiting }
  // A ticket is held: nothing is awaited.
  const ticket = body.awaiting === null ? parseRehearsalTicket(body.ticket) : null
  return ticket ? { rehearsal: REHEARSAL_MARK, ticket, fresh: body.fresh, awaiting: null } : null
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

const count = (v: unknown, max = 1_000_000_000): v is number => nonNegInt(v) && v <= max
const isRole = (v: unknown): v is ConstructionRole => v === 'owner' || v === 'patron'
const exact = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join() === keys

/** A construction view, exactly, or null. */
export function parseRehearsalConstructionView(body: unknown): RehearsalConstructionView | null {
  if (!isRecord(body) || !parseMark(body.rehearsal) || body.resource !== 'local-test-credit') return null
  if (!exact(body, 'contributors,control,credits,history,historyCount,investment,property,recipe,rehearsal,resource,standing,viewer')) return null
  const { recipe: r, property: p, standing: st, credits: c, investment: i, viewer: v, contributors: who } = body
  const recipe = parseRecipe(r)
  if (!recipe) return null
  if (!isRecord(who) || !count(who.owners) || !count(who.patrons)) return null
  if (!isRecord(p) || typeof p.propertyId !== 'string' || !UUID.test(p.propertyId) || p.buildingId !== `b-${p.propertyId}` || !count(p.tier, 64) || !count(p.built) || !count(p.maxTier, 64)) return null
  if (!(p.nextTierAt === null || (count(p.nextTierAt) && p.nextTierAt > p.built))) return null
  if (!isControl(body.control)) return null
  const standing = parseStanding(st)
  const credits = parseCredits(c)
  if (!standing || !credits) return null
  if (!isRecord(i) || !count(i.currentOwner) || !count(i.previousOwners) || !count(i.community) || !count(i.total) || i.currentOwner + i.previousOwners + i.community !== i.total || i.total !== p.built) return null
  if (!isRecord(v) || !count(v.ownerUnits) || !count(v.patronUnits)) return null
  if (!Array.isArray(body.history) || body.history.length > 100 || !count(body.historyCount) || body.historyCount < body.history.length) return null
  const history: RehearsalConstructionView['history'] = []
  for (const h of body.history) {
    if (!isRecord(h) || !count(h.sequence) || h.sequence < 3 || typeof h.recipe !== 'string' || !KEY.test(h.recipe) || !isRole(h.role) || !count(h.units) || h.units < 1 || !count(h.tierAfter, 64) || (h.by !== 'viewer' && h.by !== 'other')) return null
    if (!(h.era === null || (count(h.era) && h.era >= 1)) || !isInstant(h.at)) return null
    history.push({ sequence: h.sequence, recipe: h.recipe, role: h.role, units: h.units, tierAfter: h.tierAfter, by: h.by, era: h.era, at: h.at })
  }
  return {
    rehearsal: REHEARSAL_MARK,
    resource: 'local-test-credit',
    recipe,
    property: { propertyId: p.propertyId, buildingId: p.buildingId, tier: p.tier, built: p.built, nextTierAt: p.nextTierAt, maxTier: p.maxTier },
    control: body.control,
    standing,
    credits,
    investment: { currentOwner: i.currentOwner, previousOwners: i.previousOwners, community: i.community, total: i.total },
    viewer: { ownerUnits: v.ownerUnits, patronUnits: v.patronUnits },
    contributors: { owners: who.owners, patrons: who.patrons },
    history,
    historyCount: body.historyCount,
  }
}

function parseRecipe(r: unknown): RehearsalConstructionView['recipe'] | null {
  if (!isRecord(r) || typeof r.key !== 'string' || !KEY.test(r.key) || !count(r.unitsPerAction) || r.unitsPerAction < 1 || r.provisional !== true) return null
  if (!Array.isArray(r.tierThresholds) || r.tierThresholds.length === 0 || r.tierThresholds.length > 64 || !r.tierThresholds.every((x, n, all) => count(x) && x > (n === 0 ? 0 : all[n - 1]))) return null
  return { key: r.key, unitsPerAction: r.unitsPerAction, tierThresholds: [...(r.tierThresholds as number[])], provisional: true }
}

const isControl = (v: unknown): v is 'viewer' | 'other' | 'unknown' => v === 'viewer' || v === 'other' || v === 'unknown'

function parseStanding(st: unknown): ConstructionStanding | null {
  if (!isRecord(st)) return null
  if (st.kind === 'complete' && exact(st, 'kind')) return { kind: 'complete' }
  if ((st.kind === 'ready' || st.kind === 'insufficient') && isRole(st.role) && count(st.units) && st.units >= 1) return { kind: st.kind, role: st.role, units: st.units }
  return null
}

function parseCredits(c: unknown): RehearsalConstructionView['credits'] | null {
  if (!isRecord(c) || !count(c.available) || !count(c.recorded) || !count(c.pending) || c.available !== c.recorded + c.pending) return null
  return { available: c.available, recorded: c.recorded, pending: c.pending }
}

const TOTAL_KEYS = ['ownerUnits', 'currentEraOwnerUnits', 'earlierEraOwnerUnits', 'patronUnits', 'ownerActions', 'patronActions', 'tiersCompleted', 'propertiesDeveloped', 'propertiesDevelopedAsOwner'] as const

/** An Architect activity answer, exactly, or null. Its sums must agree: owner units are the current and earlier eras' together. */
export function parseRehearsalArchitectView(body: unknown): RehearsalArchitectView | null {
  if (!isRecord(body) || !parseMark(body.rehearsal) || body.resource !== 'local-test-credit') return null
  if (!exact(body, 'credits,properties,propertyCount,recipe,rehearsal,resource,totals')) return null
  const recipe = parseRecipe(body.recipe)
  const credits = parseCredits(body.credits)
  const t = body.totals
  if (!recipe || !credits || !isRecord(t) || !exact(t, [...TOTAL_KEYS].sort().join()) || !TOTAL_KEYS.every((k) => count(t[k]))) return null
  const totals = Object.fromEntries(TOTAL_KEYS.map((k) => [k, t[k] as number])) as RehearsalArchitectView['totals']
  if (totals.currentEraOwnerUnits + totals.earlierEraOwnerUnits !== totals.ownerUnits || totals.propertiesDevelopedAsOwner > totals.propertiesDeveloped) return null
  if (!Array.isArray(body.properties) || body.properties.length > 200 || !count(body.propertyCount) || body.propertyCount < body.properties.length) return null
  const properties: RehearsalArchitectProperty[] = []
  for (const a of body.properties) {
    if (!isRecord(a) || typeof a.propertyId !== 'string' || !UUID.test(a.propertyId) || a.buildingId !== `b-${a.propertyId}` || !parseAssetKey(a.asset)) return null
    if (typeof a.collection !== 'string' || !KEY.test(a.collection) || typeof a.districtKey !== 'string' || !KEY.test(a.districtKey) || !count(a.ward) || !count(a.plot) || a.plotId !== `${a.districtKey}-w${a.ward}-p${a.plot}`) return null
    if (typeof a.founded !== 'boolean' || !isControl(a.control) || !count(a.tier, 64) || !count(a.built) || !(a.nextTierAt === null || (count(a.nextTierAt) && a.nextTierAt > a.built))) return null
    const standing = parseStanding(a.standing)
    const y = a.yours
    if (!standing || !isRecord(y) || !count(y.ownerUnits) || !count(y.currentEraOwnerUnits) || !count(y.earlierEraOwnerUnits) || y.currentEraOwnerUnits + y.earlierEraOwnerUnits !== y.ownerUnits) return null
    if (!count(y.patronUnits) || !count(y.actions) || !count(y.tiersCompleted) || !(y.lastSequence === null ? y.actions === 0 : count(y.lastSequence) && y.lastSequence >= 3 && y.actions > 0)) return null
    properties.push({
      propertyId: a.propertyId,
      buildingId: a.buildingId,
      asset: a.asset as string,
      collection: a.collection,
      districtKey: a.districtKey,
      plotId: a.plotId,
      ward: a.ward,
      plot: a.plot,
      founded: a.founded,
      control: a.control,
      tier: a.tier,
      built: a.built,
      nextTierAt: a.nextTierAt,
      standing,
      yours: { ownerUnits: y.ownerUnits, currentEraOwnerUnits: y.currentEraOwnerUnits, earlierEraOwnerUnits: y.earlierEraOwnerUnits, patronUnits: y.patronUnits, actions: y.actions, tiersCompleted: y.tiersCompleted, lastSequence: y.lastSequence as number | null },
    })
  }
  return { rehearsal: REHEARSAL_MARK, resource: 'local-test-credit', recipe, credits, totals, properties, propertyCount: body.propertyCount }
}

/** A construction answer, exactly, or null. */
export function parseRehearsalConstructionResponse(body: unknown): RehearsalConstructionResponse | null {
  if (!isRecord(body) || !parseMark(body.rehearsal) || body.resource !== 'local-test-credit' || typeof body.fresh !== 'boolean' || !count(body.sequence) || !count(body.balance)) return null
  const view = body.view === null ? null : parseRehearsalConstructionView(body.view)
  const c = body.construction
  if (body.view !== null && !view) return null
  if (!isRecord(c) || typeof c.propertyId !== 'string' || !UUID.test(c.propertyId) || (view && c.propertyId !== view.property.propertyId) || typeof c.actionId !== 'string' || !UUID.test(c.actionId) || !isRole(c.role)) return null
  if (typeof c.recipe !== 'string' || !KEY.test(c.recipe)) return null
  if (!count(c.sequence) || c.sequence < 3 || c.sequence > body.sequence || !(c.era === null || (count(c.era) && c.era >= 1)) || !count(c.units) || c.units < 1) return null
  if (!count(c.builtBefore) || c.builtAfter !== c.builtBefore + c.units || !count(c.tierBefore, 64) || !count(c.tierAfter, 64) || c.tierAfter < c.tierBefore || !isInstant(c.constructedAt)) return null
  return {
    rehearsal: REHEARSAL_MARK,
    resource: 'local-test-credit',
    fresh: body.fresh,
    sequence: body.sequence,
    balance: body.balance,
    construction: { sequence: c.sequence, propertyId: c.propertyId, actionId: c.actionId, recipe: c.recipe, role: c.role, era: c.era, units: c.units, builtBefore: c.builtBefore, builtAfter: c.builtAfter, tierBefore: c.tierBefore, tierAfter: c.tierAfter, constructedAt: c.constructedAt },
    view,
  }
}

/** A catalog this build has, exactly as it has it, or null: the page never draws a choice it does not know. */
function parseDesignCatalog(v: unknown): DesignCatalog | null {
  if (!isRecord(v) || !exact(v, 'colors,default,entrances,facades,key,landscaping,lighting,roofs,windows') || typeof v.key !== 'string' || !Object.hasOwn(DESIGN_CATALOGS, v.key)) return null
  const known = DESIGN_CATALOGS[v.key]
  const d = v.default
  const same = (a: unknown, b: readonly string[]) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i])
  if (!same(v.facades, known.facades) || !same(v.roofs, known.roofs) || !same(v.windows, known.windows) || !same(v.lighting, known.lighting) || !same(v.entrances, known.entrances) || !same(v.landscaping, known.landscaping) || !same(v.colors, known.colors)) return null
  if (!isRecord(d) || !exact(d, 'color,entrance,facade,landscaping,lighting,roof,windows') || DESIGN_SLOTS.some((s) => d[s] !== known.default[s])) return null
  return known
}

const catalogAnswer = (c: DesignCatalog): RehearsalDesignCatalog => ({
  key: c.key,
  facades: [...c.facades],
  roofs: [...c.roofs],
  windows: [...c.windows],
  lighting: [...c.lighting],
  entrances: [...c.entrances],
  landscaping: [...c.landscaping],
  colors: [...c.colors],
  default: { ...c.default },
})
/** Exactly a choice of a catalog this build has: every slot it chooses, and null for the slots it does not have. */
const knownChoice = (r: Record<string, unknown>) =>
  typeof r.catalog === 'string' &&
  Object.hasOwn(DESIGN_CATALOGS, r.catalog) &&
  isCatalogChoice(DESIGN_CATALOGS[r.catalog], { facade: r.facade, roof: r.roof, windows: r.windows, lighting: r.lighting, entrance: r.entrance, landscaping: r.landscaping, color: r.color })
/** A record's choice, once `knownChoice` holds. */
const choiceIn = (r: Record<string, unknown>): DesignChoice => ({
  facade: r.facade as string,
  roof: r.roof as string,
  windows: r.windows as string | null,
  lighting: r.lighting as string | null,
  entrance: r.entrance as string | null,
  landscaping: r.landscaping as string | null,
  color: r.color as string | null,
})
const revision = (v: unknown): v is number => count(v, 1_000_000) && v >= 1

/** The city's saved designs, exactly, or null. One per property, and each a choice of a catalog this build has. */
export function parseRehearsalAppearanceResponse(body: unknown): RehearsalAppearanceResponse | null {
  if (!isRecord(body) || !parseMark(body.rehearsal) || !exact(body, 'catalog,designs,rehearsal') || !Array.isArray(body.designs) || body.designs.length > 100_000) return null
  const catalog = parseDesignCatalog(body.catalog)
  if (!catalog) return null
  const designs: RehearsalCityDesign[] = []
  const seen = new Set<string>()
  for (const d of body.designs) {
    if (!isRecord(d) || !exact(d, 'buildingId,catalog,color,entrance,facade,landscaping,lighting,propertyId,revision,roof,windows') || typeof d.propertyId !== 'string' || !UUID.test(d.propertyId) || d.buildingId !== `b-${d.propertyId}` || seen.has(d.propertyId)) return null
    if (!revision(d.revision) || !knownChoice(d)) return null
    seen.add(d.propertyId)
    designs.push({ propertyId: d.propertyId, buildingId: d.buildingId, revision: d.revision, catalog: d.catalog as string, ...choiceIn(d) })
  }
  return { rehearsal: REHEARSAL_MARK, catalog: catalogAnswer(catalog), designs }
}

/** A property's design view, exactly, or null. */
export function parseRehearsalDesignView(body: unknown): RehearsalDesignView | null {
  if (!isRecord(body) || !parseMark(body.rehearsal) || !exact(body, 'catalog,control,history,historyCount,open,property,rehearsal,saved')) return null
  const catalog = parseDesignCatalog(body.catalog)
  const p = body.property
  if (!catalog || !isRecord(p) || !exact(p, 'buildingId,propertyId') || typeof p.propertyId !== 'string' || !UUID.test(p.propertyId) || p.buildingId !== `b-${p.propertyId}`) return null
  if (!isControl(body.control) || typeof body.open !== 'boolean') return null
  let saved: RehearsalDesignView['saved'] = null
  if (body.saved !== null) {
    const s = body.saved
    if (!isRecord(s) || !exact(s, 'at,atCitySequence,catalog,color,entrance,facade,landscaping,lighting,revision,roof,windows') || !revision(s.revision) || !knownChoice(s) || !count(s.atCitySequence) || s.atCitySequence < 2 || !isInstant(s.at)) return null
    saved = { revision: s.revision, catalog: s.catalog as string, ...choiceIn(s), atCitySequence: s.atCitySequence, at: s.at }
  }
  if (!Array.isArray(body.history) || body.history.length > 100 || !count(body.historyCount) || body.historyCount < body.history.length) return null
  const history: RehearsalDesignView['history'] = []
  for (const h of body.history) {
    if (!isRecord(h) || !exact(h, 'at,by,catalog,color,entrance,facade,landscaping,lighting,revision,roof,windows') || !revision(h.revision) || !knownChoice(h) || (h.by !== 'viewer' && h.by !== 'other') || !isInstant(h.at)) return null
    history.push({ revision: h.revision, catalog: h.catalog as string, ...choiceIn(h), by: h.by, at: h.at })
  }
  // The newest revision is the saved one, and there is history exactly when there is a saved design.
  if ((saved === null) !== (body.historyCount === 0) || (saved && history[0]?.revision !== saved.revision) || (saved && body.historyCount !== saved.revision)) return null
  return { rehearsal: REHEARSAL_MARK, catalog: catalogAnswer(catalog), property: { propertyId: p.propertyId, buildingId: p.buildingId }, saved, control: body.control, open: body.open, history, historyCount: body.historyCount }
}

/** A design save's answer, exactly, or null. */
export function parseRehearsalDesignResponse(body: unknown): RehearsalDesignResponse | null {
  if (!isRecord(body) || !parseMark(body.rehearsal) || !exact(body, 'design,fresh,rehearsal,view') || typeof body.fresh !== 'boolean') return null
  const view = body.view === null ? null : parseRehearsalDesignView(body.view)
  if (body.view !== null && !view) return null
  const d = body.design
  if (!isRecord(d) || !exact(d, 'actionId,atCitySequence,buildingId,catalog,color,designedAt,entrance,facade,landscaping,lighting,propertyId,revision,roof,windows')) return null
  if (typeof d.propertyId !== 'string' || !UUID.test(d.propertyId) || d.buildingId !== `b-${d.propertyId}` || typeof d.actionId !== 'string' || !UUID.test(d.actionId)) return null
  if (!revision(d.revision) || !knownChoice(d) || !count(d.atCitySequence) || d.atCitySequence < 2 || !isInstant(d.designedAt)) return null
  if (view && view.property.propertyId !== d.propertyId) return null
  return {
    rehearsal: REHEARSAL_MARK,
    fresh: body.fresh,
    design: { propertyId: d.propertyId, buildingId: d.buildingId, revision: d.revision, actionId: d.actionId, catalog: d.catalog as string, ...choiceIn(d), atCitySequence: d.atCitySequence, designedAt: d.designedAt },
    view,
  }
}

/**
 * A property legacy, exactly, or null. Its sums must agree: the lifetime units are the current controller's, previous
 * controllers' and patrons' together, and exactly the eras' and the unattributed patron units together; the current
 * controller's are the current era's owner units; the player's own are within the property's; the newest revision is the
 * revision count.
 */
export function parseRehearsalPropertyLegacy(body: unknown): RehearsalPropertyLegacy | null {
  if (!isRecord(body) || !parseMark(body.rehearsal) || body.resource !== 'local-test-credit') return null
  if (!exact(body, 'contributors,control,designCount,designs,eraCount,eras,founding,investment,open,property,recipe,rehearsal,resource,unattributed,yours')) return null
  const recipe = parseRecipe(body.recipe)
  const { property: p, investment: i, yours: y, unattributed: u, contributors: who } = body
  if (!recipe || !isRecord(p) || !exact(p, 'activatedSequence,buildingId,built,foundingOrder,maxTier,nextTierAt,propertyId,tier')) return null
  if (typeof p.propertyId !== 'string' || !UUID.test(p.propertyId) || p.buildingId !== `b-${p.propertyId}` || !count(p.tier, 64) || !count(p.built) || !count(p.maxTier, 64) || p.tier > p.maxTier) return null
  if (!(p.nextTierAt === null || (count(p.nextTierAt) && p.nextTierAt > p.built)) || !count(p.activatedSequence) || p.activatedSequence < 2 || !count(p.foundingOrder) || p.foundingOrder < 1) return null
  if (body.founding !== 'viewer' && body.founding !== 'other' && body.founding !== 'unrecorded') return null
  if (typeof body.open !== 'boolean' || !isControl(body.control)) return null
  if (!isRecord(i) || !exact(i, 'community,currentController,previousControllers,total') || !count(i.currentController) || !count(i.previousControllers) || !count(i.community) || !count(i.total)) return null
  if (i.currentController + i.previousControllers + i.community !== i.total || i.total !== p.built) return null
  if (!isRecord(y) || !exact(y, 'actions,currentEraOwnerUnits,earlierEraOwnerUnits,ownerUnits,patronUnits') || ![y.ownerUnits, y.currentEraOwnerUnits, y.earlierEraOwnerUnits, y.patronUnits, y.actions].every((v) => count(v))) return null
  const yours = { ownerUnits: y.ownerUnits as number, currentEraOwnerUnits: y.currentEraOwnerUnits as number, earlierEraOwnerUnits: y.earlierEraOwnerUnits as number, patronUnits: y.patronUnits as number, actions: y.actions as number }
  if (yours.currentEraOwnerUnits + yours.earlierEraOwnerUnits !== yours.ownerUnits || yours.currentEraOwnerUnits > i.currentController || yours.ownerUnits > i.currentController + i.previousControllers || yours.patronUnits > i.community) return null
  if ((yours.actions === 0) !== (yours.ownerUnits + yours.patronUnits === 0)) return null
  if (!isRecord(u) || !exact(u, 'actions,patronUnits') || !count(u.patronUnits) || !count(u.actions) || (u.actions === 0) !== (u.patronUnits === 0)) return null
  if (!isRecord(who) || !exact(who, 'owners,patrons') || !count(who.owners) || !count(who.patrons)) return null
  if (!Array.isArray(body.eras) || body.eras.length > 100 || !count(body.eraCount) || body.eraCount < body.eras.length) return null
  const eras: RehearsalLegacyEra[] = []
  for (const e of body.eras) {
    if (!isRecord(e) || !exact(e, 'actions,current,era,firstSequence,lastSequence,ownerUnits,patronUnits,tierAfter,tierBefore,yours')) return null
    if (!count(e.era) || e.era < 1 || typeof e.current !== 'boolean' || typeof e.yours !== 'boolean' || !count(e.ownerUnits) || !count(e.patronUnits) || !count(e.actions) || e.actions < 1) return null
    if (!count(e.tierBefore, 64) || !count(e.tierAfter, 64) || e.tierAfter < e.tierBefore || !count(e.firstSequence) || e.firstSequence < 3 || !count(e.lastSequence) || e.lastSequence < e.firstSequence) return null
    // Newest first, one each.
    if (eras.length > 0 && e.era >= eras[eras.length - 1].era) return null
    eras.push({ era: e.era, current: e.current, yours: e.yours, ownerUnits: e.ownerUnits, patronUnits: e.patronUnits, actions: e.actions, tierBefore: e.tierBefore, tierAfter: e.tierAfter, firstSequence: e.firstSequence, lastSequence: e.lastSequence })
  }
  // At most one current era, and only the newest; the current controller's units are exactly its owner units.
  const current = eras.filter((e) => e.current)
  if (current.length > 1 || (current.length === 1 && eras[0] !== current[0]) || i.currentController !== (current[0]?.ownerUnits ?? 0)) return null
  // With every era listed, the eras and the unattributed patron units are exactly the lifetime units.
  if (body.eraCount === eras.length) {
    const owner = eras.reduce((n, e) => n + e.ownerUnits, 0)
    const patron = eras.reduce((n, e) => n + e.patronUnits, 0) + u.patronUnits
    if (owner !== i.currentController + i.previousControllers || patron !== i.community) return null
  }
  if (!Array.isArray(body.designs) || body.designs.length > 100 || !count(body.designCount) || body.designCount < body.designs.length) return null
  const designs: RehearsalLegacyRevision[] = []
  for (const h of body.designs) {
    if (!isRecord(h) || !exact(h, 'at,atCitySequence,by,catalog,color,entrance,facade,landscaping,lighting,revision,roof,savedBy,windows') || !revision(h.revision) || !knownChoice(h)) return null
    if ((h.by !== 'viewer' && h.by !== 'other') || (h.savedBy !== 'current-controller' && h.savedBy !== 'earlier-controller') || !count(h.atCitySequence) || h.atCitySequence < 2 || !isInstant(h.at)) return null
    // Newest first, consecutive: revision N, N-1, ...
    if (designs.length === 0 ? h.revision !== body.designCount : h.revision !== designs[designs.length - 1].revision - 1) return null
    designs.push({ revision: h.revision, catalog: h.catalog as string, ...choiceIn(h), by: h.by, savedBy: h.savedBy, atCitySequence: h.atCitySequence, at: h.at })
  }
  if ((body.designCount === 0) !== (designs.length === 0)) return null
  return {
    rehearsal: REHEARSAL_MARK,
    resource: 'local-test-credit',
    recipe,
    property: { propertyId: p.propertyId, buildingId: p.buildingId, tier: p.tier, built: p.built, nextTierAt: p.nextTierAt, maxTier: p.maxTier, activatedSequence: p.activatedSequence, foundingOrder: p.foundingOrder },
    founding: body.founding,
    open: body.open,
    control: body.control,
    investment: { currentController: i.currentController, previousControllers: i.previousControllers, community: i.community, total: i.total },
    yours,
    eras,
    eraCount: body.eraCount,
    unattributed: { patronUnits: u.patronUnits, actions: u.actions },
    contributors: { owners: who.owners, patrons: who.patrons },
    designs,
    designCount: body.designCount,
  }
}
