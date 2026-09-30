import { BILLBOARD_MIN_TIER } from './economy'

/** Landscaping item kinds that can be placed into bounded lot slots. */
export type LandscapeKind = 'tree' | 'shrub' | 'planter' | 'bench' | 'lamp'
export const LANDSCAPE_KINDS: readonly LandscapeKind[] = ['tree', 'shrub', 'planter', 'bench', 'lamp']

export type FixtureId =
  | LandscapeKind
  | 'entrance-upgrade'
  | 'premium-facade'
  | 'rooftop-sign'
  | 'crest'
  | 'premium-roof'
  | 'billboard'

export interface FixtureDef {
  id: FixtureId
  name: string
  price: number
  kind: 'landscape' | 'upgrade'
  description: string
  minTier: number
  /** Landscaping items can be bought repeatedly; upgrades are one-time unlocks. */
  repeatable: boolean
}

export const FIXTURES: readonly FixtureDef[] = [
  { id: 'tree', name: 'Tree', price: 40, kind: 'landscape', description: 'A lit ornamental tree for your lot.', minTier: 0, repeatable: true },
  { id: 'shrub', name: 'Shrub Set', price: 30, kind: 'landscape', description: 'Low hedges that frame the entrance.', minTier: 0, repeatable: true },
  { id: 'planter', name: 'Planter', price: 25, kind: 'landscape', description: 'Stone planter with glowing blooms.', minTier: 0, repeatable: true },
  { id: 'bench', name: 'Bench', price: 35, kind: 'landscape', description: 'A place for Friends to linger.', minTier: 0, repeatable: true },
  { id: 'lamp', name: 'Lamp Posts', price: 60, kind: 'landscape', description: 'Warm street lamps along the lot.', minTier: 0, repeatable: true },
  { id: 'entrance-upgrade', name: 'Entrance Upgrade', price: 300, kind: 'upgrade', description: 'Unlocks Arch and Grand Portico entrances.', minTier: 1, repeatable: false },
  { id: 'crest', name: 'Rare Friend Crest', price: 400, kind: 'upgrade', description: 'Unlocks a crest emblem on your facade.', minTier: 1, repeatable: false },
  { id: 'rooftop-sign', name: 'Rooftop Sign', price: 500, kind: 'upgrade', description: 'Illuminated sign bearing your Friend ID.', minTier: 2, repeatable: false },
  { id: 'premium-facade', name: 'Premium Facade', price: 800, kind: 'upgrade', description: 'Unlocks Copper, Jade and Aurora Glass facades.', minTier: 2, repeatable: false },
  { id: 'premium-roof', name: 'Premium Roof Treatment', price: 1_200, kind: 'upgrade', description: 'Unlocks Crown Deck and Halo roofs.', minTier: 3, repeatable: false },
  { id: 'billboard', name: 'Billboard', price: 2_000, kind: 'upgrade', description: 'One controlled billboard surface for your own image.', minTier: BILLBOARD_MIN_TIER, repeatable: false },
]

const byId = new Map(FIXTURES.map((f) => [f.id, f]))
export function getFixture(id: FixtureId): FixtureDef {
  const f = byId.get(id)
  if (!f) throw new Error(`Unknown fixture ${id}`)
  return f
}
