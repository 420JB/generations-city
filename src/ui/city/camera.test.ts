import { describe, expect, it } from 'vitest'
import { DISTRICT_IDS } from '../../config/districts'
import { standsInView, turnAbout, type Camera } from './camera'
import { placeBuilding, rotateScreen, type Pt } from './geometry'

const SIZE = { w: 1440, h: 900 }
const ANGLES = [0, 30, 60, 90, 135, 180, 270, 345, 360, 725, -15]

/** Where a point of the rotated city lands on screen (px from the viewport centre). */
const onScreen = (p: Pt, cam: Camera): Pt => ({ x: (p.x - cam.x) * cam.zoom, y: (p.y - cam.y) * cam.zoom })

describe('turnAbout', () => {
  const from: Camera = { x: 812.4, y: -233.1, zoom: 3.2, angle: 45 }
  const pivot: Pt = { x: 746.8, y: -4.2 }

  it('starts on the pose it was given', () => {
    const start = turnAbout(from, pivot)(from.angle)
    expect(start.x).toBeCloseTo(from.x, 9)
    expect(start.y).toBeCloseTo(from.y, 9)
    expect(start.zoom).toBe(from.zoom)
    expect(start.angle).toBe(from.angle)
  })

  it('keeps the pivot on the same screen point at every angle, and never changes the zoom', () => {
    const at = turnAbout(from, pivot)
    const ground = rotateScreen(pivot, -from.angle)
    const start = onScreen(pivot, from)
    for (const angle of ANGLES) {
      const cam = at(angle)
      const now = onScreen(rotateScreen(ground, angle), cam)
      expect(now.x).toBeCloseTo(start.x, 6)
      expect(now.y).toBeCloseTo(start.y, 6)
      expect(cam.zoom).toBe(from.zoom)
      expect(cam.angle).toBe(angle)
    }
  })

  it('keeps a real property anchored while the city turns around it, far from City Hall', () => {
    for (const districtId of DISTRICT_IDS) {
      const plot = { districtId, ward: 0, plot: 3 }
      for (const zoom of [1.9, 2.1, 3.2]) {
        const base = placeBuilding(plot).screen
        // Framed on the upper floors: the plot itself is far below the viewport.
        const start: Camera = { x: base.x + 60, y: base.y - 420, zoom, angle: 0 }
        const at = turnAbout(start, base)
        const want = onScreen(base, start)
        for (const angle of ANGLES) {
          const now = onScreen(placeBuilding(plot, angle).screen, at(angle))
          expect(now.x).toBeCloseTo(want.x, 6)
          expect(now.y).toBeCloseTo(want.y, 6)
        }
      }
    }
  })

  it('lands on the same pose whether the turn is eased or cut short, with nothing accumulating', () => {
    const at = turnAbout(from, pivot)
    const direct = at(from.angle + 90)
    // An eased turn visits many angles on the way; a cut-short one jumps straight to the goal.
    for (let a = from.angle; a <= from.angle + 90; a += 0.37) at(a)
    expect(at(from.angle + 90)).toEqual(direct)
    // A full orbit returns exactly to the start.
    const orbit = at(from.angle + 360)
    expect(orbit.x).toBeCloseTo(from.x, 6)
    expect(orbit.y).toBeCloseTo(from.y, 6)
  })

  it('differs from turning the camera centre about City Hall, which drags the pivot across the screen', () => {
    // The former way of finishing a turn early: correct only when the pivot is the screen centre.
    const step = 15
    const cityHall = { ...rotateScreen(from, step), zoom: from.zoom, angle: from.angle + step }
    const moved = onScreen(rotateScreen(pivot, step), cityHall)
    const start = onScreen(pivot, from)
    expect(Math.hypot(moved.x - start.x, moved.y - start.y)).toBeGreaterThan(100)
  })
})

describe('standsInView', () => {
  // A Crown-sized tower: about 460 world px from plot to roof.
  const height = 460
  const base: Pt = { x: 100, y: 500 }
  /** Camera framed on the tower's mid height, as WARP frames it. */
  const framed = (zoom: number) => ({ x: base.x, y: base.y - height / 2, zoom })

  it('counts a tall tower as in view when only its plot has left the viewport', () => {
    // Up close the plot sits below the bottom edge (former test: plot only) but the tower fills the view.
    for (const zoom of [1.97, 2.1, 2.6, 3.2]) {
      expect((height / 2) * zoom).toBeGreaterThan(SIZE.h / 2)
      expect(standsInView(base, height, framed(zoom), SIZE)).toBe(true)
    }
  })

  it('agrees with the plot test while the plot is on screen', () => {
    for (const zoom of [0.7, 1.5, 1.9]) expect(standsInView(base, height, framed(zoom), SIZE)).toBe(true)
    expect(standsInView(base, 0, { x: base.x, y: base.y, zoom: 3.2 }, SIZE)).toBe(true)
  })

  it('is false once the whole property is outside the viewport', () => {
    const zoom = 3.2
    const halfW = SIZE.w / 2 / zoom
    const halfH = SIZE.h / 2 / zoom
    // Roof below the bottom edge.
    expect(standsInView(base, height, { x: base.x, y: base.y - height - halfH - 1, zoom }, SIZE)).toBe(false)
    // Plot above the top edge.
    expect(standsInView(base, height, { x: base.x, y: base.y + halfH + 1, zoom }, SIZE)).toBe(false)
    // Off to either side.
    expect(standsInView(base, height, { x: base.x + halfW + 1, y: base.y - height / 2, zoom }, SIZE)).toBe(false)
    expect(standsInView(base, height, { x: base.x - halfW - 1, y: base.y - height / 2, zoom }, SIZE)).toBe(false)
    // A plot-only property (no height) below the viewport is out of view.
    expect(standsInView(base, 0, framed(zoom), SIZE)).toBe(false)
  })
})
