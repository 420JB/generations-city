import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WORLD } from '../../config/world'
import { parseBrandCityConfig } from '../../brand/core/config'
import { compileBrandWorld } from '../../brand/core/layout'
import { SAMPLE_BRANDS } from '../../brand/samples'
import { brandScene } from '../../brand/scene'
import { Entrance } from './BuildingSprite'
import { entranceExtent, GROUNDS, GROUNDS_ART, GROUNDS_GAP, GROUNDS_SCALE, groundsLayout, groundsRadius, porticoFit } from './buildingGeometry'
import { plotWorldIn, wardCapacityIn } from './districtGeometry'
import { boxCorners, footprintHalf, gateWorld, LOT_MARGIN, TAN30, type Pt } from './geometry'
import { lotHalfWithin, minClearance, roadSafeHalf } from './roads'
import { rotatePointAroundCenter, ROTATION_STEP_DEG } from './rotation'
import type { SceneDistrict } from './scene'

/**
 * ARCHITECT STREET LEVEL GEOMETRY (P1-C2-E4C): entrances stay on their podium face and landscaping stays on the property's
 * own paving, for every plot a brand city draws, at every tier a Districts property reaches (1, 2) and every rotation the
 * camera turns to. Pure: the same functions the sprite draws with.
 */

/** Every plot of the sample brand cities' first five wards, as the renderer places them (`city`: which sample city). */
function brandPlots() {
  const out: { city: number; d: SceneDistrict; ward: number; plot: number }[] = []
  for (const [city, sample] of SAMPLE_BRANDS.entries()) {
    const parsed = parseBrandCityConfig({ ...(sample.config as object), worldId: '0199f1a2-7c3d-7e4f-8a5b-6c7d8e9f0a1b' })
    if (!parsed.ok) throw new Error('sample invalid')
    const compiled = compileBrandWorld(parsed.config)
    if (!compiled.ok) throw new Error('world')
    for (const d of brandScene(parsed.config, compiled.world).districts) for (let ward = 0; ward <= 4; ward++) for (let plot = 0; plot < wardCapacityIn(d, ward); plot++) out.push({ city, d, ward, plot })
  }
  return out
}
const ROTATIONS = Array.from({ length: 360 / ROTATION_STEP_DEG }, (_, i) => i * ROTATION_STEP_DEG)

/** The paved lot the sprite draws for a plot at a tier and rotation (CityView's `roadSafe`, then the sprite's `lot`). */
function lotOf(d: SceneDistrict, ward: number, plot: number, tier: number, rot: number) {
  const safe = roadSafeHalf(d, ward, plotWorldIn(d, ward, plot), rot)
  return rot ? lotHalfWithin(tier, Math.min(footprintHalf(tier) + LOT_MARGIN, safe)) : lotHalfWithin(tier, safe)
}

/** Whether two convex polygons overlap (separating axes). */
function overlap(a: Pt[], b: Pt[]) {
  for (const poly of [a, b])
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]
      const q = poly[(i + 1) % poly.length]
      const n = { x: p.y - q.y, y: q.x - p.x }
      const pa = a.map((v) => v.x * n.x + v.y * n.y)
      const pb = b.map((v) => v.x * n.x + v.y * n.y)
      if (Math.max(...pa) <= Math.min(...pb) || Math.max(...pb) <= Math.min(...pa)) return false
    }
  return true
}
function inside(p: Pt, poly: Pt[]) {
  let sign = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    if (Math.abs(c) < 1e-9) continue
    if (!sign) sign = Math.sign(c)
    else if (Math.sign(c) !== sign) return false
  }
  return true
}

/** The bounding box (face-local px) of an Entrance's markup: every rect, polygon and arched path, strokes included. */
function entranceBox(kind: string, w: number, h: number) {
  const html = renderToStaticMarkup(createElement('svg', null, createElement(Entrance, { kind, w, h, accent: '#ffb34d', trim: '#8391ab' })))
  const m = /matrix\(([\d.]+) 0 0 1 ([\d.-]+) 0\)/.exec(html)
  const fx = m ? (x: number) => Number(m[1]) * x + Number(m[2]) : (x: number) => x
  const xs: number[] = []
  const ys: number[] = []
  for (const r of html.matchAll(/<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)"/g)) {
    xs.push(fx(+r[1]), fx(+r[1] + +r[3]))
    ys.push(+r[2], +r[2] + +r[4])
  }
  for (const p of html.matchAll(/<polygon points="([^"]+)"/g))
    for (const pair of p[1].trim().split(/\s+/)) {
      const [x, y] = pair.split(',').map(Number)
      xs.push(fx(x))
      ys.push(y)
    }
  for (const tag of html.matchAll(/<path [^>]*>/g)) {
    // The only paths an entrance draws: a doorway rising from its foot to an arch (a half circle) and back.
    const p = /d="M([\d.-]+) ([\d.-]+) V([\d.-]+) A([\d.]+) [\d.]+ 0 0 1 ([\d.-]+) [\d.-]+ V[\d.-]+/.exec(tag[0])
    if (!p) throw new Error(`an entrance path this test does not read: ${tag[0]}`)
    const stroke = /stroke-width="([\d.]+)"/.exec(tag[0])
    const pad = stroke ? +stroke[1] / 2 : 0
    xs.push(fx(+p[1]) - pad, fx(+p[5]) + pad)
    ys.push(+p[2], +p[3] - +p[4] - pad)
  }
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
}

describe('Architect entrances stay on their podium face (P1-C2-E4C)', () => {
  it('each entrance\'s art is exactly as wide and high as `entranceExtent` says; a brand city\'s entrances never overhang the podium or reach its top', () => {
    const podium = 28
    for (const tier of [1, 2]) {
      const w = boxCorners(footprintHalf(tier)).faceW
      for (const kind of ['simple', 'awning', 'arch', 'portico', 'grand-portico']) {
        const box = entranceBox(kind, w, podium)
        const e = entranceExtent(kind, w)
        expect(box.x0, `${kind} T${tier}`).toBeCloseTo(w / 2 - e.half, 1)
        expect(box.x1, `${kind} T${tier}`).toBeCloseTo(w / 2 + e.half, 1)
        expect(box.y0, `${kind} T${tier}`).toBeCloseTo(podium - e.rise, 1)
        expect(box.y1).toBeCloseTo(podium, 5)
      }
      // The ones a brand city draws (standard, canopy, arched, portico): inside the face, 1 px clear of each corner (to the
      // markup's 0.01 px precision), and
      // below the podium's top (where the shaft, its windows and floodlights begin).
      for (const kind of ['simple', 'awning', 'arch', 'grand-portico']) {
        const box = entranceBox(kind, w, podium)
        expect(box.x0, kind).toBeGreaterThanOrEqual(1 - 0.005)
        expect(box.x1, kind).toBeLessThanOrEqual(w - 1 + 0.005)
        expect(box.y0, kind).toBeGreaterThanOrEqual(5)
      }
      // The legacy portico (Tier 3+ in Rare City) is unchanged, and would overhang a Districts podium: never drawn there.
      expect(entranceBox('portico', w, podium).x1).toBeGreaterThan(w)
      expect(porticoFit(w)).toBeLessThan(1)
    }
    expect(porticoFit(40)).toBe(1)
  })
})

describe('Architect landscaping stays on the property\'s own paving (P1-C2-E4C)', () => {
  const plots = brandPlots()

  it('7-8. on every plot, at Tier 1 and 2 and every rotation: every piece stands inside its lot, clear of the podium and of every other piece, and the lot clears every road', () => {
    let checked = 0
    const failures: string[] = []
    for (const { d, ward, plot } of plots)
      for (const tier of [1, 2])
        for (const rot of ROTATIONS) {
          const a0 = footprintHalf(tier)
          const lot = lotOf(d, ward, plot, tier, rot)
          const where = `${d.id} w${ward} p${plot} T${tier} ${rot}°`
          // The lot itself (the property's approved paving) clears every road, as Rare City's lots do (every 45°: the
          // envelope is re-derived for each turn, and this measure is the slow one).
          if (rot % 45 === 0 && minClearance(d, ward, plotWorldIn(d, ward, plot), lot, rot).px < 2) failures.push(`lot meets a road: ${where}`)
          for (const key of Object.keys(GROUNDS)) {
            const pieces = groundsLayout(key, a0, lot)
            // Every Districts lot has room for the whole arrangement.
            if (pieces.length !== GROUNDS[key].length) failures.push(`${key} lost pieces: ${where}`)
            for (const [i, p] of pieces.entries()) {
              const r = groundsRadius(p.piece)
              const reach = Math.max(Math.abs(p.world.x), Math.abs(p.world.y))
              if (reach + r > lot - GROUNDS_GAP + 1e-9) failures.push(`${key} ${p.piece} off the lot: ${where}`)
              if (reach - r < a0 + GROUNDS_GAP - 1e-9) failures.push(`${key} ${p.piece} on the podium: ${where}`)
              for (const q of pieces.slice(i + 1)) if (Math.hypot(p.world.x - q.world.x, p.world.y - q.world.y) <= r + groundsRadius(q.piece)) failures.push(`${key} ${p.piece} meets ${q.piece}: ${where}`)
              checked++
            }
          }
        }
    expect(failures).toEqual([])
    expect(checked).toBeGreaterThan(100_000)
  }, 120_000)

  it('8. no piece stands on a neighbour\'s lot (every neighbour on the largest lots, Tier 2), a district gate or the civic centre', () => {
    const failures: string[] = []
    for (const city of new Set(plots.map((p) => p.city)))
      for (const rot of [0, 45, 90, 180, 270]) {
        const mine = plots.filter((p) => p.city === city)
        const lots = mine.map(({ d, ward, plot }) => ({ where: `${d.id} w${ward} p${plot}`, centre: rotatePointAroundCenter(plotWorldIn(d, ward, plot), rot), lot: lotOf(d, ward, plot, 2, rot) }))
        const gates = [...new Set(mine.map((p) => p.d))].map((d) => rotatePointAroundCenter(gateWorld(d), rot))
        // Every lot within 6 world units of each (a lot and its pieces reach under 2), found through a 6-unit grid.
        const cell = (x: number) => Math.floor(x / 6)
        const grid = new Map<string, number[]>()
        lots.forEach((l, i) => grid.set(`${cell(l.centre.x)},${cell(l.centre.y)}`, [...(grid.get(`${cell(l.centre.x)},${cell(l.centre.y)}`) ?? []), i]))
        const near = (a: (typeof lots)[number]) =>
          [-1, 0, 1].flatMap((dx) => [-1, 0, 1].flatMap((dy) => grid.get(`${cell(a.centre.x) + dx},${cell(a.centre.y) + dy}`) ?? [])).filter((j) => Math.hypot(lots[j].centre.x - a.centre.x, lots[j].centre.y - a.centre.y) <= 6)
        for (const [i, a] of lots.entries()) {
          const neighbours = near(a).filter((j) => j !== i)
          for (const key of ['garden', 'courtyard'])
            for (const p of groundsLayout(key, footprintHalf(2), a.lot)) {
              // Lots stay screen-aligned under rotation, so a piece's offset turns with nothing but its plot's centre.
              const at = { x: a.centre.x + p.world.x, y: a.centre.y + p.world.y }
              const r = groundsRadius(p.piece)
              for (const j of neighbours) {
                const b = lots[j]
                if (Math.max(Math.abs(at.x - b.centre.x), Math.abs(at.y - b.centre.y)) - r <= b.lot) failures.push(`${key} ${p.piece} of ${a.where} on ${b.where} at ${rot}°`)
              }
              for (const g of gates) if (Math.hypot(at.x - g.x, at.y - g.y) <= 3) failures.push(`${key} ${p.piece} of ${a.where} at a gate`)
              if (Math.hypot(at.x, at.y) <= WORLD.civicSquare.outer + 1) failures.push(`${key} ${p.piece} of ${a.where} in the civic centre`)
            }
        }
      }
    expect(failures).toEqual([])
  }, 60_000)

  it('no piece hides the entrance, a window face or the building\'s identity: low pieces only before the faces, art only over the lot or the property\'s own building', () => {
    const lots = new Set<string>()
    for (const { d, ward, plot } of plots) for (const tier of [1, 2]) for (const rot of ROTATIONS) lots.add(`${tier}:${lotOf(d, ward, plot, tier, rot).toFixed(4)}`)
    expect(lots.size).toBeGreaterThan(2)
    for (const k of lots) {
      const [tier, lot] = k.split(':').map(Number)
      const a0 = footprintHalf(tier)
      const c = boxCorners(a0)
      const cl = boxCorners(lot)
      const podium = 28
      const w = c.faceW
      // The widest, tallest entrance a brand city draws (every other one lies inside it).
      const e = entranceExtent('grand-portico', w)
      const ent = [
        [w / 2 - e.half, podium],
        [w / 2 + e.half, podium],
        [w / 2 + e.half, podium - e.rise],
        [w / 2 - e.half, podium - e.rise],
      ].map(([lx, ly]) => ({ x: c.W.x + lx, y: c.W.y - podium + TAN30 * lx + ly }))
      const lotPoly = [cl.W, cl.Sx, cl.E, cl.N]
      const own = [c.W, c.Sx, c.E, { x: c.E.x, y: c.E.y - podium }, { x: c.N.x, y: c.N.y - podium }, { x: c.W.x, y: c.W.y - podium }]
      const faceFoot = (x: number) => (x <= 0 ? c.W.y + TAN30 * (x - c.W.x) : c.Sx.y - TAN30 * x)
      for (const key of Object.keys(GROUNDS))
        groundsLayout(key, a0, lot).forEach((p, i) => {
          const half = GROUNDS_ART[p.piece].half * GROUNDS_SCALE
          const top = p.at.y - GROUNDS_ART[p.piece].rise * GROUNDS_SCALE
          const box = [
            { x: p.at.x - half, y: top },
            { x: p.at.x + half, y: top },
            { x: p.at.x + half, y: p.at.y + 1 },
            { x: p.at.x - half, y: p.at.y + 1 },
          ]
          expect(overlap(box, ent), `${key} ${p.piece} T${tier} lot ${lot}`).toBe(false)
          // Before the entrance face and at the corner, only pieces whose top stays below the podium's foot.
          if (GROUNDS[key][i].edge !== 'right')
            for (const x of [box[0].x, p.at.x, box[1].x]) if (x >= c.W.x && x <= c.E.x) expect(top, `${key} ${p.piece}`).toBeGreaterThan(faceFoot(x))
          for (let s = 0; s <= 8; s++)
            for (const y of [top, p.at.y]) {
              const q = { x: box[0].x + (s / 8) * (box[1].x - box[0].x), y }
              expect(inside(q, lotPoly) || inside(q, own), `${key} ${p.piece} T${tier} lot ${lot} at ${q.x},${q.y}`).toBe(true)
            }
        })
    }
  })

  it('a lot too tight for a piece loses the piece rather than spilling it; unknown arrangements draw nothing', () => {
    const a0 = footprintHalf(1)
    expect(groundsLayout('garden', a0, a0 + 0.15)).toEqual([])
    const partial = groundsLayout('garden', a0, a0 + 0.42)
    expect(partial.length).toBeGreaterThan(0)
    expect(partial.length).toBeLessThan(GROUNDS.garden.length)
    for (const p of partial) expect(Math.max(Math.abs(p.world.x), Math.abs(p.world.y)) + groundsRadius(p.piece)).toBeLessThanOrEqual(a0 + 0.42)
    for (const key of ['none', 'pond', '__proto__', 'constructor']) expect(groundsLayout(key, a0, a0 + 0.7)).toEqual([])
  })
})
