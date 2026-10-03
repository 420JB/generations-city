/**
 * Identity adapter boundary.
 *
 * Every Friend and user in the local demo is a DEMO identity: nothing in the demo refers
 * to a real Rare Friends NFT or wallet. The shape the game logic consumes is `CityUser`,
 * which says nothing about where the user came from.
 */
export const IDENTITY_SOURCE = 'demo' as const
export const DEMO_PLAYER_ID = 'demo-player'

/**
 * A user as the city state shows them: an id, a name and an avatar.
 *
 * PRESENTATION ONLY. `friendId` picks which Friend is drawn as this user's avatar. It is
 * never ownership authority: it does not prove the user owns that Friend, does not limit
 * a user to one Friend, and grants no control over any property. In an authoritative city
 * who may act comes from the session, a fresh ownership read from the chain, and the
 * `properties` / `ownership_eras` tables.
 */
export interface CityUser {
  id: string
  handle: string
  /** Avatar Friend. Display metadata, never authority. In the demo it is not a real token id. */
  friendId: number
  hue: number
}

/** The demo's name for the same shape. Kept so the demo code reads as it always has. */
export type DemoUser = CityUser

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
