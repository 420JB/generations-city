import { DISTRICTS } from '../config/districts'
import { RARE_FRIENDS_CHAIN } from '../config/rareFriends'
import { WORLD } from '../config/world'
import type { WorldDefinition } from './definition'
import { deepFreeze } from './freeze'
import { LEGACY_RARE_CITY_WORLD_ID } from './identity'

/**
 * THE LEGACY RARE FRIENDS CITY, AS DATA.
 *
 * Built from the same configuration the legacy engine reads (`DISTRICTS`, `WORLD`,
 * `RARE_FRIENDS_CHAIN`), never from copied numbers, so the two cannot drift apart silently.
 * Deep-frozen: `compileWorld` accepts the reserved world id `rare-city` and the `token-v1`
 * building scheme only for a definition equal to this one, so nobody may change it.
 *
 * Kept apart from `rareCity.ts` so that `definition.ts` can read it without an import cycle.
 * The collection and layout keys below are new names for existing things. They appear in
 * no stored data yet.
 */
export const RARE_FRIENDS_GENERATIONS_KEY = 'rare-friends-generations'
export const RARE_CITY_LAYOUT_KEY = 'rare-city-radial-9'

export const RARE_CITY_WORLD_DEFINITION: WorldDefinition = deepFreeze({
  worldId: LEGACY_RARE_CITY_WORLD_ID,
  districts: DISTRICTS.map((d) => ({ key: d.id })),
  collections: [{ key: RARE_FRIENDS_GENERATIONS_KEY, chain: `eip155:${RARE_FRIENDS_CHAIN.chainId}`, contract: RARE_FRIENDS_CHAIN.generations, standard: 'erc721' as const }],
  layout: {
    kind: 'radial-wedge' as const,
    key: RARE_CITY_LAYOUT_KEY,
    params: {
      coreWardInner: WORLD.coreWard.inner,
      coreWardOuter: WORLD.coreWard.outer,
      firstPlotRadius: WORLD.firstPlotRadius,
      wardDepth: WORLD.wardDepth,
      // A copy: freezing this definition must not freeze the legacy configuration's own array.
      rowOffsets: [...WORLD.wardRowOffsets],
      plotSpacing: WORLD.plotSpacing,
      marginDeg: WORLD.districtMarginDeg,
    },
    // The legacy `districtAngle`: District 1 at the back of the map, then one span per index.
    districts: DISTRICTS.map((d) => ({ district: d.id, centerDeg: -135 + (d.index - 1) * WORLD.districtSpanDeg, spanDeg: WORLD.districtSpanDeg })),
    // Legacy wards are unbounded (up to the engine's resource limits).
    maxWards: null,
  },
  // Legacy buildings are `b-<friendId>`.
  buildingIds: 'token-v1' as const,
})

/** The Rare Friends collection, as `contractRefOf` spells it. The only collection with V1 property ids. */
export const RARE_FRIENDS_CONTRACT_REF = `eip155:${RARE_FRIENDS_CHAIN.chainId}/erc721:${RARE_FRIENDS_CHAIN.generations.toLowerCase()}`
