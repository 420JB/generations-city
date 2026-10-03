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

/**
 * What the authority says about one Friend, for one wallet, at ONE block: who owns it and
 * which family it is. Both facts were read at `blockNumber`, so they describe the same
 * moment and cannot be stitched together from two.
 */
export interface ActivationOwnership {
  /** Whether the wallet owned the Friend at `blockNumber`. */
  owned: boolean
  /** The registry's family for the Friend at `blockNumber`: canonical whoever owns it. */
  family: Family
  /** The block both reads were pinned to: the chain's latest when the call was made. */
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
  /**
   * THE ACTIVATION READ. Ownership and family of one Friend at one freshly pinned block,
   * for deciding a permanent write. Never cached, never taken from Transfer history or
   * from the My Friends view. Throws OwnershipError when the answer cannot be established
   * (`unknown-token` when the Friend does not exist, which is not an outage); it never
   * answers "not owned" for "could not tell".
   */
  verifyActivation(address: string, tokenId: bigint): Promise<ActivationOwnership>
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
