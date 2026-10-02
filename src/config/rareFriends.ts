/**
 * Canonical Rare Friends chain configuration: the one place these values are written down.
 *
 * Portable (no browser or Node dependency). The server's ownership adapter reads the
 * contracts; the client reads only what a wallet needs to switch network. Nothing else in
 * Rare City names a contract address or an RPC URL.
 */
export type HexAddress = `0x${string}`

export const RARE_FRIENDS_CHAIN = {
  /** Robinhood Chain mainnet. */
  chainId: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  /** Public reference RPC. The server may be pointed elsewhere with ROBINHOOD_RPC_URL. */
  publicRpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  blockExplorerUrl: 'https://robinhoodchain.blockscout.com',
  /** Rare Friends Generations (ERC-721). The authority for who owns a Friend. */
  generations: '0x14C49e6118F46525dE9ab41a51cBAA3c6EBF181D',
  /** Block of the first Generations Transfer. No ownership history exists before it. */
  generationsFirstTransferBlock: 63_102_373n,
  /** Families Registry: `familyOf(uint256 tokenId) -> uint8`. The authority for a Friend's family. */
  familiesRegistry: '0x246E3E9730A7Eade94c79be0Fd78d210f89AEb8D',
  /** Generation metadata. Recorded for later slices; nothing reads it yet. */
  generationMetadata: '0x3A243E7f46970275CaE8375b0032e53dF91a9110',
  /** RF token. READ-ONLY KNOWN CONSTANT: no slice so far reads, approves or moves RF. */
  rf: { address: '0x0779369854d3EcdEA927206718FFD7730C67B71f', decimals: 18 },
} as const satisfies {
  chainId: number
  name: string
  nativeCurrency: { name: string; symbol: string; decimals: number }
  publicRpcUrl: string
  blockExplorerUrl: string
  generations: HexAddress
  generationsFirstTransferBlock: bigint
  familiesRegistry: HexAddress
  generationMetadata: HexAddress
  rf: { address: HexAddress; decimals: number }
}

/** The registry's family ids, in order. The index is the id `familyOf` returns. */
export const RARE_FRIENDS_FAMILIES = ['Skeleton', 'Mask', 'Family', 'Cellular', 'Asymmetry', 'Hoverer', 'Colossus', 'Sparkling', 'Hollow'] as const

export type FamilyName = (typeof RARE_FRIENDS_FAMILIES)[number]

export interface Family {
  id: number
  name: FamilyName
}

/** The family for a registry id, or null when the id is not one of the nine. Never guesses. */
export function familyById(id: unknown): Family | null {
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id >= RARE_FRIENDS_FAMILIES.length) return null
  return { id, name: RARE_FRIENDS_FAMILIES[id] }
}
