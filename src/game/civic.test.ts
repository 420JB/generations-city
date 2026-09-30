import { describe, expect, it } from 'vitest'
import { DISTRICT_IDS, type DistrictId } from '../config/districts'
import { MONUMENTS, type MonumentId } from '../config/monuments'
import { layoutMonuments } from '../ui/city/monumentLayout'
import { civicPads, civicPadsFit, civicScale, civicSlotWorld, CIVIC_LAYOUT, MONUMENT_PAD_HALF } from './world'
import { createSeedState } from './seed'
import type { GameState } from './types'

function minSeparation(d: DistrictId, count: number): number {
  const pads = civicPads(d, count, civicScale(count))
  let min = Infinity
  for (let i = 0; i < pads.length; i++)
    for (let j = i + 1; j < pads.length; j++) {
      const sep = Math.max(Math.abs(pads[i].center.x - pads[j].center.x), Math.abs(pads[i].center.y - pads[j].center.y))
      min = Math.min(min, sep - pads[i].half - pads[j].half)
    }
  return min
}

function holding(state: GameState, d: DistrictId, ids: MonumentId[]): GameState['monuments'] {
  const out = { ...state.monuments }
  for (const id of ids) out[id] = { holder: d, sinceClock: 0 }
  return out
}

describe('civic plaza composition', () => {
  it('fits 1–5 monuments in every district: pads inside the square and never overlapping', () => {
    for (let n = 1; n <= 5; n++)
      for (const d of DISTRICT_IDS) {
        expect(civicPadsFit(d, civicPads(d, n, civicScale(n))), `${d} ×${n}`).toBe(true)
        if (n > 1) expect(minSeparation(d, n)).toBeGreaterThanOrEqual(CIVIC_LAYOUT.padGap - 1e-9)
      }
  })

  it('keeps monuments large: one full-size, and even five stay well above the old crammed scale', () => {
    expect(civicScale(1)).toBe(1)
    const scales = [1, 2, 3, 4, 5].map(civicScale)
    for (let i = 1; i < scales.length; i++) expect(scales[i]).toBeLessThanOrEqual(scales[i - 1])
    expect(civicScale(5)).toBeGreaterThanOrEqual(0.55)
    // The previous single-arc layout overlapped: e.g. its 4-up at scale 0.72 did not fit.
    expect(MONUMENT_PAD_HALF).toBeCloseTo(3.565)
  })

  it('is deterministic per slot and uses radial as well as angular placement', () => {
    for (let n = 1; n <= 5; n++) {
      const a = Array.from({ length: n }, (_, i) => civicSlotWorld('d2', i, n))
      const b = Array.from({ length: n }, (_, i) => civicSlotWorld('d2', i, n))
      expect(a).toEqual(b)
      if (n >= 3) {
        const radii = new Set(a.map((p) => Math.round(Math.hypot(p.x, p.y))))
        expect(radii.size).toBeGreaterThan(1)
      }
    }
  })

  it('transfers keep the falling monument where it stood and raise it in its new slot', () => {
    const s = createSeedState()
    // Sparkling (d2) holding four monuments, then Family (d4) takes the Fountain (m4).
    const before = holding(s, 'd2', ['m2', 'm3', 'm4', 'm5'])
    const standing = layoutMonuments(before, [])
    const was = standing.find((m) => m.monumentId === 'm4' && m.districtId === 'd2')!
    const after = { ...before, m4: { holder: 'd4' as DistrictId, sinceClock: 1 } }
    const during = layoutMonuments(after, [{ key: 't', monumentId: 'm4', from: 'd2', to: 'd4' }])
    const falling = during.find((m) => m.monumentId === 'm4' && m.districtId === 'd2')!
    expect(falling.phase).toBe('falling')
    expect(falling.world).toEqual(was.world)
    expect(falling.scale).toBe(was.scale)
    // Other d2 monuments do not jump while the ruin collapses.
    for (const m of during.filter((x) => x.districtId === 'd2' && x.monumentId !== 'm4'))
      expect(m.world).toEqual(standing.find((x) => x.monumentId === m.monumentId && x.districtId === 'd2')!.world)
    const rising = during.find((m) => m.monumentId === 'm4' && m.districtId === 'd4')!
    expect(rising.phase).toBe('rising')
    const settled = layoutMonuments(after, []).find((m) => m.monumentId === 'm4')!
    expect(rising.world).toEqual(settled.world)
  })

  it('orders slots by monument tier so the same holdings always get the same composition', () => {
    const s = createSeedState()
    const all = holding(s, 'd2', MONUMENTS.map((m) => m.id))
    const a = layoutMonuments(all, []).filter((m) => m.districtId === 'd2')
    expect(a.map((m) => m.monumentId)).toEqual(['m2', 'm3', 'm4', 'm5', 'm6'])
    expect(JSON.stringify(layoutMonuments(all, []))).toBe(JSON.stringify(layoutMonuments(all, [])))
  })
})
