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

/**
 * Monument placement inside a district's civic square. Held monuments share the square
 * and are laid out left-to-right by tier; the more monuments, the tighter the spacing.
 */
export function civicSlots(count: number): { offsetDeg: number; scale: number }[] {
  if (count <= 0) return []
  const scale = count <= 2 ? 1 : count === 3 ? 0.86 : count === 4 ? 0.72 : 0.62
  const spread = count === 1 ? 0 : count === 2 ? 16 : count === 3 ? 26 : 30
  return Array.from({ length: count }, (_, i) => ({
    offsetDeg: count === 1 ? 0 : -spread / 2 + (spread * i) / (count - 1),
    scale,
  }))
}

export function civicSlotWorld(districtId: DistrictId, index: number, count: number): WorldPoint & { scale: number } {
  const slot = civicSlots(count)[index]
  const p = polar(WORLD.civicSquare.center, districtAngle(districtId) + slot.offsetDeg)
  return { ...p, scale: slot.scale }
}
