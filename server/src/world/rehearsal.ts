import type { AppMode } from '../config'
import { errorFields, silentLogger, type Logger } from '../log'
import {
  assetKey,
  CURRENT_DESIGN_CATALOG,
  parseAssetKey,
  REHEARSAL_MARK,
  type DistrictRuleMatch,
  type NftAsset,
  type RehearsalActivationResponse,
  type RehearsalAppearanceResponse,
  type RehearsalConstructionResponse,
  type RehearsalConstructionView,
  type RehearsalArchitectView,
  type RehearsalAssetsResponse,
  type RehearsalDesignCatalog,
  type RehearsalDesignResponse,
  type RehearsalDesignView,
  type RehearsalErrorCode,
  type RehearsalPropertyLegacy,
  type RehearsalTicket,
  type RehearsalTicketResponse,
  type RuleAnswer,
  type DesignCatalog,
} from '../engine'
import { PlaySessionError, type ExpectedActor, type LivePlaySession, type PlaySessionService } from '../play/session'
import {
  createConstructionService,
  WorldConstructionRefusal,
  type ArchitectOverview,
  type ConstructionAuthority,
  type ConstructionOverview,
  type WorldConstructionRefusalCode,
  type WorldConstructionStore,
} from './construction'
import type { PropertyLegacy } from './legacy'
import { createDesignService, WorldDesignRefusal, type DesignOverview, type WorldDesignRefusalCode, type WorldDesignStore } from './designs'
import { createPropertyActivationService, WorldPropertyRefusal, type WorldPropertyRefusalCode, type WorldPropertyStore } from './properties'
import type { TicketEligibility } from './rotation'
import { DistrictTicketRefusal, type DistrictTicket, type DistrictTicketRefusalCode, type DistrictTicketStore } from './tickets'

/**
 * THE LOCAL PROPERTY REHEARSAL (P1-C2-B2B, district tickets P1-C2-D1): the whole player flow of
 * placing a Tier 0 property, end to end, against the real session, world, ticket and property stores,
 * in a LOCAL deployment. NOT a production authorization, and not a path to one:
 *
 *   - It exists only when the server runs with APP_MODE=local AND LOCAL_PROPERTY_REHEARSAL_FILE
 *     (config refuses the file in any other mode; the app mounts no route without it; this module
 *     refuses to be built for any other mode). The ticket and property stores refuse any mode or
 *     database but local, and the database refuses a ticket or a world property anywhere but a local
 *     database (0007, 0010).
 *   - WHICH NFTs a player may place, each NFT's traits, and the explicit district rules are the file:
 *     a SERVER-TRUSTED LOCAL FIXTURE keyed by the Discord user id Proofy Play redeemed for the session.
 *     It is TEST DATA standing in for Proofy Core eligibility, which no contract provides: it is never
 *     reported as verified, and nothing the browser asserts about an NFT, a trait or a district is
 *     believed. The browser only names one of the NFTs listed for it, and that is checked again here.
 *   - THE DISTRICT IS ASSIGNED, never chosen (MCD 46B, locked): entering the claim flow
 *     (`POST …/entry`, which the page sends on a Play launch, or when the player asks to claim) issues
 *     the player a district ticket from the city's rotation, or returns the one they hold; selecting an
 *     NFT an explicit fixture rule assigns swaps it for that rule's ticket (`…/assignment`); leaving
 *     releases it (`…/release`); an activation must name it, and consumes it. A reload only reads it
 *     (`GET …/ticket`): it never issues one.
 *   - RESTRICTED districts (a Proofy rule) are never a default district (D1). One is reached only by an
 *     explicit fixture rule for the NFT AND a positive fixture RULE RESULT (file version 3) for the
 *     session's player: the local stand-in for Proofy Core's `access/check`. A missing, `null` or
 *     conflicting result, or `false`, refuses. In a city whose every district is restricted, entry
 *     answers `awaiting: "asset"` and the player's selection of an NFT (`…/assignment` with
 *     `ticketId: null`) issues its rule ticket. None of this is a verified Core answer.
 *   - Who acts is `requireActor` for every change: the cookie's live session must be exactly the one
 *     the page drew (session, world, player), and Play must answer `active` now (no cache, no grace).
 *   - The page names the geometry it drew; under the city's lock it must be the governing one, and a
 *     world's first property also needs Play to name the governing version as active (`properties.ts`).
 *
 *   - CONSTRUCTION (P1-C2-E3A, file version 4): a player builds one fixed step of the local TEST recipe into
 *     a property (`construction.ts`), paid in valueless TEST credits. Who controls an NFT NOW (an owner's
 *     authority) and which test credits a player is granted are the file's `controllers` and `testCredits`,
 *     each scoped to one Discord server (the world's): TEST DATA, never verified ownership, never a
 *     currency. Founding an NFT's property does not make anyone its owner here. No route grants credits:
 *     a grant is recorded once, inside the first construction of that player that needs it. A city whose
 *     Discord server the file names in neither list has no construction at all, read or write.
 *
 *   - ARCHITECT DESIGN (P1-C2-E4A, P1-C2-E4B, P1-C2-E4C): the NFT's current controller, as the same `controllers` name
 *     them, saves a facade, roof, window, lighting, entrance and landscaping treatment from the engine's design catalog for the property (`designs.ts`). Free, identifiers
 *     only. Founding, patronage and earlier control authorize nothing; a design stays with the property when
 *     the file names another controller. Every city's saved designs are read (`appearance`) wherever they
 *     exist; only a city whose Discord server the file names saves one.
 *
 * Still open, and not replaced here: F5 (browser-bound launch), F7 (fresh membership and entitlement),
 * F3 (Play game status), Core NFT/role/trait eligibility and verified rule results, and a separate
 * non-owner database role. Conflicting explicit rules are refused (D3), never ordered.
 */

/**
 * The rehearsal file's `kind`: v1 lists NFTs only; v2 also gives NFTs traits and declares explicit district rules; v3 also
 * gives Proofy rule results for players (restricted districts, D1); v4 also names current NFT controllers and test credit
 * grants for construction (P1-C2-E3A).
 */
export const REHEARSAL_FILE_KIND = 'rare-city/local-property-rehearsal-v1'
export const REHEARSAL_FILE_KIND_V2 = 'rare-city/local-property-rehearsal-v2'
export const REHEARSAL_FILE_KIND_V3 = 'rare-city/local-property-rehearsal-v3'
export const REHEARSAL_FILE_KIND_V4 = 'rare-city/local-property-rehearsal-v4'
const MAX_CONTROLLERS = 1_000
const MAX_TEST_CREDITS = 1_000
/** At most this many grants per player and Discord server, and units per grant (migration 0013 holds the same bounds). */
const MAX_GRANTS_PER_PLAYER = 20
const MAX_GRANT_UNITS = 1_000
const MAX_RULE_RESULTS = 1_000
const MAX_PLAYERS = 200
const MAX_ASSETS_PER_PLAYER = 200
const MAX_RULES = 100
const MAX_TRAITS = 16
const DISCORD_ID = /^[0-9]{15,25}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PLOT_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-w(?:0|[1-9][0-9]{0,5})-p(?:0|[1-9][0-9]{0,5})$/
const HASH = /^[0-9a-f]{64}$/
const KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const RULE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const ACTOR_KEYS = ['discordUserId', 'sessionRef', 'worldId']
const ACTIVATION_KEYS = ['asset', 'discordUserId', 'geometryFingerprint', 'plotId', 'sessionRef', 'ticketId', 'worldId']
const ASSIGNMENT_KEYS = ['asset', 'discordUserId', 'sessionRef', 'ticketId', 'worldId']
const RELEASE_KEYS = ['discordUserId', 'sessionRef', 'ticketId', 'worldId']
const CONSTRUCTION_KEYS = ['actionId', 'discordUserId', 'propertyId', 'role', 'sessionRef', 'worldId']
/**
 * A design save names a facade and a roof; (catalog v2, P1-C2-E4B) a window and a lighting treatment; and (catalog v3,
 * P1-C2-E4C) an entrance and a landscaping treatment. Exactly one of these shapes; the store judges which its catalog has.
 */
const DESIGN_KEYS = ['actionId', 'baseRevision', 'catalog', 'discordUserId', 'facade', 'propertyId', 'roof', 'sessionRef', 'worldId']
const DESIGN_DETAIL_KEYS = ['actionId', 'baseRevision', 'catalog', 'discordUserId', 'facade', 'lighting', 'propertyId', 'roof', 'sessionRef', 'windows', 'worldId']
const DESIGN_STREET_KEYS = ['actionId', 'baseRevision', 'catalog', 'discordUserId', 'entrance', 'facade', 'landscaping', 'lighting', 'propertyId', 'roof', 'sessionRef', 'windows', 'worldId']
/** A catalog or choice identifier a design request may name (the store judges it against the catalog). */
const CHOICE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** Which test NFTs each player may place, by Discord user id. */
export type RehearsalGrants = ReadonlyMap<string, readonly NftAsset[]>

/** An explicit district rule of the local fixture: NFTs of one collection (and, if given, with every listed trait) belong in `district`. */
export interface RehearsalDistrictRule {
  id: string
  chain: string
  contract: string
  traits: Readonly<Record<string, string>> | null
  district: string
}

/**
 * A Proofy rule result of the local fixture: what Proofy Core's `access/check` (`checkType: "rule"`) would answer for one
 * player and one verification rule, `qualifies` true, false or null. `guild` limits it to one Discord server; without
 * it, it holds in every server (local test data: a Core rule id names one rule of one server). TEST DATA, never verified.
 */
export interface RehearsalRuleResult {
  guild: string | null
  discordUserId: string
  verificationRuleId: number
  qualifies: RuleAnswer
}

/**
 * Who the local fixture says controls an NFT NOW in one Discord server's city (file v4): the only thing that lets a player
 * build on a property as its owner. TEST DATA, never verified ownership; changing it (and restarting) simulates a transfer.
 */
export interface RehearsalController {
  guild: string
  asset: string
  discordUserId: string
}

/** Valueless TEST credits the local fixture grants one player in one Discord server's city, once, by `id` (file v4). */
export interface RehearsalTestCredit {
  id: string
  guild: string
  discordUserId: string
  units: number
}

/** The whole local fixture: grants, each NFT's traits, explicit district rules, Proofy rule results, controllers and test credits. */
export interface RehearsalFixture {
  grants: RehearsalGrants
  traits: ReadonlyMap<string, Readonly<Record<string, string>>>
  rules: readonly RehearsalDistrictRule[]
  results: readonly RehearsalRuleResult[]
  controllers: readonly RehearsalController[]
  testCredits: readonly RehearsalTestCredit[]
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function parseTraits(where: string, v: unknown): Record<string, string> {
  if (!isRecord(v) || Object.keys(v).length === 0 || Object.keys(v).length > MAX_TRAITS) throw new Error(`${where}: traits are an object of 1 to ${MAX_TRAITS} entries`)
  const traits: Record<string, string> = {}
  for (const [k, value] of Object.entries(v)) {
    if (k.length === 0 || k.length > 64 || typeof value !== 'string' || value.length === 0 || value.length > 64) throw new Error(`${where}: trait ${JSON.stringify(k)} must be a short non-empty string`)
    traits[k] = value
  }
  return traits
}

/**
 * The rehearsal file, strictly. v1: `{ "kind": "…-v1", "players": { "<discord user id>": ["<CAIP-19 asset id>", …] } }`.
 * v2 adds, per NFT, `{ "asset": "<id>", "traits": { "<name>": "<value>" } }` in place of an id, and `"districtRules": [{
 * "id", "collection": { "chain", "contract" }, "traits"?, "district" }]`. Every asset id in its one canonical spelling, an
 * NFT's traits the same wherever it is listed. Throws with the reason otherwise.
 */
export function parseRehearsalFile(raw: unknown): RehearsalFixture {
  const v4 = isRecord(raw) && raw.kind === REHEARSAL_FILE_KIND_V4
  const v3 = v4 || (isRecord(raw) && raw.kind === REHEARSAL_FILE_KIND_V3)
  const v2 = v3 || (isRecord(raw) && raw.kind === REHEARSAL_FILE_KIND_V2)
  const keys = v4 ? 'controllers,districtRules,kind,players,ruleResults,testCredits' : v3 ? 'districtRules,kind,players,ruleResults' : v2 ? 'districtRules,kind,players' : 'kind,players'
  if (!isRecord(raw) || Object.keys(raw).sort().join() !== keys || (raw.kind !== REHEARSAL_FILE_KIND && !v2) || !isRecord(raw.players))
    throw new Error(
      `a local rehearsal file is exactly { "kind": "${REHEARSAL_FILE_KIND}", "players": { … } }, { "kind": "${REHEARSAL_FILE_KIND_V2}", "players": { … }, "districtRules": [ … ] }, { "kind": "${REHEARSAL_FILE_KIND_V3}", "players", "districtRules", "ruleResults": [ … ] }, or { "kind": "${REHEARSAL_FILE_KIND_V4}", "players", "districtRules", "ruleResults", "controllers": [ … ], "testCredits": [ … ] }`,
    )
  const entries = Object.entries(raw.players)
  if (entries.length > MAX_PLAYERS) throw new Error(`a local rehearsal file lists at most ${MAX_PLAYERS} players`)
  const grants = new Map<string, readonly NftAsset[]>()
  const traits = new Map<string, Readonly<Record<string, string>>>()
  for (const [player, list] of entries) {
    if (!DISCORD_ID.test(player)) throw new Error(`"${player}" is not a Discord user id`)
    if (!Array.isArray(list) || list.length > MAX_ASSETS_PER_PLAYER) throw new Error(`player ${player} must list at most ${MAX_ASSETS_PER_PLAYER} assets`)
    const assets: NftAsset[] = []
    for (const item of list) {
      const listed = v2 && isRecord(item) ? item : null
      if (listed && Object.keys(listed).sort().join() !== 'asset,traits') throw new Error(`player ${player} lists an NFT that is not exactly { "asset", "traits" }`)
      const key = listed ? listed.asset : item
      const asset = parseAssetKey(key)
      if (!asset) throw new Error(`player ${player} lists ${JSON.stringify(key)}, which is not a canonical ERC-721 CAIP-19 asset id`)
      if (assets.some((a) => assetKey(a) === key)) throw new Error(`player ${player} lists ${key} twice`)
      const own = listed ? parseTraits(`player ${player} ${key}`, listed.traits) : null
      const known = traits.get(key as string)
      if (own && known && JSON.stringify(Object.entries(own).sort()) !== JSON.stringify(Object.entries(known).sort())) throw new Error(`${key} is listed with different traits`)
      if (own) traits.set(key as string, Object.freeze(own))
      assets.push(asset)
    }
    grants.set(player, Object.freeze(assets))
  }
  const rules: RehearsalDistrictRule[] = []
  if (v2) {
    if (!Array.isArray(raw.districtRules) || raw.districtRules.length > MAX_RULES) throw new Error(`districtRules is a list of at most ${MAX_RULES} rules`)
    for (const r of raw.districtRules) {
      if (!isRecord(r) || !['collection,district,id', 'collection,district,id,traits'].includes(Object.keys(r).sort().join())) throw new Error('a district rule is exactly { "id", "collection", "district" } and optionally "traits"')
      if (typeof r.id !== 'string' || !RULE_ID.test(r.id) || rules.some((x) => x.id === r.id)) throw new Error(`district rule id ${JSON.stringify(r.id)} is not a unique short lowercase id`)
      if (typeof r.district !== 'string' || !KEY.test(r.district) || r.district.length > 32) throw new Error(`district rule ${r.id} names no district key`)
      const c = r.collection
      const probe = isRecord(c) && Object.keys(c).sort().join() === 'chain,contract' ? parseAssetKey(`${String(c.chain)}/erc721:${String(c.contract)}/0`) : null
      if (!probe) throw new Error(`district rule ${r.id} names no canonical collection { "chain", "contract" }`)
      rules.push({ id: r.id, chain: probe.chain, contract: probe.contract, traits: r.traits === undefined ? null : Object.freeze(parseTraits(`district rule ${r.id}`, r.traits)), district: r.district })
    }
  }
  const results: RehearsalRuleResult[] = []
  if (v3) {
    if (!Array.isArray(raw.ruleResults) || raw.ruleResults.length > MAX_RULE_RESULTS) throw new Error(`ruleResults is a list of at most ${MAX_RULE_RESULTS} results`)
    for (const r of raw.ruleResults) {
      if (!isRecord(r) || !['discordUserId,qualifies,verificationRuleId', 'discordUserId,guild,qualifies,verificationRuleId'].includes(Object.keys(r).sort().join()))
        throw new Error('a rule result is exactly { "discordUserId", "verificationRuleId", "qualifies" } and optionally "guild"')
      if (typeof r.discordUserId !== 'string' || !DISCORD_ID.test(r.discordUserId)) throw new Error(`rule result for ${JSON.stringify(r.discordUserId)}: not a Discord user id`)
      if (r.guild !== undefined && (typeof r.guild !== 'string' || !DISCORD_ID.test(r.guild))) throw new Error(`rule result guild ${JSON.stringify(r.guild)} is not a Discord server id`)
      if (typeof r.verificationRuleId !== 'number' || !Number.isSafeInteger(r.verificationRuleId) || r.verificationRuleId < 1) throw new Error(`rule result ${JSON.stringify(r.verificationRuleId)} is not a Proofy verification rule id`)
      if (r.qualifies !== true && r.qualifies !== false && r.qualifies !== null) throw new Error('a rule result qualifies true, false or null (unknown)')
      const result: RehearsalRuleResult = { guild: (r.guild as string | undefined) ?? null, discordUserId: r.discordUserId, verificationRuleId: r.verificationRuleId, qualifies: r.qualifies }
      if (results.some((x) => x.guild === result.guild && x.discordUserId === result.discordUserId && x.verificationRuleId === result.verificationRuleId))
        throw new Error(`rule ${result.verificationRuleId} has two results for player ${result.discordUserId}${result.guild ? ` in ${result.guild}` : ''}`)
      results.push(Object.freeze(result))
    }
  }
  const controllers: RehearsalController[] = []
  const testCredits: RehearsalTestCredit[] = []
  if (v4) {
    if (!Array.isArray(raw.controllers) || raw.controllers.length > MAX_CONTROLLERS) throw new Error(`controllers is a list of at most ${MAX_CONTROLLERS} entries`)
    for (const c of raw.controllers) {
      if (!isRecord(c) || Object.keys(c).sort().join() !== 'asset,discordUserId,guild') throw new Error('a controller is exactly { "guild", "asset", "discordUserId" }')
      if (typeof c.guild !== 'string' || !DISCORD_ID.test(c.guild)) throw new Error(`controller guild ${JSON.stringify(c.guild)} is not a Discord server id`)
      if (!parseAssetKey(c.asset)) throw new Error(`controller asset ${JSON.stringify(c.asset)} is not a canonical ERC-721 CAIP-19 asset id`)
      if (typeof c.discordUserId !== 'string' || !DISCORD_ID.test(c.discordUserId)) throw new Error(`controller of ${String(c.asset)}: ${JSON.stringify(c.discordUserId)} is not a Discord user id`)
      // One controller per NFT and server: two would be ambiguous evidence, which authorizes nobody.
      if (controllers.some((x) => x.guild === c.guild && x.asset === c.asset)) throw new Error(`${String(c.asset)} has two controllers in ${c.guild}`)
      controllers.push(Object.freeze({ guild: c.guild, asset: c.asset as string, discordUserId: c.discordUserId }))
    }
    if (!Array.isArray(raw.testCredits) || raw.testCredits.length > MAX_TEST_CREDITS) throw new Error(`testCredits is a list of at most ${MAX_TEST_CREDITS} grants`)
    for (const g of raw.testCredits) {
      if (!isRecord(g) || Object.keys(g).sort().join() !== 'discordUserId,guild,id,units') throw new Error('a test credit grant is exactly { "id", "guild", "discordUserId", "units" }')
      if (typeof g.id !== 'string' || !RULE_ID.test(g.id)) throw new Error(`test credit grant id ${JSON.stringify(g.id)} is not a short lowercase id`)
      if (typeof g.guild !== 'string' || !DISCORD_ID.test(g.guild)) throw new Error(`test credit grant ${g.id}: ${JSON.stringify(g.guild)} is not a Discord server id`)
      if (typeof g.discordUserId !== 'string' || !DISCORD_ID.test(g.discordUserId)) throw new Error(`test credit grant ${g.id}: ${JSON.stringify(g.discordUserId)} is not a Discord user id`)
      if (typeof g.units !== 'number' || !Number.isSafeInteger(g.units) || g.units < 1 || g.units > MAX_GRANT_UNITS) throw new Error(`test credit grant ${g.id}: units are a whole number from 1 to ${MAX_GRANT_UNITS}`)
      const mine = testCredits.filter((x) => x.guild === g.guild && x.discordUserId === g.discordUserId)
      if (mine.some((x) => x.id === g.id)) throw new Error(`test credit grant ${g.id} is listed twice for ${g.discordUserId} in ${g.guild}`)
      if (mine.length >= MAX_GRANTS_PER_PLAYER) throw new Error(`a player has at most ${MAX_GRANTS_PER_PLAYER} test credit grants in one Discord server`)
      testCredits.push(Object.freeze({ id: g.id, guild: g.guild, discordUserId: g.discordUserId, units: g.units }))
    }
  }
  return { grants, traits, rules: Object.freeze(rules), results: Object.freeze(results), controllers: Object.freeze(controllers), testCredits: Object.freeze(testCredits) }
}

/** The grants of a rehearsal file (either version). */
export const parseRehearsalGrants = (raw: unknown): RehearsalGrants => parseRehearsalFile(raw).grants

/** The fixture's explicit rules that match an NFT: its collection, and every trait the rule lists. */
export function matchingRules(fixture: Pick<RehearsalFixture, 'traits' | 'rules'>, asset: NftAsset): DistrictRuleMatch[] {
  const own = fixture.traits.get(assetKey(asset)) ?? {}
  return fixture.rules
    .filter((r) => r.chain === asset.chain && r.contract === asset.contract && Object.entries(r.traits ?? {}).every(([k, v]) => own[k] === v))
    .map((r) => ({ id: r.id, district: r.district }))
}

/**
 * The fixture's answer to a Proofy rule for a player of a Discord server: the results for that player and rule, in that
 * server or in any. None, or results that disagree (ambiguous evidence), answer `null`: unknown, which never qualifies.
 */
export function ruleAnswerOf(fixture: Pick<RehearsalFixture, 'results'>, where: { guildId: string; discordUserId: string }, verificationRuleId: number): RuleAnswer {
  const found = fixture.results.filter((r) => r.discordUserId === where.discordUserId && r.verificationRuleId === verificationRuleId && (r.guild === null || r.guild === where.guildId))
  if (found.length === 0) return null
  return found.every((r) => r.qualifies === found[0].qualifies) ? found[0].qualifies : null
}

/** The ticket store's eligibility, from the local fixture: TEST DATA standing in for Proofy Core. */
export function rehearsalEligibility(given: RehearsalFixture | RehearsalGrants): TicketEligibility {
  const fixture = fixtureOf(given)
  return {
    source: 'local-fixture',
    assets: (player) => fixture.grants.get(player.discordUserId) ?? [],
    matches: (asset) => matchingRules(fixture, asset),
    ruleAnswer: (where, rule) => ruleAnswerOf(fixture, where, rule),
  }
}

/** The construction store's trusted source, from the local fixture: TEST DATA standing in for verified NFT control, and valueless test credits. */
export function rehearsalConstructionAuthority(given: RehearsalFixture | RehearsalGrants): ConstructionAuthority {
  const fixture = fixtureOf(given)
  return {
    source: 'local-fixture',
    opensIn: (where) => fixture.controllers.some((c) => c.guild === where.guildId) || fixture.testCredits.some((g) => g.guild === where.guildId),
    controllerOf: (where, asset) => fixture.controllers.find((c) => c.guild === where.guildId && c.asset === assetKey(asset))?.discordUserId ?? null,
    grantsFor: (where) => fixture.testCredits.filter((g) => g.guild === where.guildId && g.discordUserId === where.discordUserId).map((g) => ({ key: g.id, units: g.units })),
  }
}

/** A fixture, or a bare grants map as v1 gave it (no traits, rules, results, controllers or test credits). */
const fixtureOf = (given: RehearsalFixture | RehearsalGrants): RehearsalFixture =>
  given instanceof Map ? { grants: given, traits: new Map(), rules: [], results: [], controllers: [], testCredits: [] } : (given as RehearsalFixture)

/** A refusal of the rehearsal routes, as the status and `{ "error": code }` it is answered with. */
export class RehearsalRefusal extends Error {
  readonly status: number
  readonly code: RehearsalErrorCode | 'invalid_request'
  constructor(status: number, code: RehearsalErrorCode | 'invalid_request', message: string = code) {
    super(message)
    this.name = 'RehearsalRefusal'
    this.status = status
    this.code = code
  }
}

type Answered = Exclude<WorldPropertyRefusalCode | DistrictTicketRefusalCode | WorldConstructionRefusalCode | WorldDesignRefusalCode, 'session_ended' | 'world_unavailable' | 'config_superseded' | 'active_config_unverified'>

/** How each store refusal is answered. The session layer's own answers are the rest (see `answer`). */
const REFUSALS: Record<Answered, [number, RehearsalErrorCode]> = {
  'invalid-asset': [400, 'invalid_asset'],
  'asset-not-in-world': [422, 'asset_not_in_world'],
  'asset-already-placed': [409, 'asset_already_placed'],
  'unknown-plot': [422, 'unknown_plot'],
  'plot-unavailable': [409, 'plot_unavailable'],
  'district-rule-unverified': [403, 'district_rule_unverified'],
  district_rule_unverified: [403, 'district_rule_unverified'],
  district_rule_unqualified: [403, 'district_rule_unqualified'],
  mutations_held: [403, 'mutations_held'],
  sequence_conflict: [409, 'sequence_conflict'],
  not_eligible: [403, 'not_eligible'],
  no_default_district: [409, 'no_default_district'],
  ticket_not_live: [409, 'ticket_not_live'],
  ticket_expired: [409, 'ticket_expired'],
  ticket_superseded: [409, 'ticket_superseded'],
  plot_outside_assignment: [422, 'plot_outside_assignment'],
  district_rule_applies: [409, 'district_rule_applies'],
  district_rule_ambiguous: [409, 'district_rule_ambiguous'],
  district_rule_ref_too_long: [409, 'district_rule_ref_too_long'],
  ticket_asset_mismatch: [409, 'ticket_asset_mismatch'],
  unknown_property: [422, 'unknown_property'],
  construction_not_open: [403, 'construction_not_open'],
  construction_complete: [409, 'construction_complete'],
  not_current_controller: [403, 'not_current_controller'],
  control_unverified: [403, 'control_unverified'],
  controller_builds_as_owner: [409, 'controller_builds_as_owner'],
  insufficient_test_credits: [409, 'insufficient_test_credits'],
  action_conflict: [409, 'action_conflict'],
  design_not_open: [403, 'design_not_open'],
  design_unsupported: [422, 'design_unsupported'],
  design_retired: [409, 'design_retired'],
  design_stale: [409, 'design_stale'],
  design_unchanged: [409, 'design_unchanged'],
}

/** A store's refusal, as the routes answer it: the session layer's own error for a session or world problem, else a rehearsal refusal. */
function answer(err: WorldPropertyRefusal | DistrictTicketRefusal | WorldConstructionRefusal | WorldDesignRefusal): never {
  if (err.code === 'session_ended') throw new PlaySessionError(401, 'play_session_required', err.message)
  if (err.code === 'world_unavailable') throw new PlaySessionError(503, 'world_unavailable', err.message)
  // The page's city, or Play's active configuration, is not the one that governs: the page reads the city again.
  if (err.code === 'config_superseded') throw new PlaySessionError(409, 'config_superseded', err.message)
  if (err.code === 'active_config_unverified') throw new PlaySessionError(503, 'installation_unverified', err.message)
  const [status, code] = REFUSALS[err.code]
  throw new RehearsalRefusal(status, code, err.message)
}

/** A ticket as its holder is told it: no session, no player, no other ticket. */
export function rehearsalTicket(t: DistrictTicket): RehearsalTicket {
  return {
    id: t.id,
    kind: t.kind,
    districtKey: t.districtKey,
    slot: t.kind === 'fallback' && t.ordinal !== null && t.generation !== null ? { ordinal: t.ordinal, generation: t.generation, epoch: t.epoch } : null,
    rule: t.kind === 'rule' && t.ruleRef !== null && t.asset !== null ? { ref: t.ruleRef, asset: t.asset } : null,
    // A restricted district's rule, and that the answer was local test data: never presented as verified.
    authorization: t.authorization && t.authorization.source === 'local-fixture' ? { verificationRuleId: t.authorization.verificationRuleId, source: 'local-fixture' } : null,
    configVersion: t.configVersion,
    layoutGeometryFingerprint: t.layoutGeometryFingerprint,
    issuedAt: t.issuedAt,
    expiresAt: t.expiresAt,
  }
}

export interface LocalPropertyRehearsal {
  /** The test NFTs the cookie's player may place. Throws PlaySessionError (401 without a live session). */
  assets(presented: string | null): Promise<RehearsalAssetsResponse>
  /** The player's live district ticket in the session's city, or none. Read only. */
  ticket(presented: string | null): Promise<RehearsalTicketResponse>
  /** Enter the claim flow: the player's live ticket, or a new one if the file lists an unplaced NFT of this city for them. */
  enter(presented: string | null, body: Record<string, unknown>): Promise<RehearsalTicketResponse>
  /** The NFT the player selected: an explicit fixture rule for it swaps the ticket for that rule's. */
  assign(presented: string | null, body: Record<string, unknown>): Promise<RehearsalTicketResponse>
  /** Leave the claim flow: the ticket is released and its slot reused by the next entrant. */
  release(presented: string | null, body: Record<string, unknown>): Promise<RehearsalTicketResponse>
  /** Place one, for exactly the actor the page names, with its live ticket. Throws RehearsalRefusal or PlaySessionError. */
  activate(presented: string | null, body: Record<string, unknown>): Promise<RehearsalActivationResponse>
  /** A property's construction as the cookie's player may see it. Read only. */
  construction(presented: string | null, propertyId: string | null): Promise<RehearsalConstructionView>
  /** Build one step of the local test recipe, for exactly the actor the page names, in the role it names. */
  construct(presented: string | null, body: Record<string, unknown>): Promise<RehearsalConstructionResponse>
  /** The cookie's player's own construction record in its city (Architect activity). Read only. */
  architect(presented: string | null): Promise<RehearsalArchitectView>
  /** A property's legacy (founding, control eras, investment, the player's part, design revisions) as the cookie's player may see it (P1-C2-E5A). Read only. */
  legacy(presented: string | null, propertyId: string | null): Promise<RehearsalPropertyLegacy>
  /** The saved design of every property of the cookie's city that has one. Read only. */
  appearance(presented: string | null): Promise<RehearsalAppearanceResponse>
  /** A property's design as the cookie's player may see it. Read only. */
  design(presented: string | null, propertyId: string | null): Promise<RehearsalDesignView>
  /** Save one design (catalog facade and roof) for a property, for exactly the actor the page names, as the NFT's current controller. */
  saveDesign(presented: string | null, body: Record<string, unknown>): Promise<RehearsalDesignResponse>
}

export interface LocalPropertyRehearsalOptions {
  mode: AppMode
  /** The parsed rehearsal file. (A bare grants map, as v1 gave, is a fixture without traits, rules or results.) The ticket store must be built on the same one (`rehearsalEligibility`). */
  fixture: RehearsalFixture | RehearsalGrants
  sessions: Pick<PlaySessionService, 'session' | 'requireActor' | 'activeConfig'>
  store: WorldPropertyStore
  tickets: DistrictTicketStore
  /** Construction (file v4). Without it, construction is held (`mutations_held`). */
  construction?: WorldConstructionStore | null
  /** Architect property design (P1-C2-E4A). Without it, designs are held (`mutations_held`). */
  designs?: WorldDesignStore | null
  /** Where a read that failed after a construction was written is reported (the answer still carries the construction). */
  log?: Logger
}

/** The actor a request names, exactly these keys and shapes, or the refusal. */
function actorOf(body: Record<string, unknown>, keys: readonly string[]): ExpectedActor {
  if (Object.keys(body).sort().join() !== keys.join()) throw new RehearsalRefusal(400, 'invalid_request')
  const { sessionRef, worldId, discordUserId } = body
  if (typeof sessionRef !== 'string' || !UUID.test(sessionRef) || typeof worldId !== 'string' || !UUID.test(worldId) || typeof discordUserId !== 'string' || !DISCORD_ID.test(discordUserId))
    throw new RehearsalRefusal(400, 'invalid_request')
  return { sessionRef, worldId, discordUserId }
}

const ticketIdOf = (body: Record<string, unknown>) => {
  if (typeof body.ticketId !== 'string' || !UUID.test(body.ticketId)) throw new RehearsalRefusal(400, 'invalid_request')
  return body.ticketId
}

/** An assignment may name no ticket (`null`): the one the player holds, or none in a city whose every district is restricted. */
const heldTicketIdOf = (body: Record<string, unknown>) => (body.ticketId === null ? null : ticketIdOf(body))

export function createLocalPropertyRehearsal({ mode, fixture: given, sessions, store, tickets, construction = null, designs = null, log = silentLogger }: LocalPropertyRehearsalOptions): LocalPropertyRehearsal {
  if (mode !== 'local') throw new Error(`the local property rehearsal runs only with APP_MODE=local, not ${mode}`)
  const fixture = fixtureOf(given)
  const service = createPropertyActivationService({ sessions, store })
  const authority = rehearsalConstructionAuthority(fixture)
  const builder = construction ? createConstructionService({ sessions, store: construction, authority }) : null
  const designer = designs ? createDesignService({ sessions, store: designs, authority }) : null

  /** A design store call, its refusals answered. */
  async function designCall<T>(work: (store: WorldDesignStore) => Promise<T>): Promise<T> {
    if (!designs) throw new RehearsalRefusal(403, 'mutations_held', 'This local server does not save designs.')
    try {
      return await work(designs)
    } catch (err) {
      if (err instanceof WorldDesignRefusal) answer(err)
      throw err
    }
  }

  /** A construction store call, its refusals answered. */
  async function constructionCall<T>(work: (store: WorldConstructionStore) => Promise<T>): Promise<T> {
    if (!construction) throw new RehearsalRefusal(403, 'mutations_held', 'This local server does not build.')
    try {
      return await work(construction)
    } catch (err) {
      if (err instanceof WorldConstructionRefusal) answer(err)
      throw err
    }
  }
  const listed = (player: string) => fixture.grants.get(player) ?? []
  const granted = (player: string, key: string) => listed(player).some((a) => assetKey(a) === key)

  /** A ticket store call for the actor, its refusals answered. */
  async function ticketCall<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (err) {
      if (err instanceof DistrictTicketRefusal) answer(err)
      throw err
    }
  }

  /** The actor the page names, if it is exactly the browser's live session and Play answers active now. */
  const actor = (presented: string | null, expected: ExpectedActor): Promise<LivePlaySession> => sessions.requireActor(presented, expected)

  return {
    async assets(presented) {
      const session = await sessions.session(presented)
      const assets = listed(session.player.discordUserId).map((a) => ({ asset: assetKey(a), chain: a.chain, contract: a.contract, tokenId: a.tokenId }))
      return { rehearsal: REHEARSAL_MARK, assets }
    },

    async ticket(presented) {
      const session = await sessions.session(presented)
      const held = await ticketCall(() => tickets.current(session))
      return { rehearsal: REHEARSAL_MARK, ticket: held ? rehearsalTicket(held) : null, fresh: false, awaiting: null }
    },

    async enter(presented, body) {
      const who = await actor(presented, actorOf(body, ACTOR_KEYS))
      // Eligibility is the server-trusted local file for the session's player, never anything the request says.
      const entered = await ticketCall(() => tickets.enter(who))
      return { rehearsal: REHEARSAL_MARK, ticket: entered.ticket ? rehearsalTicket(entered.ticket) : null, fresh: entered.fresh, awaiting: entered.awaiting }
    },

    async assign(presented, body) {
      const expected = actorOf(body, ASSIGNMENT_KEYS)
      const ticketId = heldTicketIdOf(body)
      const asset = parseAssetKey(body.asset)
      if (!asset) throw new RehearsalRefusal(400, 'invalid_asset')
      const who = await actor(presented, expected)
      if (!granted(who.player.discordUserId, assetKey(asset))) throw new RehearsalRefusal(403, 'rehearsal_asset_not_granted')
      const assigned = await ticketCall(() => tickets.assign(who, ticketId, asset))
      return { rehearsal: REHEARSAL_MARK, ticket: rehearsalTicket(assigned.ticket), fresh: assigned.changed, awaiting: null }
    },

    async release(presented, body) {
      const expected = actorOf(body, RELEASE_KEYS)
      const ticketId = ticketIdOf(body)
      const who = await actor(presented, expected)
      await ticketCall(() => tickets.release(who, ticketId))
      return { rehearsal: REHEARSAL_MARK, ticket: null, fresh: false, awaiting: null }
    },

    async activate(presented, body) {
      const expected = actorOf(body, ACTIVATION_KEYS)
      const { asset: key, plotId, geometryFingerprint } = body
      // The geometry the page drew: judged against the governing one under the city's lock, never believed.
      if (typeof geometryFingerprint !== 'string' || !HASH.test(geometryFingerprint)) throw new RehearsalRefusal(400, 'invalid_request')
      const ticketId = ticketIdOf(body)
      const asset = parseAssetKey(key)
      if (!asset) throw new RehearsalRefusal(400, 'invalid_asset')
      if (typeof plotId !== 'string' || !PLOT_ID.test(plotId)) throw new RehearsalRefusal(422, 'unknown_plot')

      let result
      try {
        result = await service.activate(
          presented,
          expected,
          { asset, plotId, geometryFingerprint },
          {
            refuseRuleGatedDistricts: true,
            // The district ticket the plot was chosen under, the explicit rules the trusted fixture says match this NFT, and
            // its Proofy rule results, asked again for a restricted district under the city's lock.
            ticket: { id: ticketId, matches: matchingRules(fixture, asset), ruleAnswer: (where, rule) => ruleAnswerOf(fixture, where, rule), source: 'local-fixture' },
            // The player Proofy Play redeemed for the session, never one the request names, must be listed for this NFT.
            authorize: (who) => {
              if (!granted(who.player.discordUserId, assetKey(asset))) throw new RehearsalRefusal(403, 'rehearsal_asset_not_granted')
            },
          },
        )
      } catch (err) {
        if (err instanceof WorldPropertyRefusal) answer(err)
        throw err
      }
      const p = result.property
      return {
        rehearsal: REHEARSAL_MARK,
        fresh: result.fresh,
        sequence: result.sequence,
        property: { id: p.id, buildingId: p.buildingId, asset: p.asset, collection: p.collection, plotId: p.plotId, districtKey: p.districtKey, ward: p.ward, plot: p.plot, sequence: p.sequence, configVersion: p.configVersion, activatedAt: p.activatedAt },
        consumedTicket: result.ticketId ?? null,
      }
    },

    async construction(presented, propertyId) {
      const session = await sessions.session(presented)
      if (propertyId === null || !UUID.test(propertyId)) throw new RehearsalRefusal(400, 'invalid_request')
      return constructionView(await constructionCall((c) => c.overview(session, propertyId, authority)))
    },

    async construct(presented, body) {
      const expected = actorOf(body, CONSTRUCTION_KEYS)
      const { propertyId, role, actionId } = body
      // Which property, which role, which press: nothing else is read from the request, and no amount or tier at all.
      if (typeof propertyId !== 'string' || !UUID.test(propertyId) || (role !== 'owner' && role !== 'patron') || typeof actionId !== 'string' || !UUID.test(actionId)) throw new RehearsalRefusal(400, 'invalid_request')
      const done = await constructionCall(() => builder!.construct(presented, expected, { propertyId, role, actionId }))
      // Written and committed, for exactly this actor. What follows only reads the property again for the page, so its
      // failure (the session ended a moment later, a lost database answer) is never answered as if nothing was built:
      // the construction is answered without a view, and the page reads the view again itself.
      let view: RehearsalConstructionView | null = null
      try {
        const session = await sessions.session(presented)
        view = constructionView(await constructionCall((c) => c.overview(session, propertyId, authority)))
      } catch (err) {
        log.warn('rehearsal construction committed; its view could not be read again', { sequence: done.construction.sequence, ...errorFields(err) })
      }
      const c = done.construction
      return {
        rehearsal: REHEARSAL_MARK,
        resource: 'local-test-credit',
        fresh: done.fresh,
        sequence: done.sequence,
        balance: done.balance,
        construction: { sequence: c.sequence, propertyId: c.propertyId, actionId: c.actionId, recipe: c.recipe, role: c.role, era: c.era, units: c.units, builtBefore: c.builtBefore, builtAfter: c.builtAfter, tierBefore: c.tierBefore, tierAfter: c.tierAfter, constructedAt: c.constructedAt },
        view,
      }
    },

    async architect(presented) {
      // The player is the cookie's session's, as Proofy Play redeemed it: the request names nobody.
      const session = await sessions.session(presented)
      return architectView(await constructionCall((c) => c.architect(session, authority)))
    },

    async legacy(presented, propertyId) {
      // The viewer is the cookie's session's player, as Proofy Play redeemed it: the request names a property and nobody.
      const session = await sessions.session(presented)
      if (propertyId === null || !UUID.test(propertyId)) throw new RehearsalRefusal(400, 'invalid_request')
      return legacyView(await constructionCall((c) => c.legacy(session, propertyId, authority)))
    },

    async appearance(presented) {
      // Every saved design of the session's own city, for anyone signed in to it: designs are what the city looks like.
      const session = await sessions.session(presented)
      const saved = await designCall((d) => d.city(session))
      return {
        rehearsal: REHEARSAL_MARK,
        catalog: catalogAnswer(CURRENT_DESIGN_CATALOG),
        designs: saved.map((d) => ({ propertyId: d.propertyId, buildingId: d.buildingId, revision: d.revision, catalog: d.catalog, facade: d.facade, roof: d.roof, windows: d.windows, lighting: d.lighting, entrance: d.entrance, landscaping: d.landscaping })),
      }
    },

    async design(presented, propertyId) {
      const session = await sessions.session(presented)
      if (propertyId === null || !UUID.test(propertyId)) throw new RehearsalRefusal(400, 'invalid_request')
      return designView(await designCall((d) => d.overview(session, propertyId, authority)))
    },

    async saveDesign(presented, body) {
      // Exactly one of the three shapes: an earlier page's save (without the slots its catalog did not have) is answered as exactly that save.
      const street = Object.hasOwn(body, 'entrance') || Object.hasOwn(body, 'landscaping')
      const detailed = street || Object.hasOwn(body, 'windows') || Object.hasOwn(body, 'lighting')
      const expected = actorOf(body, street ? DESIGN_STREET_KEYS : detailed ? DESIGN_DETAIL_KEYS : DESIGN_KEYS)
      const { propertyId, actionId, baseRevision, catalog, facade, roof, windows, lighting, entrance, landscaping } = body
      // Which property, which press, which revision, and identifiers only: no color, markup or URL is ever read.
      if (typeof propertyId !== 'string' || !UUID.test(propertyId) || typeof actionId !== 'string' || !UUID.test(actionId) || !Number.isSafeInteger(baseRevision) || (baseRevision as number) < 0)
        throw new RehearsalRefusal(400, 'invalid_request')
      if ([catalog, facade, roof, ...(detailed ? [windows, lighting] : []), ...(street ? [entrance, landscaping] : [])].some((v) => typeof v !== 'string' || v.length > 64 || !CHOICE.test(v)))
        throw new RehearsalRefusal(400, 'invalid_request')
      const done = await designCall(() =>
        designer!.save(presented, expected, { propertyId, actionId, baseRevision, catalog, facade, roof, ...(detailed ? { windows, lighting } : {}), ...(street ? { entrance, landscaping } : {}) }),
      )
      // Written and committed, for exactly this actor. The view only reads the property again for the page, so its
      // failure is never answered as if nothing was saved: the design is answered without a view.
      let view: RehearsalDesignView | null = null
      try {
        const session = await sessions.session(presented)
        view = designView(await designCall((d) => d.overview(session, propertyId, authority)))
      } catch (err) {
        log.warn('rehearsal design committed; its view could not be read again', { property: done.design.propertyId, revision: done.design.revision, ...errorFields(err) })
      }
      const d = done.design
      return {
        rehearsal: REHEARSAL_MARK,
        fresh: done.fresh,
        design: {
          propertyId: d.propertyId,
          buildingId: d.buildingId,
          revision: d.revision,
          actionId: d.actionId,
          catalog: d.catalog,
          facade: d.facade,
          roof: d.roof,
          windows: d.windows,
          lighting: d.lighting,
          entrance: d.entrance,
          landscaping: d.landscaping,
          atCitySequence: d.atCitySequence,
          designedAt: d.designedAt,
        },
        view,
      }
    },
  }
}

const catalogAnswer = (c: DesignCatalog): RehearsalDesignCatalog => ({
  key: c.key,
  facades: [...c.facades],
  roofs: [...c.roofs],
  windows: [...c.windows],
  lighting: [...c.lighting],
  entrances: [...c.entrances],
  landscaping: [...c.landscaping],
  default: { ...c.default },
})

/** A property's design as its viewer is told it: no other player is named. */
export function designView(o: DesignOverview): RehearsalDesignView {
  return {
    rehearsal: REHEARSAL_MARK,
    catalog: catalogAnswer(o.catalog),
    property: { ...o.property },
    saved: o.saved ? { ...o.saved } : null,
    control: o.control,
    open: o.open,
    history: o.history.map((h) => ({ ...h })),
    historyCount: o.historyCount,
  }
}

/** A player's own construction record as they are told it: only their own records, every amount marked as local test units. */
export function architectView(o: ArchitectOverview): RehearsalArchitectView {
  return {
    rehearsal: REHEARSAL_MARK,
    resource: 'local-test-credit',
    recipe: { key: o.recipe.key, unitsPerAction: o.recipe.unitsPerAction, tierThresholds: [...o.recipe.tierThresholds], provisional: true },
    credits: { ...o.credits },
    totals: { ...o.totals },
    properties: o.properties.map((a) => ({ ...a, standing: a.standing.kind === 'complete' ? { kind: 'complete' } : { ...a.standing }, yours: { ...a.yours } })),
    propertyCount: o.propertyCount,
  }
}

/** A property's legacy as its viewer is told it: no other player is named, and every amount is marked as local test units. */
export function legacyView(o: PropertyLegacy): RehearsalPropertyLegacy {
  return {
    rehearsal: REHEARSAL_MARK,
    resource: 'local-test-credit',
    recipe: { key: o.recipe.key, unitsPerAction: o.recipe.unitsPerAction, tierThresholds: [...o.recipe.tierThresholds], provisional: true },
    property: { ...o.property },
    founding: o.founding,
    open: o.open,
    control: o.control,
    investment: { ...o.investment },
    yours: { ...o.yours },
    eras: o.eras.map((e) => ({ ...e })),
    eraCount: o.eraCount,
    unattributed: { ...o.unattributed },
    contributors: { ...o.contributors },
    designs: o.designs.map((d) => ({ ...d })),
    designCount: o.designCount,
  }
}

/** A property's construction as its viewer is told it: no other player is named, and every amount is marked as local test units. */
export function constructionView(o: ConstructionOverview): RehearsalConstructionView {
  return {
    rehearsal: REHEARSAL_MARK,
    resource: 'local-test-credit',
    recipe: { key: o.recipe.key, unitsPerAction: o.recipe.unitsPerAction, tierThresholds: [...o.recipe.tierThresholds], provisional: true },
    property: { ...o.property },
    control: o.control,
    standing: o.standing.kind === 'complete' ? { kind: 'complete' } : { ...o.standing },
    credits: { ...o.credits },
    investment: { ...o.investment },
    viewer: { ...o.viewer },
    contributors: { ...o.contributors },
    history: o.history.map((h) => ({ ...h })),
    historyCount: o.historyCount,
  }
}
