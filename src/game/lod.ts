/**
 * Level-of-detail planning (renderer-independent).
 *
 * Production Generations City may hold tens or hundreds of thousands of active properties.
 * No renderer should draw them all at once. Renderers ask this module what to draw for
 * the current zoom and for each ward, and only mount what is visible.
 *
 *   far   -> district geometry, ward massing (aggregate skyline), monuments, Capital, Crown
 *   mid   -> wards/blocks with representative buildings, roads, landmarks
 *   near  -> real nearby buildings with architecture, billboards, landscaping, patrons
 *   ground (future 3D Explore) -> only geometry around the player's Friend
 *
 * The local demo stays below these limits, so every building renders individually, but
 * the same code path switches to aggregates automatically as wards fill up.
 */
import type { Building } from './types'
import { totalBuilt } from './economy'

export type DetailLevel = 'far' | 'mid' | 'near'

export const LOD_LIMITS = {
  /** At far zoom, wards with more buildings than this render as aggregate massing. */
  farIndividualPerWard: 12,
  /** At mid zoom, wards above this render only their tallest representatives + massing. */
  midIndividualPerWard: 60,
  /** How many representative towers to keep individually when aggregating a ward. */
  representatives: 8,
} as const

export type WardRenderMode = 'individual' | 'representatives'

export function wardRenderMode(population: number, detail: DetailLevel): WardRenderMode {
  if (detail === 'near') return 'individual'
  const limit = detail === 'far' ? LOD_LIMITS.farIndividualPerWard : LOD_LIMITS.midIndividualPerWard
  return population > limit ? 'representatives' : 'individual'
}

/**
 * Pick which buildings of an aggregated ward stay individually rendered: the tallest
 * towers plus anything that must always be visible (the player's, the selected one, the
 * Crown holder). Deterministic ordering.
 */
export function representativeBuildings(buildings: Building[], keep: ReadonlySet<string>, n: number = LOD_LIMITS.representatives): Set<string> {
  const out = new Set<string>()
  for (const b of buildings) if (keep.has(b.id)) out.add(b.id)
  const sorted = [...buildings].sort((a, z) => totalBuilt(z) - totalBuilt(a) || a.id.localeCompare(z.id))
  for (const b of sorted) {
    if (out.size >= n + keep.size) break
    out.add(b.id)
  }
  return out
}

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0
}
