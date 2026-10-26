import type { RehearsalArchitectProperty } from '../../protocol/playRehearsal'

/**
 * THE ARCHITECT PORTFOLIO'S RELATIONSHIPS (P1-C2-E5A, `architect.tsx`): how a listed property relates to the player, each
 * from its own field of the server's Architect answer, never one inferred from another, and what an empty relationship
 * says. The server lists at most `ARCHITECT_PROPERTY_LIMIT` properties (most recent activity first) while its totals count
 * every one, so when the list is capped an empty relationship is said of the listed properties only.
 */

/** The relationships a player can have with a property, each from its own record: never one inferred from another. */
export const RELATIONS = [
  { key: 'all', name: 'All', test: () => true },
  { key: 'controlled', name: 'Controlled now', test: (a: RehearsalArchitectProperty) => a.control === 'viewer' },
  { key: 'founded', name: 'Founded', test: (a: RehearsalArchitectProperty) => a.founded },
  { key: 'patron', name: 'Patron', test: (a: RehearsalArchitectProperty) => a.yours.patronUnits > 0 },
  { key: 'earlier', name: 'Earlier control', test: (a: RehearsalArchitectProperty) => a.yours.earlierEraOwnerUnits > 0 },
] as const
export type Relation = (typeof RELATIONS)[number]['key']

/** An empty relationship, when every property of the player's record is listed: then it is true of all of them. */
const EMPTY_RELATION: Record<Relation, string> = {
  all: '',
  controlled: 'This local server’s test file names you as the controller of none of these properties.',
  founded: 'You have not founded any of these properties.',
  patron: 'You have not built on any of these properties as a patron.',
  earlier: 'You have no owner units under a control that has since ended.',
}
/** The same, of the listed properties only (the list is capped): one not listed may still have it. */
const EMPTY_LISTED: Record<Relation, string> = {
  all: '',
  controlled: 'names you as its test controller',
  founded: 'was founded by you',
  patron: 'has your patron units',
  earlier: 'has your owner units under a control that has since ended',
}

/** What an empty relationship says, of `listed` properties shown of `count` in the player's record. */
export function emptyRelation(relation: Relation, listed: number, count: number): string {
  if (relation === 'all') return ''
  if (count <= listed) return EMPTY_RELATION[relation]
  return `None of the ${listed} properties listed here ${EMPTY_LISTED[relation]}. Properties not listed may; your totals above count every property.`
}
