import { describe, expect, it } from 'vitest'
import { DEFAULT_ARCHITECTURE } from '../config/architecture'
import type { DistrictId } from '../config/districts'
import {
  capitalHolder,
  capitalScore,
  districtStandings,
  districtTierCounts,
  monumentHolder,
  resolveHolder,
  tallestBuilding,
} from './competition'
import type { Building } from './types'

function b(id: string, districtId: DistrictId, total: number): Building {
  return {
    id,
    friendId: 1,
    ownerId: `o-${id}`,
    districtId,
    ward: 0,
    plot: 0,
    ownerBuilt: total,
    patrons: {},
    architecture: DEFAULT_ARCHITECTURE,
    fixtures: [],
    landscapeInventory: {},
    landscapeSlots: [],
    billboard: { image: null, updatedClock: null },
    milestones: [],
  }
}

describe('cumulative district tier counts', () => {
  it('a Tier 5 building counts toward tiers 1..5', () => {
    const c = districtTierCounts([b('a', 'd1', 60_000)])
    expect(c.d1).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 0 })
  })
  it('upgrading T3 → T4 never weakens lower tiers', () => {
    const before = districtTierCounts([b('a', 'd1', 3_000), b('b', 'd1', 600)])
    const after = districtTierCounts([b('a', 'd1', 10_000), b('b', 'd1', 600)])
    for (let t = 1; t <= 3; t++) expect(after.d1[t]).toBe(before.d1[t])
    expect(after.d1[4]).toBe(before.d1[4] + 1)
  })
})

describe('monument winner', () => {
  const counts = districtTierCounts([
    b('a', 'd1', 10_000),
    b('b', 'd1', 10_000),
    b('c', 'd2', 10_000),
    b('d', 'd2', 10_000),
    b('e', 'd3', 10_000),
  ])
  it('incumbent keeps a tie', () => {
    expect(monumentHolder(counts, 4, 'd2')).toBe('d2')
    expect(monumentHolder(counts, 4, 'd1')).toBe('d1')
  })
  it('strict majority takes it from the incumbent', () => {
    expect(monumentHolder(counts, 4, 'd3')).toBe('d1')
  })
  it('acting district wins a tie among challengers', () => {
    expect(monumentHolder(counts, 4, 'd3', 'd2')).toBe('d2')
  })
  it('no qualifying buildings means unclaimed', () => {
    expect(monumentHolder(counts, 6, null)).toBeNull()
    expect(resolveHolder({} as Record<DistrictId, number>, 'd1')).toBeNull()
  })
})

describe('capital scoring', () => {
  it('weights higher tiers more than broad low tiers but values breadth', () => {
    expect(capitalScore({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 0, 6: 0 })).toBe(32)
    expect(capitalScore({ 1: 10, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 })).toBe(10)
  })
  it('ranks districts and resolves the Capital with incumbent tie-break', () => {
    const list = [b('a', 'd1', 10_000), b('c', 'd2', 10_000)]
    expect(capitalHolder(list, 'd2')).toBe('d2')
    expect(capitalHolder(list, null)).toBe('d1')
    expect(capitalHolder([...list, b('x', 'd2', 150)], 'd1')).toBe('d2')
    const s = districtStandings(list, 'd2')
    expect(s[0].districtId).toBe('d2')
    expect(s[0].rank).toBe(1)
    expect(s).toHaveLength(9)
  })
  it('is not total RF burned', () => {
    // One giant tower vs. three solid T4s.
    const giant = [b('g', 'd1', 240_000)]
    const broad = [b('x', 'd2', 10_000), b('y', 'd2', 10_000), b('z', 'd2', 10_000)]
    expect(capitalHolder([...giant, ...broad], null)).toBe('d2')
  })
})

describe('tallest building', () => {
  it('picks the highest total and keeps the incumbent on ties', () => {
    const list = [b('a', 'd1', 500), b('b', 'd2', 900), b('c', 'd3', 900)]
    expect(tallestBuilding(list, null)).toBe('b')
    expect(tallestBuilding(list, 'c')).toBe('c')
    expect(tallestBuilding([...list, b('d', 'd4', 901)], 'c')).toBe('d')
  })
})
