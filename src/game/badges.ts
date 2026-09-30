import { BADGES, type BadgeMetric } from '../config/badges'
import { buildSplit, tierFor, totalBuilt, uniqueSupporters } from './economy'
import type { BadgeAward, GameEvent, GameState, UserCounters } from './types'

export const EMPTY_COUNTERS: UserCounters = {
  closerCount: 0,
  kingmakerCount: 0,
  capitalCaptures: 0,
  capitalReigns: 0,
  crownedCount: 0,
}

export type UserMetrics = Record<BadgeMetric, number>

export function userMetrics(state: GameState, userId: string): UserMetrics {
  const c = state.counters[userId] ?? EMPTY_COUNTERS
  let ownerRF = 0
  let contributedRF = 0
  let buildingsSupported = 0
  let maxPatronOnBuilding = 0
  let ownMaxTier = 0
  let selfMade = 0
  let peoplesTower = 0
  let foundingProperty = 0
  const perDistrict = new Map<string, number>()
  for (const b of Object.values(state.buildings)) {
    if (b.ownerId === userId) {
      ownerRF += b.ownerBuilt
      const split = buildSplit(b)
      const tier = tierFor(split.total)
      ownMaxTier = Math.max(ownMaxTier, tier)
      if (tier >= 3 && split.ownerPct >= 75) selfMade = 1
      peoplesTower = Math.max(peoplesTower, uniqueSupporters(b))
      if (b.ward === 0) foundingProperty = 1
    }
    const given = b.patrons[userId] ?? 0
    if (given > 0 && b.ownerId !== userId) {
      contributedRF += given
      buildingsSupported += 1
      maxPatronOnBuilding = Math.max(maxPatronOnBuilding, given)
      perDistrict.set(b.districtId, (perDistrict.get(b.districtId) ?? 0) + 1)
    }
  }
  return {
    ownerRF,
    contributedRF,
    buildingsSupported,
    maxDistrictSupported: Math.max(0, ...perDistrict.values()),
    districtsSupported: perDistrict.size,
    maxPatronOnBuilding,
    closerCount: c.closerCount,
    kingmakerCount: c.kingmakerCount,
    capitalCaptures: c.capitalCaptures,
    capitalReigns: c.capitalReigns,
    crownedCount: c.crownedCount,
    ownMaxTier,
    selfMade,
    peoplesTower,
    foundingProperty,
  }
}

/** Level (0 = not earned) a metric value qualifies for. */
export function levelFor(value: number, thresholds: readonly number[]): number {
  let lvl = 0
  thresholds.forEach((t, i) => {
    if (value >= t) lvl = i + 1
  })
  return lvl
}

/**
 * Evaluate every badge for a user. Badges are permanent: an award is only ever added
 * or upgraded, never removed or downgraded, even if the qualifying state later changes.
 */
export function evaluateUserBadges(
  state: GameState,
  userId: string,
  existing: readonly BadgeAward[],
): { awards: BadgeAward[]; events: GameEvent[] } {
  const metrics = userMetrics(state, userId)
  const awards = existing.map((a) => ({ ...a }))
  const events: GameEvent[] = []
  for (const def of BADGES) {
    const lvl = levelFor(metrics[def.metric], def.thresholds)
    if (lvl === 0) continue
    const current = awards.find((a) => a.badgeId === def.id)
    if (!current) {
      awards.push({ badgeId: def.id, level: lvl, clock: state.clock })
      events.push({ type: 'badge', userId, badgeId: def.id, level: lvl })
    } else if (lvl > current.level) {
      current.level = lvl
      current.clock = state.clock
      events.push({ type: 'badge', userId, badgeId: def.id, level: lvl })
    }
  }
  return { awards, events }
}

export function evaluateAllBadges(state: GameState): { badges: Record<string, BadgeAward[]>; events: GameEvent[] } {
  const badges: Record<string, BadgeAward[]> = {}
  const events: GameEvent[] = []
  for (const userId of Object.keys(state.users).sort()) {
    const r = evaluateUserBadges(state, userId, state.badges[userId] ?? [])
    badges[userId] = r.awards
    events.push(...r.events)
  }
  return { badges, events }
}

export interface ProfileSummary {
  ownerRF: number
  contributedRF: number
  buildingsSupported: number
  tierUpsCaused: number
  monumentCaptures: number
  capitalCaptures: number
  ownedBuildingIds: string[]
}

export function profileSummary(state: GameState, userId: string): ProfileSummary {
  const m = userMetrics(state, userId)
  return {
    ownerRF: m.ownerRF,
    contributedRF: m.contributedRF,
    buildingsSupported: m.buildingsSupported,
    tierUpsCaused: m.closerCount,
    monumentCaptures: m.kingmakerCount,
    capitalCaptures: m.capitalCaptures,
    ownedBuildingIds: Object.values(state.buildings)
      .filter((b) => b.ownerId === userId)
      .sort((a, b) => totalBuilt(b) - totalBuilt(a))
      .map((b) => b.id),
  }
}
