import { custom, decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionResult, getAddress, multicall3Abi, numberToHex, parseAbi, parseAbiItem, type Address, type Hex, type Transport } from 'viem'
import { RARE_FRIENDS_CHAIN } from '../src/engine'

/**
 * An in-memory stand-in for a Robinhood Chain RPC endpoint, for the ownership adapter's
 * tests. It answers the four methods the adapter uses, from a list of Transfers, and can
 * be told to misbehave the ways real providers do.
 */
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)')
const ERC721 = parseAbi(['function balanceOf(address owner) view returns (uint256)', 'function ownerOf(uint256 tokenId) view returns (address)', 'error ERC721NonexistentToken(uint256 tokenId)'])
const FAMILIES = parseAbi(['function familyOf(uint256 tokenId) view returns (uint8)'])
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const ZERO: Address = '0x0000000000000000000000000000000000000000'

export const FIRST_BLOCK: bigint = RARE_FRIENDS_CHAIN.generationsFirstTransferBlock
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const rpcError = (code: number, message: string, data?: Hex) => Object.assign(new Error(message), { code, data })

export interface FakeTransfer {
  block: bigint
  logIndex: number
  from: Address
  to: Address
  tokenId: bigint
}

export interface FakeChain {
  transport: Transport
  /** Every request received, in order. */
  requests: { method: string; params: unknown[] }[]
  logQueries(): { fromBlock: bigint; toBlock: bigint }[]
  chainId: number
  head: bigint
  transfers: FakeTransfer[]
  /** Family ids by token; anything else gets `defaultFamily`. */
  families: Map<bigint, number>
  defaultFamily: number
  /** Overrides what the contract says, independently of the Transfer history. */
  ownerOverride: Map<bigint, Address | null>
  balanceOverride: Map<string, bigint>
  /** Reject log queries wider than this many blocks, the way the public RPC does. */
  maxSpan: bigint | null
  /** Reject log queries that would return more than this many logs. */
  maxResults: number | null
  /** Make a method fail: return an error to throw, or undefined to answer normally. */
  fail: (method: string, params: unknown[]) => Error | undefined
  /** Silently drop logs, the way a truncating provider would. */
  dropLogs: (transfer: FakeTransfer) => boolean
  mint(to: Address, tokenId: bigint, block?: bigint): void
  transfer(from: Address, to: Address, tokenId: bigint, block?: bigint): void
}

export function fakeChain(): FakeChain {
  let nextBlock: bigint = FIRST_BLOCK
  const chain: FakeChain = {
    requests: [],
    chainId: RARE_FRIENDS_CHAIN.chainId,
    head: FIRST_BLOCK + 14_000_000n,
    transfers: [],
    families: new Map(),
    defaultFamily: 2,
    ownerOverride: new Map(),
    balanceOverride: new Map(),
    maxSpan: null,
    maxResults: null,
    fail: () => undefined,
    dropLogs: () => false,
    logQueries: () => chain.requests.filter((r) => r.method === 'eth_getLogs').map((r) => r.params[0] as { fromBlock: Hex; toBlock: Hex }).map((f) => ({ fromBlock: BigInt(f.fromBlock), toBlock: BigInt(f.toBlock) })),
    mint: (to, tokenId, block) => chain.transfer(ZERO, to, tokenId, block),
    transfer(from, to, tokenId, block) {
      nextBlock = block ?? nextBlock + 1_000n
      chain.transfers.push({ block: nextBlock, logIndex: chain.transfers.filter((t) => t.block === nextBlock).length, from, to, tokenId })
    },
    transport: undefined as unknown as Transport,
  }

  const ownerAt = (tokenId: bigint): Address | null => {
    if (chain.ownerOverride.has(tokenId)) return chain.ownerOverride.get(tokenId) ?? null
    const last = chain.transfers.filter((t) => t.tokenId === tokenId).at(-1)
    return last && !same(last.to, ZERO) ? last.to : null
  }

  function call(to: Address, data: Hex): Hex {
    if (same(to, RARE_FRIENDS_CHAIN.generations)) {
      const { functionName, args } = decodeFunctionData({ abi: ERC721, data })
      if (functionName === 'balanceOf') {
        const account = args[0].toLowerCase()
        const balance = chain.balanceOverride.get(account) ?? BigInt([...new Set(chain.transfers.map((t) => t.tokenId))].filter((id) => same(ownerAt(id) ?? ZERO, account)).length)
        return encodeFunctionResult({ abi: ERC721, functionName: 'balanceOf', result: balance })
      }
      const owner = ownerAt(args[0])
      if (!owner) throw rpcError(3, 'execution reverted', encodeErrorResult({ abi: ERC721, errorName: 'ERC721NonexistentToken', args: [args[0]] }))
      return encodeFunctionResult({ abi: ERC721, functionName: 'ownerOf', result: owner })
    }
    if (same(to, RARE_FRIENDS_CHAIN.familiesRegistry)) {
      const { args } = decodeFunctionData({ abi: FAMILIES, data })
      // Like the real registry, it answers for any number, minted or not.
      return encodeAbiParameters([{ type: 'uint8' }], [chain.families.get(args[0]) ?? chain.defaultFamily])
    }
    if (same(to, MULTICALL3)) {
      const { args } = decodeFunctionData({ abi: multicall3Abi, data })
      const results = (args![0] as readonly { target: Address; callData: Hex }[]).map(({ target, callData }) => {
        try {
          return { success: true, returnData: call(target, callData) }
        } catch (err) {
          return { success: false, returnData: (err as { data?: Hex }).data ?? ('0x' as Hex) }
        }
      })
      return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results })
    }
    throw rpcError(-32000, 'no contract at that address')
  }

  function getLogs(filter: { address: Address; fromBlock: Hex; toBlock: Hex; topics: (Hex | null)[] }) {
    const from = BigInt(filter.fromBlock)
    const to = BigInt(filter.toBlock)
    const span = to - from + 1n
    if (chain.maxSpan !== null && span > chain.maxSpan) throw rpcError(-32602, `query spans ${span} blocks (${from} to ${to}), but only ${chain.maxSpan} are allowed for this request; narrow the block range`)
    const matches = chain.transfers.filter((t) => {
      if (!same(filter.address, RARE_FRIENDS_CHAIN.generations) || t.block < from || t.block > to || t.block > chain.head) return false
      const topics = encodeEventTopics({ abi: [TRANSFER], eventName: 'Transfer', args: { from: t.from, to: t.to, tokenId: t.tokenId } })
      return filter.topics.every((want, i) => want === null || want === undefined || same(want, topics[i] as Hex))
    })
    if (chain.maxResults !== null && matches.length > chain.maxResults) throw rpcError(-32005, `query returned more than ${chain.maxResults} results`)
    return matches
      .filter((t) => !chain.dropLogs(t))
      .map((t) => ({
        address: RARE_FRIENDS_CHAIN.generations.toLowerCase(),
        topics: encodeEventTopics({ abi: [TRANSFER], eventName: 'Transfer', args: { from: t.from, to: t.to, tokenId: t.tokenId } }),
        data: '0x',
        blockNumber: numberToHex(t.block),
        blockHash: `0x${'ab'.repeat(32)}`,
        transactionHash: `0x${'cd'.repeat(32)}`,
        transactionIndex: '0x0',
        logIndex: numberToHex(t.logIndex),
        removed: false,
      }))
  }

  chain.transport = custom(
    {
      async request({ method, params = [] }: { method: string; params?: unknown[] }) {
        chain.requests.push({ method, params })
        const failure = chain.fail(method, params)
        if (failure) throw failure
        switch (method) {
          case 'eth_chainId':
            return numberToHex(chain.chainId)
          case 'eth_blockNumber':
            return numberToHex(chain.head)
          case 'eth_getLogs':
            return getLogs(params[0] as Parameters<typeof getLogs>[0])
          case 'eth_call': {
            const { to, data } = params[0] as { to: Address; data: Hex }
            return call(getAddress(to), data)
          }
        }
        throw rpcError(-32601, `the method ${method} does not exist`)
      },
    },
    { retryCount: 0 },
  )
  return chain
}

/** Deterministic distinct addresses for tests. */
export const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, '0')}`)
