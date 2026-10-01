import { describe, expect, it } from 'vitest'
import { DISTRICT_IDS } from '../../config/districts'
import { plotWorld, wardCapacity } from '../../game/world'
import { footprintHalf, iso, isoEllipse, isoW, LOT_MARGIN, place, placeBuilding, rotateScreen } from './geometry'
import { minClearance, propertyLotHalf } from './roads'
import { normalizeAngle, ROTATION_STEP_DEG, rotatePointAroundCenter, shortestAngleDelta } from './rotation'

describe('angle helpers', () => {
  it('normalizeAngle wraps cleanly into [0, 360)', () => {
    expect(normalizeAngle(0)).toBe(0)
    expect(normalizeAngle(360)).toBe(0)
    expect(normalizeAngle(-360)).toBe(0)
    expect(normalizeAngle(-15)).toBe(345)
    expect(normalizeAngle(725)).toBe(5)
    expect(normalizeAngle(-725)).toBe(355)
    expect(Object.is(normalizeAngle(-0), 0)).toBe(true)
    // A tiny negative must not round up to 360.
    expect(normalizeAngle(-1e-15)).toBe(0)
    for (let k = -50; k <= 50; k++) {
      const a = normalizeAngle(k * ROTATION_STEP_DEG)
      expect(a).toBeGreaterThanOrEqual(0)
      expect(a).toBeLessThan(360)
      expect(a % ROTATION_STEP_DEG).toBe(0)
    }
  })

  it('a full orbit of steps lands exactly back on 0°', () => {
    let a = 0
    for (let i = 0; i < 360 / ROTATION_STEP_DEG; i++) a = normalizeAngle(a + ROTATION_STEP_DEG)
    expect(a).toBe(0)
    for (let i = 0; i < 360 / ROTATION_STEP_DEG; i++) a = normalizeAngle(a - ROTATION_STEP_DEG)
    expect(a).toBe(0)
  })

  it('shortestAngleDelta takes the short way round', () => {
    expect(shortestAngleDelta(350, 10)).toBe(20)
    expect(shortestAngleDelta(10, 350)).toBe(-20)
    expect(shortestAngleDelta(90, 0)).toBe(-90)
    expect(shortestAngleDelta(345, 0)).toBe(15)
    expect(shortestAngleDelta(0, 180)).toBe(180)
    expect(shortestAngleDelta(725, 5)).toBe(0)
  })
})

describe('rotatePointAroundCenter', () => {
  it('0° returns the point untouched and never mutates its input', () => {
    const p = { x: 12.5, y: -7.25 }
    expect(rotatePointAroundCenter(p, 0)).toEqual(p)
    rotatePointAroundCenter(p, 90)
    expect(p).toEqual({ x: 12.5, y: -7.25 })
  })

  it('turns about City Hall, keeping every distance from the centre', () => {
    const q = rotatePointAroundCenter({ x: 1, y: 0 }, 90)
    expect(q.x).toBeCloseTo(0)
    expect(q.y).toBeCloseTo(1)
    const p = plotWorld('d4', 0, 6)
    for (let deg = -720; deg <= 720; deg += 37) {
      const r = rotatePointAroundCenter(p, deg)
      expect(Math.hypot(r.x, r.y)).toBeCloseTo(Math.hypot(p.x, p.y), 9)
    }
  })

  it('is undone by the opposite turn and by a full orbit of steps', () => {
    const p = plotWorld('d7', 1, 3)
    const back = rotatePointAroundCenter(rotatePointAroundCenter(p, 135), -135)
    expect(back.x).toBeCloseTo(p.x, 9)
    expect(back.y).toBeCloseTo(p.y, 9)
    let o = p
    for (let i = 0; i < 24; i++) o = rotatePointAroundCenter(o, ROTATION_STEP_DEG)
    expect(o.x).toBeCloseTo(p.x, 9)
    expect(o.y).toBeCloseTo(p.y, 9)
  })

  it('supports another centre', () => {
    const r = rotatePointAroundCenter({ x: 3, y: 2 }, 180, { x: 2, y: 2 })
    expect(r.x).toBeCloseTo(1)
    expect(r.y).toBeCloseTo(2)
  })
})

describe('rotated projection', () => {
  it('0° is the existing projection, bit for bit', () => {
    for (const d of DISTRICT_IDS) {
      const w = plotWorld(d, 0, 0)
      expect(isoW(w, 0)).toEqual(isoW(w))
      expect(iso(w.x, w.y, 0)).toEqual({ x: (w.x - w.y) * 0.8660254 * 16, y: (w.x + w.y) * 0.5 * 16 })
      expect(place(w, 0)).toEqual(place(w))
    }
  })

  it('rotation is presentation only: placements keep their world point and plot address', () => {
    const b = { districtId: 'd4', ward: 0, plot: 6 } as const
    const at0 = placeBuilding(b)
    const at90 = placeBuilding(b, 90)
    expect(at90.world).toEqual(at0.world)
    expect(at90.world).toEqual(plotWorld('d4', 0, 6))
    expect(at90.screen).not.toEqual(at0.screen)
    // Depth order follows the turned city (what is in front is drawn last).
    const r = rotatePointAroundCenter(at0.world, 90)
    expect(at90.depth).toBeCloseTo(r.x + r.y, 9)
  })

  it('rotateScreen is the screen-space twin of rotating the world point', () => {
    const w = plotWorld('d2', 1, 9)
    for (const deg of [15, 45, 90, 200, 345, -30]) {
      const viaScreen = rotateScreen(isoW(w), deg)
      const viaWorld = isoW(w, deg)
      expect(viaScreen.x).toBeCloseTo(viaWorld.x, 6)
      expect(viaScreen.y).toBeCloseTo(viaWorld.y, 6)
      const back = rotateScreen(viaScreen, -deg)
      expect(back.x).toBeCloseTo(isoW(w).x, 6)
      expect(back.y).toBeCloseTo(isoW(w).y, 6)
    }
  })

  it('the city footprint is the same ellipse at every angle (overview framing still fits)', () => {
    const r = 90
    const e = isoEllipse(r)
    for (let deg = 0; deg < 360; deg += ROTATION_STEP_DEG)
      for (let a = 0; a < 360; a += 20) {
        const p = iso(r * Math.cos((a * Math.PI) / 180), r * Math.sin((a * Math.PI) / 180), deg)
        expect((p.x / e.rx) ** 2 + (p.y / e.ry) ** 2).toBeCloseTo(1, 6)
      }
  })
})

describe('road clearance while the city is rotated', () => {
  const WARDS = [0, 1, 4]
  const MIN_GAP_PX = 2

  it('lots, podiums and open plots clear every turned road at representative angles', () => {
    for (const rot of [15, 45, 90, 135, 200, 345])
      for (const d of DISTRICT_IDS)
        for (const w of WARDS)
          for (let i = 0; i < wardCapacity(w); i++) {
            const p = plotWorld(d, w, i)
            for (const tier of [0, 6]) {
              const lot = propertyLotHalf(d, w, i, tier, rot)
              expect(lot).toBeGreaterThan(footprintHalf(tier))
              expect(minClearance(d, w, p, lot, rot).px, `${d} w${w} p${i} T${tier} @${rot}°`).toBeGreaterThanOrEqual(MIN_GAP_PX)
            }
            expect(minClearance(d, w, p, footprintHalf(6), rot).px).toBeGreaterThanOrEqual(MIN_GAP_PX)
          }
  })

  it('open-plot and placement sites keep their full size at every rotation step', () => {
    for (let rot = 0; rot < 360; rot += ROTATION_STEP_DEG)
      for (const d of DISTRICT_IDS)
        for (const w of [0, 1])
          for (let i = 0; i < wardCapacity(w); i++) expect(propertyLotHalf(d, w, i, 0, rot)).toBe(footprintHalf(0) + LOT_MARGIN)
  })
})
