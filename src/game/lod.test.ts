import { describe, expect, it } from 'vitest'
import { intersects, LOD_LIMITS, representativeBuildings, wardRenderMode } from './lod'
import { createSeedState } from './seed'

describe('level of detail', () => {
  it('renders small wards individually and aggregates dense ones at a distance', () => {
    expect(wardRenderMode(7, 'far')).toBe('individual')
    expect(wardRenderMode(LOD_LIMITS.farIndividualPerWard + 1, 'far')).toBe('representatives')
    expect(wardRenderMode(LOD_LIMITS.farIndividualPerWard + 1, 'mid')).toBe('individual')
    expect(wardRenderMode(10_000, 'near')).toBe('individual')
  })
  it('keeps the tallest towers plus must-show buildings', () => {
    const list = Object.values(createSeedState().buildings)
    const reps = representativeBuildings(list, new Set(['b-162']), 3)
    expect(reps.has('b-162')).toBe(true)
    expect(reps.has('b-120')).toBe(true)
    expect(reps.has('b-505')).toBe(true)
    expect(reps.size).toBe(4)
  })
  it('culls by rectangle intersection', () => {
    expect(intersects({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 5, y0: 5, x1: 20, y1: 20 })).toBe(true)
    expect(intersects({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 11, y0: 0, x1: 20, y1: 10 })).toBe(false)
  })
})
