import { WORLD } from '../../config/world'
import { CIVIC_LAYOUT, CIVIC_TEMPLATES, MONUMENT_PAD_HALF, polar, wardBand, type PlotRow, type WorldPoint } from '../../game/world'
import type { RadialWedgeParams } from '../../world/definition'
import { plotRowsFor } from '../../world/layout'
import type { CityScene, SceneDistrict } from './scene'

/**
 * Per-district geometry of a scene, on the STANDARD radial layout.
 *
 * Ward bands, plot radii and streets are the same for every city (`config/world.ts`); what
 * differs between scenes is where each district's wedge sits and how wide it is. Plot rows
 * come from the generic world engine (`plotRowsFor`), so a plot drawn here stands exactly
 * where the engine says that plot id is. For the legacy nine 40° wedges every function
 * returns bit-for-bit what `game/world.ts` returns (pinned by districtGeometry.test.ts).
 */
export const STANDARD_LAYOUT_PARAMS: Readonly<RadialWedgeParams> = Object.freeze({
  coreWardInner: WORLD.coreWard.inner,
  coreWardOuter: WORLD.coreWard.outer,
  firstPlotRadius: WORLD.firstPlotRadius,
  wardDepth: WORLD.wardDepth,
  rowOffsets: Object.freeze([...WORLD.wardRowOffsets]) as readonly number[],
  plotSpacing: WORLD.plotSpacing,
  marginDeg: WORLD.districtMarginDeg,
})

/** Usable half-span of a district wedge in degrees (excludes the boundary avenues). */
export function usableHalfSpanOf(d: SceneDistrict): number {
  return d.spanDeg / 2 - WORLD.districtMarginDeg
}

export function wardRowsIn(d: SceneDistrict, ward: number): PlotRow[] {
  if (!Number.isInteger(ward) || ward < 0) throw new Error(`Invalid ward ${ward}`)
  return plotRowsFor(STANDARD_LAYOUT_PARAMS, d.spanDeg, ward)
}

export function wardCapacityIn(d: SceneDistrict, ward: number): number {
  return wardRowsIn(d, ward).reduce((a, r) => a + r.count, 0)
}

/** Plot address -> (radius, angle offset from the district centre line). */
export function plotPolarIn(d: SceneDistrict, ward: number, plot: number): { r: number; offsetDeg: number } {
  let i = plot
  for (const row of wardRowsIn(d, ward)) {
    if (i < row.count) {
      const usable = 2 * usableHalfSpanOf(d)
      const offsetDeg = -usable / 2 + (usable * (i + 0.5)) / row.count
      return { r: row.r, offsetDeg }
    }
    i -= row.count
  }
  throw new Error(`Plot ${plot} out of range for ward ${ward}`)
}

export function plotWorldIn(d: SceneDistrict, ward: number, plot: number): WorldPoint {
  const p = plotPolarIn(d, ward, plot)
  return polar(p.r, d.centerDeg + p.offsetDeg)
}

/** Outer radius of the city given how many wards each district has open. */
export function sceneCityRadius(scene: CityScene, openWards: Readonly<Record<string, number>>): number {
  let max: number = WORLD.coreWard.outer
  for (const d of scene.districts) max = Math.max(max, wardBand(Math.max(0, (openWards[d.id] ?? 1) - 1)).outer)
  return max
}

// ---------- civic square (monument plaza) ----------

function civicTemplatePoint(d: SceneDistrict, u: number, v: number): WorldPoint {
  const r = WORLD.civicSquare.center + u
  return polar(r, d.centerDeg + (v / r) * (180 / Math.PI))
}

/** Pads (axis-aligned world squares) of a composition, for placement checks and tests. */
export function civicPadsIn(d: SceneDistrict, count: number, scale: number): { center: WorldPoint; half: number }[] {
  return (CIVIC_TEMPLATES[count] ?? []).map(([u, v]) => ({ center: civicTemplatePoint(d, u, v), half: MONUMENT_PAD_HALF * scale }))
}

/** Every pad inside the district's civic square (with margins) and no two pads closer than the gap. */
export function civicPadsFitIn(d: SceneDistrict, pads: { center: WorldPoint; half: number }[]): boolean {
  const { inner, outer } = WORLD.civicSquare
  const a = (d.centerDeg * Math.PI) / 180
  const halfSpan = ((d.spanDeg / 2) * Math.PI) / 180
  for (const { center: p, half: h } of pads) {
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
 * One uniform scale per monument count and scene: the largest (≤ 1) at which the composition
 * fits in EVERY district's civic square, so a transferring monument never changes size.
 */
const civicScaleCache = new WeakMap<CityScene, Map<number, number>>()
export function sceneCivicScale(scene: CityScene, count: number): number {
  let cache = civicScaleCache.get(scene)
  if (!cache) civicScaleCache.set(scene, (cache = new Map()))
  const cached = cache.get(count)
  if (cached !== undefined) return cached
  const fitsAll = (s: number) => scene.districts.every((d) => civicPadsFitIn(d, civicPadsIn(d, count, s)))
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
  cache.set(count, scale)
  return scale
}

export function civicSlotIn(scene: CityScene, d: SceneDistrict, index: number, count: number): WorldPoint & { scale: number } {
  const [u, v] = (CIVIC_TEMPLATES[count] ?? CIVIC_TEMPLATES[1])[index]
  return { ...civicTemplatePoint(d, u, v), scale: sceneCivicScale(scene, count) }
}
