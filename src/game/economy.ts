import {
  ARCHITECT_LEVELS,
  HEIGHT_ANCHORS,
  LANDSCAPE_BASE_SLOTS,
  LANDSCAPE_MAX_SLOTS,
  MAX_TIER,
  METERS_PER_FLOOR,
  PATRON_LEVELS,
  STAGES_PER_TIER,
  TIER6_STAGE_CEILING,
  TIER_THRESHOLDS,
  type PatronLevelId,
} from '../config/economy'
import type { Building } from './types'

/** Major tier (0..6) for a cumulative Total RF Built. */
export function tierFor(total: number): number {
  let tier = 0
  for (let i = 0; i < TIER_THRESHOLDS.length; i++) {
    if (total >= TIER_THRESHOLDS[i]) tier = i + 1
  }
  return tier
}

/** RF threshold that starts `tier` (Tier 0 starts at 0). */
export function tierFloor(tier: number): number {
  return tier <= 0 ? 0 : TIER_THRESHOLDS[Math.min(tier, MAX_TIER) - 1]
}

/** RF threshold of the next tier, or null at max tier. */
export function nextTierThreshold(total: number): number | null {
  const tier = tierFor(total)
  return tier >= MAX_TIER ? null : TIER_THRESHOLDS[tier]
}

/** RF still required to reach the next tier (null at max tier). */
export function rfToNextTier(total: number): number | null {
  const next = nextTierThreshold(total)
  return next === null ? null : next - total
}

/** Intermediate construction stage (1..STAGES_PER_TIER) within the current tier. */
export function stageFor(total: number): number {
  const tier = tierFor(total)
  const lower = tierFloor(tier)
  const upper = tier >= MAX_TIER ? TIER6_STAGE_CEILING : TIER_THRESHOLDS[tier]
  const frac = Math.max(0, Math.min(1, (total - lower) / (upper - lower)))
  return Math.min(STAGES_PER_TIER, Math.floor(frac * STAGES_PER_TIER) + 1)
}

/** Fraction (0..1) of progress through the current tier. */
export function tierProgress(total: number): number {
  const tier = tierFor(total)
  const lower = tierFloor(tier)
  const upper = tier >= MAX_TIER ? TIER6_STAGE_CEILING : TIER_THRESHOLDS[tier]
  return Math.max(0, Math.min(1, (total - lower) / (upper - lower)))
}

/** Continuous floor count; strictly increasing with total RF built. */
export function floorsFor(total: number): number {
  const t = Math.max(0, total)
  for (let i = 1; i < HEIGHT_ANCHORS.length; i++) {
    const [x1, y1] = HEIGHT_ANCHORS[i]
    if (t <= x1) {
      const [x0, y0] = HEIGHT_ANCHORS[i - 1]
      return y0 + ((t - x0) / (x1 - x0)) * (y1 - y0)
    }
  }
  const [xl, yl] = HEIGHT_ANCHORS[HEIGHT_ANCHORS.length - 1]
  const [xp, yp] = HEIGHT_ANCHORS[HEIGHT_ANCHORS.length - 2]
  return yl + ((t - xl) / (xl - xp)) * (yl - yp)
}

export function heightMeters(total: number): number {
  return Math.round(floorsFor(total) * METERS_PER_FLOOR * 10) / 10
}

export function communityBuilt(b: Pick<Building, 'patrons'>): number {
  let sum = 0
  for (const v of Object.values(b.patrons)) sum += v
  return sum
}

export function totalBuilt(b: Pick<Building, 'patrons' | 'ownerBuilt'>): number {
  return b.ownerBuilt + communityBuilt(b)
}

export interface BuildSplit {
  total: number
  owner: number
  community: number
  ownerPct: number
  communityPct: number
}

export function buildSplit(b: Pick<Building, 'patrons' | 'ownerBuilt'>): BuildSplit {
  const community = communityBuilt(b)
  const total = b.ownerBuilt + community
  const ownerPct = total === 0 ? 0 : (b.ownerBuilt / total) * 100
  return { total, owner: b.ownerBuilt, community, ownerPct, communityPct: total === 0 ? 0 : 100 - ownerPct }
}

export function uniqueSupporters(b: Pick<Building, 'patrons'>): number {
  return Object.values(b.patrons).filter((v) => v > 0).length
}

/** Architect level (0..5) from personal owner spend only. */
export function architectLevel(ownerBuilt: number): number {
  let lvl = 0
  for (let i = 0; i < ARCHITECT_LEVELS.length; i++) if (ownerBuilt >= ARCHITECT_LEVELS[i]) lvl = i
  return lvl
}

export function nextArchitectThreshold(ownerBuilt: number): number | null {
  const lvl = architectLevel(ownerBuilt)
  return lvl + 1 < ARCHITECT_LEVELS.length ? ARCHITECT_LEVELS[lvl + 1] : null
}

export function landscapeCapacity(ownerBuilt: number): number {
  return Math.min(LANDSCAPE_MAX_SLOTS, LANDSCAPE_BASE_SLOTS + architectLevel(ownerBuilt))
}

/** Highest patron recognition level for a cumulative contribution, or null for 0. */
export function patronLevel(amount: number): PatronLevelId | null {
  let level: PatronLevelId | null = null
  for (const l of PATRON_LEVELS) if (amount >= l.min) level = l.id
  return level
}

export function patronLevelIndex(amount: number): number {
  let idx = -1
  PATRON_LEVELS.forEach((l, i) => {
    if (amount >= l.min) idx = i
  })
  return idx
}

/** Patrons sorted by contribution, largest first (ties by user id for determinism). */
export function rankedPatrons(b: Pick<Building, 'patrons'>): { userId: string; amount: number }[] {
  return Object.entries(b.patrons)
    .filter(([, v]) => v > 0)
    .map(([userId, amount]) => ({ userId, amount }))
    .sort((a, z) => z.amount - a.amount || a.userId.localeCompare(z.userId))
}

export function formatRF(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}
