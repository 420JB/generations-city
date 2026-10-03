import { familyById } from '../engine'
import { OwnershipError, type OwnedFriend, type OwnershipProvider } from './provider'

/**
 * DETERMINISTIC TEST / DEV OWNERSHIP. NOT REAL.
 *
 * A fixed table standing in for the chain, so local work and automated tests can sign in
 * and see Friends without a network. It can only be selected when APP_MODE=local, and
 * every answer it gives is labelled `fixture`.
 */
export interface FixtureHoldings {
  /** address → [tokenId, familyId] pairs. Addresses are compared case-insensitively. */
  owners: Record<string, readonly (readonly [bigint, number])[]>
  /** Addresses for which the source "is down", to exercise the unavailable path. */
  unavailable?: readonly string[]
}

/**
 * The well-known public development accounts (the `test test … junk` mnemonic, indexes
 * 0-2). They hold nothing of value anywhere; their keys are public.
 */
export const DEV_FIXTURE: FixtureHoldings = {
  owners: {
    '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266': [
      [812n, 2],
      [1204n, 0],
      [4471n, 7],
    ],
    '0x70997970C51812dc3A010C7d01b50e0d17dc79C8': [[77n, 5]],
  },
  unavailable: ['0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'],
}

export function createFixtureOwnershipProvider(holdings: FixtureHoldings = DEV_FIXTURE): OwnershipProvider {
  const owners = new Map<string, OwnedFriend[]>()
  const families = new Map<bigint, number>()
  for (const [address, tokens] of Object.entries(holdings.owners)) {
    const friends = tokens.map(([tokenId, familyId]) => {
      const family = familyById(familyId)
      if (!family) throw new Error(`Fixture family ${familyId} is not a Rare Friends family.`)
      families.set(tokenId, familyId)
      return { tokenId, family }
    })
    owners.set(address.toLowerCase(), friends.sort((a, b) => (a.tokenId < b.tokenId ? -1 : a.tokenId > b.tokenId ? 1 : 0)))
  }
  const down = new Set((holdings.unavailable ?? []).map((a) => a.toLowerCase()))
  const held = (address: string) => {
    const key = address.toLowerCase()
    if (down.has(key)) throw new OwnershipError('unavailable')
    return owners.get(key) ?? []
  }
  return {
    source: 'fixture',
    async listOwnedFriends(address) {
      return { friends: held(address).map((f) => ({ ...f })), blockNumber: 0n }
    },
    async verifyOwnership(address, tokenId) {
      return held(address).some((f) => f.tokenId === tokenId)
    },
    async resolveFamily(tokenId) {
      const family = familyById(families.get(tokenId))
      if (!family) throw new OwnershipError('unknown-token')
      return family
    },
    async verifyActivation(address, tokenId) {
      const mine = held(address)
      const family = familyById(families.get(tokenId))
      if (!family) throw new OwnershipError('unknown-token')
      return { owned: mine.some((f) => f.tokenId === tokenId), family, blockNumber: 0n }
    },
  }
}
