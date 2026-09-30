import { DISTRICTS, type DistrictId } from '../../config/districts'
import { WORLD } from '../../config/world'
import { floorsFor } from '../../game/economy'
import type { Building } from '../../game/types'
import { districtAngle, plotWorld, polar, type WorldPoint } from '../../game/world'

/**
 * SVG strategic-map projection. World layout lives in `game/world.ts`; this module only
 * projects world coordinates to isometric screen space and holds SVG drawing helpers.
 */

/** Pixels per world unit. */
export const S = 16
export const COS30 = 0.8660254
export const TAN30 = 0.5773503
export const FLOOR_PX = 12

export const PLAZA_R = WORLD.plazaRadius
export const RING_OUTER = WORLD.ringRoadOuter

export { districtAngle, polar }

export interface Pt {
  x: number
  y: number
}

/** World (x, y) on the ground plane → screen pixels (isometric). */
export function iso(x: number, y: number): Pt {
  return { x: (x - y) * COS30 * S, y: (x + y) * 0.5 * S }
}

export function isoW(w: WorldPoint): Pt {
  return iso(w.x, w.y)
}

export function depthOf(w: { x: number; y: number }): number {
  return w.x + w.y
}

function pointsStr(pts: Pt[]): string {
  return pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
}

/** Annular sector of a district between radii r0..r1, inset from the boundary avenues. */
export function sectorPolygon(id: DistrictId, r0: number, r1: number, insetUnits = 1.4): string {
  const a = districtAngle(id)
  const half = WORLD.districtSpanDeg / 2
  const pts: Pt[] = []
  const steps = 18
  const arc = (r: number, reverse: boolean) => {
    const insetDeg = (insetUnits / r) * (180 / Math.PI)
    const from = a - half + insetDeg
    const to = a + half - insetDeg
    for (let i = 0; i <= steps; i++) {
      const t = reverse ? 1 - i / steps : i / steps
      pts.push(isoW(polar(r, from + (to - from) * t)))
    }
  }
  arc(r1, false)
  arc(r0, true)
  return pointsStr(pts)
}

/** Iso polyline along an arc (used for ward boundary streets). */
export function arcPoints(id: DistrictId, r: number, insetUnits = 1.4): Pt[] {
  const a = districtAngle(id)
  const half = WORLD.districtSpanDeg / 2
  const insetDeg = (insetUnits / r) * (180 / Math.PI)
  const pts: Pt[] = []
  for (let i = 0; i <= 18; i++) pts.push(isoW(polar(r, a - half + insetDeg + ((2 * half - 2 * insetDeg) * i) / 18)))
  return pts
}

export function arcPath(id: DistrictId, r: number, insetUnits = 1.4): string {
  return pointsStr(arcPoints(id, r, insetUnits))
}

/** Iso ellipse radii for a world-space circle of radius r. */
export function isoEllipse(r: number) {
  return { rx: r * Math.SQRT2 * COS30 * S, ry: r * Math.SQRT2 * 0.5 * S }
}

/**
 * Footprint half-size (world units) for the base of a building at a tier.
 * Deliberately narrow (≈55% less width/depth than the first pass): dense city blocks,
 * with the skyline carried by height, which is unchanged.
 */
export const FOOTPRINT_HALF = [0.7, 0.75, 0.82, 0.9, 0.98, 1.06, 1.12] as const
export function footprintHalf(tier: number): number {
  return FOOTPRINT_HALF[Math.min(6, Math.max(0, tier))]
}
/** Lot (paved plot) half-size around a building footprint. */
export const LOT_MARGIN = 0.7

export function buildingHeightPx(total: number): number {
  return floorsFor(total) * FLOOR_PX + 4
}

export interface Placement {
  world: WorldPoint
  screen: Pt
  depth: number
}

export function place(w: WorldPoint): Placement {
  return { world: w, screen: isoW(w), depth: depthOf(w) }
}

export function placeBuilding(b: Pick<Building, 'districtId' | 'ward' | 'plot'>): Placement {
  return place(plotWorld(b.districtId, b.ward, b.plot))
}

/** Screen point near the middle of a building (used for camera warp). */
export function buildingFocus(b: Building, total: number): Pt {
  const p = placeBuilding(b).screen
  return { x: p.x, y: p.y - buildingHeightPx(total) * 0.5 }
}

export function districtLabelPos(id: DistrictId, radius: number): Pt {
  return isoW(polar(radius + 5, districtAngle(id)))
}

/** Iso box corner offsets for half-sizes ax (along world x) and ay (along world y). */
export function boxCorners(ax: number, ay: number = ax) {
  const kx = ax * S
  const ky = ay * S
  return {
    N: { x: (ky - kx) * COS30, y: -(kx + ky) * 0.5 },
    E: { x: (kx + ky) * COS30, y: (kx - ky) * 0.5 },
    Sx: { x: (kx - ky) * COS30, y: (kx + ky) * 0.5 },
    W: { x: -(kx + ky) * COS30, y: (ky - kx) * 0.5 },
    /** Width of the left (W→S) face; equals the right face for square boxes. */
    faceW: 2 * COS30 * kx,
    faceWR: 2 * COS30 * ky,
  }
}

/** Transform mapping face-local coords (x along W→S, y down from top z1) onto the left face. */
export function leftFace(ax: number, z1: number, ay: number = ax): string {
  const c = boxCorners(ax, ay)
  return `matrix(1 ${TAN30} 0 1 ${c.W.x.toFixed(2)} ${(c.W.y - z1).toFixed(2)})`
}

/** Transform mapping face-local coords (x along S→E, y down from top z1) onto the right face. */
export function rightFace(ax: number, z1: number, ay: number = ax): string {
  const c = boxCorners(ax, ay)
  return `matrix(1 ${-TAN30} 0 1 ${c.Sx.x.toFixed(2)} ${(c.Sx.y - z1).toFixed(2)})`
}

export function hsl(h: number, s = 70, l = 60): string {
  return `hsl(${h} ${s}% ${l}%)`
}

export const WINDOW_TILES: Record<string, number> = { grid: 8, ribbon: 8, arched: 9, lattice: 8, panoramic: 16 }

/** District gateway: on the avenue between the ring road and the civic square. */
export function gateWorld(id: DistrictId): WorldPoint {
  return polar((WORLD.ringRoadOuter + WORLD.civicSquare.inner) / 2 + 0.2, districtAngle(id))
}

export function pylonWorld(i: number) {
  return polar(PLAZA_R * 0.72, -90 + i * 72 + 36)
}

export type Detail = 'far' | 'mid' | 'near'

/** Detail level from camera zoom (screen pixels per world pixel). */
export function detailFor(zoom: number): Detail {
  return zoom < 0.8 ? 'far' : zoom < 1.3 ? 'mid' : 'near'
}

export const DISTRICT_LIST = DISTRICTS
