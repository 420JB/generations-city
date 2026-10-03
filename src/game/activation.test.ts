import { describe, expect, it } from 'vitest'
import { DEFAULT_ARCHITECTURE } from '../config/architecture'
import { FAMILY_DISTRICTS } from '../config/familyDistricts'
import { activateFriend, neutralCityUser, type FriendActivation } from './activation'
import { availablePlots, newBuilding } from './allocation'
import { createGenesisState } from './genesis'
import { checkCityState } from './invariants'
import type { GameState } from './types'
import { wardCapacity } from './world'

const USER = '7b0c1c7e-3c53-4d0e-9a52-6a3f5d0f1a11'
const OTHER = '9d6f2a10-0b1e-4c7a-8f3d-2e5b6c7d8e9f'
const ADDRESS = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'

/** Friend 812 of the Family family (registry id 2, district d4), onto the plot asked for. */
const activation = (patch: Partial<FriendActivation> = {}): FriendActivation => ({ userId: USER, ownerAddress: ADDRESS, tokenId: 812, familyId: 2, address: { districtId: 'd4', ward: 0, plot: 7 }, ...patch })

const applied = (state: GameState, input: FriendActivation) => {
  const outcome = activateFriend(state, input)
  if (!outcome.ok) throw new Error(`activation refused: ${outcome.reason}`)
  return outcome
}

/** A state whose district `d4` has every plot of ward 0 taken, by Friends 5000, 5001, ... */
function fullFirstWard(): GameState {
  let state = createGenesisState()
  for (let plot = 0; plot < wardCapacity(0); plot++) state = applied(state, activation({ tokenId: 5000 + plot, address: { districtId: 'd4', ward: 0, plot } })).state
  return state
}

describe('activateFriend', () => {
  it('adds exactly one unbuilt building for the Friend, on the exact plot, owned by the user', () => {
    const genesis = createGenesisState()
    const { state, building, openedWard, createdUser } = applied(genesis, activation())
    expect(Object.keys(state.buildings)).toEqual(['b-812'])
    expect(building).toEqual(state.buildings['b-812'])
    expect(building).toEqual(newBuilding({ friendId: 812, ownerId: USER, address: { districtId: 'd4', ward: 0, plot: 7 }, clock: 1 }))
    expect(building).toMatchObject({ id: 'b-812', friendId: 812, ownerId: USER, districtId: 'd4', ward: 0, plot: 7, ownerBuilt: 0, patrons: {}, fixtures: [], landscapeInventory: {}, milestones: [], billboard: { image: null, updatedClock: null } })
    expect(building.architecture).toEqual(DEFAULT_ARCHITECTURE)
    expect(building.landscapeSlots.every((slot) => slot === null)).toBe(true)
    expect([openedWard, createdUser]).toEqual([false, true])
    expect(checkCityState(state)).toEqual([])
  })

  it('advances the clock by one and moves nothing else', () => {
    const genesis = createGenesisState()
    const { state } = applied(genesis, activation())
    expect(state.clock).toBe(genesis.clock + 1)
    // No demo resident, no simulated RF, no Representative, no reward, no Radio line.
    expect(state.residentSeq).toBe(genesis.residentSeq)
    expect(state.wallets).toEqual({})
    expect(state.season).toEqual(genesis.season)
    expect(state.season.representatives).toEqual({})
    expect(state.season.joinedClock).toEqual({})
    expect(state.badges).toEqual({})
    expect(state.counters).toEqual({})
    expect(state.radio).toEqual([])
    expect(state.alertKeys).toEqual([])
    expect(state.rivalCursor).toBe(genesis.rivalCursor)
    expect(state.wards).toEqual(genesis.wards)
    for (const key of ['monuments', 'monumentHistory', 'capital', 'capitalHistory', 'crown', 'crownHistory', 'version'] as const) expect(state[key], key).toEqual(genesis[key])
  })

  it('is pure: the state it is given is not changed, and the same input gives the same result', () => {
    const genesis = createGenesisState()
    const before = JSON.stringify(genesis)
    const first = applied(genesis, activation())
    expect(JSON.stringify(genesis)).toBe(before)
    expect(applied(genesis, activation())).toEqual(first)
  })

  it('creates a neutral display user for a first activation, with that Friend as avatar only', () => {
    const { state } = applied(createGenesisState(), activation())
    expect(Object.keys(state.users)).toEqual([USER])
    expect(state.users[USER]).toEqual({ id: USER, handle: '0xf39f…2266', friendId: 812, hue: Number.parseInt('f39fd6e5', 16) % 360 })
    expect(state.users[USER]).toEqual(neutralCityUser(USER, ADDRESS, 812))
    // Derived from the address whatever its casing.
    expect(neutralCityUser(USER, '0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266', 812)).toEqual(state.users[USER])
  })

  it('leaves an existing user exactly as they are when they activate a second Friend', () => {
    const first = applied(createGenesisState(), activation())
    const second = applied(first.state, activation({ tokenId: 4471, familyId: 7, address: { districtId: 'd2', ward: 0, plot: 0 } }))
    expect(second.createdUser).toBe(false)
    // The avatar is still the first Friend: a second one does not replace it.
    expect(second.state.users).toBe(first.state.users)
    expect(second.state.users[USER].friendId).toBe(812)
    expect(Object.keys(second.state.buildings).sort()).toEqual(['b-4471', 'b-812'])
    expect(second.state.buildings['b-4471'].ownerId).toBe(USER)
    expect(second.state.clock).toBe(2)
    expect(checkCityState(second.state)).toEqual([])
  })

  it('never reads a user avatar as authority: a user whose avatar is the Friend gains nothing from it', () => {
    // Another user's display record claims Friend 812 as its avatar. It changes nothing about who gets the building.
    const genesis = createGenesisState()
    const state: GameState = { ...genesis, users: { [OTHER]: { id: OTHER, handle: 'impostor', friendId: 812, hue: 10 } } }
    const outcome = applied(state, activation())
    expect(outcome.state.buildings['b-812'].ownerId).toBe(USER)
    expect(outcome.state.users[OTHER]).toEqual(state.users[OTHER])
  })

  it('opens no ward for an ordinary free plot', () => {
    const { state, openedWard } = applied(createGenesisState(), activation({ address: { districtId: 'd4', ward: 0, plot: wardCapacity(0) - 1 } }))
    expect(openedWard).toBe(false)
    expect(state.wards).toEqual(createGenesisState().wards)
  })

  it('opens exactly the next ward, in that district only, for a plot in it', () => {
    const full = fullFirstWard()
    expect(full.wards.d4).toBe(1)
    expect(availablePlots(full, 'd4').every((c) => c.ward === 1 && c.newWard)).toBe(true)
    const { state, openedWard } = applied(full, activation({ address: { districtId: 'd4', ward: 1, plot: 3 } }))
    expect(openedWard).toBe(true)
    expect(state.wards).toEqual({ ...full.wards, d4: 2 })
    expect(state.buildings['b-812']).toMatchObject({ ward: 1, plot: 3 })
    expect(checkCityState(state)).toEqual([])
    // The ward is open now, so its next plot opens nothing more.
    const next = applied(state, activation({ tokenId: 813, address: { districtId: 'd4', ward: 1, plot: 4 } }))
    expect([next.openedWard, next.state.wards.d4]).toEqual([false, 2])
  })

  it('refuses a plot that is taken, not real, or beyond the next ward, and returns no state', () => {
    const one = applied(createGenesisState(), activation()).state
    const refusal = (state: GameState, input: FriendActivation) => activateFriend(state, input)
    // Taken.
    expect(refusal(one, activation({ tokenId: 900 }))).toEqual({ ok: false, reason: 'plot-unavailable' })
    // Past the end of the ward.
    expect(refusal(one, activation({ tokenId: 900, address: { districtId: 'd4', ward: 0, plot: wardCapacity(0) } }))).toEqual({ ok: false, reason: 'plot-unavailable' })
    // The next ward, while the open one still has room.
    expect(refusal(one, activation({ tokenId: 900, address: { districtId: 'd4', ward: 1, plot: 0 } }))).toEqual({ ok: false, reason: 'plot-unavailable' })
    // Two wards out, even when the open one is full.
    expect(refusal(fullFirstWard(), activation({ address: { districtId: 'd4', ward: 2, plot: 0 } }))).toEqual({ ok: false, reason: 'plot-unavailable' })
    for (const address of [{ districtId: 'd4' as const, ward: 0.5, plot: 0 }, { districtId: 'd4' as const, ward: 0, plot: -1 }, { districtId: 'd4' as const, ward: -1, plot: 0 }]) expect(refusal(one, activation({ tokenId: 900, address }))).toEqual({ ok: false, reason: 'plot-unavailable' })
  })

  it('refuses a Friend that already has a building, whatever plot is asked for', () => {
    const one = applied(createGenesisState(), activation()).state
    expect(activateFriend(one, activation({ address: { districtId: 'd4', ward: 0, plot: 8 } }))).toEqual({ ok: false, reason: 'friend-active' })
    expect(activateFriend(one, activation({ userId: OTHER, address: { districtId: 'd4', ward: 0, plot: 8 } }))).toEqual({ ok: false, reason: 'friend-active' })
    // Even if it had been stored under another key.
    const renamed: GameState = { ...one, buildings: { odd: { ...one.buildings['b-812'], id: 'odd' } } }
    expect(activateFriend(renamed, activation({ address: { districtId: 'd4', ward: 0, plot: 8 } }))).toEqual({ ok: false, reason: 'friend-active' })
  })

  it('places a family only in its own district', () => {
    FAMILY_DISTRICTS.forEach((districtId, familyId) => {
      const ok = applied(createGenesisState(), activation({ familyId, address: { districtId, ward: 0, plot: 0 } }))
      expect(ok.building.districtId).toBe(districtId)
      for (const other of FAMILY_DISTRICTS) if (other !== districtId) expect(activateFriend(createGenesisState(), activation({ familyId, address: { districtId: other, ward: 0, plot: 0 } })), `${familyId} in ${other}`).toEqual({ ok: false, reason: 'wrong-district' })
    })
  })

  it('refuses inputs it cannot build an activation from', () => {
    const genesis = createGenesisState()
    const bad: Partial<FriendActivation>[] = [
      { tokenId: -1 },
      { tokenId: 1.5 },
      { tokenId: Number.NaN },
      { tokenId: Number.MAX_SAFE_INTEGER + 1 },
      { tokenId: '812' as unknown as number },
      { familyId: 9 },
      { familyId: -1 },
      { familyId: 2.5 },
      { userId: '' },
      { userId: '__proto__' },
      { userId: 'has space' },
      { ownerAddress: '0x1234' },
      { ownerAddress: 'f39fd6e51aad88f6f4ce6ab8827279cfffb92266' },
    ]
    for (const patch of bad) expect(activateFriend(genesis, activation(patch)), JSON.stringify(patch)).toEqual({ ok: false, reason: 'invalid-input' })
    expect(applied(genesis, activation({ tokenId: 0 })).building.id).toBe('b-0')
    expect(applied(genesis, activation({ tokenId: Number.MAX_SAFE_INTEGER })).building.id).toBe('b-9007199254740991')
  })
})
