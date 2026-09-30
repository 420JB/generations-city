import { describe, expect, it } from 'vitest'
import { BILLBOARD_FACADE, facadeBillboardWidth, sectionsFor } from './buildingGeometry'
import { boxCorners, footprintHalf } from './geometry'

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
