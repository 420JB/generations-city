import { DEMO_SEASON, SEASON_RULES } from '../config/season'
import { DISTRICT_IDS, type DistrictId } from '../config/districts'
import { tierFor, totalBuilt } from './economy'
import type { ActionResult, GameState, SeasonState } from './types'

export function emptySeason(number = 1): SeasonState {
  return {
    id: number === 1 ? DEMO_SEASON.id : `demo-s${number}`,
    name: `Demo Season ${number}`,
    number,
    representatives: {},
    activity: {},
    joinedClock: {},
  }
}

/** The player's Home District this season (from their Representative Friend), if chosen. */
export function homeDistrict(state: GameState, userId: string): DistrictId | null {
  return state.season.representatives[userId]?.districtId ?? null
}

export function ownedFriends(state: GameState, userId: string) {
  return Object.values(state.buildings)
    .filter((b) => b.ownerId === userId)
    .sort((a, b) => totalBuilt(b) - totalBuilt(a) || a.id.localeCompare(b.id))
}

/**
 * Choose the season's Representative Friend. Allowed once per season; after that the
 * Home District is locked until the next season (no hopping to a winning district).
 */
export function chooseRepresentative(state: GameState, userId: string, buildingId: string): ActionResult {
  const b = state.buildings[buildingId]
  if (!b) return { state, events: [], error: 'Unknown building' }
  if (b.ownerId !== userId) return { state, events: [], error: 'You can only choose a Friend you own' }
  if (SEASON_RULES.allegianceLockedForSeason && state.season.representatives[userId])
    return { state, events: [], error: 'Allegiance is locked until next season' }
  return {
    state: {
      ...state,
      clock: state.clock + 1,
      season: {
        ...state.season,
        representatives: { ...state.season.representatives, [userId]: { buildingId, districtId: b.districtId, chosenClock: state.clock + 1 } },
      },
    },
    events: [],
  }
}

export type Allegiance = 'home' | 'rival' | 'unaligned'

/** Whether building this property helps the player's Home District or another one. */
export function contributionAllegiance(state: GameState, userId: string, buildingId: string): { allegiance: Allegiance; warning: string | null } {
  const home = homeDistrict(state, userId)
  const b = state.buildings[buildingId]
  if (!home || !b) return { allegiance: 'unaligned', warning: null }
  if (b.districtId === home) return { allegiance: 'home', warning: null }
  return { allegiance: 'rival', warning: SEASON_RULES.crossDistrictWarning }
}

/** Record seasonal activity for a spend (called from the single RF path). */
export function recordSeasonActivity(season: SeasonState, buildingId: string, userId: string, amount: number, tierUps: number): SeasonState {
  const prev = season.activity[buildingId] ?? { rf: 0, tierUps: 0, builders: [] }
  return {
    ...season,
    activity: {
      ...season.activity,
      [buildingId]: {
        rf: prev.rf + amount,
        tierUps: prev.tierUps + tierUps,
        builders: prev.builders.includes(userId) ? prev.builders : [...prev.builders, userId].sort(),
      },
    },
  }
}

/**
 * Start the next season: permanent world state (buildings, tiers, badges, history) is
 * untouched; allegiances and seasonal activity reset. Not exposed in the demo UI.
 */
export function startNextSeason(state: GameState): GameState {
  return { ...state, clock: state.clock + 1, season: emptySeason(state.season.number + 1) }
}

export interface SeasonSignals {
  districtId: DistrictId
  buildings: number
  activeBuildings: number
  activeShare: number
  seasonRF: number
  tierUps: number
  builders: number
}

/**
 * Population-normalised seasonal signals per district. PREVIEW ONLY: the current demo
 * scoring (monuments + Capital) does not use these yet.
 */
export function seasonSignals(state: GameState): SeasonSignals[] {
  return DISTRICT_IDS.map((districtId) => {
    const list = Object.values(state.buildings).filter((b) => b.districtId === districtId)
    let active = 0
    let rf = 0
    let tierUps = 0
    const builders = new Set<string>()
    for (const b of list) {
      const a = state.season.activity[b.id]
      if (!a) continue
      active++
      rf += a.rf
      tierUps += a.tierUps
      a.builders.forEach((u) => builders.add(u))
    }
    return {
      districtId,
      buildings: list.length,
      activeBuildings: active,
      activeShare: list.length ? active / list.length : 0,
      seasonRF: rf,
      tierUps,
      builders: builders.size,
    }
  })
}

/** Permanent tier is never touched by seasons; exported for clarity in tests. */
export function permanentTier(state: GameState, buildingId: string): number {
  return tierFor(totalBuilt(state.buildings[buildingId]))
}
