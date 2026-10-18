import { canonicalAddress, parseChainRef, parseUint256 } from './identity'

/**
 * CANONICAL NFT ASSET IDENTITY.
 *
 * One NFT is one (chain, contract, token id) triple, whatever world it appears in and
 * whatever a brand calls its collection. Token ids are canonical decimal TEXT for their
 * whole uint256 range, never a JavaScript number: 2^53 + 1 and 2^53 are different tokens.
 *
 * Only ERC-721 is modelled. Other token standards are a later decision.
 */
export type TokenStandard = 'erc721'

export interface NftAsset {
  /** CAIP-2, e.g. `eip155:4663`. */
  chain: string
  /** `0x` and 40 lowercase hex digits. */
  contract: `0x${string}`
  standard: TokenStandard
  /** Canonical decimal uint256. */
  tokenId: string
}

/** A validated, canonical asset, or null. Nothing is guessed: a non-canonical token id or an unknown chain is refused. */
export function nftAsset(input: { chain: unknown; contract: unknown; tokenId: unknown; standard?: unknown }): NftAsset | null {
  const chain = parseChainRef(input.chain)
  const contract = canonicalAddress(input.contract)
  const tokenId = parseUint256(input.tokenId)
  const standard = input.standard === undefined ? 'erc721' : input.standard
  if (!chain || !contract || tokenId === null || standard !== 'erc721') return null
  return Object.freeze({ chain: chain.text, contract, standard, tokenId })
}

/**
 * The asset's CAIP-19 id, e.g. `eip155:4663/erc721:0x14c4…181d/812`: one text per NFT,
 * usable as a map key across collections and worlds.
 */
export function assetKey(asset: NftAsset): string {
  return `${asset.chain}/${asset.standard}:${asset.contract}/${asset.tokenId}`
}

export function sameAsset(a: NftAsset, b: NftAsset): boolean {
  return assetKey(a) === assetKey(b)
}

/** The collection part of an asset key: `eip155:4663/erc721:0x…`. Two assets are in one collection exactly when these match. */
export function contractRefOf(asset: Pick<NftAsset, 'chain' | 'standard' | 'contract'>): string {
  return `${asset.chain}/${asset.standard}:${asset.contract}`
}

const ASSET_KEY = /^(eip155:[1-9][0-9]{0,15})\/(erc721):(0x[0-9a-f]{40})\/(0|[1-9][0-9]{0,77})$/

/** The asset a CAIP-19 key (as `assetKey` spells it) names, or null. Only the canonical spelling parses. */
export function parseAssetKey(input: unknown): NftAsset | null {
  if (typeof input !== 'string') return null
  const match = ASSET_KEY.exec(input)
  if (!match) return null
  const asset = nftAsset({ chain: match[1], standard: match[2], contract: match[3], tokenId: match[4] })
  return asset && assetKey(asset) === input ? asset : null
}
