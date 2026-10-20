import { BRAND_A, BRAND_B } from './brands'

/**
 * The LOCAL PROPERTY REHEARSAL file the browser tests start the server with (`serve.ts` writes it
 * and sets LOCAL_PROPERTY_REHEARSAL_FILE). TEST DATA, standing in for Proofy Core eligibility: which
 * example NFTs four made-up Discord players may place, the traits of a few of them, and explicit
 * district rules for those traits (file version 2). Every other player (LOCAL_PLAYER, snowflake()
 * players) is listed for nothing, so every other test sees the city exactly as without a rehearsal.
 */
export const MAX_UINT256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
export const REHEARSAL_ADA = '900000000000000901'
export const REHEARSAL_BEA = '900000000000000902'
export const REHEARSAL_CY = '900000000000000903'
export const REHEARSAL_DEE = '900000000000000904'

const asset = (brand: { collections: { key: string; chain: string; contract: string }[] }, key: string, tokenId: string) => {
  const c = brand.collections.find((x) => x.key === key)!
  return `${c.chain}/erc721:${c.contract}/${tokenId}`
}
export const nft = asset

const keepers = BRAND_A.collections.find((c) => c.key === 'harbor-keepers')!

/** Ada's Captain (a rule assigns it to Tidewater) and her Dune dock keeper (a rule assigns it to Dune, where a city has one). */
export const CAPTAIN = asset(BRAND_A, 'harbor-keepers', '9002')
export const DUNE_DOCK = asset(BRAND_A, 'harbor-keepers', '9001')

export const REHEARSAL_FILE = {
  kind: 'rare-city/local-property-rehearsal-v2',
  players: {
    [REHEARSAL_ADA]: [
      asset(BRAND_A, 'harbor-keepers', MAX_UINT256),
      asset(BRAND_A, 'harbor-keepers', '812'),
      asset(BRAND_A, 'tide-pass', '77'),
      { asset: DUNE_DOCK, traits: { Dock: 'Dune' } },
      { asset: CAPTAIN, traits: { Role: 'Captain' } },
      asset(BRAND_B, 'orchard-sprites', '1'),
      asset(BRAND_B, 'neon-seeds', '9007199254740993'),
      asset(BRAND_B, 'grove-pass', '3'),
    ],
    [REHEARSAL_BEA]: [asset(BRAND_A, 'harbor-keepers', '812'), asset(BRAND_A, 'tide-pass', '5'), asset(BRAND_B, 'grove-pass', '4')],
    [REHEARSAL_CY]: [asset(BRAND_A, 'harbor-keepers', '300'), asset(BRAND_A, 'tide-pass', '301')],
    [REHEARSAL_DEE]: [asset(BRAND_A, 'harbor-keepers', '400')],
  },
  districtRules: [
    { id: 'captains-to-tidewater', collection: { chain: keepers.chain, contract: keepers.contract }, traits: { Role: 'Captain' }, district: 'tidewater' },
    { id: 'dune-dock', collection: { chain: keepers.chain, contract: keepers.contract }, traits: { Dock: 'Dune' }, district: 'dune' },
  ],
}
