import type { LandscapeKind } from '../../config/fixtures'
import { FLOOR_PX, iso, S, TAN30 } from './geometry'

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
export function landscapeSlotPos(a0: number, i: number, lot: number = a0 + 0.7) {
  // Stay on the paved lot (never in the road), but outside the podium.
  const L = Math.max(a0 + 0.1, Math.min(a0 + 0.5, lot - 0.2))
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

/**
 * STREET-LEVEL GROUNDS (P1-C2-E4C): a brand city's Architect landscaping, as fixed arrangements of the standard landscape
 * pieces (`LandscapeItem`). Never placed by a player: each arrangement is a list of pieces at fixed places along the two
 * visible edges of the paved lot, and the layout below is where they stand on a lot of a given size.
 *
 * Every piece stands on the property's own paving: its ground footprint (a circle as wide as its art) lies inside the
 * paved lot the sprite draws (itself the plot's road-safe envelope) and clear of the podium. Pieces stand only in front of
 * the two podium faces or at the lot's front corner, so their art rises against the property's own building; in front of
 * the entrance face (the left one) and at the corner only low pieces stand, short enough to stay below the face, so no
 * piece hides the entrance, a window or the building's label. A piece that does not fit a lot (a lot trimmed tighter
 * than any of the sample cities' first five wards has) is left out rather than moved, so the arrangement can only lose pieces, never spill.
 */
export type GroundsPiece = LandscapeKind

/** Pieces are drawn at this scale of their standard art. */
export const GROUNDS_SCALE = 0.6

/** Each piece's art at scale 1 (px): half its width, and how high it rises above its foot. */
export const GROUNDS_ART: Readonly<Record<GroundsPiece, { half: number; rise: number }>> = {
  tree: { half: 6.5, rise: 18.5 },
  shrub: { half: 5.9, rise: 4.6 },
  planter: { half: 4, rise: 8.1 },
  bench: { half: 5, rise: 6.6 },
  lamp: { half: 7, rise: 22 },
}

/**
 * Where a piece stands: `right` in front of the right podium face, `left` in front of the left (entrance) face, at `t`
 * along it (-1 its back end, 1 its front end); `corner` at the lot's front corner.
 */
type GroundsSpot = { piece: GroundsPiece; edge: 'right' | 'left' | 'corner'; t: number }

/** The arrangements, by grounds key. `none` is bare paving. */
export const GROUNDS: Readonly<Record<string, readonly GroundsSpot[]>> = {
  none: [],
  garden: [
    { piece: 'tree', edge: 'right', t: -0.55 },
    { piece: 'shrub', edge: 'right', t: 0.05 },
    { piece: 'tree', edge: 'right', t: 0.6 },
    { piece: 'planter', edge: 'left', t: -0.55 },
    { piece: 'shrub', edge: 'left', t: 0.55 },
    { piece: 'planter', edge: 'corner', t: 0 },
  ],
  courtyard: [
    { piece: 'lamp', edge: 'right', t: -0.45 },
    { piece: 'shrub', edge: 'right', t: 0.15 },
    { piece: 'lamp', edge: 'right', t: 0.75 },
    { piece: 'planter', edge: 'left', t: -0.6 },
    { piece: 'planter', edge: 'left', t: 0.6 },
    { piece: 'bench', edge: 'corner', t: 0 },
  ],
}

/** World units of clear paving kept between a piece's footprint and the podium, and between it and the lot's edge. */
export const GROUNDS_GAP = 0.06
const ISO_RX = Math.SQRT2 * 0.8660254 * S

/** A piece's ground footprint radius (world units): its art's half width, as a circle on the ground. */
export const groundsRadius = (piece: GroundsPiece) => (GROUNDS_ART[piece].half * GROUNDS_SCALE) / ISO_RX

/**
 * The pieces of arrangement `key` on a lot of half-size `lot` around a podium of half-size `a0` (world units), with where
 * each stands: `world` its foot (offsets from the plot centre), `at` the same on screen. Unknown keys draw nothing.
 */
export function groundsLayout(key: string, a0: number, lot: number): { piece: GroundsPiece; world: { x: number; y: number }; at: { x: number; y: number } }[] {
  const spots = Object.hasOwn(GROUNDS, key) ? GROUNDS[key] : []
  const out: { piece: GroundsPiece; world: { x: number; y: number }; at: { x: number; y: number } }[] = []
  for (const { piece, edge, t } of spots) {
    const r = groundsRadius(piece)
    // As far out on the paving as the piece fits, so low pieces stay well below the face behind them.
    const d = lot - GROUNDS_GAP - r
    if (d - r < a0 + GROUNDS_GAP) continue
    const along = t * a0
    const w = edge === 'right' ? { x: d, y: along } : edge === 'left' ? { x: along, y: d } : { x: d, y: d }
    out.push({ piece, world: w, at: iso(w.x, w.y) })
  }
  return out
}

/**
 * How far each `Entrance` art reaches on its podium face (face-local px): half its width about the face's centre, and how
 * high it rises above the face's foot, mirroring exactly what BuildingSprite draws (strokes included). `grand-portico`
 * (P1-C2-E4C) is the portico fitted to a face of width `w`: its columns and pediment close up so it never overhangs the
 * podium, and keep their full height. Any other kind is the standard door.
 */
export function entranceExtent(kind: string, w: number): { half: number; rise: number } {
  switch (kind) {
    case 'awning':
      return { half: 8, rise: 13 }
    case 'arch':
      return { half: 7.1, rise: 16.1 }
    case 'portico':
      return { half: 14, rise: 21 }
    case 'grand-portico':
      return { half: 14 * porticoFit(w), rise: 21 }
    default:
      return { half: 3.5, rise: 10 }
  }
}

/** The horizontal scale that fits the 28 px portico on a face of width `w`, 1 px in from each corner (never wider than drawn). */
export const porticoFit = (w: number) => Math.min(1, Math.max(0, (w - 2) / 28))

/** T4 facade billboard sizing (px): follows the facade width with a small overhang. */
export const BILLBOARD_FACADE = { min: 28, max: 40, overhang: 4 } as const
export function facadeBillboardWidth(faceW: number): number {
  return Math.round(Math.min(BILLBOARD_FACADE.max, Math.max(BILLBOARD_FACADE.min, faceW + 2 * BILLBOARD_FACADE.overhang)))
}

/**
 * Rooftop billboard panels (px): T5 skyline billboard and T6 landmark screen. The 2:1 media
 * surface stands on `legs` above the roof inside a `frame`-wide border, and runs along the
 * left-face direction (so its left end is its highest point). Shared by the sprite and the
 * Crown anchor so the two can never drift apart.
 */
export const ROOFTOP_BILLBOARD = {
  skyline: { w: 68, legs: 10 },
  landmark: { w: 92, legs: 14 },
  frame: 3,
} as const

/** How far the roof itself rises above the top section (px): the base Crown / label anchor. */
export function roofHeightPx(roof: string, topA: number): number {
  return roof === 'spire' ? 48 : roof === 'halo' ? 26 : roof === 'dome' ? topA * S + 12 : 12
}

/** Heights in px above the roof plane (the top section's upper face). */
export interface RooftopExtent {
  /** Highest point of anything standing on the roof. */
  top: number
  /** Height of the roofline on the building's centre line, where a Crown mast can stand. */
  axis: number
}

/**
 * ROOFTOP EXTENT: how high the visible rooftop attachments reach, mirroring exactly what
 * BuildingSprite draws (roof, rooftop fixture, rooftop billboard, construction crane).
 * Pure and deterministic, so the Crown can always float clear of the tallest of them.
 */
export function rooftopExtent({
  roof,
  rooftop,
  topA,
  tier,
  stage,
  billboard,
}: {
  roof: string
  rooftop: string
  /** Half-size (world units) of the top section. */
  topA: number
  tier: number
  stage: number
  /** The property has the billboard fixture (it stands on the roof from Tier 5). */
  billboard: boolean
}): RooftopExtent {
  const roofH = roofHeightPx(roof, topA)
  let top = roofH
  let axis = roofH
  if (tier > 0) {
    const k = topA * S
    // Rooftop fixtures stand beside the centre line, so they only raise `top`.
    top = Math.max(top, rooftop === 'antenna' ? k * 0.1 + 31 : rooftop === 'sign' ? 23 : rooftop === 'beacon' ? 14 : 0)
  }
  if (billboard && tier >= 5) {
    const { w, legs } = tier >= 6 ? ROOFTOP_BILLBOARD.landmark : ROOFTOP_BILLBOARD.skyline
    const frameTopAtCentre = w / 2 + legs + ROOFTOP_BILLBOARD.frame
    top = Math.max(top, frameTopAtCentre + (w / 2 + ROOFTOP_BILLBOARD.frame) * TAN30)
    // A hair above the frame on the centre line (the top edge slopes under a mast's width).
    axis = Math.max(axis, frameTopAtCentre + CROWN_GAP)
  }
  if (tier > 0 && tier < 6 && stage >= 7) {
    // Scaffold around the next section; from stage 8 a crane stands on the centre line.
    const scaffold = (stage - 6) * 6 + topA * 0.8 * S + (stage >= 8 ? 38 : 0)
    top = Math.max(top, scaffold)
    axis = Math.max(axis, scaffold)
  }
  return { top, axis }
}

/** Clear air (px) kept between the City Crown and the highest rooftop attachment. */
export const CROWN_GAP = 5
/** Crown art, in its own units: a stem from 0 up to the crown body. */
export const CROWN_STEM = 18
/** The Crown is drawn larger at overview so the skyline's tallest tower still reads. */
export function crownScale(far: boolean): number {
  return far ? 2 : 1.4
}

/**
 * CROWN ANCHOR. The City Crown floats above the highest visible rooftop attachment:
 *  - nothing tall on the roof: exactly the classic spot (stem standing on the roofline);
 *  - a rooftop billboard, crane, etc.: the crown body rises to clear it by CROWN_GAP, still
 *    centred on the property, and its stem becomes a mast from the roofline on the centre
 *    line, so it stays visibly tied to the building and never crosses the media.
 * `base` is where the crown art's origin sits (px above the roof plane); `stem` is where its
 * stem / light beam start, in crown units (0 = the classic stem).
 */
export function crownAnchor(roofH: number, extent: RooftopExtent, scale: number): { base: number; stem: number } {
  // Lift from the classic position (exactly 0 when nothing tall stands on the roof).
  const lift = Math.max(0, extent.top + CROWN_GAP - (roofH + CROWN_STEM * scale))
  const base = roofH + lift
  const mast = Math.max(roofH, Math.min(extent.axis, base + CROWN_STEM * scale))
  return { base, stem: (base - mast) / scale }
}
