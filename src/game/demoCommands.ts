import type { DistrictId } from '../config/districts'
import { claimFaucet, joinAtPlot, joinCity, rivalTurn } from './actions'
import { simulateDistrictGrowth } from './growth'
import type { ActionResult, GameState } from './types'

/**
 * Demo-only controls: the simulated faucet, the scripted rival, simulated residents joining
 * and the growth simulator. They mint simulated RF or simulated identities, so a server
 * authority must never accept them. Real activation needs verified ownership instead.
 */
export type DemoCommand =
  | { type: 'faucet' }
  | { type: 'rival' }
  | { type: 'join'; districtId: DistrictId }
  | { type: 'join-at'; districtId: DistrictId; ward: number; plot: number }
  | { type: 'grow'; districtId: DistrictId }

const DEMO_COMMAND_TYPES: ReadonlySet<string> = new Set<DemoCommand['type']>(['faucet', 'rival', 'join', 'join-at', 'grow'])

export function isDemoCommand(command: { type: string }): command is DemoCommand {
  return DEMO_COMMAND_TYPES.has(command.type)
}

/** Apply a demo-only control on behalf of `actorId`. Pure: returns a new state. */
export function applyDemoCommand(state: GameState, actorId: string, command: DemoCommand): ActionResult {
  switch (command.type) {
    case 'faucet':
      return claimFaucet(state, actorId)
    case 'rival':
      return rivalTurn(state, actorId)
    case 'join':
      return joinCity(state, command.districtId)
    case 'join-at':
      return joinAtPlot(state, { districtId: command.districtId, ward: command.ward, plot: command.plot })
    case 'grow':
      return simulateDistrictGrowth(state, command.districtId)
  }
}
