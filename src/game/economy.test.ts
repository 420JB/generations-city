import { describe, expect, it } from 'vitest'
import {
  architectLevel,
  buildSplit,
  floorsFor,
  heightMeters,
  landscapeCapacity,
  patronLevel,
  rankedPatrons,
  rfToNextTier,
  stageFor,
  tierFor,
} from './economy'

describe('tier calculation', () => {
  it('maps thresholds to tiers inclusively', () => {
    expect(tierFor(0)).toBe(0)
    expect(tierFor(99)).toBe(0)
    expect(tierFor(100)).toBe(1)
    expect(tierFor(499)).toBe(1)
    expect(tierFor(500)).toBe(2)
    expect(tierFor(2_500)).toBe(3)
    expect(tierFor(9_999)).toBe(3)
    expect(tierFor(10_000)).toBe(4)
    expect(tierFor(50_000)).toBe(5)
    expect(tierFor(250_000)).toBe(6)
    expect(tierFor(9_000_000)).toBe(6)
  })
  it('reports RF to next tier', () => {
    expect(rfToNextTier(9_962)).toBe(38)
    expect(rfToNextTier(250_000)).toBeNull()
  })
})

describe('stage calculation', () => {
  it('has 10 intermediate stages per tier', () => {
    expect(stageFor(10_000)).toBe(1)
    expect(stageFor(13_999)).toBe(1)
    expect(stageFor(14_000)).toBe(2)
    expect(stageFor(49_999)).toBe(10)
    expect(stageFor(50_000)).toBe(1)
    expect(stageFor(0)).toBe(1)
    expect(stageFor(95)).toBe(10)
  })
})

describe('height', () => {
  it('is strictly increasing with RF so the Crown race is visible', () => {
    let prev = -1
    for (const t of [0, 50, 100, 400, 2_500, 9_999, 10_000, 49_000, 180_000, 250_000, 2_000_000]) {
      const f = floorsFor(t)
      expect(f).toBeGreaterThan(prev)
      prev = f
    }
    expect(heightMeters(182_400)).toBeGreaterThan(heightMeters(179_900))
  })
})

describe('owner/community split', () => {
  it('derives totals and percentages', () => {
    const s = buildSplit({ ownerBuilt: 750, patrons: { a: 200, b: 50 } })
    expect(s).toMatchObject({ total: 1_000, owner: 750, community: 250 })
    expect(s.ownerPct).toBe(75)
    expect(s.communityPct).toBe(25)
    expect(buildSplit({ ownerBuilt: 0, patrons: {} }).ownerPct).toBe(0)
  })
})

describe('patron levels', () => {
  it('uses cumulative recognition thresholds', () => {
    expect(patronLevel(0)).toBeNull()
    expect(patronLevel(99)).toBe('supporter')
    expect(patronLevel(100)).toBe('plaque')
    expect(patronLevel(500)).toBe('marker')
    expect(patronLevel(2_500)).toBe('banner')
    expect(patronLevel(10_000)).toBe('crest')
    expect(patronLevel(60_000)).toBe('grand')
  })
  it('ranks patrons deterministically', () => {
    expect(rankedPatrons({ patrons: { z: 10, a: 10, m: 50, q: 0 } }).map((p) => p.userId)).toEqual(['m', 'a', 'z'])
  })
})

describe('architect progression', () => {
  it('only depends on owner spend', () => {
    expect(architectLevel(0)).toBe(0)
    expect(architectLevel(250)).toBe(1)
    expect(architectLevel(8_200)).toBe(3)
    expect(landscapeCapacity(0)).toBe(3)
    expect(landscapeCapacity(1_000_000)).toBe(8)
  })
})
