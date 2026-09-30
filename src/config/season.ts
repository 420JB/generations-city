/**
 * SEASON RULES (prototype). Permanent world state (buildings, tiers, history, badges)
 * persists forever. Seasonal competition is a separate layer that resets each season.
 * No real calendar is modelled: the demo runs a single, undated demo season.
 */
export const SEASON_RULES = {
  /** A player's Representative Friend (and therefore Home District) is fixed for the season. */
  allegianceLockedForSeason: true,
  /** New players may join and pick a Representative mid-season. */
  allowLateJoin: true,
  /**
   * Placeholder for production: minimum share of the season a player must have been a
   * resident to qualify for championship recognition/rewards. Not enforced in the demo.
   */
  minResidencyForChampionship: 0.5,
  /** Cross-district construction is allowed, but always flagged. */
  crossDistrictWarning: 'This construction strengthens another district.',
} as const

export const DEMO_SEASON = {
  id: 'demo-s1',
  name: 'Demo Season 1',
  label: 'DEMO SEASON',
} as const

/**
 * Future seasonal signals (direction only; NOT used by the current demo scoring).
 * Production district competition should normalise against declared / active seasonal
 * participation (not raw family supply or building count) so the largest family cannot win
 * on size alone. See FAIRNESS_PRINCIPLE in districtIdentity.ts.
 */
export const FUTURE_SEASON_SIGNALS = [
  { id: 'activeShare', label: 'Share of buildings active this season' },
  { id: 'seasonRF', label: 'RF construction this season (per active building)' },
  { id: 'tierUps', label: 'Buildings crossing tiers this season' },
  { id: 'builders', label: 'Unique active builders' },
  { id: 'patrons', label: 'Patron activity' },
  { id: 'monuments', label: 'Monument control' },
  { id: 'events', label: 'Strategic completion events' },
] as const
