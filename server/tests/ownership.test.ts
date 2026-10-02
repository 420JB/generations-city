import { encodeErrorResult, parseAbi } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { familyById, RARE_FRIENDS_CHAIN, RARE_FRIENDS_FAMILIES } from '../src/engine'
import { createFixtureOwnershipProvider, DEV_FIXTURE } from '../src/ownership/fixture'
import { createGenerationsOwnershipProvider, type GenerationsProviderOptions } from '../src/ownership/generations'
import { OwnershipError, type OwnershipProvider } from '../src/ownership/provider'
import { createFriendsReader } from '../src/ownership/reader'
import { addr, fakeChain, FIRST_BLOCK, type FakeChain } from './fakeChain'

const ME = addr(0xa11ce)
const OTHER = addr(0xb0b)
const THIRD = addr(0xc4a7)

const provider = (chain: FakeChain, options: Partial<GenerationsProviderOptions> = {}) => createGenerationsOwnershipProvider({ transport: chain.transport, ...options })
const ids = async (p: OwnershipProvider, account = ME) => (await p.listOwnedFriends(account)).friends.map((f) => f.tokenId)
const failure = async (work: Promise<unknown>) => {
  const err = await work.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(OwnershipError)
  return (err as OwnershipError).reason
}
const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code })

describe('canonical Rare Friends chain configuration', () => {
  it('names Robinhood Chain and the verified contracts, in one place', () => {
    expect(RARE_FRIENDS_CHAIN).toMatchObject({
      chainId: 4663,
      publicRpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
      generations: '0x14C49e6118F46525dE9ab41a51cBAA3c6EBF181D',
      generationsFirstTransferBlock: 63_102_373n,
      familiesRegistry: '0x246E3E9730A7Eade94c79be0Fd78d210f89AEb8D',
      generationMetadata: '0x3A243E7f46970275CaE8375b0032e53dF91a9110',
      rf: { address: '0x0779369854d3EcdEA927206718FFD7730C67B71f', decimals: 18 },
    })
  })

  it('maps the nine family ids exactly, and nothing else', () => {
    expect(RARE_FRIENDS_FAMILIES).toEqual(['Skeleton', 'Mask', 'Family', 'Cellular', 'Asymmetry', 'Hoverer', 'Colossus', 'Sparkling', 'Hollow'])
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((id) => familyById(id))).toEqual(RARE_FRIENDS_FAMILIES.map((name, id) => ({ id, name })))
    for (const id of [-1, 9, 255, 1.5, Number.NaN, '2', null, undefined, 2n]) expect(familyById(id), String(id)).toBeNull()
  })
})

describe('Generations ownership discovery', () => {
  it('returns a Friend that came in and is still owned, with its on-chain family', async () => {
    const chain = fakeChain()
    chain.mint(ME, 812n)
    chain.families.set(812n, 7)
    const result = await provider(chain).listOwnedFriends(ME)
    expect(result).toEqual({ friends: [{ tokenId: 812n, family: { id: 7, name: 'Sparkling' } }], blockNumber: chain.head })
  })

  it('does not return a Friend that came in and then left', async () => {
    const chain = fakeChain()
    chain.mint(ME, 1n)
    chain.mint(ME, 2n)
    chain.transfer(ME, OTHER, 1n)
    expect(await ids(provider(chain))).toEqual([2n])
    expect(await ids(provider(chain), OTHER)).toEqual([1n])
  })

  it('counts a Friend once however often it moved, and follows it through a round trip', async () => {
    const chain = fakeChain()
    chain.mint(OTHER, 5n)
    chain.transfer(OTHER, ME, 5n)
    chain.transfer(ME, OTHER, 5n)
    chain.transfer(OTHER, ME, 5n)
    chain.transfer(ME, ME, 5n)
    chain.mint(ME, 9n)
    chain.transfer(ME, THIRD, 9n)
    chain.transfer(THIRD, ME, 9n)
    expect(await ids(provider(chain))).toEqual([5n, 9n])
    expect(await ids(provider(chain), OTHER)).toEqual([])
  })

  it('orders transfers by block and log index, not by the order the provider lists them', async () => {
    const chain = fakeChain()
    // Same block: received at log 0, sent at log 1. Listed in reverse.
    chain.transfers.push({ block: FIRST_BLOCK + 10n, logIndex: 1, from: ME, to: OTHER, tokenId: 3n }, { block: FIRST_BLOCK + 10n, logIndex: 0, from: OTHER, to: ME, tokenId: 3n })
    chain.ownerOverride.set(3n, OTHER)
    chain.balanceOverride.set(ME.toLowerCase(), 1n)
    // History says "left", the contract says "holds one": they disagree, so nothing is claimed.
    expect(await failure(provider(chain).listOwnedFriends(ME))).toBe('inconsistent')
    chain.balanceOverride.set(ME.toLowerCase(), 0n)
    expect(await ids(provider(chain))).toEqual([])
  })

  it('requires the contract to confirm the current owner: transfer history alone never returns a Friend', async () => {
    const chain = fakeChain()
    chain.mint(ME, 40n)
    chain.mint(ME, 41n)
    // The history says ME received #41 and never sent it, and the balance agrees, but ownerOf names someone else.
    chain.ownerOverride.set(41n, OTHER)
    chain.balanceOverride.set(ME.toLowerCase(), 2n)
    expect(await failure(provider(chain).listOwnedFriends(ME))).toBe('inconsistent')
    // Likewise when the token the history names does not exist at all.
    chain.ownerOverride.set(41n, null)
    expect(await failure(provider(chain).listOwnedFriends(ME))).toBe('inconsistent')
  })

  it('refuses a history that does not add up to the balance the contract reports', async () => {
    const chain = fakeChain()
    for (const id of [1n, 2n, 3n]) chain.mint(ME, id)
    // A provider that silently truncates: one incoming transfer never arrives.
    chain.dropLogs = (t) => t.tokenId === 2n
    expect(await failure(provider(chain).listOwnedFriends(ME))).toBe('inconsistent')
  })

  it('answers an empty wallet from the contract, without reading any history', async () => {
    const chain = fakeChain()
    chain.mint(OTHER, 1n)
    expect(await provider(chain).listOwnedFriends(ME)).toEqual({ friends: [], blockNumber: chain.head })
    expect(chain.requests.map((r) => r.method)).toEqual(['eth_chainId', 'eth_blockNumber', 'eth_call'])
  })

  it('asks only for this wallet, from the first Transfer block, pinned to one block, and never scans the collection', async () => {
    const chain = fakeChain()
    chain.mint(ME, 7n)
    await provider(chain).listOwnedFriends(ME)
    const logs = chain.requests.filter((r) => r.method === 'eth_getLogs').map((r) => r.params[0] as { address: string; topics: (string | null)[] })
    expect(logs.length).toBeGreaterThan(0)
    const padded = `0x${ME.slice(2).toLowerCase().padStart(64, '0')}`
    for (const filter of logs) {
      expect(filter.address.toLowerCase()).toBe(RARE_FRIENDS_CHAIN.generations.toLowerCase())
      // Every query is filtered by the account on one of the indexed positions.
      expect([filter.topics[1], filter.topics[2]].filter((t) => t === padded)).toHaveLength(1)
    }
    const ranges = chain.logQueries()
    expect(ranges[0].fromBlock).toBe(FIRST_BLOCK)
    expect(ranges.at(-1)!.toBlock).toBe(chain.head)
    // Every contract read names the same block the history was read up to.
    const pinned = `0x${chain.head.toString(16)}`
    for (const call of chain.requests.filter((r) => r.method === 'eth_call')) expect(call.params[1]).toBe(pinned)
    // Only read methods are ever used.
    expect(new Set(chain.requests.map((r) => r.method))).toEqual(new Set(['eth_chainId', 'eth_blockNumber', 'eth_getLogs', 'eth_call']))
  })

  it('pages the history in ranges the provider accepts', async () => {
    const chain = fakeChain()
    chain.maxSpan = 10_000_000n
    chain.mint(ME, 1n, FIRST_BLOCK + 5n)
    chain.mint(ME, 2n, FIRST_BLOCK + 12_000_000n)
    expect(await ids(provider(chain))).toEqual([1n, 2n])
    const ranges = chain.logQueries()
    // 14,000,001 blocks: two pages, each asked for in both directions.
    expect(ranges).toHaveLength(4)
    expect(ranges.every((r) => r.toBlock - r.fromBlock + 1n <= 10_000_000n)).toBe(true)
    expect(ranges[2].fromBlock).toBe(ranges[0].toBlock + 1n)
  })

  it('narrows the range when the provider says it is too wide, and still reads every block exactly once', async () => {
    const chain = fakeChain()
    chain.maxSpan = 3_000_000n
    chain.mint(ME, 1n, FIRST_BLOCK)
    chain.mint(ME, 2n, FIRST_BLOCK + 6_999_999n)
    chain.mint(ME, 3n, chain.head)
    expect(await ids(provider(chain))).toEqual([1n, 2n, 3n])
    const ok = chain.logQueries().filter((r) => r.toBlock - r.fromBlock + 1n <= 3_000_000n)
    const incoming = ok.filter((_, i) => i % 2 === 0)
    expect(incoming[0].fromBlock).toBe(FIRST_BLOCK)
    expect(incoming.at(-1)!.toBlock).toBe(chain.head)
    for (let i = 1; i < incoming.length; i++) expect(incoming[i].fromBlock).toBe(incoming[i - 1].toBlock + 1n)
  })

  it('narrows the range when a query returns too many results', async () => {
    const chain = fakeChain()
    chain.maxResults = 2
    for (let i = 0; i < 6; i++) chain.mint(ME, BigInt(i + 1), FIRST_BLOCK + BigInt(i) * 2_000_000n)
    expect(await ids(provider(chain))).toEqual([1n, 2n, 3n, 4n, 5n, 6n])
  })

  it('gives up honestly when narrowing cannot help, within a fixed request budget', async () => {
    const chain = fakeChain()
    chain.mint(ME, 1n)
    chain.maxSpan = 10n
    expect(await failure(provider(chain).listOwnedFriends(ME))).toBe('unavailable')
    // 10M → 50k is eight halvings: nine attempts, two queries each, then it stops.
    expect(chain.logQueries().length).toBeLessThanOrEqual(18)

    const greedy = fakeChain()
    greedy.mint(ME, 1n)
    greedy.maxSpan = 60_000n
    expect(await failure(provider(greedy, { maxLogRequests: 40 }).listOwnedFriends(ME))).toBe('unavailable')
    expect(greedy.logQueries().length).toBeLessThanOrEqual(40)
  })

  it('reports an RPC failure as unavailable, never as an empty wallet', async () => {
    for (const method of ['eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_getLogs']) {
      const chain = fakeChain()
      chain.mint(ME, 1n)
      chain.fail = (m) => (m === method ? new Error('socket hang up https://rpc.example/secret-key') : undefined)
      const err = await provider(chain)
        .listOwnedFriends(ME)
        .catch((e: unknown) => e)
      expect(err, method).toBeInstanceOf(OwnershipError)
      expect((err as OwnershipError).reason, method).toBe('unavailable')
      // The provider's own text (which can hold the endpoint URL) is not the message.
      expect((err as OwnershipError).message).toBe('ownership unavailable')
    }
  })

  it('reports a failed family or owner batch as unavailable, not as a missing Friend', async () => {
    const chain = fakeChain()
    chain.mint(ME, 1n)
    let calls = 0
    // balanceOf answers; the batched ownerOf read is an endpoint error.
    chain.fail = (m) => (m === 'eth_call' && ++calls === 2 ? rpcError(-32603, 'internal error') : undefined)
    expect(await failure(provider(chain).listOwnedFriends(ME))).toBe('unavailable')
  })

  it('stops at its deadline, between steps and in the middle of one', async () => {
    const chain = fakeChain()
    chain.mint(ME, 1n)
    let t = 0
    expect(await failure(provider(chain, { deadlineMs: 5_000, now: () => (t += 10_000) }).listOwnedFriends(ME))).toBe('unavailable')

    // An endpoint that never answers at all: the wait itself is bounded.
    const stuck = fakeChain()
    stuck.fail = () => undefined
    const hang = stuck.transport
    const never = createGenerationsOwnershipProvider({ transport: (args) => ({ ...hang(args), request: () => new Promise(() => {}) }), deadlineMs: 30 })
    const started = Date.now()
    expect(await failure(never.listOwnedFriends(ME))).toBe('unavailable')
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('refuses a wallet too large for one read instead of truncating it', async () => {
    const chain = fakeChain()
    for (let i = 1; i <= 4; i++) chain.mint(ME, BigInt(i))
    expect(await failure(provider(chain, { maxOwned: 3 }).listOwnedFriends(ME))).toBe('too-large')
    expect(chain.requests.some((r) => r.method === 'eth_getLogs')).toBe(false)
    expect(await ids(provider(chain, { maxOwned: 4 }))).toEqual([1n, 2n, 3n, 4n])
  })

  it('reads many Friends in bounded batches', async () => {
    const chain = fakeChain()
    for (let i = 1; i <= 25; i++) chain.mint(ME, BigInt(i), FIRST_BLOCK + BigInt(i))
    const before = chain.requests.length
    expect(await ids(provider(chain, { callBatchSize: 10, concurrency: 2 }))).toEqual(Array.from({ length: 25 }, (_, i) => BigInt(i + 1)))
    // balanceOf + 3 owner batches + 3 family batches.
    expect(chain.requests.slice(before).filter((r) => r.method === 'eth_call')).toHaveLength(7)
  })

  it('keeps token ids as bigint beyond the safe integer range', async () => {
    const chain = fakeChain()
    const huge = 2n ** 200n + 7n
    chain.mint(ME, huge)
    expect(await ids(provider(chain))).toEqual([huge])
  })

  it('rejects an endpoint that is not Robinhood Chain', async () => {
    const chain = fakeChain()
    chain.mint(ME, 1n)
    chain.chainId = 1
    const p = provider(chain)
    expect(await failure(p.listOwnedFriends(ME))).toBe('wrong-chain')
    expect(await failure(p.verifyOwnership(ME, 1n))).toBe('wrong-chain')
    expect(await failure(p.resolveFamily(1n))).toBe('wrong-chain')
    expect(chain.requests.map((r) => r.method)).toEqual(['eth_chainId', 'eth_chainId', 'eth_chainId'])
  })
})

describe('family resolution', () => {
  it('maps every registry id to its family', async () => {
    const chain = fakeChain()
    RARE_FRIENDS_FAMILIES.forEach((_, id) => {
      chain.mint(ME, BigInt(100 + id))
      chain.families.set(BigInt(100 + id), id)
    })
    const { friends } = await provider(chain).listOwnedFriends(ME)
    expect(friends.map((f) => f.family)).toEqual(RARE_FRIENDS_FAMILIES.map((name, id) => ({ id, name })))
    expect(await provider(chain).resolveFamily(104n)).toEqual({ id: 4, name: 'Asymmetry' })
  })

  it('treats an id outside 0-8 as an error, never as a family', async () => {
    for (const bad of [9, 200, 255]) {
      const chain = fakeChain()
      chain.mint(ME, 1n)
      chain.mint(ME, 2n)
      chain.families.set(2n, bad)
      expect(await failure(provider(chain).listOwnedFriends(ME)), String(bad)).toBe('invalid-family')
      expect(await failure(provider(chain).resolveFamily(2n))).toBe('invalid-family')
    }
  })

  it('does not resolve a family for a Friend that does not exist, though the registry would answer', async () => {
    const chain = fakeChain()
    chain.mint(ME, 1n)
    expect(await failure(provider(chain).resolveFamily(999n))).toBe('unknown-token')
    chain.fail = (m) => (m === 'eth_call' ? rpcError(-32603, 'internal error') : undefined)
    expect(await failure(provider(chain).resolveFamily(1n))).toBe('unavailable')
  })
})

describe('verifyOwnership', () => {
  it('is true only for the current owner', async () => {
    const chain = fakeChain()
    chain.mint(ME, 1n)
    chain.transfer(ME, OTHER, 1n)
    const p = provider(chain)
    expect(await p.verifyOwnership(OTHER, 1n)).toBe(true)
    expect(await p.verifyOwnership(OTHER.toLowerCase(), 1n)).toBe(true)
    expect(await p.verifyOwnership(ME, 1n)).toBe(false)
    expect(await p.verifyOwnership(ME, 404n)).toBe(false)
  })

  it('treats an endpoint error as "could not tell", not as "not the owner"', async () => {
    const chain = fakeChain()
    chain.mint(ME, 1n)
    // Endpoint failures, including ones a client library would present as a contract revert.
    const errors = [
      rpcError(-32603, 'internal error'),
      Object.assign(rpcError(-32603, 'Internal error'), { data: 'upstream request timeout' }),
      Object.assign(rpcError(-32603, 'Internal error'), { data: { data: 'backend down' } }),
      Object.assign(rpcError(-32603, 'Internal error'), { data: '0x7e273289' }),
      rpcError(3, 'too many requests'),
      Object.assign(rpcError(3, 'execution reverted'), { data: 'not hex at all' }),
      Object.assign(rpcError(3, 'execution reverted'), { data: '0x' }),
      rpcError(-32000, 'header not found'),
      new Error('timeout'),
    ]
    for (const error of errors) {
      chain.fail = (m) => (m === 'eth_call' ? error : undefined)
      const label = JSON.stringify({ ...error, message: error.message })
      expect(await failure(provider(chain).verifyOwnership(ME, 1n)), label).toBe('unavailable')
      expect(await failure(provider(chain).resolveFamily(1n)), label).toBe('unavailable')
    }
    // A genuine revert (the node's code 3 with ABI error bytes) is still an answer.
    chain.fail = () => undefined
    expect(await provider(chain).verifyOwnership(ME, 404n)).toBe(false)
  })

  it('never fetches a URL because a contract call asked it to (CCIP-Read is off)', async () => {
    const fetched: string[] = []
    vi.stubGlobal('fetch', async (input: unknown) => {
      fetched.push(String(input))
      return new Response('0x', { status: 200 })
    })
    try {
      const chain = fakeChain()
      chain.mint(ME, 1n)
      const lookup = encodeErrorResult({
        abi: parseAbi(['error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)']),
        errorName: 'OffchainLookup',
        args: [RARE_FRIENDS_CHAIN.generations, ['http://169.254.169.254/latest/meta-data/{sender}/{data}', 'http://postgres.internal:5432/'], '0x1234', '0x12345678', '0x'],
      })
      chain.fail = (m) => (m === 'eth_call' ? Object.assign(rpcError(3, 'execution reverted'), { data: lookup }) : undefined)
      await provider(chain)
        .verifyOwnership(ME, 1n)
        .catch(() => undefined)
      expect(await failure(provider(chain).listOwnedFriends(ME))).toBe('unavailable')
      expect(fetched).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('fixture ownership provider', () => {
  it('is deterministic, labelled, and case-insensitive about addresses', async () => {
    const p = createFixtureOwnershipProvider()
    const [first] = Object.keys(DEV_FIXTURE.owners)
    expect(p.source).toBe('fixture')
    const a = await p.listOwnedFriends(first)
    expect(a).toEqual(await p.listOwnedFriends(first.toLowerCase()))
    expect(a.friends).toEqual([
      { tokenId: 812n, family: { id: 2, name: 'Family' } },
      { tokenId: 1204n, family: { id: 0, name: 'Skeleton' } },
      { tokenId: 4471n, family: { id: 7, name: 'Sparkling' } },
    ])
    expect(await p.listOwnedFriends(addr(1))).toEqual({ friends: [], blockNumber: 0n })
    expect(await p.verifyOwnership(first, 812n)).toBe(true)
    expect(await p.verifyOwnership(addr(1), 812n)).toBe(false)
    expect(await p.resolveFamily(1204n)).toEqual({ id: 0, name: 'Skeleton' })
    expect(await failure(p.resolveFamily(5n))).toBe('unknown-token')
  })

  it('can be unavailable, and refuses a family that does not exist', async () => {
    expect(await failure(createFixtureOwnershipProvider().listOwnedFriends(DEV_FIXTURE.unavailable![0]))).toBe('unavailable')
    expect(() => createFixtureOwnershipProvider({ owners: { [ME]: [[1n, 9]] } })).toThrow(/not a Rare Friends family/)
  })
})

describe('owned-Friends read view', () => {
  function counting() {
    const calls: string[] = []
    let fail = false
    const p: OwnershipProvider = {
      source: 'robinhood-chain',
      async listOwnedFriends(address) {
        calls.push(address)
        await new Promise((done) => setTimeout(done, 5))
        if (fail) throw new OwnershipError('unavailable')
        return { friends: [{ tokenId: BigInt(calls.length), family: { id: 2, name: 'Family' } }], blockNumber: 1n }
      },
      verifyOwnership: async () => false,
      resolveFamily: async () => ({ id: 2, name: 'Family' }),
    }
    return { p, calls, setFail: (v: boolean) => (fail = v) }
  }

  it('shares one discovery between concurrent readers and reuses the answer briefly', async () => {
    const { p, calls } = counting()
    let t = 0
    const reader = createFriendsReader(p, { ttlMs: 1_000, now: () => t })
    const [a, b] = await Promise.all([reader.read(ME), reader.read(ME.toLowerCase())])
    expect(a).toBe(b)
    expect(calls).toHaveLength(1)
    t = 999
    expect(await reader.read(ME)).toBe(a)
    t = 1_000
    expect(await reader.read(ME)).not.toBe(a)
    expect(calls).toHaveLength(2)
    expect(reader.source).toBe('robinhood-chain')
  })

  it('never remembers a failure, and keeps wallets apart', async () => {
    const { p, calls, setFail } = counting()
    const reader = createFriendsReader(p)
    setFail(true)
    await expect(reader.read(ME)).rejects.toBeInstanceOf(OwnershipError)
    setFail(false)
    const mine = await reader.read(ME)
    const theirs = await reader.read(OTHER)
    expect(mine).not.toBe(theirs)
    expect(calls).toEqual([ME, ME, OTHER])
  })

  it('bounds how many discoveries run at once and how many wallets it remembers', async () => {
    const { p, calls } = counting()
    const reader = createFriendsReader(p, { maxConcurrent: 2, maxEntries: 2 })
    const busy = [reader.read(addr(1)), reader.read(addr(2))]
    await expect(reader.read(addr(3))).rejects.toMatchObject({ reason: 'unavailable' })
    await Promise.all(busy)
    await reader.read(addr(3))
    // addr(1) was pushed out by the third wallet, so it is read again; addr(3) is still remembered.
    await reader.read(addr(1))
    await reader.read(addr(3))
    expect(calls).toEqual([addr(1), addr(2), addr(3), addr(1)])
  })
})
