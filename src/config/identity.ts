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

/** A Rare City account id: the server's `users.id`, a UUID. No demo identity has one. */
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * True when a building belongs to a Rare City account rather than to a demo identity.
 *
 * The only thing that gives an account a building is activating a real Rare Friend, so such
 * a building is an ownership-backed property. The demo's player, NPCs and simulated
 * residents have ids of their own (`demo-player`, `npc-07`, ...) and never match.
 *
 * A CLIENT-SIDE READING OF THE CITY, NEVER AUTHORITY. It has two uses: it picks the label
 * ("Friend #N" or "Demo Friend #N", see `buildingFriendLabel`), and through
 * `cityAcceptsActivation` it decides whether the page OFFERS "Activate" in the city on
 * screen. It grants nothing: whether a Friend may be activated is the server's answer at
 * the intent and again at the commit, whatever this says.
 *
 * Both uses rest on how owner ids look TODAY: every owner of a property in a real city is a
 * Rare City account (a UUID), and no demo identity is. The city response carries no field
 * that says which kind of city it is, so the shape of the ids is all the page has. If a
 * property can ever have an owner written another way (P0-E: an owner with no account, or
 * no known owner), this would call that building a demo Friend and hide "Activate" for the
 * whole city. P0-E must revisit it then.
 */
export function isAccountOwned(building: { ownerId: string }): boolean {
  return ACCOUNT_ID.test(building.ownerId)
}

/** The name of the Friend a building stands for: a real Friend by its token id, a demo Friend labelled as one. */
export function buildingFriendLabel(building: { friendId: number; ownerId: string }): string {
  return isAccountOwned(building) ? `Friend #${building.friendId}` : friendLabel(building.friendId)
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
