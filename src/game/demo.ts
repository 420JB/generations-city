import type { DistrictId } from '../config/districts'
import { DEMO_PLAYER_ID } from '../config/identity'
import { DEFAULT_ARCHITECTURE } from '../config/architecture'
import { rfToNextTier, tierFor, totalBuilt } from './economy'
import { buildingIdFor, createSeedState, SCENARIO } from './seed'
import type { GameState } from './types'

export interface DemoProgress {
  kingmakerId: string
  kingmakerNeed: number | null
  /** The Kingmaker's district (internal d4, the player's Home District). */
  kingmakerDistrict: DistrictId | null
  /** #812 reached Tier 4. */
  tierUp: boolean
  /** The Kingmaker's district holds the T4 monument. */
  captured: boolean
  /** Bonus: the Kingmaker's district became the Capital. */
  capital: boolean
  /** Bonus: the player built, bought fixtures for, or redesigned their own tower. */
  customized: boolean
  /** The core 30-second loop is done. */
  primaryComplete: boolean
}

const seedMine = (() => {
  const s = createSeedState()
  const b = Object.values(s.buildings).find((x) => x.ownerId === DEMO_PLAYER_ID)
  return { architecture: b?.architecture ?? DEFAULT_ARCHITECTURE, ownerBuilt: b?.ownerBuilt ?? 0, slots: JSON.stringify(b?.landscapeSlots ?? []) }
})()

/** Progress through the guided demo, derived purely from game state. */
export function demoProgress(state: GameState): DemoProgress {
  const kingmakerId = buildingIdFor(SCENARIO.kingmakerFriend)
  const king = state.buildings[kingmakerId]
  const mine = Object.values(state.buildings).find((b) => b.ownerId === DEMO_PLAYER_ID)
  const tierUp = !!king && tierFor(totalBuilt(king)) >= 4
  const captured = !!king && state.monuments.m4.holder === king.districtId
  return {
    kingmakerId,
    kingmakerNeed: king ? rfToNextTier(totalBuilt(king)) : null,
    kingmakerDistrict: king?.districtId ?? null,
    tierUp,
    captured,
    capital: !!king && state.capital.holder === king.districtId,
    customized:
      !!mine &&
      (mine.ownerBuilt > seedMine.ownerBuilt ||
        JSON.stringify(mine.architecture) !== JSON.stringify(seedMine.architecture) ||
        JSON.stringify(mine.landscapeSlots) !== seedMine.slots),
    primaryComplete: tierUp && captured,
  }
}
