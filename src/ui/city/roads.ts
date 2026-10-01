import type { DistrictId } from '../../config/districts'
import { WORLD } from '../../config/world'
import { districtAngle, plotWorld, polar, wardBand, wardStreetRadius, type WorldPoint } from '../../game/world'
import { arcPoints, footprintHalf, isoW, LOT_MARGIN, type Pt } from './geometry'
import { rotatePointAroundCenter } from './rotation'

/**
 * ROAD MODEL (pure). Mirrors exactly how CityGround draws asphalt: arc streets are polylines
 * of `arcPoints()` and every road has a fixed SCREEN-pixel stroke. Used to derive road-safe
 * property envelopes and to test clearance in projected space at every district angle.
 *
 * `rot` is the city rotation (degrees): roads turn with the city while lots stay screen-aligned
 * (like the buildings on them), so the road-safe envelope is re-derived for the turned roads.
 */
export type RoadKind = 'civic' | 'ward-street' | 'ward-boundary' | 'radial'

/** Stroke widths in screen px, as rendered in CityGround. */
export const ROAD_STROKE: Record<RoadKind, number> = { civic: 11, 'ward-street': 10, 'ward-boundary': 12, radial: 20 }

/** Smallest screen px per world unit of the iso projection (its minor singular value). */
const ISO_MIN_SCALE = 16 * Math.SQRT1_2

/** Visual gap (world units) kept between a paved lot and the edge of any road. */
export const LOT_SETBACK = 0.4

export interface RoadPolyline {
  kind: RoadKind
  points: Pt[]
  /** Half the stroke width, in screen px. */
  halfWidth: number
}

/** Arc roads that bound a ward's plots: inner edge, mid-ward street and outer boundary. */
function wardArcs(ward: number): { kind: RoadKind; r: number }[] {
  const inner: { kind: RoadKind; r: number } = ward === 0 ? { kind: 'civic', r: WORLD.civicSquare.outer + 1 } : { kind: 'ward-boundary', r: wardBand(ward).inner }
  // The outer boundary street appears once the next ward opens, so always respect it.
  return [inner, { kind: 'ward-street', r: wardStreetRadius(ward) }, { kind: 'ward-boundary', r: wardBand(ward + 1).inner }]
}

/** Every road polyline near a district's ward (arcs as drawn + both radial boundary avenues). */
export function wardRoads(id: DistrictId, ward: number, rot = 0): RoadPolyline[] {
  const arcs = wardArcs(ward).map(({ kind, r }) => ({ kind, points: arcPoints(id, r, undefined, rot), halfWidth: ROAD_STROKE[kind] / 2 }))
  const outer = wardBand(ward + 1).outer + 1
  const radials = [-1, 1].map((s) => {
    const a = districtAngle(id) + (s * WORLD.districtSpanDeg) / 2
    return { kind: 'radial' as const, points: [isoW(polar(WORLD.ringRoadOuter, a), rot), isoW(polar(outer, a), rot)], halfWidth: ROAD_STROKE.radial / 2 }
  })
  return [...arcs, ...radials]
}

/**
 * Largest half-size of an axis-aligned (world x/y) square centred on `p` whose every point
 * stays LOT_SETBACK clear of each nearby road, whatever the district's rotation. For a road
 * whose normal is n, a square of half-size L reaches L·(|nx|+|ny|) toward it; road widths are
 * converted from screen px to world units conservatively (worst-case iso scale).
 * `p` is the unrotated plot centre; `rot` turns it and its roads together about City Hall.
 */
export function roadSafeHalf(id: DistrictId, ward: number, p: WorldPoint, rot = 0): number {
  const turn = (rot * Math.PI) / 180
  const r = Math.hypot(p.x, p.y)
  const theta = Math.atan2(p.y, p.x) + turn
  let best = Number.POSITIVE_INFINITY
  for (const { kind, r: R } of wardArcs(ward)) {
    const reach = Math.abs(Math.cos(theta)) + Math.abs(Math.sin(theta))
    best = Math.min(best, (Math.abs(R - r) - ROAD_STROKE[kind] / 2 / ISO_MIN_SCALE - LOT_SETBACK) / reach)
  }
  for (const s of [-1, 1]) {
    const phi = ((districtAngle(id) + (s * WORLD.districtSpanDeg) / 2) * Math.PI) / 180 + turn
    const dist = Math.abs(r * Math.sin(theta - phi))
    const reach = Math.abs(Math.sin(phi)) + Math.abs(Math.cos(phi))
    best = Math.min(best, (dist - ROAD_STROKE.radial / 2 / ISO_MIN_SCALE - LOT_SETBACK) / reach)
  }
  return Math.max(0, best)
}

// ---------- screen-space clearance (tests / diagnostics) ----------

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

function cross(o: Pt, a: Pt, b: Pt) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

function segmentsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0
}

function inConvex(p: Pt, poly: Pt[]): boolean {
  let sign = 0
  for (let i = 0; i < poly.length; i++) {
    const c = cross(poly[i], poly[(i + 1) % poly.length], p)
    if (c !== 0) {
      if (sign === 0) sign = Math.sign(c)
      else if (Math.sign(c) !== sign) return false
    }
  }
  return true
}

/** Distance (screen px) from a convex polygon to a road's asphalt edge; negative = overlap. */
export function polygonRoadClearance(poly: Pt[], road: RoadPolyline): number {
  let min = Number.POSITIVE_INFINITY
  for (let i = 0; i + 1 < road.points.length; i++) {
    const a = road.points[i]
    const b = road.points[i + 1]
    for (let j = 0; j < poly.length; j++) {
      const c = poly[j]
      const d = poly[(j + 1) % poly.length]
      if (segmentsIntersect(a, b, c, d)) return -road.halfWidth
      min = Math.min(min, segDist(c, a, b), segDist(a, c, d), segDist(b, c, d))
    }
    if (inConvex(a, poly)) return -road.halfWidth
  }
  return min - road.halfWidth
}

/**
 * Screen-space diamond of an axis-aligned square (half-size `half`) centred at `p`. Under a
 * city rotation the centre orbits but the square stays screen-aligned, exactly as lots draw.
 */
export function squareOnScreen(p0: WorldPoint, half: number, rot = 0): Pt[] {
  const p = rotatePointAroundCenter(p0, rot)
  return [
    isoW({ x: p.x - half, y: p.y - half }),
    isoW({ x: p.x + half, y: p.y - half }),
    isoW({ x: p.x + half, y: p.y + half }),
    isoW({ x: p.x - half, y: p.y + half }),
  ]
}

/** Minimum clearance (screen px) and the road kind it is measured against. */
export function minClearance(id: DistrictId, ward: number, p: WorldPoint, half: number, rot = 0): { px: number; kind: RoadKind } {
  const poly = squareOnScreen(p, half, rot)
  let best = { px: Number.POSITIVE_INFINITY, kind: 'civic' as RoadKind }
  for (const road of wardRoads(id, ward, rot)) {
    const c = polygonRoadClearance(poly, road)
    if (c < best.px) best = { px: c, kind: road.kind }
  }
  return best
}

/** Minimum paved apron kept around a podium even on the tightest plot. */
export const MIN_APRON = 0.15

/** A tier's lot half-size inside a plot's road-safe envelope `safe`. */
export function lotHalfWithin(tier: number, safe: number): number {
  const nominal = footprintHalf(tier) + LOT_MARGIN
  return Math.max(footprintHalf(tier) + MIN_APRON, Math.min(nominal, safe))
}

/**
 * Paved-lot half-size for a property: the normal lot (footprint + LOT_MARGIN) trimmed to the
 * road-safe envelope of its plot. Open and ghost plots use the Tier 0 lot so an open plot and
 * the property that later fills it read as the same parcel.
 */
export function propertyLotHalf(id: DistrictId, ward: number, plot: number, tier = 0, rot = 0): number {
  return lotHalfWithin(tier, roadSafeHalf(id, ward, plotWorld(id, ward, plot), rot))
}
