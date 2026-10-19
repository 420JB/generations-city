import { BRAND_A, BRAND_B } from './brands'

/**
 * The LOCAL PROPERTY REHEARSAL file the browser tests start the server with (`serve.ts` writes it
 * and sets LOCAL_PROPERTY_REHEARSAL_FILE). TEST DATA: which example NFTs two made-up Discord
 * players may place. Every other player (LOCAL_PLAYER, snowflake() players) is listed for nothing,
 * so every other test sees the city exactly as without a rehearsal.
 */
export const MAX_UINT256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
export const REHEARSAL_ADA = '900000000000000901'
export const REHEARSAL_BEA = '900000000000000902'

const asset = (brand: { collections: { key: string; chain: string; contract: string }[] }, key: string, tokenId: string) => {
  const c = brand.collections.find((x) => x.key === key)!
  return `${c.chain}/erc721:${c.contract}/${tokenId}`
}
export const nft = asset

export const REHEARSAL_FILE = {
  kind: 'rare-city/local-property-rehearsal-v1',
  players: {
    [REHEARSAL_ADA]: [
      asset(BRAND_A, 'harbor-keepers', MAX_UINT256),
      asset(BRAND_A, 'harbor-keepers', '812'),
      asset(BRAND_A, 'tide-pass', '77'),
      asset(BRAND_B, 'orchard-sprites', '1'),
      asset(BRAND_B, 'neon-seeds', '9007199254740993'),
      asset(BRAND_B, 'grove-pass', '3'),
    ],
    [REHEARSAL_BEA]: [asset(BRAND_A, 'harbor-keepers', '812'), asset(BRAND_A, 'tide-pass', '5'), asset(BRAND_B, 'grove-pass', '4')],
  },
}
