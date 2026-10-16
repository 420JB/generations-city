import type { District, RadialWedgeParams, World } from './definition'

/**
 * Geometry of a world's radial-wedge layout, from its definition alone.
 *
 * Wards are derived from their index on demand, with no pre-generation; whether a ward may
 * open is the layout's `wardLimit`. The arithmetic is written in the same order as the
 * legacy `src/game/world.ts`, so the Rare Friends preset gives bit-identical results
 * (pinned by `rareCity.test.ts`).
 */
export interface WardBand {
  ward: number
  inner: number
  outer: number
}

export interface PlotRow {
  r: number
  count: number
}

export interface Point {
  x: number
  y: number
}

function assertWard(ward: number) {
  if (!Number.isSafeInteger(ward) || ward < 0) throw new Error(`Invalid ward ${ward}`)
}

/** Ward 0 spans the district core; ward N >= 1 is the band one ward depth farther out. */
export function wardBandOf(world: World, ward: number): WardBand {
  assertWard(ward)
  const p = world.layout.params
  if (ward === 0) return { ward, inner: p.coreWardInner, outer: p.coreWardOuter }
  const inner = p.coreWardOuter + (ward - 1) * p.wardDepth
  return { ward, inner, outer: inner + p.wardDepth }
}

/**
 * Plot rows of ward `ward` in a wedge `spanDeg` wide, from raw parameters. `compileWorld`
 * uses this before a `World` exists; everything else goes through `wardRowsOf`.
 */
export function plotRowsFor(params: Readonly<RadialWedgeParams>, spanDeg: number, ward: number): PlotRow[] {
  const base = params.firstPlotRadius + ward * params.wardDepth
  const usableRad = (2 * (spanDeg / 2 - params.marginDeg) * Math.PI) / 180
  return params.rowOffsets.map((off) => {
    const r = base + off
    return { r, count: Math.max(1, Math.floor((usableRad * r) / params.plotSpacing)) }
  })
}

/** Plot rows of a ward in a district. Outer wards are longer arcs, so they hold more plots. */
export function wardRowsOf(world: World, district: District, ward: number): PlotRow[] {
  assertWard(ward)
  return plotRowsFor(world.layout.params, district.spanDeg, ward)
}

/** How many plots a ward of a district holds. Depends on the district's wedge, so districts of different widths differ. */
export function wardCapacityOf(world: World, district: District, ward: number): number {
  return wardRowsOf(world, district, ward).reduce((a, r) => a + r.count, 0)
}

/** True when a ward index is one the layout allows at all (below its `wardLimit`). */
export function wardAllowed(world: World, ward: number): boolean {
  return Number.isSafeInteger(ward) && ward >= 0 && ward < world.layout.wardLimit
}

/** True when a district that has `openWards` wards open may open one more. */
export function canOpenWard(world: World, openWards: number): boolean {
  return wardAllowed(world, openWards)
}

/** Plot address -> (radius, angle offset from the district's centre line). */
export function plotPolarOf(world: World, district: District, ward: number, plot: number): { r: number; offsetDeg: number } {
  const rows = wardRowsOf(world, district, ward)
  let i = plot
  for (const row of rows) {
    if (i < row.count) {
      const usable = 2 * (district.spanDeg / 2 - world.layout.params.marginDeg)
      const offsetDeg = -usable / 2 + (usable * (i + 0.5)) / row.count
      return { r: row.r, offsetDeg }
    }
    i -= row.count
  }
  throw new Error(`Plot ${plot} out of range for ward ${ward}`)
}

/** Ground-plane position of a plot, with the city centre at the origin. */
export function plotPointOf(world: World, district: District, ward: number, plot: number): Point {
  const p = plotPolarOf(world, district, ward, plot)
  const a = ((district.centerDeg + p.offsetDeg) * Math.PI) / 180
  return { x: p.r * Math.cos(a), y: p.r * Math.sin(a) }
}
