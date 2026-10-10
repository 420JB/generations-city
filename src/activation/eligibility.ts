import { isAccountOwned } from '../config/identity'
import type { GameState } from '../game/types'

/**
 * Could the city on screen take a Friend activation at all?
 *
 * A city that holds real properties holds nothing else: every building in it belongs to a
 * Rare City account, and it has no simulated RF. A city with a demo building or a simulated
 * wallet in it is the simulated demo city, where the server refuses every activation.
 *
 * A HINT, NOT A DECISION. It only keeps the page from offering "Activate" where it can
 * already see the answer is no. Where it says yes the server still decides, every time.
 *
 * It tells a real city from the demo by the shape of what is in it (`isAccountOwned`, and
 * an empty `wallets`), because the city response does not say which it is. That holds for
 * the cities that exist today and is not server authority; P0-E should revisit it if a
 * property's owner can be written as anything other than an account id.
 */
export function cityAcceptsActivation(game: Pick<GameState, 'buildings' | 'wallets'>): boolean {
  return Object.keys(game.wallets).length === 0 && Object.values(game.buildings).every(isAccountOwned)
}
