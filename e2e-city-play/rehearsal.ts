import { BRAND_A, BRAND_B } from './brands'

/**
 * The LOCAL PROPERTY REHEARSAL file the browser tests start the server with (`serve.ts` writes it
 * and sets LOCAL_PROPERTY_REHEARSAL_FILE). TEST DATA, standing in for Proofy Core eligibility: which
 * example NFTs six made-up Discord players may place, the traits of a few of them, explicit district
 * rules for those traits, and Proofy rule results for two players (file version 3). Every other
 * player (LOCAL_PLAYER, snowflake() players) is listed for nothing, so every other test sees the
 * city exactly as without a rehearsal.
 */
export const MAX_UINT256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
export const REHEARSAL_ADA = '900000000000000901'
export const REHEARSAL_BEA = '900000000000000902'
export const REHEARSAL_CY = '900000000000000903'
export const REHEARSAL_DEE = '900000000000000904'
/** Eve holds a Captain too, and Tidewater's Proofy rule (`RESTRICTED_RULES.tidewater`) answers no for her. */
export const REHEARSAL_EVE = '900000000000000905'
/** Fay holds a keeper both district rules name (a Captain of the Dune dock): in a city with Tidewater and Dune, they conflict. */
export const REHEARSAL_FAY = '900000000000000906'
/**
 * The Proofy verification rules of `ALL_RESTRICTED` (tickets.spec.ts): no other test's city names them, so their results
 * here change nothing elsewhere. Ada meets Tidewater's; Eve does not.
 */
export const RESTRICTED_RULES = { 'lantern-quay': 7101, tidewater: 7102, saltmarsh: 7103, 'compass-row': 7104 } as const

const asset = (brand: { collections: { key: string; chain: string; contract: string }[] }, key: string, tokenId: string) => {
  const c = brand.collections.find((x) => x.key === key)!
  return `${c.chain}/erc721:${c.contract}/${tokenId}`
}
export const nft = asset

const keepers = BRAND_A.collections.find((c) => c.key === 'harbor-keepers')!

/** Ada's Captain (a rule assigns it to Tidewater) and her Dune dock keeper (a rule assigns it to Dune, where a city has one). */
export const CAPTAIN = asset(BRAND_A, 'harbor-keepers', '9002')
export const DUNE_DOCK = asset(BRAND_A, 'harbor-keepers', '9001')
/** Eve's Captain. */
export const EVE_CAPTAIN = asset(BRAND_A, 'harbor-keepers', '9005')
/** Fay's keeper: both explicit rules apply to it, naming different districts (claim-experience.spec.ts). */
export const FAY_TWIN = asset(BRAND_A, 'harbor-keepers', '9006')

export const REHEARSAL_FILE = {
  kind: 'rare-city/local-property-rehearsal-v3',
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
    [REHEARSAL_EVE]: [{ asset: EVE_CAPTAIN, traits: { Role: 'Captain' } }],
    [REHEARSAL_FAY]: [{ asset: FAY_TWIN, traits: { Role: 'Captain', Dock: 'Dune' } }, asset(BRAND_A, 'tide-pass', '906')],
  },
  districtRules: [
    { id: 'captains-to-tidewater', collection: { chain: keepers.chain, contract: keepers.contract }, traits: { Role: 'Captain' }, district: 'tidewater' },
    { id: 'dune-dock', collection: { chain: keepers.chain, contract: keepers.contract }, traits: { Dock: 'Dune' }, district: 'dune' },
  ],
  // In every Discord server (no "guild"): the test servers are made up per test.
  ruleResults: [
    { discordUserId: REHEARSAL_ADA, verificationRuleId: RESTRICTED_RULES.tidewater, qualifies: true },
    { discordUserId: REHEARSAL_EVE, verificationRuleId: RESTRICTED_RULES.tidewater, qualifies: false },
  ],
}
