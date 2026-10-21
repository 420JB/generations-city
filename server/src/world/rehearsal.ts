import type { AppMode } from '../config'
import {
  assetKey,
  parseAssetKey,
  REHEARSAL_MARK,
  type DistrictRuleMatch,
  type NftAsset,
  type RehearsalActivationResponse,
  type RehearsalAssetsResponse,
  type RehearsalErrorCode,
  type RehearsalTicket,
  type RehearsalTicketResponse,
  type RuleAnswer,
} from '../engine'
import { PlaySessionError, type ExpectedActor, type LivePlaySession, type PlaySessionService } from '../play/session'
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
 * Still open, and not replaced here: F5 (browser-bound launch), F7 (fresh membership and entitlement),
 * F3 (Play game status), Core NFT/role/trait eligibility and verified rule results, and a separate
 * non-owner database role. Conflicting explicit rules are refused (D3), never ordered.
 */

/**
 * The rehearsal file's `kind`: v1 lists NFTs only; v2 also gives NFTs traits and declares explicit district rules; v3 also
 * gives Proofy rule results for players (restricted districts, D1).
 */
export const REHEARSAL_FILE_KIND = 'rare-city/local-property-rehearsal-v1'
export const REHEARSAL_FILE_KIND_V2 = 'rare-city/local-property-rehearsal-v2'
export const REHEARSAL_FILE_KIND_V3 = 'rare-city/local-property-rehearsal-v3'
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

/** The whole local fixture: grants, each NFT's traits, explicit district rules, Proofy rule results. */
export interface RehearsalFixture {
  grants: RehearsalGrants
  traits: ReadonlyMap<string, Readonly<Record<string, string>>>
  rules: readonly RehearsalDistrictRule[]
  results: readonly RehearsalRuleResult[]
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
  const v3 = isRecord(raw) && raw.kind === REHEARSAL_FILE_KIND_V3
  const v2 = v3 || (isRecord(raw) && raw.kind === REHEARSAL_FILE_KIND_V2)
  const keys = v3 ? 'districtRules,kind,players,ruleResults' : v2 ? 'districtRules,kind,players' : 'kind,players'
  if (!isRecord(raw) || Object.keys(raw).sort().join() !== keys || (raw.kind !== REHEARSAL_FILE_KIND && !v2) || !isRecord(raw.players))
    throw new Error(
      `a local rehearsal file is exactly { "kind": "${REHEARSAL_FILE_KIND}", "players": { … } }, { "kind": "${REHEARSAL_FILE_KIND_V2}", "players": { … }, "districtRules": [ … ] }, or { "kind": "${REHEARSAL_FILE_KIND_V3}", "players", "districtRules", "ruleResults": [ … ] }`,
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
  return { grants, traits, rules: Object.freeze(rules), results: Object.freeze(results) }
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

/** A fixture, or a bare grants map as v1 gave it (no traits, rules or results). */
const fixtureOf = (given: RehearsalFixture | RehearsalGrants): RehearsalFixture => (given instanceof Map ? { grants: given, traits: new Map(), rules: [], results: [] } : (given as RehearsalFixture))

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

type Answered = Exclude<WorldPropertyRefusalCode | DistrictTicketRefusalCode, 'session_ended' | 'world_unavailable' | 'config_superseded' | 'active_config_unverified'>

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
}

/** A store's refusal, as the routes answer it: the session layer's own error for a session or world problem, else a rehearsal refusal. */
function answer(err: WorldPropertyRefusal | DistrictTicketRefusal): never {
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
}

export interface LocalPropertyRehearsalOptions {
  mode: AppMode
  /** The parsed rehearsal file. (A bare grants map, as v1 gave, is a fixture without traits, rules or results.) The ticket store must be built on the same one (`rehearsalEligibility`). */
  fixture: RehearsalFixture | RehearsalGrants
  sessions: Pick<PlaySessionService, 'session' | 'requireActor' | 'activeConfig'>
  store: WorldPropertyStore
  tickets: DistrictTicketStore
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

export function createLocalPropertyRehearsal({ mode, fixture: given, sessions, store, tickets }: LocalPropertyRehearsalOptions): LocalPropertyRehearsal {
  if (mode !== 'local') throw new Error(`the local property rehearsal runs only with APP_MODE=local, not ${mode}`)
  const fixture = fixtureOf(given)
  const service = createPropertyActivationService({ sessions, store })
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
  }
}
