import { describe, expect, it } from 'vitest'
import { BILLBOARD_FACADE, CROWN_GAP, CROWN_STEM, crownAnchor, crownScale, facadeBillboardWidth, ROOFTOP_BILLBOARD, roofHeightPx, rooftopExtent, sectionsFor } from './buildingGeometry'
import { boxCorners, footprintHalf, TAN30 } from './geometry'

describe('T4 facade billboard proportion', () => {
  it('follows facade width with a modest overhang, within a useful range', () => {
    expect(facadeBillboardWidth(10)).toBe(BILLBOARD_FACADE.min)
    expect(facadeBillboardWidth(24)).toBe(32)
    expect(facadeBillboardWidth(60)).toBe(BILLBOARD_FACADE.max)
  })
  it('is narrower than the previous fixed 40px panel on a real Tier 4 shaft', () => {
    const shaft = sectionsFor(4, 200, footprintHalf(4)).find((s) => s.kind === 'shaft')!
    const faceW = boxCorners(shaft.a).faceW
    const bw = facadeBillboardWidth(faceW)
    expect(bw).toBeLessThan(40)
    expect(bw - faceW).toBeLessThanOrEqual(2 * BILLBOARD_FACADE.overhang + 1)
  })
})

describe('City Crown anchor floats above the highest rooftop attachment', () => {
  const ROOFS = ['flat', 'terrace', 'dome', 'spire', 'crown-deck', 'halo']
  const SCALES = [crownScale(false), crownScale(true)]
  const topA = 0.5
  const plain = { roof: 'terrace', rooftop: 'none', topA, tier: 5, stage: 3, billboard: false }
  /** Bottom of the crown body (top of its stem), px above the roof plane. */
  const body = (base: number, scale: number) => base + CROWN_STEM * scale

  it('keeps the classic position when nothing tall stands on the roof', () => {
    for (const roof of ROOFS)
      for (const rooftop of ['none', 'antenna', 'garden', 'beacon', 'helipad', 'sign'])
        for (const scale of SCALES)
          for (const tier of [1, 3, 5, 6]) {
            const roofH = roofHeightPx(roof, topA)
            // A billboard below Tier 5 hangs on the facade, not the roof: no effect either.
            const anchor = crownAnchor(roofH, rooftopExtent({ ...plain, roof, rooftop, tier, billboard: tier < 5 }), scale)
            expect(anchor, `${roof}/${rooftop} T${tier} ×${scale}`).toEqual({ base: roofH, stem: 0 })
          }
  })

  it('rises above a rooftop billboard with a small gap, at every zoom scale', () => {
    for (const [tier, panel] of [[5, ROOFTOP_BILLBOARD.skyline], [6, ROOFTOP_BILLBOARD.landmark]] as const) {
      const frame = ROOFTOP_BILLBOARD.frame
      // The frame's top-left corner, exactly as RooftopBillboard draws it.
      const billboardTop = panel.w / 2 + panel.legs + frame + (panel.w / 2 + frame) * TAN30
      const frameTopAtCentre = panel.w / 2 + panel.legs + frame
      for (const roof of ROOFS)
        for (const scale of SCALES) {
          const roofH = roofHeightPx(roof, topA)
          const extent = rooftopExtent({ ...plain, roof, tier, billboard: true })
          expect(extent.top).toBeCloseTo(Math.max(roofH, billboardTop), 6)
          const { base, stem } = crownAnchor(roofH, extent, scale)
          // The whole crown body clears the highest point of the billboard...
          expect(body(base, scale)).toBeGreaterThanOrEqual(billboardTop + CROWN_GAP - 1e-9)
          // ...by a small, intentional gap (never shoved far away), unless a taller roof
          // (a spire) already holds it higher.
          if (roofH + CROWN_STEM * scale <= billboardTop + CROWN_GAP) expect(body(base, scale)).toBeCloseTo(billboardTop + CROWN_GAP, 6)
          expect(base).toBeGreaterThanOrEqual(roofH)
          // The mast starts above the frame on the centre line, so it never crosses the media,
          // and ends at the crown body (it never inverts).
          const mast = base - stem * scale
          expect(mast).toBeGreaterThanOrEqual(frameTopAtCentre)
          expect(mast).toBeLessThanOrEqual(body(base, scale))
        }
    }
  })

  it('also clears a construction crane, and never drops below the classic position', () => {
    for (const scale of SCALES)
      for (let stage = 1; stage <= 10; stage++) {
        const extent = rooftopExtent({ ...plain, tier: 4, stage })
        const roofH = roofHeightPx('terrace', topA)
        const { base } = crownAnchor(roofH, extent, scale)
        expect(base).toBeGreaterThanOrEqual(roofH)
        expect(body(base, scale)).toBeGreaterThanOrEqual(extent.top + CROWN_GAP - 1e-9)
        if (stage < 7) expect(base).toBe(roofH)
      }
    // Tier 6 has no next section under construction.
    expect(rooftopExtent({ ...plain, tier: 6, stage: 10 })).toEqual({ top: 12, axis: 12 })
  })
})
