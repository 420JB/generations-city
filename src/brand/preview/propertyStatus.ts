import type { ConstructionState } from './constructionState'
import type { DesignLoad } from './design'

/**
 * What a STORED property's panel says about who controls it and why an action is not offered (P1-E6), from the answers the
 * panel already has (its design answer and its construction). Pure: nothing here asks the server, grants anything or
 * decides an action the server would refuse; it only says what the answers say. No word of ownership: a founder's panel
 * uses none (P1-C2-E2), and control is the local file's TEST data, never verified.
 */

/**
 * Whom the local file names as the NFT's current controller, as this viewer may know it: the viewer, another player, nobody;
 * or that it is not checked in this city, still being read, or not checked by this page at all (no local rehearsal).
 */
export type ControlStatus = 'viewer' | 'other' | 'unknown' | 'closed' | 'checking' | 'unchecked'

/**
 * The control status from the panel's answers (the design and the construction ask the same trusted source). `answer`:
 * the design answer, null while it is read, undefined where the panel reads none; `construction`: null where it reads none.
 */
export function controlStatusOf(answer: DesignLoad | null | undefined, construction: ConstructionState | null): ControlStatus {
  if (answer === undefined && !construction) return 'unchecked'
  if (answer?.ok) return answer.view.open ? answer.view.control : 'closed'
  if (construction?.view) return construction.view.control
  // Neither answer names a controller: wait for both, then say whether this city checks control at all.
  if (answer === null || (construction && !construction.problem)) return 'checking'
  return construction?.problem?.code === 'construction_not_open' ? 'closed' : 'unchecked'
}

export const CONTROL_LINES: Readonly<Record<ControlStatus, string>> = {
  viewer: 'You are its current test controller',
  other: 'Another player is its current test controller',
  unknown: 'No current controller is named',
  closed: 'Control is not checked in this city',
  checking: 'Checking who controls it…',
  unchecked: 'Current holder not verified',
}

/** Why the design view is not offered to this viewer, said without a word of ownership (a founder's panel uses none). */
export function designReason(answer: DesignLoad | null, control: ControlStatus, earlier: boolean, founder: boolean): string {
  if (!answer) return 'Reading its design…'
  if (!answer.ok) return answer.problem.message
  if (!answer.view.open) return 'Property design is not open in this city on this local server.'
  if (control === 'unknown') return 'No current controller is named for this NFT, so nobody can customize it.'
  return `${earlier ? 'You controlled it earlier; only' : 'Only'} its current test controller can customize its design.${founder ? ' Founding it does not let you change it.' : ''}`
}

/** Why there is no construction action for this viewer now. */
export function buildReason(c: ConstructionState): string {
  if (c.problem?.code === 'construction_not_open') return 'Building is not open in this city yet.'
  if (!c.view) return c.problem ? c.problem.message : 'Reading its construction…'
  if (c.view.standing.kind === 'complete') return `Tier ${c.view.property.tier} is the highest tier this local rehearsal builds.`
  return 'This local server’s test file grants you no test credits here, so you can look but not build.'
}
