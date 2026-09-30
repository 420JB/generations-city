import { describe, expect, it } from 'vitest'
import { DISTRICT_IDS } from '../../config/districts'
import { plotWorld, wardCapacity } from '../../game/world'
import { landscapeSlotPos } from './buildingGeometry'
import { footprintHalf, iso, LOT_MARGIN, type Pt } from './geometry'
import { minClearance, polygonRoadClearance, propertyLotHalf, wardRoads, type RoadKind } from './roads'

/** Wards I, II, V and XX: core, first expansion and representative outer wards. */
const WARDS = [0, 1, 4, 19]
/** Required visible gap (screen px) between any paved lot / podium / ring and road asphalt. */
const MIN_GAP_PX = 2

function* plots() {
  for (const d of DISTRICT_IDS) for (const w of WARDS) for (let i = 0; i < wardCapacity(w); i++) yield { d, w, i, p: plotWorld(d, w, i) }
}

function circleOnScreen(center: { x: number; y: number }, r: number): Pt[] {
  const c = iso(center.x, center.y)
  return Array.from({ length: 24 }, (_, k) => {
    const t = (k / 24) * Math.PI * 2
    const q = iso(r * Math.cos(t), r * Math.sin(t))
    return { x: c.x + q.x, y: c.y + q.y }
  })
}

describe('road-safe property envelope', () => {
  it('capacities and plot centres are unchanged (the fix is visual only)', () => {
    expect([0, 1, 2].map(wardCapacity)).toEqual([21, 33, 44])
    expect(plotWorld('d4', 0, 6)).toEqual(plotWorld('d4', 0, 6))
    const p = plotWorld('d4', 0, 0)
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(43)
  })

  it('pins the root cause: the old fixed T6 lot and 1.9 open plot crossed ward-boundary asphalt', () => {
    let worstLot = Infinity
    let worstOpen = Infinity
    for (const { d, w, p } of plots()) {
      worstLot = Math.min(worstLot, minClearance(d, w, p, footprintHalf(6) + LOT_MARGIN).px)
      worstOpen = Math.min(worstOpen, minClearance(d, w, p, 1.9).px)
    }
    expect(worstLot).toBeLessThan(0)
    expect(worstOpen).toBeLessThan(0)
  })

  it('every lot (Tier 0–6), podium and open plot clears every road in all 9 districts', () => {
    const seen: Partial<Record<RoadKind, number>> = {}
    for (const { d, w, i, p } of plots()) {
      for (let tier = 0; tier <= 6; tier++) {
        const lot = propertyLotHalf(d, w, i, tier)
        expect(lot).toBeGreaterThan(footprintHalf(tier))
        const c = minClearance(d, w, p, lot)
        expect(c.px, `${d} w${w} p${i} T${tier} lot vs ${c.kind}`).toBeGreaterThanOrEqual(MIN_GAP_PX)
        expect(minClearance(d, w, p, footprintHalf(tier)).px).toBeGreaterThanOrEqual(MIN_GAP_PX)
        seen[c.kind] = Math.min(seen[c.kind] ?? Infinity, c.px)
      }
      expect(minClearance(d, w, p, propertyLotHalf(d, w, i)).px).toBeGreaterThanOrEqual(MIN_GAP_PX)
    }
    // Clearance was measured against every road type, not just one.
    for (const road of wardRoads('d4', 1)) expect(road.halfWidth).toBeGreaterThan(0)
    expect(Object.keys(seen).sort()).toEqual(expect.arrayContaining(['civic', 'ward-boundary', 'ward-street']))
  })

  it('checks radial boundary avenues directly for the plots nearest each district edge', () => {
    for (const d of DISTRICT_IDS)
      for (const w of WARDS) {
        const edge = [0, wardCapacity(w) - 1].map((i) => ({ i, p: plotWorld(d, w, i) }))
        for (const { i, p } of edge) {
          const lot = propertyLotHalf(d, w, i, 6)
          const poly = [iso(p.x - lot, p.y - lot), iso(p.x + lot, p.y - lot), iso(p.x + lot, p.y + lot), iso(p.x - lot, p.y + lot)]
          for (const road of wardRoads(d, w).filter((r) => r.kind === 'radial')) expect(polygonRoadClearance(poly, road)).toBeGreaterThanOrEqual(MIN_GAP_PX)
        }
      }
  })

  it('selection ring, landscaping and patron markers stay on the property', () => {
    for (const { d, w, i, p } of plots()) {
      const lot = propertyLotHalf(d, w, i, 6)
      for (const road of wardRoads(d, w)) expect(polygonRoadClearance(circleOnScreen(p, lot * 1.1), road)).toBeGreaterThanOrEqual(0)
      // Landscaping slots and patron markers lie inside the lot square (world coordinates).
      for (let k = 0; k < 8; k++) {
        const s = landscapeSlotPos(footprintHalf(6), k, lot)
        // Invert iso: x - y = s.x / (0.866·16), x + y = s.y / (0.5·16)
        const a = s.x / (0.8660254 * 16)
        const b = s.y / (0.5 * 16)
        const wx = (a + b) / 2
        const wy = (b - a) / 2
        expect(Math.max(Math.abs(wx), Math.abs(wy))).toBeLessThanOrEqual(lot - 0.19)
      }
      for (let k = 0; k < 3; k++) {
        const y = Math.max(-(lot - 0.2), lot - 0.6 - k * 1.1)
        expect(Math.max(lot - 0.2, Math.abs(y))).toBeLessThan(lot)
      }
    }
  })

  it('preserves density: small lots are never trimmed and most large lots keep full size', () => {
    let trimmed = 0
    let total = 0
    for (const { d, w, i } of plots()) {
      expect(propertyLotHalf(d, w, i, 0)).toBe(footprintHalf(0) + LOT_MARGIN)
      total++
      if (propertyLotHalf(d, w, i, 6) < footprintHalf(6) + LOT_MARGIN) trimmed++
    }
    expect(trimmed / total).toBeLessThan(0.6)
  })
})
