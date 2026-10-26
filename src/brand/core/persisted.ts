import { DEFAULT_ARCHITECTURE } from '../../config/architecture'
import { LANDSCAPE_MAX_SLOTS, TIER_THRESHOLDS } from '../../config/economy'
import { MONUMENTS } from '../../config/monuments'
import { capitalHolderIn, computeMonumentHoldersIn, tallestBuilding } from '../../game/competition'
import { tierFor, totalBuilt } from '../../game/economy'
import { parseAssetKey } from '../../world/asset'
import type { WorldBuildingDevelopment, WorldBuildingRecord, WorldCityState } from '../../world/cityState'
import { developmentOf, LOCAL_TEST_CONSTRUCTION_RECIPE, recipeMaxTier, type ConstructionRecipe } from '../../world/construction'
import { isDrawableDesign, type PropertyDesign } from '../../world/design'
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
 *   - A property's saved Architect design (P1-C2-E4A, P1-C2-E4B, `designs`, by building id) is drawn through the same
 *     architecture the renderer always reads: its facade finish, roof silhouette, windows and lighting replace the
 *     default's, and nothing else does (`withPropertyDesigns`). Tier, height, district and the NFT's label stay the
 *     stored city's.
 *
 * The civic world (plaza, squares, monument pads, roads) is drawn from the configuration, so an
 * empty city is still a whole city.
 */
export function persistedBrandCityState(config: Pick<BrandCityConfig, 'districts'>, stored: WorldCityState, designs: Readonly<Record<string, PropertyDesign>> = {}): BrandCityState {
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
    buildings: withPropertyDesigns({ buildings }, designs).buildings,
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

/**
 * How the renderer draws each Architect lighting treatment (P1-C2-E4B): the window glow it already draws (`LIGHTING_COLORS`)
 * and, for a floodlit one, static exterior floodlights in the same color. `standard` is exactly how every building was
 * drawn before: the warm glow, no floodlights.
 */
const LIGHTING_DRAWN: Readonly<Record<string, { glow: string; floodlights?: string }>> = Object.freeze({
  standard: { glow: 'warm' },
  warm: { glow: 'warm', floodlights: 'warm' },
  cool: { glow: 'cool', floodlights: 'cool' },
})

/**
 * A city's buildings with Architect designs applied (by building id): each designed building is a NEW object with that
 * facade, roof, windows and lighting, every other building is the very object it was, so the renderer redraws only what
 * changed (a preview of one choice redraws one building). A design is applied only when it is exactly an appearance a
 * catalog this build has draws (`isDrawableDesign`), and only to a building of the city; anything else leaves the building
 * as it was drawn. A building drawn with the standard treatments carries no floodlights at all, exactly as before.
 *
 * A Tier 0 foundation has no roof to draw, so its saved roof is drawn from Tier 1: until then the building keeps the
 * default's (the renderer places a building's label and hit area by its roof's height, even where it draws none). Its
 * windows and lighting are applied, and drawn once it has storeys (Tier 1).
 */
export function withPropertyDesigns<T extends Pick<BrandCityState, 'buildings'>>(state: T, designs: Readonly<Record<string, PropertyDesign>>): T {
  const ids = Object.keys(designs).filter((id) => Object.hasOwn(state.buildings, id) && isDrawableDesign(designs[id]) && Object.hasOwn(LIGHTING_DRAWN, designs[id].lighting))
  if (ids.length === 0) return state
  const buildings = { ...state.buildings }
  for (const id of ids) {
    const b = buildings[id]
    const { facade, windows } = designs[id]
    const roof = tierFor(totalBuilt(b)) === 0 ? b.architecture.roof : designs[id].roof
    const { glow: lighting, floodlights } = LIGHTING_DRAWN[designs[id].lighting]
    const a = b.architecture
    if (a.facade === facade && a.roof === roof && a.windows === windows && a.lighting === lighting && b.floodlights === floodlights) continue
    const next: BrandBuilding = { ...b, architecture: { ...a, facade, roof, windows, lighting } }
    // A building drawn with the standard lighting carries no floodlights key at all, exactly as before.
    if (floodlights) next.floodlights = floodlights
    else delete next.floodlights
    buildings[id] = next
  }
  return { ...state, buildings }
}
