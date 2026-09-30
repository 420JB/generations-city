/**
 * Identity adapter boundary.
 *
 * Every Friend and user in this build is a DEMO identity. Nothing here refers to a real
 * Rare Friends NFT or wallet. To integrate real identities later, replace this module's
 * data source (e.g. wallet connection + Rare Friend ownership lookup) while keeping the
 * `DemoUser` shape consumed by the game logic.
 */
export const IDENTITY_SOURCE = 'demo' as const
export const DEMO_PLAYER_ID = 'demo-player'

export interface DemoUser {
  id: string
  handle: string
  /** Demo Friend used as the user's avatar identity. Not a real token ID. */
  friendId: number
  hue: number
}

export function friendLabel(friendId: number): string {
  return `Demo Friend #${friendId}`
}

export function friendShort(friendId: number): string {
  return `#${friendId}`
}

/** Deterministic NPC handles for the seeded demo city. */
export const NPC_HANDLES = [
  'kilnwright', 'nova.lane', 'echo_mason', 'lumen', 'brassfox', 'quietpier', 'tallowmoth', 'orbital',
  'sablewren', 'marrow', 'cinder.jay', 'haloquartz', 'pebblewise', 'vantablue', 'rookery', 'glasshouse',
  'mothlight', 'ironpetal', 'loamstar', 'westwick', 'arcadia.k', 'foundry9', 'saltbloom', 'ninefold',
  'emberline', 'tidewalker', 'copperleaf', 'duskmint', 'hollowell', 'riverstone', 'paperkite', 'starwright',
  'mossgate', 'windowsill', 'longhour', 'fablehouse', 'gildedowl', 'pinecrest', 'lowtide', 'brightfold',
  'redbrick', 'skylark.z', 'citrine', 'oakmarrow', 'violetta', 'northgate', 'shingle', 'bellweather',
  'plinth', 'cornice', 'terrazzo', 'gablefox', 'corbel', 'atrium.a', 'mezzanine', 'lintel',
] as const
