import { MONUMENTS } from '../config/monuments'
import { initialWards } from './allocation'
import { STATE_VERSION } from './stateSchema'
import type { GameState } from './types'

/** The neutral season an empty city starts in. Season assignment is a later slice's work. */
export const PRESEASON = { id: 'preseason', name: 'Preseason', number: 0 } as const

/**
 * The state of a city in which nothing has happened yet: what canonical genesis installs,
 * and what an activation rehearsal starts from.
 *
 * No users, no buildings, no simulated wallets, no badges or counters, nothing held, no
 * history and no radio. Every district has its one founding ward open. The civic world a
 * visitor sees (plaza, district squares, monument pads, roads) is drawn from configuration,
 * not from state, so an empty state is still a whole city.
 *
 * Pure and deterministic: two calls return deep-equal states.
 */
export function createGenesisState(): GameState {
  const monuments = {} as GameState['monuments']
  const monumentHistory = {} as GameState['monumentHistory']
  for (const m of MONUMENTS) {
    monuments[m.id] = { holder: null, sinceClock: 0 }
    monumentHistory[m.id] = []
  }
  return {
    version: STATE_VERSION,
    clock: 0,
    users: {},
    buildings: {},
    wallets: {},
    monuments,
    monumentHistory,
    capital: { holder: null, sinceClock: 0 },
    capitalHistory: [],
    crown: { holder: null, sinceClock: 0 },
    crownHistory: [],
    badges: {},
    counters: {},
    radio: [],
    alertKeys: [],
    rivalCursor: 0,
    wards: initialWards(),
    residentSeq: 0,
    season: { ...PRESEASON, representatives: {}, activity: {}, joinedClock: {} },
  }
}
