/**
 * DEFAULT DISTRICT ASSIGNMENT, the pure rules (owner-locked, MCD 46A/46B; policies D1 to D4 locked
 * 2026-10-21). The persistence and concurrency (tickets, slots, gap reuse, claim windows, expiry) are
 * the server's (`server/src/world/tickets.ts`, migrations 0010 and 0011); this module only says what
 * a rotation is, how a district is chosen, and what may authorize a restricted one.
 *
 *   - One rotation per world, shared by every collection of the city. A player does not choose
 *     their default district: entering the city assigns the district of the next slot.
 *   - D1 (locked): the rotation's districts are the city's UNRESTRICTED districts (no Proofy rule) in
 *     configuration order. A RESTRICTED district (one with a Proofy rule) is never a default: it is
 *     reached only by an explicit collection/trait rule for the NFT AND a positive answer to the
 *     district's own Proofy rule for the player (`districtAuthorization`). A city whose every district
 *     is restricted has an empty rotation, and is playable only that way.
 *   - Ordinal n of an epoch names districts[(n - epoch start) mod length]: districts 1, 2, 3, ... and
 *     round again. A released slot is reused by the next entrant, lowest ordinal first.
 *   - An explicit collection/trait rule that matches an NFT overrides the default for that NFT.
 *     D3 (locked): when the rules that apply name different districts the result is `ambiguous` and
 *     the NFT is refused until the configuration is fixed: no priority by rule order, id or type.
 *     Rules that name the same district agree.
 *   - D2 (locked): a claim window, and every ticket in it, lasts exactly `DISTRICT_TICKET_LEASE_SECONDS`.
 */

/** D2 (locked): how long a claim window lasts from its first ticket's issuance, exactly. Never extended or renewed. */
export const DISTRICT_TICKET_LEASE_SECONDS = 900

/** A Proofy rule's answer for one player: Core's `qualifies` (`true`, `false`, or `null`: unknown, stale, unsupported, conflicting). */
export type RuleAnswer = true | false | null

export type DistrictAuthorization =
  /** The district has no Proofy rule: every otherwise eligible player may be assigned it. */
  | { kind: 'open' }
  /** The district's rule answered `true` for the player. */
  | { kind: 'qualified'; verificationRuleId: number }
  /** The district's rule answered `false`: refused. */
  | { kind: 'unqualified'; verificationRuleId: number }
  /** No answer, an unknown one, or conflicting ones: refused, never guessed. */
  | { kind: 'unverified'; verificationRuleId: number }

/** Whether a player may be assigned a district, from its Proofy rule (if any) and that rule's answer for them. Only `true` qualifies. */
export function districtAuthorization(gate: { verificationRuleId: number } | null | undefined, answer: RuleAnswer | undefined): DistrictAuthorization {
  if (gate === null || gate === undefined) return { kind: 'open' }
  if (answer === true) return { kind: 'qualified', verificationRuleId: gate.verificationRuleId }
  if (answer === false) return { kind: 'unqualified', verificationRuleId: gate.verificationRuleId }
  return { kind: 'unverified', verificationRuleId: gate.verificationRuleId }
}

/** A district as a configuration states it, as far as assignment needs: its key, and whether a Proofy rule gates it. */
export interface AssignableDistrict {
  key: string
  gate: unknown
}

/** The rotation's district order (D1): every UNRESTRICTED district (no Proofy rule), in configuration order. */
export function defaultRotationDistricts(districts: readonly AssignableDistrict[]): string[] {
  return districts.filter((d) => d.gate === null || d.gate === undefined).map((d) => d.key)
}

/** The district a rotation ordinal names, or null if the rotation has no district or the ordinal is not of this epoch. */
export function rotationDistrict(districts: readonly string[], epochStart: number, ordinal: number): string | null {
  if (districts.length === 0 || !Number.isSafeInteger(ordinal) || !Number.isSafeInteger(epochStart) || ordinal < epochStart) return null
  return districts[(ordinal - epochStart) % districts.length]
}

/**
 * The longest `ruleRef` a rule ticket can record: the database's own limit (migration 0010, `wdt_rule_shape`), which
 * stays. Every rule id is short, but enough of them applying to one NFT add up to more; that is refused, typed, before
 * anything is written, and never shortened: a ticket records every rule that decided it, or none.
 */
export const MAX_RULE_REF_LENGTH = 200

/** An explicit rule that matched an NFT: its id and the district it assigns. */
export interface DistrictRuleMatch {
  id: string
  district: string
}

export type DistrictRuleResolution =
  /** No explicit rule applies in this city: the default rotation assigns the district. */
  | { kind: 'none' }
  /** Every rule that applies names one district. `ruleRef` lists their ids, sorted, comma-joined. */
  | { kind: 'rule'; district: string; ruleRef: string }
  /** Rules that apply name different districts, and no precedence is approved: refused. */
  | { kind: 'ambiguous'; districts: string[] }
  /** Every rule that applies names one district, but their ids together are longer than a ticket can record: refused. */
  | { kind: 'overlong'; district: string; ruleRef: string }

/**
 * What the explicit rules that matched an NFT decide in one city. A rule applies only in a city that has its district
 * (`cityDistricts`); one naming a district the city does not have is not a rule of that city.
 */
export function resolveDistrictRules(matches: readonly DistrictRuleMatch[], cityDistricts: ReadonlySet<string>): DistrictRuleResolution {
  const applying = matches.filter((m) => cityDistricts.has(m.district))
  if (applying.length === 0) return { kind: 'none' }
  const districts = [...new Set(applying.map((m) => m.district))].sort()
  if (districts.length > 1) return { kind: 'ambiguous', districts }
  const ruleRef = [...new Set(applying.map((m) => m.id))].sort().join(',')
  if (ruleRef.length > MAX_RULE_REF_LENGTH) return { kind: 'overlong', district: districts[0], ruleRef }
  return { kind: 'rule', district: districts[0], ruleRef }
}
