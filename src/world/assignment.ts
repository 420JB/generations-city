/**
 * DEFAULT DISTRICT ASSIGNMENT, the pure rules (owner-locked, MCD 46A/46B). The persistence and
 * concurrency (tickets, slots, gap reuse, expiry) are the server's (`server/src/world/tickets.ts`,
 * migration 0010); this module only says what a rotation is and how a district is chosen.
 *
 *   - One rotation per world, shared by every collection of the city. A player does not choose
 *     their default district: entering the city assigns the district of the next slot.
 *   - The rotation's districts are the city's districts in configuration order, leaving out every
 *     district with a Proofy rule. ENGINEERING CHOICE, NOT AN OWNER LOCK (MCD 46A leaves the exact
 *     default topology and order open): a rule-gated district admits only players its rule admits,
 *     and nothing can check a rule yet, so it cannot be anyone's default.
 *   - Ordinal n of an epoch names districts[(n - epoch start) mod length]: districts 1, 2, 3, ... and
 *     round again. A released slot is reused by the next entrant, lowest ordinal first.
 *   - An explicit collection/trait rule that matches an NFT overrides the default for that NFT. The
 *     precedence of overlapping explicit rules is NOT APPROVED (MCD 46A): when the rules that apply
 *     name different districts the result is `ambiguous`, and the NFT is refused, never guessed.
 */

/** A district as a configuration states it, as far as assignment needs: its key, and whether a Proofy rule gates it. */
export interface AssignableDistrict {
  key: string
  gate: unknown
}

/** The rotation's district order: every district without a Proofy rule, in configuration order. */
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
