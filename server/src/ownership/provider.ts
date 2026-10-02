import type { Family } from '../engine'

/**
 * Where Rare City learns which Friends a wallet owns and which family a Friend belongs to.
 *
 * The rest of the service knows only this interface. Everything specific to Rare Friends
 * on Robinhood Chain (contracts, RPC, log history, the Rare Friends SDK if it is ever
 * used) lives behind it in an adapter, so the source can change without the core changing.
 *
 * Answers are read from the authority at call time. Nothing a browser says about what it
 * owns is ever an input.
 */
export interface OwnedFriend {
  tokenId: bigint
  family: Family
}

export interface OwnedFriends {
  /** Ascending by token id. */
  friends: OwnedFriend[]
  /** The block every read in this answer was pinned to. */
  blockNumber: bigint
}

export interface OwnershipProvider {
  readonly source: 'robinhood-chain' | 'fixture'
  /** Every Friend `address` owns right now. Throws OwnershipError; never answers "none" for "could not tell". */
  listOwnedFriends(address: string): Promise<OwnedFriends>
  /** Whether `address` owns this Friend right now. */
  verifyOwnership(address: string, tokenId: bigint): Promise<boolean>
  /** The canonical family of an existing Friend. */
  resolveFamily(tokenId: bigint): Promise<Family>
}

/**
 * Why ownership could not be established.
 * - `unavailable`    the source did not answer (network, RPC error, limits exhausted, deadline).
 * - `wrong-chain`    the endpoint is not Robinhood Chain.
 * - `inconsistent`   the source's answers disagree with each other; nothing can be concluded.
 * - `too-large`      the wallet holds more Friends than one read supports.
 * - `invalid-family` the registry returned a family id that is not one of the nine.
 * - `unknown-token`  the Friend does not exist.
 */
export type OwnershipFailure = 'unavailable' | 'wrong-chain' | 'inconsistent' | 'too-large' | 'invalid-family' | 'unknown-token'

export class OwnershipError extends Error {
  readonly reason: OwnershipFailure
  constructor(reason: OwnershipFailure, options?: ErrorOptions) {
    // The message is the reason only: an RPC error's own text can contain the endpoint URL.
    super(`ownership ${reason}`, options)
    this.name = 'OwnershipError'
    this.reason = reason
  }
}
