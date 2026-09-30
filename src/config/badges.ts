/**
 * Permanent badges. Badges never revoke once earned; levelled badges only move upward.
 * `thresholds` map to Bronze / Silver / Gold / Diamond. A single-threshold badge is unlevelled.
 */
export type BadgeCategory = 'architect' | 'patron' | 'strategy' | 'prestige'
export type BadgeMetric =
  | 'ownerRF'
  | 'contributedRF'
  | 'buildingsSupported'
  | 'maxDistrictSupported'
  | 'districtsSupported'
  | 'maxPatronOnBuilding'
  | 'closerCount'
  | 'kingmakerCount'
  | 'capitalCaptures'
  | 'capitalReigns'
  | 'crownedCount'
  | 'ownMaxTier'
  | 'selfMade'
  | 'peoplesTower'
  | 'foundingProperty'

export interface BadgeDef {
  id: string
  name: string
  category: BadgeCategory
  metric: BadgeMetric
  thresholds: readonly number[]
  description: string
  glyph: string
}

export const BADGE_LEVEL_NAMES = ['Bronze', 'Silver', 'Gold', 'Diamond'] as const

export const BADGES: readonly BadgeDef[] = [
  { id: 'groundbreaker', name: 'Groundbreaker', category: 'architect', metric: 'ownerRF', thresholds: [100], description: 'Personally built 100 RF into your own property.', glyph: '⛏' },
  { id: 'architect', name: 'Architect', category: 'architect', metric: 'ownerRF', thresholds: [2_500], description: 'Personally built 2,500 RF into your own property.', glyph: '◭' },
  { id: 'master-architect', name: 'Master Architect', category: 'architect', metric: 'ownerRF', thresholds: [25_000], description: 'Personally built 25,000 RF into your own property.', glyph: '◈' },
  { id: 'self-made', name: 'Self Made', category: 'architect', metric: 'selfMade', thresholds: [1], description: 'Own a Tier 3+ building that is at least 75% owner-funded.', glyph: '✦' },
  { id: 'high-rise', name: 'High-Rise', category: 'architect', metric: 'ownMaxTier', thresholds: [4], description: 'Own a Tier 4 building.', glyph: '▥' },
  { id: 'skyline-legend', name: 'Skyline Legend', category: 'architect', metric: 'ownMaxTier', thresholds: [5, 6], description: 'Own a Tier 5 (Bronze) or Tier 6 (Silver) building.', glyph: '♜' },
  { id: 'peoples-tower', name: "People's Tower", category: 'architect', metric: 'peoplesTower', thresholds: [8, 15, 30, 60], description: 'Unique supporters on one of your buildings.', glyph: '❖' },
  { id: 'good-neighbor', name: 'Good Neighbor', category: 'patron', metric: 'contributedRF', thresholds: [1], description: "Contributed to another Friend's building.", glyph: '♥' },
  { id: 'patron', name: 'Patron', category: 'patron', metric: 'contributedRF', thresholds: [1_000, 5_000, 25_000, 100_000], description: 'Cumulative RF contributed to other buildings.', glyph: '✚' },
  { id: 'district-builder', name: 'District Builder', category: 'patron', metric: 'maxDistrictSupported', thresholds: [5], description: 'Supported 5 buildings in a single district.', glyph: '▦' },
  { id: 'city-builder', name: 'City Builder', category: 'patron', metric: 'districtsSupported', thresholds: [5, 9], description: 'Supported buildings in 5 (Bronze) or all 9 (Silver) districts.', glyph: '✺' },
  { id: 'local-legend', name: 'Local Legend', category: 'patron', metric: 'maxPatronOnBuilding', thresholds: [10_000], description: 'Earned an Illuminated Patron Crest on a building.', glyph: '☀' },
  { id: 'closer', name: 'Closer', category: 'strategy', metric: 'closerCount', thresholds: [1, 3, 10, 25], description: "Your contribution pushed someone else's building across a tier.", glyph: '⤒' },
  { id: 'kingmaker', name: 'Kingmaker', category: 'strategy', metric: 'kingmakerCount', thresholds: [1, 3, 10, 25], description: 'Your tier-up directly moved a district monument.', glyph: '♛' },
  { id: 'capital-maker', name: 'Capital Maker', category: 'prestige', metric: 'capitalCaptures', thresholds: [1, 2, 5, 10], description: 'Your action crowned a new Capital district.', glyph: '⚑' },
  { id: 'capital-citizen', name: 'Capital Citizen', category: 'prestige', metric: 'capitalReigns', thresholds: [1, 3, 5, 10], description: 'Owned property in a district when it became the Capital.', glyph: '⌂' },
  { id: 'founding-resident', name: 'Founding Resident', category: 'prestige', metric: 'foundingProperty', thresholds: [1], description: 'Owns a property in a Founding Ward (Ward I). Prestige only: no gameplay advantage.', glyph: '⌘' },
  { id: 'crowned', name: 'Crowned', category: 'prestige', metric: 'crownedCount', thresholds: [1], description: 'Owned the tallest building in Generations City.', glyph: '♔' },
]

const byId = new Map(BADGES.map((b) => [b.id, b]))
export function getBadge(id: string): BadgeDef | undefined {
  return byId.get(id)
}
