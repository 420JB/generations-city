import { memo, useMemo } from 'react'
import { WORLD } from '../../config/world'
import { isoEllipse, isoW, polar, type Pt } from './geometry'

/**
 * The world just outside Rare City: a calm night sea and the low island the city stands on.
 *
 * PRESENTATION ONLY. Everything here is static scenery behind the city: a dozen filled shapes,
 * no animation, no filters, nothing a camera, a plot or the game state knows about. Shapes are
 * fixed functions of the bearing from City Hall (no randomness), projected through `isoW` like
 * the rest of the ground, so the coast turns with the city.
 *
 * The camera repaints the whole map on every move, so nothing is painted twice: the sea is the
 * only shape under the land, and the bands along the shore are rings, not stacked discs.
 */

/** Coastline harmonics [cycles per turn, weight, phase°]: three uneven capes, three uneven bays. */
const COAST: readonly (readonly [number, number, number])[] = [
  [1, 0.16, 40],
  [2, 0.24, 200],
  [3, 0.22, 75],
  [4, 0.12, 150],
  [6, 0.07, 310],
  [9, 0.035, 20],
]
/** Range of the full harmonic sum (fixed by the table above), used to normalise it to 0..1. */
const COAST_MIN = -0.537
const COAST_SPAN = 0.972

/** How far the shore bulges at `deg`, 0 (deepest bay) to 1 (longest cape). Fewer `terms` = smoother. */
function shoreBulge(deg: number, terms = COAST.length): number {
  let sum = 0
  for (let i = 0; i < terms; i++) {
    const [k, w, phase] = COAST[i]
    sum += w * Math.sin(((k * deg + phase) * Math.PI) / 180)
  }
  return (sum - COAST_MIN) / COAST_SPAN
}

/** Shore radius at `deg` for a city of `radius`: always clear of the next ward to open. */
function shoreRadius(radius: number, deg: number, terms?: number): number {
  return (radius + WORLD.wardDepth + 3) * (1.02 + 0.34 * shoreBulge(deg, terms))
}

const SHORE_STEPS = 360

/** Closed outline at shore + `pad` world units (negative = inland), as an SVG subpath. */
function shorePath(radius: number, rot: number, pad: number, terms?: number): string {
  const pts: Pt[] = []
  for (let i = 0; i < SHORE_STEPS; i++) {
    const deg = (i * 360) / SHORE_STEPS
    pts.push(isoW(polar(shoreRadius(radius, deg, terms) + pad, deg), rot))
  }
  return subpath(pts)
}

function subpath(pts: Pt[]): string {
  return `M${pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L')}Z`
}

/** Offshore islets [bearing°, distance past the shore, size, shape phase°], clear of the shore's own shallows. */
const ISLETS: readonly (readonly [number, number, number, number])[] = [
  [-166, 22, 4.4, 30],
  [-57, 19, 2.6, 140],
  [47, 21, 3.6, 250],
]
const ISLET_STEPS = 40

function isletPath(radius: number, rot: number, [bearing, off, size, phase]: (typeof ISLETS)[number], pad: number): string {
  const c = polar(shoreRadius(radius, bearing) + off, bearing)
  const pts: Pt[] = []
  for (let i = 0; i < ISLET_STEPS; i++) {
    const a = (i * 360) / ISLET_STEPS
    const rad = (a * Math.PI) / 180
    const r = size * (1 + 0.24 * Math.sin(2 * rad + phase) + 0.13 * Math.sin(3 * rad + 2 * phase)) + pad
    pts.push(isoW({ x: c.x + r * Math.cos(rad), y: c.y + r * Math.sin(rad) }, rot))
  }
  return subpath(pts)
}

/** Groves [bearing°, how far from the last ward toward the shore (0..1), trees]. Skipped where the land is too narrow. */
const GROVES: readonly (readonly [number, number, number])[] = [
  [-108, 0.55, 6],
  [-93, 0.3, 4],
  [-30, 0.6, 7],
  [-12, 0.3, 5],
  [6, 0.66, 4],
  [88, 0.5, 5],
  [112, 0.72, 4],
  [128, 0.4, 8],
  [146, 0.68, 6],
]
/** Tree offsets inside a grove (world units) and canopy size, in planting order. */
const GROVE_SPOTS: readonly (readonly [number, number, number])[] = [
  [0, 0, 1],
  [1.9, 0.7, 0.82],
  [-1.3, 1.6, 0.9],
  [0.8, -1.9, 0.74],
  [-2.3, -0.7, 0.86],
  [3.1, -1.4, 0.7],
  [-0.4, 3.2, 0.78],
  [2.6, 2.7, 0.66],
]

/** Low ground cover beyond the next ward: patches scattered by fixed irrational steps (even, never a grid, never random). */
const SCRUB_PATCHES = 56
const frac = (v: number) => v - Math.floor(v)

/** A world-space circle lying on the ground (an ellipse on screen), as an SVG subpath. */
function groundDisc(c: Pt, r: number): string {
  const e = isoEllipse(r)
  const rx = e.rx.toFixed(1)
  const ry = e.ry.toFixed(1)
  return `M${(c.x - e.rx).toFixed(1)} ${c.y.toFixed(1)}a${rx} ${ry} 0 1 0 ${(2 * e.rx).toFixed(1)} 0a${rx} ${ry} 0 1 0 ${(-2 * e.rx).toFixed(1)} 0Z`
}

const circle = (x: number, y: number, r: number) => `M${(x - r).toFixed(1)} ${y.toFixed(1)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`

export const CityPerimeter = memo(function CityPerimeter({ radius, rot }: { radius: number; rot: number }) {
  const d = useMemo(() => {
    const islets = (pad: number) => ISLETS.map((i) => isletPath(radius, rot, i, pad)).join('')
    const shallows = shorePath(radius, rot, 5.5, 5)
    const shore = shorePath(radius, rot, 0)
    const inland = shorePath(radius, rot, -3.5, 5)
    const edge = radius + WORLD.wardDepth + 3
    // Each patch is a few overlapping discs (one filled outline), so no two share a shape.
    let scrub = ''
    for (let i = 1; i <= SCRUB_PATCHES; i++) {
      const deg = frac(i * 0.381966) * 360
      const room = shoreRadius(radius, deg) - 5 - edge
      if (room < 3) continue
      const c = polar(edge + room * frac(i * 0.414214), deg)
      const r = 1.2 + 1.8 * frac(i * 0.754878)
      for (let lobe = 0; lobe < 3; lobe++) {
        const a = frac(i * 0.56984 + lobe * 0.29) * 2 * Math.PI
        const off = lobe ? r * (0.55 + 0.25 * lobe) : 0
        scrub += groundDisc(isoW({ x: c.x + off * Math.cos(a), y: c.y + off * Math.sin(a) }, rot), r * (1 - 0.22 * lobe))
      }
    }
    let shade = ''
    let canopy = ''
    let light = ''
    for (const [bearing, along, count] of GROVES) {
      const room = shoreRadius(radius, bearing) - 5 - edge
      if (room < 5) continue
      const c = polar(edge + room * along, bearing)
      for (const [dx, dy, size] of GROVE_SPOTS.slice(0, count)) {
        const p = isoW({ x: c.x + dx, y: c.y + dy }, rot)
        const r = Math.round(6.2 * size * 10) / 10
        shade += groundDisc(p, r / 13)
        canopy += circle(p.x, p.y - r * 1.1, r)
        light += circle(p.x - r * 0.3, p.y - r * 1.4, Math.round(r * 5.2) / 10)
      }
    }
    return {
      // Rings (even-odd): each band is painted once, and never under the land. A ring's hole
      // ends just under the shape painted next, so no hairline of sea shows between them.
      shelf: shorePath(radius, rot, 13, 4) + shallows,
      shallows: shallows + inland,
      strand: shore + shorePath(radius, rot, -4.5, 5),
      inland,
      isletShallows: islets(2.2),
      islets: islets(0),
      scrub,
      shade,
      canopy,
      light,
    }
  }, [radius, rot])
  const sea = isoEllipse((radius + WORLD.wardDepth + 14) * 1.9)
  return (
    <g className="perimeter" data-testid="city-perimeter">
      {/* The sea is the map's backdrop: the one shape here a click or drag can land on. */}
      <ellipse rx={sea.rx} ry={sea.ry} fill="url(#perimeter-sea)" />
      <g pointerEvents="none">
        <path d={d.shelf} fillRule="evenodd" fill="#4f7fc4" fillOpacity={0.07} />
        <path d={d.shallows} fillRule="evenodd" fill="#568bcb" fillOpacity={0.16} />
        <path d={d.isletShallows} fill="#568bcb" fillOpacity={0.14} />
        {/* A pale strand at the water's edge, then the darker ground the city is built on. */}
        <path d={d.strand} fillRule="evenodd" fill="#1d2937" />
        <path d={d.islets} fill="#1d2937" />
        <path d={d.inland} fill="#111a24" />
        <path d={d.scrub} fill="#1a2b30" fillOpacity={0.45} />
        <path d={d.shade} fill="#04070d" fillOpacity={0.45} />
        <path d={d.canopy} fill="#163c31" />
        <path d={d.light} fill="#1f5544" />
      </g>
    </g>
  )
})
