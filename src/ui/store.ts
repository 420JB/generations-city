import { useCallback, useEffect, useReducer } from 'react'
import type { ArchitectureSlot } from '../config/architecture'
import type { FixtureId, LandscapeKind } from '../config/fixtures'
import type { DistrictId } from '../config/districts'
import { DEMO_PLAYER_ID } from '../config/identity'
import {
  claimFaucet,
  contribute,
  joinCity,
  placeLandscape,
  purchaseFixture,
  rally,
  rivalTurn,
  setArchitecture,
  setBillboardImage,
  setBillboardMessage,
  swapLandscape,
} from '../game/actions'
import { simulateDistrictGrowth } from '../game/growth'
import { clearState, loadState, saveState } from '../game/persistence'
import { createSeedState } from '../game/seed'
import type { ActionResult, GameEvent, GameState } from '../game/types'

export type GameAction =
  | { type: 'contribute'; buildingId: string; amount: number }
  | { type: 'fixture'; buildingId: string; fixtureId: FixtureId }
  | { type: 'architecture'; buildingId: string; slot: ArchitectureSlot; optionId: string }
  | { type: 'landscape-place'; buildingId: string; slot: number; kind: LandscapeKind | null }
  | { type: 'landscape-swap'; buildingId: string; a: number; b: number }
  | { type: 'billboard'; buildingId: string; image: string | null }
  | { type: 'billboard-message'; buildingId: string; message: string }
  | { type: 'rally'; buildingId: string }
  | { type: 'faucet' }
  | { type: 'rival' }
  | { type: 'join'; districtId: DistrictId }
  | { type: 'grow'; districtId: DistrictId }
  | { type: 'reset' }

export interface StoreState {
  game: GameState
  /** Events from the most recent successful action, tagged with a sequence number. */
  last: { seq: number; events: GameEvent[]; action: GameAction['type'] } | null
  error: { seq: number; message: string } | null
  seq: number
  restored: boolean
  saveFailed: boolean
}

function run(game: GameState, action: GameAction): ActionResult {
  const P = DEMO_PLAYER_ID
  switch (action.type) {
    case 'contribute':
      return contribute(game, action.buildingId, P, action.amount)
    case 'fixture':
      return purchaseFixture(game, action.buildingId, P, action.fixtureId)
    case 'architecture':
      return setArchitecture(game, action.buildingId, P, action.slot, action.optionId)
    case 'landscape-place':
      return placeLandscape(game, action.buildingId, P, action.slot, action.kind)
    case 'landscape-swap':
      return swapLandscape(game, action.buildingId, P, action.a, action.b)
    case 'billboard':
      return setBillboardImage(game, action.buildingId, P, action.image)
    case 'billboard-message':
      return setBillboardMessage(game, action.buildingId, P, action.message)
    case 'rally':
      return rally(game, action.buildingId, P)
    case 'faucet':
      return claimFaucet(game, P)
    case 'rival':
      return rivalTurn(game, P)
    case 'join':
      return joinCity(game, action.districtId)
    case 'grow':
      return simulateDistrictGrowth(game, action.districtId)
    case 'reset':
      return { state: createSeedState(), events: [] }
  }
}

function reducer(s: StoreState, action: GameAction): StoreState {
  const seq = s.seq + 1
  const r = run(s.game, action)
  if (r.error) return { ...s, seq, error: { seq, message: r.error } }
  return { ...s, seq, game: r.state, last: { seq, events: r.events, action: action.type }, error: null }
}

function init(): StoreState {
  const storage = typeof window !== 'undefined' ? window.localStorage : null
  const { state, restored } = loadState(storage)
  return { game: state, last: null, error: null, seq: 0, restored, saveFailed: false }
}

export function useGameStore() {
  const [store, dispatch] = useReducer(reducer, undefined, init)

  useEffect(() => {
    if (store.last?.action === 'reset') clearState(window.localStorage)
    saveState(window.localStorage, store.game)
  }, [store.game, store.last])

  const act = useCallback((a: GameAction) => dispatch(a), [])
  return { store, act }
}
