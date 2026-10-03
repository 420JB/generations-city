import type { DistrictId } from './districts'

/**
 * Where each Rare Friends family lives: registry family id (what `familyOf` returns) to
 * Rare City district. Family geography is permanent, so this table is also written into
 * the database as a constraint on every property (migration 0004).
 *
 *   0 Skeleton d8 · 1 Mask d6 · 2 Family d4 · 3 Cellular d5 · 4 Asymmetry d7
 *   5 Hoverer d9 · 6 Colossus d3 · 7 Sparkling d2 · 8 Hollow d1
 */
export const FAMILY_DISTRICTS: readonly DistrictId[] = ['d8', 'd6', 'd4', 'd5', 'd7', 'd9', 'd3', 'd2', 'd1']

/** The district of a registry family id, or null when the id is not one of the nine. Never guesses. */
export function districtForFamily(familyId: unknown): DistrictId | null {
  if (typeof familyId !== 'number' || !Number.isInteger(familyId) || familyId < 0 || familyId >= FAMILY_DISTRICTS.length) return null
  return FAMILY_DISTRICTS[familyId]
}

/** The registry family id of a district, or null for an unknown district. */
export function familyForDistrict(districtId: unknown): number | null {
  const id = FAMILY_DISTRICTS.indexOf(districtId as DistrictId)
  return id < 0 ? null : id
}
