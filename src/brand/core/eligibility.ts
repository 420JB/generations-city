import type { ProofyRuleRef } from './config'

/**
 * DISTRICT ACCESS, AS THE PREVIEW PRESENTS IT. Presentation only: nothing here authorizes.
 *
 * Exploring is never gated: every visitor and member may see and visit every district.
 * Claiming a plot or building in a district that references a Proofy rule needs that rule
 * to be satisfied. The authority is Proofy Core, server-side (today `POST /api/v1/access/check`,
 * `checkType: "rule"`, answering `qualifies: true | false | null`); a future claim/build
 * endpoint must ask it again itself. What the browser shows can be manipulated and is never
 * trusted. Losing a rule later never removes or moves an existing property.
 *
 * Proofy's answer is mirrored as `RuleAnswer`; `null` (not known, stale, unsupported) fails closed.
 */
export type RuleAnswer = true | false | null

/** A SIMULATED member for the preview: which sample rules they are pretended to satisfy. */
export interface PreviewMember {
  id: string
  label: string
  /**
   * `player`: the real player Proofy Play launched, whose rules are NOT checked here (every
   * rule answer stays unknown, so every gated district stays closed). Absent: simulated.
   */
  kind?: 'player'
  /** Simulated answers per Proofy verification rule id. A rule absent here is unknown (null). */
  answers: Readonly<Record<number, RuleAnswer>>
}

export type ClaimAccess =
  /** Not signed in: the city can be explored, nothing can be claimed. */
  | { kind: 'visitor' }
  /** No rule on this district: every otherwise eligible member may claim and build. */
  | { kind: 'open' }
  | { kind: 'eligible'; rule: ProofyRuleRef }
  | { kind: 'restricted'; rule: ProofyRuleRef; reason: 'not-qualified' | 'unknown' }

export function previewClaimAccess(gate: ProofyRuleRef | null, member: PreviewMember | null): ClaimAccess {
  if (!member) return { kind: 'visitor' }
  if (!gate) return { kind: 'open' }
  const answer = Object.hasOwn(member.answers, gate.verificationRuleId) ? member.answers[gate.verificationRuleId] : null
  if (answer === true) return { kind: 'eligible', rule: gate }
  return { kind: 'restricted', rule: gate, reason: answer === false ? 'not-qualified' : 'unknown' }
}

/** True when the preview should offer the (simulated) claim/build action. */
export function mayAct(access: ClaimAccess): boolean {
  return access.kind === 'open' || access.kind === 'eligible'
}
