import type { PlayErrorCode } from '../../protocol/play'
import type { RehearsalErrorCode } from '../../protocol/playRehearsal'

/**
 * THE PLAYER'S CLAIM, as the Proofy Play page presents it (P1-C2-E1): how long their claim window has
 * left, which step they are on, and what kind of problem a refusal is. Pure: no clock, no browser.
 *
 * The countdown's only authority is the server's district ticket: its `expiresAt` is the end of the
 * player's claim window (900 seconds by the database's clock, never renewed; policy D2). The page
 * never starts, stores or extends a lease of its own: a reload, a relaunch, another tab, an NFT
 * switch or leaving and entering again all read the same instant back from the server. The page's
 * clock is only corrected by the server's `Date` header (`serverClockOffset`), and the server alone
 * decides whether a claim has ended: at zero the page stops offering activation and asks it.
 */

/** A claim window's whole length (policy D2). No ticket can have more left than this, whatever a clock says. */
export const CLAIM_WINDOW_MS = 900_000
/** Under this much time left, the countdown says the claim is nearly over. */
export const CLAIM_ENDING_MS = 120_000
/** The `Date` header has whole-second resolution: an offset smaller than this is noise, not a wrong clock. */
const CLOCK_NOISE_MS = 2_000

/**
 * The server's clock minus this browser's, from one answer: its `Date` header against the middle of the request. 0 when
 * the header is missing or unreadable, or the difference is within the header's resolution and the round trip.
 */
export function serverClockOffset(dateHeader: string | null, sentAt: number, receivedAt: number): number {
  const server = dateHeader ? Date.parse(dateHeader) : Number.NaN
  if (!Number.isFinite(server) || !(receivedAt >= sentAt)) return 0
  // The header is truncated to the second: on average the server's instant was half a second later.
  const offset = server + 500 - (sentAt + receivedAt) / 2
  return Math.abs(offset) < CLOCK_NOISE_MS ? 0 : Math.round(offset)
}

export type CountdownState = 'open' | 'ending' | 'ended'

export interface Countdown {
  /** Whole seconds left, rounded up: 0 only once the end has passed (by the corrected clock). */
  seconds: number
  /** MM:SS. */
  label: string
  state: CountdownState
  /** Until the shown second changes, so a timer redraws exactly then. Null once ended. */
  nextTickMs: number | null
}

/** The time left until `expiresAt`, at `serverNow` (this browser's clock plus `serverClockOffset`). */
export function claimCountdown(expiresAt: string, serverNow: number): Countdown {
  const end = Date.parse(expiresAt)
  const left = Number.isFinite(end) ? Math.min(end - serverNow, CLAIM_WINDOW_MS) : 0
  if (!(left > 0)) return { seconds: 0, label: '00:00', state: 'ended', nextTickMs: null }
  const seconds = Math.ceil(left / 1000)
  const label = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  return { seconds, label, state: left <= CLAIM_ENDING_MS ? 'ending' : 'open', nextTickMs: left - (seconds - 1) * 1000 }
}

/** The time left, as a screen reader says it. */
export function spokenCountdown(seconds: number): string {
  if (seconds <= 0) return 'no time left'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`
  return m === 0 ? part(s, 'second') : s === 0 ? part(m, 'minute') : `${part(m, 'minute')} ${part(s, 'second')}`
}

/**
 * Where a player is in a claim. `district`: no district yet (or the selected NFT's district is being decided). `nft`:
 * a test NFT to select. `plot`: an exact plot to choose. `review`: the permanent placement to confirm. `activating`:
 * the server is placing it. `ended`: the claim window ran out; nothing can be placed under it.
 */
export type ClaimStep = 'district' | 'nft' | 'plot' | 'review' | 'activating' | 'ended'

export interface ClaimProgress {
  /** The page holds a live district ticket, or (every district restricted) the NFT decides the district. */
  district: 'held' | 'awaiting-asset' | 'none'
  /** A test NFT is selected, and whether the server has answered for it under the ticket held now. */
  nft: 'none' | 'checking' | 'assigned' | 'refused'
  plotSelected: boolean
  stage: 'choose' | 'review' | 'activating'
  /** The countdown reached zero (the server is asked; it decides). */
  ended: boolean
}

export function claimStep(p: ClaimProgress): ClaimStep {
  if (p.stage === 'activating') return 'activating'
  if (p.ended) return 'ended'
  if (p.district === 'none') return 'district'
  if (p.nft === 'none' || p.nft === 'refused') return 'nft'
  if (p.nft === 'checking') return 'district'
  if (!p.plotSelected) return 'plot'
  return 'review'
}

/** The next thing the player does, in a few words. */
export const NEXT_ACTION: Record<ClaimStep, string> = {
  district: 'The server is assigning your district.',
  nft: 'Select the test NFT you want to place.',
  plot: 'Tap a highlighted plot on the map.',
  review: 'Review your placement, then activate it.',
  activating: 'Placing your property…',
  ended: 'Your claim time is up. Nothing was placed.',
}

/**
 * What a refusal asks of the player. `retry`: a temporary failure, nothing changed; try the same again. `renew`: the
 * claim (its ticket or the city's districts) changed or ended; a fresh, validated attempt is needed, in the same
 * window while it lasts. `refused`: not allowed, for this player or NFT; no retry changes that. `config`: the city's
 * configuration must be fixed by its administrator. `plot`: that plot cannot be had; choose another one.
 */
export type ProblemKind = 'retry' | 'renew' | 'refused' | 'config' | 'plot'

export interface ClaimProblem {
  message: string
  kind: ProblemKind
  /** The server's refusal code; null when the server could not be reached or answered something unreadable. */
  code: string | null
}

const REHEARSAL_KINDS: Record<RehearsalErrorCode | 'invalid_request', ProblemKind> = {
  rehearsal_asset_not_granted: 'refused',
  invalid_asset: 'retry',
  invalid_request: 'retry',
  asset_not_in_world: 'refused',
  asset_already_placed: 'refused',
  unknown_plot: 'plot',
  plot_unavailable: 'plot',
  district_rule_unverified: 'refused',
  district_rule_unqualified: 'refused',
  mutations_held: 'refused',
  sequence_conflict: 'retry',
  not_eligible: 'refused',
  no_default_district: 'refused',
  ticket_not_live: 'renew',
  ticket_expired: 'renew',
  ticket_superseded: 'renew',
  plot_outside_assignment: 'plot',
  district_rule_applies: 'renew',
  district_rule_ambiguous: 'config',
  district_rule_ref_too_long: 'config',
  ticket_asset_mismatch: 'renew',
  // Construction (P1-C2-E3A): only a lost answer is worth pressing again; the rest change only with the city or the local file.
  unknown_property: 'refused',
  construction_not_open: 'refused',
  construction_complete: 'refused',
  not_current_controller: 'refused',
  control_unverified: 'refused',
  controller_builds_as_owner: 'renew',
  insufficient_test_credits: 'refused',
  action_conflict: 'retry',
  construction_unconfirmed: 'retry',
  // Architect design (P1-C2-E4A): a stale design is read again and chosen on; the rest change only with the city or the local file.
  design_not_open: 'refused',
  design_unsupported: 'refused',
  design_stale: 'renew',
  design_unchanged: 'refused',
  design_unconfirmed: 'retry',
}

/** Play session refusals a claim can meet. Anything else (the session ended, a stale tab) leaves the city entirely. */
const SESSION_KINDS: Partial<Record<PlayErrorCode, ProblemKind>> = {
  rate_limited: 'retry',
  world_unavailable: 'retry',
  play_unavailable: 'retry',
  play_session_unavailable: 'retry',
  installation_unverified: 'retry',
  config_superseded: 'renew',
  config_invalid: 'config',
  config_incompatible: 'config',
  config_schema_unsupported: 'config',
}

/** The kind of a refusal code; an unreachable server (null) or an unknown code is a temporary failure. */
export function problemKind(code: string | null): ProblemKind {
  if (code === null) return 'retry'
  if (Object.hasOwn(REHEARSAL_KINDS, code)) return REHEARSAL_KINDS[code as RehearsalErrorCode]
  return SESSION_KINDS[code as PlayErrorCode] ?? 'retry'
}

/** The heading a problem of each kind is shown under. */
export const PROBLEM_TITLES: Record<ProblemKind, string> = {
  retry: 'Temporary problem · try again',
  renew: 'Your claim changed',
  refused: 'Not allowed',
  config: 'Needs the city’s administrator',
  plot: 'Choose another plot',
}

/** The refusals that say a restricted district's Proofy rule result (local test data here) does not let the player in. */
export const RULE_REFUSALS: ReadonlySet<string> = new Set(['district_rule_unverified', 'district_rule_unqualified'])
