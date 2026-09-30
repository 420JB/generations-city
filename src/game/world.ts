import { DISTRICTS, type DistrictId } from '../config/districts'
import { WORLD } from '../config/world'

/**
 * Renderer-independent world geometry. Coordinates are on the ground plane in world
 * units with the City Hall at the origin. Renderers project these (the SVG map uses an
 * isometric projection; a future 3D Explore renderer can use them directly).
 */
export interface WorldPoint {
  x: number
  y: number
}

export function polar(r: number, deg: number): WorldPoint {
  const a = (deg * Math.PI) / 180
  return { x: r * Math.cos(a), y: r * Math.sin(a) }
}

/** Centre angle of a district wedge (District 1 at the back of the map). */
export function districtAngle(id: DistrictId): number {
  const d = DISTRICTS.find((x) => x.id === id)!
  return -135 + (d.index - 1) * WORLD.districtSpanDeg
}

export interface WardBand {
  ward: number
  inner: number
  outer: number
}

/**
 * Ward N geometry is derived lazily from its index (no pre-generation, no cap):
 * ward 0 spans the district core; ward N >= 1 is the band one wardDepth farther out.
 */
export function wardBand(ward: number): WardBand {
  if (!Number.isInteger(ward) || ward < 0) throw new Error(`Invalid ward ${ward}`)
  if (ward === 0) return { ward, inner: WORLD.coreWard.inner, outer: WORLD.coreWard.outer }
  const inner = WORLD.coreWard.outer + (ward - 1) * WORLD.wardDepth
  return { ward, inner, outer: inner + WORLD.wardDepth }
}

/** Radius where plots of a ward begin (ward 0 leaves room for the civic square). */
export function wardPlotRadius(ward: number): number {
  return WORLD.firstPlotRadius + ward * WORLD.wardDepth
}

/** Street radius inside a ward (between its two row pairs). */
export function wardStreetRadius(ward: number): number {
  return wardPlotRadius(ward) + WORLD.wardStreetOffset
}

/** Usable half-span of a district wedge in degrees (excludes the boundary avenues). */
export function usableHalfSpanDeg(): number {
  return WORLD.districtSpanDeg / 2 - WORLD.districtMarginDeg
}

export interface PlotRow {
  r: number
  count: number
}

/** Plot rows of a ward. Outer wards are longer arcs, so they hold more plots. */
export function wardRows(ward: number): PlotRow[] {
  const base = wardPlotRadius(ward)
  const usableRad = (2 * usableHalfSpanDeg() * Math.PI) / 180
  return WORLD.wardRowOffsets.map((off) => {
    const r = base + off
    return { r, count: Math.max(1, Math.floor((usableRad * r) / WORLD.plotSpacing)) }
  })
}

export function wardCapacity(ward: number): number {
  return wardRows(ward).reduce((a, r) => a + r.count, 0)
}

/** Deterministic, stable plot identifier. */
export function plotId(districtId: DistrictId, ward: number, plot: number): string {
  return `${districtId}-w${ward}-p${plot}`
}

/** Plot address -> (radius, angle offset from the district centre line). */
export function plotPolar(ward: number, plot: number): { r: number; offsetDeg: number } {
  const rows = wardRows(ward)
  let i = plot
  for (const row of rows) {
    if (i < row.count) {
      const usable = 2 * usableHalfSpanDeg()
      const offsetDeg = -usable / 2 + (usable * (i + 0.5)) / row.count
      return { r: row.r, offsetDeg }
    }
    i -= row.count
  }
  throw new Error(`Plot ${plot} out of range for ward ${ward}`)
}

export function plotWorld(districtId: DistrictId, ward: number, plot: number): WorldPoint {
  const p = plotPolar(ward, plot)
  return polar(p.r, districtAngle(districtId) + p.offsetDeg)
}

/** Outer radius of the city given how many wards each district has open. */
export function cityRadius(openWards: Record<DistrictId, number>): number {
  let max: number = WORLD.coreWard.outer
  for (const d of DISTRICTS) max = Math.max(max, wardBand(Math.max(0, (openWards[d.id] ?? 1) - 1)).outer)
  return max
}

/** Monument pad geometry, shared with the renderer (MonumentSprite pad a=3.1, sprite ×1.15). */
export const MONUMENT_PAD_A = 3.1
export const MONUMENT_SPRITE_SCALE = 1.15
/** World half-size of an axis-aligned monument pad at slot scale 1. */
export const MONUMENT_PAD_HALF = MONUMENT_PAD_A * MONUMENT_SPRITE_SCALE

/** Civic-plaza layout rules: pad gap, and clearances to the square's edges. */
export const CIVIC_LAYOUT = {
  padGap: 0.5,
  innerMargin: 0.3,
  outerMargin: 0.3,
  /** The civic square is drawn inset this far from each radial boundary avenue. */
  sideInset: 2.6,
  sideMargin: 0.3,
} as const

/**
 * Civic-plaza compositions in local plaza units: u = radial offset from the square's centre
 * line (+ = outward), v = tangential offset along the arc. Slot order follows monument tier
 * (lowest first); the highest-tier monument takes the ceremonial axis (v = 0) when there is one.
 *   1: ceremonial centre · 2: balanced pair · 3: triangle (2 outer, 1 on the axis)
 *   4: staggered 2 + 2 · 5: 2 inner + 3 outer with the top landmark on the axis
 */
export const CIVIC_TEMPLATES: Record<number, readonly (readonly [number, number])[]> = {
  1: [[0, 0]],
  2: [[2.5, -4.5], [2.5, 4.5]],
  3: [[3, -5], [3, 5], [-3, 0]],
  4: [[-3, -3.5], [-3, 3.5], [3.5, -4], [3.5, 4]],
  5: [[-3.5, -3.5], [-3.5, 3.5], [3.5, -6], [3.5, 6], [3.5, 0]],
}

function civicTemplatePoint(districtId: DistrictId, u: number, v: number): WorldPoint {
  const r = WORLD.civicSquare.center + u
  return polar(r, districtAngle(districtId) + (v / r) * (180 / Math.PI))
}

/** Pads (axis-aligned world squares) of a composition, for placement checks and tests. */
export function civicPads(districtId: DistrictId, count: number, scale: number): { center: WorldPoint; half: number }[] {
  return (CIVIC_TEMPLATES[count] ?? []).map(([u, v]) => ({ center: civicTemplatePoint(districtId, u, v), half: MONUMENT_PAD_HALF * scale }))
}

/** Every pad inside the civic square (with margins) and no two pads closer than the gap. */
export function civicPadsFit(districtId: DistrictId, pads: { center: WorldPoint; half: number }[]): boolean {
  const { inner, outer } = WORLD.civicSquare
  const a = (districtAngle(districtId) * Math.PI) / 180
  const halfSpan = ((WORLD.districtSpanDeg / 2) * Math.PI) / 180
  for (const { center: p, half: h } of pads) {
    // Nearest point of the pad to the city centre must clear the square's inner edge.
    const nx = Math.max(p.x - h, Math.min(0, p.x + h))
    const ny = Math.max(p.y - h, Math.min(0, p.y + h))
    if (Math.hypot(nx, ny) < inner + CIVIC_LAYOUT.innerMargin) return false
    for (const [cx, cy] of [[p.x - h, p.y - h], [p.x + h, p.y - h], [p.x + h, p.y + h], [p.x - h, p.y + h]]) {
      if (Math.hypot(cx, cy) > outer - CIVIC_LAYOUT.outerMargin) return false
      for (const sg of [-1, 1]) {
        const phi = a + sg * halfSpan
        const inward = -sg * (-cx * Math.sin(phi) + cy * Math.cos(phi))
        if (inward < CIVIC_LAYOUT.sideInset + CIVIC_LAYOUT.sideMargin) return false
      }
    }
  }
  for (let i = 0; i < pads.length; i++)
    for (let j = i + 1; j < pads.length; j++) {
      const sep = Math.max(Math.abs(pads[i].center.x - pads[j].center.x), Math.abs(pads[i].center.y - pads[j].center.y))
      if (sep < pads[i].half + pads[j].half + CIVIC_LAYOUT.padGap) return false
    }
  return true
}

/**
 * One uniform scale per monument count: the largest (≤ 1) at which the composition fits in
 * EVERY district's civic square. Derived from the geometry once, so a transferring monument
 * never changes size just because of its new district's angle.
 */
const civicScaleCache = new Map<number, number>()
export function civicScale(count: number): number {
  const cached = civicScaleCache.get(count)
  if (cached !== undefined) return cached
  const fitsAll = (s: number) => DISTRICTS.every((d) => civicPadsFit(d.id, civicPads(d.id, count, s)))
  let scale = 1
  if (!fitsAll(1)) {
    let lo = 0
    let hi = 1
    for (let k = 0; k < 24; k++) {
      const m = (lo + hi) / 2
      if (fitsAll(m)) lo = m
      else hi = m
    }
    scale = Math.floor(lo * 1000) / 1000
  }
  civicScaleCache.set(count, scale)
  return scale
}

export function civicSlotWorld(districtId: DistrictId, index: number, count: number): WorldPoint & { scale: number } {
  const [u, v] = (CIVIC_TEMPLATES[count] ?? CIVIC_TEMPLATES[1])[index]
  return { ...civicTemplatePoint(districtId, u, v), scale: civicScale(count) }
}
