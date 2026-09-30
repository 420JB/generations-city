import { describe, expect, it } from 'vitest'
import { centeredFraming, clampFraming, FRAME, panFraming, sourceRect, zoomFraming } from './billboardCrop'

describe('billboard framing', () => {
  it('centres a wide image so it covers the 2:1 frame', () => {
    const f = centeredFraming(1000, 250)
    // 1000x250 is 4:1 -> height-bound: scale 0.96, width 960
    expect(f.zoom).toBe(1)
    expect(f.y).toBe(0)
    expect(f.x).toBeCloseTo((FRAME.w - 960) / 2)
    const r = sourceRect(f, 1000, 250)
    expect(r.sh).toBeCloseTo(250)
    expect(r.sw).toBeCloseTo(500)
    expect(r.sx).toBeCloseTo(250)
  })
  it('never leaves empty edges when panning', () => {
    const f = centeredFraming(800, 800)
    const far = panFraming(f, 800, 800, 5000, 5000)
    expect(far.x).toBe(0)
    expect(far.y).toBe(0)
    const other = panFraming(f, 800, 800, -5000, -5000)
    expect(other.x).toBeCloseTo(FRAME.w - 480)
    expect(other.y).toBeCloseTo(FRAME.h - 480)
  })
  it('zooming keeps the centre point and clamps the range', () => {
    const f = centeredFraming(600, 300)
    const z = zoomFraming(f, 600, 300, 2)
    const before = sourceRect(f, 600, 300)
    const after = sourceRect(z, 600, 300)
    expect(after.sw).toBeCloseTo(before.sw / 2)
    expect(after.sx + after.sw / 2).toBeCloseTo(before.sx + before.sw / 2)
    expect(zoomFraming(f, 600, 300, 99).zoom).toBe(4)
    expect(clampFraming({ zoom: 0.2, x: 0, y: 0 }, 600, 300).zoom).toBe(1)
  })
})
