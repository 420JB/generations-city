import { districtForFamily } from '../config/familyDistricts'
import { allocateSpecificPlot, newBuilding, type PlotAddress } from './allocation'
import type { Building, CityUser, GameState } from './types'

/**
 * PERMANENT FRIEND ACTIVATION, as a pure state transition.
 *
 * One real Rare Friend becomes one building on the exact plot its owner chose. This is the
 * authoritative counterpart of the demo's `joinAtPlot`, and deliberately not that function:
 * a demo join invents a resident, a Friend number, a Representative and a Radio line. An
 * activation invents nothing.
 *
 * The caller (the server) has already established everything this cannot: who the user is,
 * that their wallet owns the Friend, and which family the registry says it belongs to. This
 * decides only what the city state allows, and says no rather than guess.
 */
export interface FriendActivation {
  /** The authoritative Rare City user id. Becomes the building's `ownerId`. */
  userId: string
  /** The activating wallet, as `0x` and 40 hex characters. Used only to derive a neutral display handle and hue. */
  ownerAddress: string
  /** The Friend's token id. */
  tokenId: number
  /** The registry family id. Fixes the district; the plot must lie in it. */
  familyId: number
  address: PlotAddress
}

export type ActivationRefusal =
  /** The inputs are not ones an activation can be built from. */
  | 'invalid-input'
  /** The plot is not in the district of the Friend's family. */
  | 'wrong-district'
  /** The Friend already has a building in this city. */
  | 'friend-active'
  /** The plot is not one a joining Friend may take: taken, not a real plot, or beyond the next ward. */
  | 'plot-unavailable'

export type ActivationOutcome =
  | { ok: true; state: GameState; building: Building; openedWard: boolean; createdUser: boolean }
  | { ok: false; reason: ActivationRefusal }

const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/**
 * How a real user appears in the city state until profiles exist: a neutral handle and hue
 * derived from the wallet address, which is already public beside the Friend it owns.
 * PRESENTATION ONLY, like every `CityUser`.
 */
export function neutralCityUser(userId: string, ownerAddress: string, avatarFriendId: number): CityUser {
  const address = ownerAddress.toLowerCase()
  return { id: userId, handle: `${address.slice(0, 6)}…${address.slice(-4)}`, friendId: avatarFriendId, hue: Number.parseInt(address.slice(2, 10), 16) % 360 }
}

/**
 * Apply one activation to `state`. Pure: `state` is not changed, and a refusal returns no state.
 *
 * - The plot is allocated again, here, against the state it is given. If it lies in the
 *   next ward, exactly that ward opens.
 * - One building is added, `b-<tokenId>`, owned by `userId`: nothing built, no patrons,
 *   default architecture, no fixtures, no landscaping, a blank billboard, no milestones.
 * - A user who is not yet in the state is added with this Friend as their avatar. A user
 *   who is already there is left exactly as they are: a second Friend does not replace
 *   their avatar. `friendId` is display only and is never consulted here or anywhere for
 *   what a user may do.
 * - The clock advances by one, as it does for every other change to a city.
 *
 * Nothing else moves: no simulated wallet or RF, no `residentSeq`, no Representative, no
 * badge, counter, season activity or Radio entry.
 */
export function activateFriend(state: GameState, input: FriendActivation): ActivationOutcome {
  const { userId, ownerAddress, tokenId, familyId, address } = input
  if (typeof userId !== 'string' || !USER_ID.test(userId) || typeof ownerAddress !== 'string' || !ADDRESS.test(ownerAddress)) return { ok: false, reason: 'invalid-input' }
  if (typeof tokenId !== 'number' || !Number.isSafeInteger(tokenId) || tokenId < 0) return { ok: false, reason: 'invalid-input' }
  const districtId = districtForFamily(familyId)
  if (!districtId) return { ok: false, reason: 'invalid-input' }
  if (address.districtId !== districtId) return { ok: false, reason: 'wrong-district' }

  // One building per Friend, whatever key it was stored under.
  if (Object.hasOwn(state.buildings, `b-${tokenId}`) || Object.values(state.buildings).some((b) => b.friendId === tokenId)) return { ok: false, reason: 'friend-active' }

  const allocation = allocateSpecificPlot(state, address)
  if (!allocation) return { ok: false, reason: 'plot-unavailable' }

  const clock = state.clock + 1
  const building = newBuilding({ friendId: tokenId, ownerId: userId, address: allocation.address, clock })
  const createdUser = !Object.hasOwn(state.users, userId)
  return {
    ok: true,
    building,
    openedWard: allocation.openedWard,
    createdUser,
    state: {
      ...state,
      clock,
      wards: allocation.wards,
      users: createdUser ? { ...state.users, [userId]: neutralCityUser(userId, ownerAddress, tokenId) } : state.users,
      buildings: { ...state.buildings, [building.id]: building },
    },
  }
}
