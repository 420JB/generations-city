import { describe, expect, it } from 'vitest'
import { DISTRICT_FAMILY } from '../../config/districtIdentity'
import { DISTRICT_IDS, getDistrict } from '../../config/districts'
import { FAMILY_ART_METRICS } from '../../config/familyArtMetrics'
import { DEMO_PLAYER_ID } from '../../config/identity'
import { contribute } from '../../game/actions'
import { createSeedState } from '../../game/seed'
import { STATUE_MAX, statueForm } from './familyStatue'

describe('T5 Friend Statue family form', () => {
  it("takes the holding district's family silhouette for all nine families", () => {
    for (const id of DISTRICT_IDS) {
      const f = statueForm(id)
      expect(f.familyKey).toBe(DISTRICT_FAMILY[id])
      expect(f.familyName).toBe(getDistrict(id).name)
      expect(f.image).toBe(getDistrict(id).art.primaryTransparent)
      // Fits the plinth and fills it on at least one axis.
      expect(f.width).toBeLessThanOrEqual(STATUE_MAX.w + 1e-9)
      expect(f.height).toBeLessThanOrEqual(STATUE_MAX.h + 1e-9)
      expect(Math.max(f.width / STATUE_MAX.w, f.height / STATUE_MAX.h)).toBeCloseTo(1)
      // Feet sit on the plinth (y = 0) and the figure is centred.
      const b = FAMILY_ART_METRICS[f.familyKey][1]
      const k = f.imageSize / 512
      expect(f.imageY + b.y1 * k).toBeCloseTo(0)
      expect(f.imageX + ((b.x0 + b.x1) / 2) * k).toBeCloseTo(0)
    }
  })

  it('follows T5 monument possession, which is separate from the Capital', () => {
    const s = createSeedState()
    const holder = s.monuments.m5.holder!
    expect(statueForm(holder).familyKey).toBe(getDistrict(holder).familyKey)
    expect(statueForm('d3').familyName).toBe('Colossus')
    // Capturing the T4 Fountain changes neither the T5 holder nor its sculpture.
    const after = contribute(s, 'b-812', DEMO_PLAYER_ID, 38).state
    expect(after.monuments.m4.holder).toBe('d4')
    expect(after.monuments.m5.holder).toBe(holder)
    expect(statueForm(after.monuments.m5.holder!).familyKey).toBe(statueForm(holder).familyKey)
  })

  it('every family produces a distinct sculpture silhouette', () => {
    expect(new Set(DISTRICT_IDS.map((id) => statueForm(id).image)).size).toBe(9)
  })
})
