import { RARE_FRIENDS_CHAIN } from '../config/rareFriends'
import type { GameState } from '../game/types'
import { nftAsset, type NftAsset } from './asset'
import { compileWorldOrThrow } from './definition'
import { RARE_CITY_WORLD_DEFINITION } from './legacy'
import { formatPlotId, type WorldOccupancy } from './plots'

/**
 * COMPATIBILITY FIXTURE: the legacy Rare Friends city as a world.
 *
 * The definition (`legacy.ts`) is built from the configuration the legacy engine reads.
 * `rareCity.test.ts` proves the generic engine reproduces the legacy engine exactly on it,
 * within `WORLD_LIMITS` (the fixture's unbounded wards stop at `layout.wardLimit`).
 *
 * This is one preset, not a default: nothing in `src/world` assumes nine districts, this
 * layout, or these keys. The legacy engine (`src/game`) remains the authority for the Rare
 * Friends city and is not driven by this module. The world id `rare-city`, the `token-v1`
 * building scheme and V1 property ids belong to this definition alone.
 */
export { RARE_CITY_LAYOUT_KEY, RARE_CITY_WORLD_DEFINITION, RARE_FRIENDS_GENERATIONS_KEY } from './legacy'

export const RARE_CITY_WORLD = compileWorldOrThrow(RARE_CITY_WORLD_DEFINITION)

/** A Rare Friend as a canonical NFT asset, or null for a token id that is not canonical decimal. */
export function rareFriendAsset(tokenId: string): NftAsset | null {
  return nftAsset({ chain: `eip155:${RARE_FRIENDS_CHAIN.chainId}`, contract: RARE_FRIENDS_CHAIN.generations, tokenId })
}

/**
 * Read-only adapter: a legacy v5 city state as world occupancy. It reads the state and
 * never changes, upgrades or re-encodes it.
 */
export function legacyOccupancy(state: Pick<GameState, 'buildings' | 'wards'>): WorldOccupancy {
  const occupied = new Set<string>()
  for (const b of Object.values(state.buildings)) occupied.add(formatPlotId(b.districtId, b.ward, b.plot))
  return { openWards: { ...state.wards }, occupied }
}
