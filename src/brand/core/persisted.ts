import { DEFAULT_ARCHITECTURE } from '../../config/architecture'
import { LANDSCAPE_MAX_SLOTS } from '../../config/economy'
import { MONUMENTS } from '../../config/monuments'
import { capitalHolderIn, computeMonumentHoldersIn, tallestBuilding } from '../../game/competition'
import { parseAssetKey } from '../../world/asset'
import type { WorldBuildingRecord, WorldCityState } from '../../world/cityState'
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
 *     architecture, nothing built, no landscaping, no billboard. Progress, owners and economy are
 *     not recorded anywhere yet, so none is shown; the building has no owner (`ownerId` empty).
 *   - Monument holders, the Capital and the Crown are the standard competition rules applied to
 *     those buildings. With nothing built they are all vacant, as the rules say.
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
      ownerBuilt: 0,
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
  const list = Object.values(buildings)
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
