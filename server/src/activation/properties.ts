import type { Database } from '../db/pool'
import { RARE_FRIENDS_CHAIN, type FriendPropertyDto } from '../engine'

/**
 * READ side of the normalized `properties` table, for annotating a wallet's Friends with
 * the property each one already has.
 *
 * `properties` is the authority for which Friend has a property. The city state's users
 * are presentation: a user's avatar `friendId` says nothing about what they own, and is
 * never read here.
 */
export interface PropertyReader {
  /** The property of each of these Friends that has one, keyed by decimal token id. Public facts only. */
  forFriends(tokenIds: readonly bigint[]): Promise<Map<string, FriendPropertyDto>>
}

export function createPropertyReader(db: Database): PropertyReader {
  return {
    async forFriends(tokenIds) {
      const found = new Map<string, FriendPropertyDto>()
      if (tokenIds.length === 0) return found
      const { rows } = await db.query<{ id: string; token_id: string; building_id: string; district_id: string; ward: number; plot: number; plot_id: string; activated_at: Date }>(
        `SELECT id, token_id::text AS token_id, building_id, district_id, ward, plot, plot_id, activated_at
           FROM properties
          WHERE chain_id = $1 AND collection = $2 AND token_id = ANY($3::numeric[])`,
        [RARE_FRIENDS_CHAIN.chainId, RARE_FRIENDS_CHAIN.generations.toLowerCase(), tokenIds.map((id) => id.toString())],
      )
      for (const p of rows) found.set(p.token_id, { id: p.id, buildingId: p.building_id, districtId: p.district_id, ward: p.ward, plot: p.plot, plotId: p.plot_id, activatedAt: p.activated_at.toISOString() })
      return found
    },
  }
}
