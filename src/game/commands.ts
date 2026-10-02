import type { ArchitectureSlot } from '../config/architecture'
import type { FixtureId, LandscapeKind } from '../config/fixtures'
import { contribute, placeLandscape, purchaseFixture, rally, setArchitecture, setBillboardImage, setBillboardMessage, swapLandscape } from './actions'
import type { ActionResult, GameState } from './types'

/**
 * Command vocabulary: the player intents a client may send to whichever authority owns
 * the city.
 *
 * A command never names who is acting. The authority supplies the actor: the local demo
 * transport uses its demo viewer, a server derives it from the authenticated session.
 * This module is pure and has no browser dependency, so a server can reuse it as is.
 * Demo-only controls live apart in `demoCommands.ts`.
 */
export type CityCommand =
  | { type: 'contribute'; buildingId: string; amount: number }
  | { type: 'fixture'; buildingId: string; fixtureId: FixtureId }
  | { type: 'architecture'; buildingId: string; slot: ArchitectureSlot; optionId: string }
  | { type: 'landscape-place'; buildingId: string; slot: number; kind: LandscapeKind | null }
  | { type: 'landscape-swap'; buildingId: string; a: number; b: number }
  | { type: 'billboard'; buildingId: string; image: string | null }
  | { type: 'billboard-message'; buildingId: string; message: string }
  | { type: 'rally'; buildingId: string }

/** Apply a player intent on behalf of `actorId`. Pure: returns a new state. */
export function applyCityCommand(state: GameState, actorId: string, command: CityCommand): ActionResult {
  switch (command.type) {
    case 'contribute':
      return contribute(state, command.buildingId, actorId, command.amount)
    case 'fixture':
      return purchaseFixture(state, command.buildingId, actorId, command.fixtureId)
    case 'architecture':
      return setArchitecture(state, command.buildingId, actorId, command.slot, command.optionId)
    case 'landscape-place':
      return placeLandscape(state, command.buildingId, actorId, command.slot, command.kind)
    case 'landscape-swap':
      return swapLandscape(state, command.buildingId, actorId, command.a, command.b)
    case 'billboard':
      return setBillboardImage(state, command.buildingId, actorId, command.image)
    case 'billboard-message':
      return setBillboardMessage(state, command.buildingId, actorId, command.message)
    case 'rally':
      return rally(state, command.buildingId, actorId)
    default: {
      // Commands cross a trust boundary as untyped data: anything unrecognised changes nothing.
      const unknown: never = command
      void unknown
      return { state, events: [], error: 'Unknown command' }
    }
  }
}
