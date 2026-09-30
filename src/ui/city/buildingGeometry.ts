import { FLOOR_PX, iso } from './geometry'

export interface Section {
  a: number
  z0: number
  z1: number
  kind: 'podium' | 'shaft' | 'setback' | 'top'
}

export function sectionsFor(tier: number, H: number, a0: number): Section[] {
  if (tier === 0) return [{ a: a0, z0: 0, z1: Math.max(6, H * 0.45), kind: 'podium' }]
  const podiumTop = Math.min(H, FLOOR_PX * 2 + 4)
  const out: Section[] = [{ a: a0, z0: 0, z1: podiumTop, kind: 'podium' }]
  if (H <= podiumTop + 2) return out
  const cuts: [number, number, Section['kind']][] =
    tier <= 3
      ? [[1, 0.84, 'shaft']]
      : tier === 4
        ? [[0.72, 0.84, 'shaft'], [1, 0.64, 'setback']]
        : tier === 5
          ? [[0.6, 0.86, 'shaft'], [0.84, 0.7, 'setback'], [1, 0.52, 'top']]
          : [[0.5, 0.88, 'shaft'], [0.75, 0.74, 'setback'], [0.92, 0.58, 'setback'], [1, 0.4, 'top']]
  let z = podiumTop
  for (const [frac, scale, kind] of cuts) {
    const z1 = Math.max(z + 4, podiumTop + (H - podiumTop) * frac)
    out.push({ a: a0 * scale, z0: z, z1, kind })
    z = z1
  }
  return out
}

/** Landscaping slot positions (world offsets) along the two visible lot edges. */
export function landscapeSlotPos(a0: number, i: number) {
  const L = a0 + 0.5
  const spots = [
    { x: L, y: -0.45 * L },
    { x: -0.45 * L, y: L },
    { x: L, y: 0.45 * L },
    { x: 0.45 * L, y: L },
    { x: L, y: -0.85 * L },
    { x: -0.85 * L, y: L },
    { x: L, y: 0.85 * L },
    { x: 0.85 * L, y: L },
  ]
  const p = spots[i % spots.length]
  return iso(p.x, p.y)
}


/** T4 facade billboard sizing (px): follows the facade width with a small overhang. */
export const BILLBOARD_FACADE = { min: 28, max: 40, overhang: 4 } as const
export function facadeBillboardWidth(faceW: number): number {
  return Math.round(Math.min(BILLBOARD_FACADE.max, Math.max(BILLBOARD_FACADE.min, faceW + 2 * BILLBOARD_FACADE.overhang)))
}
