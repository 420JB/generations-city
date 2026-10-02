import { BaseError, createPublicClient, getAddress, isAddressEqual, parseAbi, parseAbiItem, type Address, type Transport } from 'viem'
import { familyById, RARE_FRIENDS_CHAIN, type Family } from '../engine'
import { OwnershipError, type OwnedFriend, type OwnedFriends, type OwnershipProvider } from './provider'

/**
 * Rare Friends on Robinhood Chain: the real ownership adapter. READ-ONLY.
 *
 * The Generations contract is a plain ERC-721 without owner enumeration (it does not
 * implement ERC721Enumerable), so the Friends a wallet owns are found the way the public
 * Rare Friends SDK finds them:
 *
 *   1. pin one block, and read every answer at that block;
 *   2. read `balanceOf(account)`: how many Friends the contract says the wallet holds;
 *   3. read the wallet's own Transfer history, both directions, filtered by the indexed
 *      account topic. The collection is never scanned;
 *   4. replay that history in chain order into the set of token ids still held;
 *   5. require the set to be exactly as large as `balanceOf`: a truncated or partial
 *      history cannot pass;
 *   6. confirm `ownerOf(tokenId) == account` for every one of them;
 *   7. resolve each family with `familyOf(tokenId)` on the Families Registry.
 *
 * History only nominates candidates. A token is returned because the contract says the
 * wallet owns it at the pinned block, never because of a past Transfer. Any failure is an
 * OwnershipError: "could not tell" is never reported as "owns nothing".
 *
 * The only calls made are eth_chainId, eth_blockNumber, eth_getLogs and eth_call. RF is
 * not read, and nothing is ever signed or sent.
 */
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)')
const GENERATIONS_ABI = parseAbi(['function balanceOf(address owner) view returns (uint256)', 'function ownerOf(uint256 tokenId) view returns (address)'])
const FAMILIES_ABI = parseAbi(['function familyOf(uint256 tokenId) view returns (uint8)'])
/** The standard Multicall3 deployment, present on Robinhood Chain. Used only to batch read-only calls. */
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

/** ABI-encoded revert data: a four-byte selector, then zero or more 32-byte words. */
const REVERT_DATA = /^0x[0-9a-fA-F]{8}(?:[0-9a-fA-F]{64})*$/

/** JSON-RPC error codes a provider uses to say "that log query is too wide or too heavy". */
const NARROWABLE_CODES = new Set([-32602, -32005, -32000, -32603])

export interface GenerationsProviderOptions {
  /** viem transport for the RPC endpoint. Its URL is never logged or put in an error message. */
  transport: Transport
  /** Widest block range asked for in one log query. The public RPC allows ten million. */
  maxBlockSpan?: bigint
  /** A query that still fails at this width is a failure, not something to narrow further. */
  minBlockSpan?: bigint
  /** Ceiling on eth_getLogs requests in one discovery, failed ones included. */
  maxLogRequests?: number
  /** Ceiling on Transfer logs accepted for one wallet. */
  maxTransferLogs?: number
  /** Ceiling on Friends one wallet may hold for this read. */
  maxOwned?: number
  /** Contract reads bundled into one eth_call. */
  callBatchSize?: number
  /** Batched calls in flight at once. */
  concurrency?: number
  /** Whole-discovery time budget. */
  deadlineMs?: number
  now?: () => number
}

type TransferLog = { blockNumber: bigint; logIndex: number; from: Address; to: Address; tokenId: bigint }

const MAX_UINT256 = (1n << 256n) - 1n

/**
 * True only when the contract itself reverted, as opposed to the endpoint failing.
 *
 * Deliberately narrow, because a revert is treated as an answer ("no such token"): it takes
 * the node's own "execution reverted" code together with revert data that really is ABI
 * error bytes. An endpoint error that merely looks like a revert (an internal error, a
 * rate limit reusing the code, a message in place of data) stays an error.
 */
function isRevert(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false
  return (
    err.walk((e) => {
      const { code, data } = e as { code?: unknown; data?: unknown }
      const bytes = typeof data === 'object' && data !== null ? (data as { data?: unknown }).data : data
      // Code 3 is "execution reverted", and a real revert of these calls carries at least an error selector.
      return code === 3 && typeof bytes === 'string' && REVERT_DATA.test(bytes)
    }) !== null
  )
}

/** True when a provider rejected a log query in a way a narrower block range may cure. */
function isNarrowable(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false
  const coded = err.walk((e) => typeof (e as { code?: unknown }).code === 'number') as { code?: number } | null
  return typeof coded?.code === 'number' && NARROWABLE_CODES.has(coded.code)
}

/** Run `work` over `items` with at most `limit` in flight; results keep their order. */
async function pooled<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const lane = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await work(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return out
}

const chunk = <T>(items: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))

export function createGenerationsOwnershipProvider(options: GenerationsProviderOptions): OwnershipProvider {
  const { maxBlockSpan = 10_000_000n, minBlockSpan = 50_000n, maxLogRequests = 96, maxTransferLogs = 50_000, maxOwned = 2_000, callBatchSize = 200, concurrency = 4, deadlineMs = 25_000 } = options
  const now = options.now ?? (() => Date.now())
  const chain = RARE_FRIENDS_CHAIN
  // ccipRead off: a contract (or the endpoint, by faking a revert) must never be able to make this service fetch a URL.
  const client = createPublicClient({ transport: options.transport, cacheTime: 0, ccipRead: false })

  /** Anything not already an OwnershipError is the endpoint failing. The cause is kept for the log, by name only. */
  const failed = (err: unknown): OwnershipError => (err instanceof OwnershipError ? err : new OwnershipError('unavailable', { cause: err }))

  async function assertChain() {
    if ((await client.getChainId()) !== chain.chainId) throw new OwnershipError('wrong-chain')
  }

  function parseTokenId(tokenId: bigint): bigint {
    if (typeof tokenId !== 'bigint' || tokenId < 0n || tokenId > MAX_UINT256) throw new OwnershipError('unknown-token')
    return tokenId
  }

  /** The wallet's Transfer history in [from, to], both directions, narrowing the range when the provider objects. */
  async function transferHistory(account: Address, from: bigint, to: bigint, expired: () => boolean): Promise<TransferLog[]> {
    const seen = new Map<string, TransferLog>()
    let span = maxBlockSpan
    let cursor = from
    let requests = 0
    while (cursor <= to) {
      if (expired()) throw new OwnershipError('unavailable')
      requests += 2
      if (requests > maxLogRequests) throw new OwnershipError('unavailable')
      const end = cursor + span - 1n < to ? cursor + span - 1n : to
      const query = { address: chain.generations, event: TRANSFER, fromBlock: cursor, toBlock: end, strict: true } as const
      let pages
      try {
        pages = await Promise.all([client.getLogs({ ...query, args: { to: account } }), client.getLogs({ ...query, args: { from: account } })])
      } catch (err) {
        // A range or result limit, or a query that timed out server-side: ask for half as much.
        if (!isNarrowable(err) || span <= minBlockSpan) throw failed(err)
        span = span / 2n > minBlockSpan ? span / 2n : minBlockSpan
        continue
      }
      for (const log of pages.flat()) {
        const { from: sender, to: receiver, tokenId } = log.args
        // Anything that is not a mined Generations Transfer touching this account, inside the range asked for, is not evidence.
        if (log.removed || log.blockNumber === null || log.logIndex === null || !isAddressEqual(log.address, chain.generations)) throw new OwnershipError('inconsistent')
        if (log.blockNumber < cursor || log.blockNumber > end || tokenId < 0n || tokenId > MAX_UINT256) throw new OwnershipError('inconsistent')
        if (!isAddressEqual(sender, account) && !isAddressEqual(receiver, account)) throw new OwnershipError('inconsistent')
        // A transfer to oneself appears in both directions: one event, counted once.
        seen.set(`${log.blockNumber}:${log.logIndex}`, { blockNumber: log.blockNumber, logIndex: log.logIndex, from: sender, to: receiver, tokenId })
        if (seen.size > maxTransferLogs) throw new OwnershipError('too-large')
      }
      cursor = end + 1n
    }
    return [...seen.values()].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))
  }

  /** One contract read per token id, batched through Multicall3 and pinned to `blockNumber`. */
  async function readEach<T>(ids: readonly bigint[], blockNumber: bigint, call: (id: bigint) => { address: Address; abi: typeof GENERATIONS_ABI | typeof FAMILIES_ABI; functionName: string; args: readonly [bigint] }, expired: () => boolean): Promise<T[]> {
    const groups = await pooled(chunk(ids, callBatchSize), concurrency, async (group) => {
      if (expired()) throw new OwnershipError('unavailable')
      // batchSize 0: one eth_call per group, so `concurrency` really is the number in flight.
      const results = (await client.multicall({ contracts: group.map(call) as never, allowFailure: true, blockNumber, multicallAddress: MULTICALL3, batchSize: 0 })) as { status: 'success' | 'failure'; result?: unknown; error?: unknown }[]
      return results.map((r) => {
        if (r.status === 'success') return r.result as T
        // At a pinned block every one of these reads must succeed. A revert means the history named a token the
        // contract does not have; anything else is the endpoint failing.
        throw isRevert(r.error) ? new OwnershipError('inconsistent') : new OwnershipError('unavailable', { cause: r.error })
      })
    })
    return groups.flat()
  }

  function familyOrThrow(id: unknown): Family {
    const family = familyById(typeof id === 'bigint' ? Number(id) : id)
    if (!family) throw new OwnershipError('invalid-family')
    return family
  }

  async function discover(address: string): Promise<OwnedFriends> {
    const deadline = now() + deadlineMs
    const expired = () => now() > deadline
    try {
      const account = getAddress(address)
      await assertChain()
      const blockNumber = await client.getBlockNumber({ cacheTime: 0 })
      if (blockNumber < chain.generationsFirstTransferBlock) throw new OwnershipError('inconsistent')

      const balance = await client.readContract({ address: chain.generations, abi: GENERATIONS_ABI, functionName: 'balanceOf', args: [account], blockNumber })
      if (balance > BigInt(maxOwned)) throw new OwnershipError('too-large')
      // The contract itself says this wallet holds nothing: an authoritative empty answer.
      if (balance === 0n) return { friends: [], blockNumber }

      const held = new Set<bigint>()
      for (const log of await transferHistory(account, chain.generationsFirstTransferBlock, blockNumber, expired)) {
        if (isAddressEqual(log.to, account)) held.add(log.tokenId)
        else held.delete(log.tokenId)
      }
      // History and contract must agree on how many: a truncated or incomplete history fails here.
      if (BigInt(held.size) !== balance) throw new OwnershipError('inconsistent')

      const ids = [...held].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      const owners = await readEach<Address>(ids, blockNumber, (id) => ({ address: chain.generations, abi: GENERATIONS_ABI, functionName: 'ownerOf', args: [id] }), expired)
      // CURRENT OWNERSHIP. Every candidate must be owned by this wallet according to the contract, at the pinned block.
      if (!owners.every((owner) => isAddressEqual(owner, account))) throw new OwnershipError('inconsistent')

      const families = await readEach<number>(ids, blockNumber, (id) => ({ address: chain.familiesRegistry, abi: FAMILIES_ABI, functionName: 'familyOf', args: [id] }), expired)
      const friends: OwnedFriend[] = ids.map((tokenId, i) => ({ tokenId, family: familyOrThrow(families[i]) }))
      return { friends, blockNumber }
    } catch (err) {
      throw failed(err)
    }
  }

  return {
    source: 'robinhood-chain',

    async listOwnedFriends(address): Promise<OwnedFriends> {
      // Two limits: `expired` stops the work between steps, and the timer bounds the wait whatever a step is doing.
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeUp = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new OwnershipError('unavailable')), deadlineMs)
      })
      try {
        return await Promise.race([discover(address), timeUp])
      } finally {
        clearTimeout(timer)
      }
    },

    async verifyOwnership(address, tokenId) {
      try {
        const account = getAddress(address)
        await assertChain()
        const owner = await client.readContract({ address: chain.generations, abi: GENERATIONS_ABI, functionName: 'ownerOf', args: [parseTokenId(tokenId)] })
        return isAddressEqual(owner, account)
      } catch (err) {
        // The contract reverts for a token that does not exist: nobody owns it.
        if (isRevert(err)) return false
        throw failed(err)
      }
    },

    async resolveFamily(tokenId) {
      try {
        await assertChain()
        const id = parseTokenId(tokenId)
        // The registry answers for any number, minted or not, so existence is established first.
        try {
          await client.readContract({ address: chain.generations, abi: GENERATIONS_ABI, functionName: 'ownerOf', args: [id] })
        } catch (err) {
          throw isRevert(err) ? new OwnershipError('unknown-token') : err
        }
        return familyOrThrow(await client.readContract({ address: chain.familiesRegistry, abi: FAMILIES_ABI, functionName: 'familyOf', args: [id] }))
      } catch (err) {
        throw failed(err)
      }
    },
  }
}
