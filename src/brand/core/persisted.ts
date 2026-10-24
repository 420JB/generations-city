import { DEFAULT_ARCHITECTURE } from '../../config/architecture'
import { LANDSCAPE_MAX_SLOTS, TIER_THRESHOLDS } from '../../config/economy'
import { MONUMENTS } from '../../config/monuments'
import { capitalHolderIn, computeMonumentHoldersIn, tallestBuilding } from '../../game/competition'
import { parseAssetKey } from '../../world/asset'
import type { WorldBuildingDevelopment, WorldBuildingRecord, WorldCityState } from '../../world/cityState'
import { developmentOf, LOCAL_TEST_CONSTRUCTION_RECIPE, recipeMaxTier, type ConstructionRecipe } from '../../world/construction'
import type { BrandCityConfig } from './config'
import type { BrandBuilding, BrandCityState, SampleNft } from './sampleCity'

/**
 * A PERSISTENT city's state, as the standard renderer draws it: exactly what is stored, and
 * nothing more. Nothing is simulated.
 *
 *   - A city as founded (state version 1) is empty: no buildings, every district with its
 *     founding ward open.
 *   - A city with properties (version 2) draws each property as a building on its exact plot,
 *     as the standard game draws a newly placed property: a Tier 0 foundation with the default
 *     architecture, nothing built, no landscaping, no billboard. Owners and economy are not
 *     recorded, so none is shown; the building has no owner (`ownerId` empty).
 *   - A city with construction (version 3) draws what has been built into each building at the
 *     tier the server stored, through the standard renderer's own tier visuals (`renderedBuilt`).
 *     Who built it is not drawn: the panel reads that from the server's construction records.
 *   - Monument holders, the Capital and the Crown are the standard competition rules applied to
 *     those buildings' CANONICAL development. Every development a city stores today is LOCAL TEST
 *     construction (valueless test credits, the provisional local recipe), which the rules do not
 *     count: a test-built building is drawn at its tier, but holds no monument, Capital or Crown, so
 *     they are all vacant, as with nothing built. Whether real construction will ever count is not
 *     decided here.
 *
 * The civic world (plaza, squares, monument pads, roads) is drawn from the configuration, so an
 * empty city is still a whole city.
 */
export function persistedBrandCityState(config: Pick<BrandCityConfig, 'districts'>, stored: WorldCityState): BrandCityState {
  const buildings: Record<string, BrandBuilding> = {}
  const nfts: Record<string, SampleNft> = {}
  for (const [id, b] of Object.entries(stored.buildings) as [string, WorldBuildingRecord][]) {
    const tokenId = parseAssetKey(b.asset)?.tokenId
    if (tokenId === undefined) throw new Error(`Stored building ${id} does not name an NFT`)
    buildings[id] = {
      id,
      // Display only. Exact below 2^53; the property id, not this, is the building's identity.
      friendId: Number(tokenId),
      ownerId: '',
      districtId: b.districtKey,
      ward: b.ward,
      plot: b.plot,
      ownerBuilt: renderedBuilt(developmentOf(stored, id)),
      patrons: {},
      architecture: { ...DEFAULT_ARCHITECTURE },
      fixtures: [],
      landscapeInventory: {},
      landscapeSlots: Array(LANDSCAPE_MAX_SLOTS).fill(null),
      billboard: { image: null, updatedClock: null },
      milestones: [],
    }
    nfts[id] = { collection: b.collection, tokenId }
  }
  const keys = config.districts.map((d) => d.key)
  // The competition sees each building as founded: local test construction is never an earned award.
  const list = Object.values(buildings).map((b) => ({ ...b, ownerBuilt: 0 }))
  const holders = computeMonumentHoldersIn(keys, list, {})
  const monuments = {} as BrandCityState['monuments']
  for (const m of MONUMENTS) monuments[m.id] = { holder: holders[m.id], sinceClock: 0 }
  const open: Readonly<Record<string, number>> = stored.openWards
  const wards: Record<string, number> = {}
  for (const key of keys) wards[key] = open[key] ?? 1
  return {
    users: {},
    buildings,
    nfts,
    wards,
    monuments,
    capital: { holder: capitalHolderIn(keys, list, null), sinceClock: 0 },
    crown: { holder: tallestBuilding(list, null), sinceClock: 0 },
  }
}

/**
 * Where the standard renderer draws a stored building's development: the tier the server stored, and the progress
 * through it, on the renderer's own scale (`TIER_THRESHOLDS`). The renderer draws tiers from an amount built, so this is
 * the amount that draws exactly that tier and progress. It is a drawing position only, never a balance or a price: the
 * recipe's units and the renderer's amounts are different scales that happen to be drawn together.
 */
export function renderedBuilt(d: WorldBuildingDevelopment | null, recipe: ConstructionRecipe = LOCAL_TEST_CONSTRUCTION_RECIPE): number {
  if (!d) return 0
  const tier = Math.min(d.tier, recipeMaxTier(recipe), TIER_THRESHOLDS.length)
  const floor = tier === 0 ? 0 : TIER_THRESHOLDS[tier - 1]
  if (tier >= recipeMaxTier(recipe) || tier >= TIER_THRESHOLDS.length) return floor
  const from = tier === 0 ? 0 : recipe.tierThresholds[tier - 1]
  const fraction = Math.max(0, Math.min(1, (d.built - from) / (recipe.tierThresholds[tier] - from)))
  // Short of the next tier, always: progress never draws a tier the server has not stored.
  return Math.min(TIER_THRESHOLDS[tier] - 1, floor + Math.floor(fraction * (TIER_THRESHOLDS[tier] - floor)))
}
