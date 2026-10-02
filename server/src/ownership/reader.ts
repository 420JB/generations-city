import { OwnershipError, type OwnedFriends, type OwnershipProvider } from './provider'

/**
 * The owned-Friends READ VIEW: what "My Friends" shows.
 *
 * A discovery costs several RPC round trips, so a successful answer is reused for a short
 * time, concurrent requests for one wallet share one discovery, and only a few
 * discoveries run at once. Failures are never remembered.
 *
 * This is a display cache. Anything that decides what a wallet may DO must ask the
 * provider directly (`verifyOwnership`), never this.
 */
export interface FriendsReader {
  readonly source: OwnershipProvider['source']
  read(address: string): Promise<OwnedFriends>
}

export interface FriendsReaderOptions {
  /** How long a successful answer is reused. */
  ttlMs?: number
  /** Wallets remembered at once. */
  maxEntries?: number
  /** Discoveries in flight at once. Past this, a request is told to retry rather than queued. */
  maxConcurrent?: number
  now?: () => number
}

export function createFriendsReader(provider: OwnershipProvider, options: FriendsReaderOptions = {}): FriendsReader {
  const { ttlMs = 30_000, maxEntries = 500, maxConcurrent = 4 } = options
  const now = options.now ?? (() => Date.now())
  const cache = new Map<string, { at: number; value: OwnedFriends }>()
  const inFlight = new Map<string, Promise<OwnedFriends>>()

  return {
    source: provider.source,
    read(address) {
      const key = address.toLowerCase()
      const hit = cache.get(key)
      if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.value)
      const running = inFlight.get(key)
      if (running) return running
      if (inFlight.size >= maxConcurrent) return Promise.reject(new OwnershipError('unavailable'))

      const work = provider
        .listOwnedFriends(address)
        .then((value) => {
          // Re-inserting moves the wallet to the back; the front is the one unused longest.
          cache.delete(key)
          cache.set(key, { at: now(), value })
          if (cache.size > maxEntries) cache.delete(cache.keys().next().value!)
          return value
        })
        .finally(() => inFlight.delete(key))
      inFlight.set(key, work)
      return work
    },
  }
}
