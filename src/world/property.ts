import { sha256, stringToBytes } from 'viem'
import { assetKey, contractRefOf, nftAsset, type NftAsset } from './asset'
import { collectionForAsset, type Collection, type World } from './definition'
import { isBrandWorldId, LEGACY_RARE_CITY_WORLD_ID, parseChainRef } from './identity'
import { RARE_FRIENDS_CONTRACT_REF } from './legacy'

/**
 * WORLD-SCOPED PROPERTY IDENTITY. A property is one NFT in one world, and its id is a UUID
 * derived from what it permanently is. There are two namespaces, and a world uses exactly one:
 *
 * V1, FROZEN, LEGACY ONLY. The Rare Friends city (`rare-city`) and nothing else:
 *
 *   rare-city:property:v1|world=rare-city|chain=4663|collection=<lowercase contract>|token=<canonical decimal>
 *
 *   Byte for byte the id in server/src/activation/propertyId.ts (pinned by
 *   server/tests/worldEngine.unit.test.ts). Only Rare Friends Generations has V1 ids.
 *
 * V2, EVERY BRAND WORLD:
 *
 *   proofy-world:property:v2|world=<world uuid>|asset=<CAIP-19 asset id>
 *
 *   The asset id is `assetKey`: `<namespace>:<chain reference>/<standard>:<lowercase contract>/<canonical decimal token id>`,
 *   e.g. `eip155:8453/erc721:0xa1a1…a1a1/812`. So the id covers the world, the chain
 *   namespace and reference, the token standard, the contract and the whole uint256 token
 *   id, and nothing that configuration can change: collection keys, districts, layout, plan
 *   or trial status are not in it. The same NFT in two worlds, or the same token number in
 *   two collections or on two chains, are different properties.
 *
 * Both: SHA-256 of the UTF-8 text; the first 16 bytes become a UUID with version nibble 8
 * and RFC variant bits, in canonical lowercase 8-4-4-4-12 form. Every field's grammar
 * excludes `|`, so a preimage reads back one way only, and the two prefixes differ, so no
 * V2 preimage is ever a V1 preimage.
 *
 * Hashing is viem's (portable). Nothing here implements a hash.
 */
export const LEGACY_PROPERTY_ID_PREFIX = 'rare-city:property:v1'
export const PROPERTY_ID_V2_PREFIX = 'proofy-world:property:v2'

export type PropertyIdVersion = 'v1' | 'v2'

/** The asset exactly as given, if it is already canonical. A property id never repairs its input. */
function exactAsset(asset: NftAsset): NftAsset {
  const canonical = nftAsset(asset)
  if (!canonical || canonical.chain !== asset.chain || canonical.contract !== asset.contract || canonical.tokenId !== asset.tokenId || canonical.standard !== asset.standard)
    throw new Error('A property id is derived from a canonical NFT asset.')
  return canonical
}

/** The frozen V1 preimage of a Rare Friend. Refuses any other asset. */
export function legacyPropertyIdPreimage(asset: NftAsset): string {
  const canonical = exactAsset(asset)
  if (contractRefOf(canonical) !== RARE_FRIENDS_CONTRACT_REF) throw new Error('V1 property ids exist only for Rare Friends Generations in the legacy world.')
  return `${LEGACY_PROPERTY_ID_PREFIX}|world=${LEGACY_RARE_CITY_WORLD_ID}|chain=${parseChainRef(canonical.chain)!.chainId}|collection=${canonical.contract}|token=${canonical.tokenId}`
}

/** The V2 preimage of an NFT in a brand world. Refuses the legacy world and anything that is not a canonical UUID. */
export function propertyIdV2Preimage(worldId: string, asset: NftAsset): string {
  if (!isBrandWorldId(worldId)) throw new Error('A V2 property id is derived from a brand world id (a lowercase UUID).')
  return `${PROPERTY_ID_V2_PREFIX}|world=${worldId}|asset=${assetKey(exactAsset(asset))}`
}

/** The namespace a world's property ids are in. */
export function propertyIdVersionOf(worldId: string): PropertyIdVersion {
  if (worldId === LEGACY_RARE_CITY_WORLD_ID) return 'v1'
  if (isBrandWorldId(worldId)) return 'v2'
  throw new Error('Not a world id.')
}

/** The exact text a property id is the hash of, in the world's own namespace. */
export function worldPropertyIdPreimage(worldId: string, asset: NftAsset): string {
  return propertyIdVersionOf(worldId) === 'v1' ? legacyPropertyIdPreimage(asset) : propertyIdV2Preimage(worldId, asset)
}

/** The UUID made of the first 16 bytes of SHA-256(`preimage`), marked version 8, RFC variant. */
export function uuidV8FromText(preimage: string): string {
  const bytes = sha256(stringToBytes(preimage), 'bytes').slice(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export interface WorldProperty {
  worldId: string
  collection: Collection
  asset: NftAsset
  /** CAIP-19 key of the NFT, the same in every world. */
  assetKey: string
  /** Permanent property id in this world. */
  propertyId: string
  /** Which namespace `propertyId` is in. */
  propertyIdVersion: PropertyIdVersion
  /** Key of the property's building in this world's state (see `BuildingIdScheme`). */
  buildingId: string
}

/**
 * The identity of an NFT as a property of this world, or null when the NFT is not from one
 * of the world's collections. Pure: whether the property exists is the database's question.
 */
export function worldProperty(world: World, asset: NftAsset): WorldProperty | null {
  const collection = collectionForAsset(world, asset)
  if (!collection) return null
  const propertyIdVersion = propertyIdVersionOf(world.id)
  const propertyId = uuidV8FromText(worldPropertyIdPreimage(world.id, asset))
  const buildingId = world.buildingIds === 'token-v1' ? `b-${asset.tokenId}` : `b-${propertyId}`
  return { worldId: world.id, collection, asset, assetKey: assetKey(asset), propertyId, propertyIdVersion, buildingId }
}
