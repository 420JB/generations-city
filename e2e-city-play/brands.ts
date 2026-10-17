/**
 * Two brands, as their Discord server admins would configure them in Proofy Play (Rare City
 * configuration schema v1). Made up for local tests: the contracts are example addresses, and
 * the Proofy rule ids name no real rule (they are well-formed Core `verification_rules` ids).
 */
const example = (n: number) => `0x${'0'.repeat(36)}${n.toString(16).padStart(4, '0')}`

export const BRAND_A = {
  cityName: 'Harborlight',
  brand: { name: 'Harborlight Collective', logo: '/brand-media/samples/harborlight-logo.svg' },
  capital: { name: 'Beacon Hall', crest: '/brand-media/samples/harborlight-logo.svg' },
  collections: [
    { key: 'harbor-keepers', chain: 'eip155:8453', contract: example(0xa001), displayName: 'Harbor Keepers' },
    { key: 'tide-pass', chain: 'eip155:1', contract: example(0xa002), displayName: 'Tide Pass' },
  ],
  districts: [
    { key: 'lantern-quay', name: 'Lantern Quay', accent: '#ff9f43', monument: { collection: 'harbor-keepers', tokenId: '1004', artwork: '/brand-media/samples/harbor-keeper-1004.svg' }, proofyRule: null },
    { key: 'tidewater', name: 'Tidewater', accent: '#2ec4b6', monument: { collection: 'tide-pass', tokenId: '2002', artwork: '/brand-media/samples/tide-pass-2002.svg' }, proofyRule: null },
    { key: 'saltmarsh', name: 'Saltmarsh', accent: '#7bd389', monument: null, proofyRule: null },
    { key: 'compass-row', name: 'Compass Row', accent: '#5aa9ff', monument: null, proofyRule: { verificationRuleId: 41, label: 'Verified Captain role' } },
  ],
}

export const BRAND_B = {
  cityName: 'Neon Orchard',
  brand: { name: 'Neon Orchard', logo: '/brand-media/samples/neon-orchard-logo.svg' },
  capital: { name: 'The Glasshouse', crest: '/brand-media/samples/neon-orchard-logo.svg' },
  collections: [
    { key: 'orchard-sprites', chain: 'eip155:8453', contract: example(0xb001), displayName: 'Orchard Sprites' },
    { key: 'neon-seeds', chain: 'eip155:42161', contract: example(0xb002), displayName: 'Neon Seeds' },
    { key: 'grove-pass', chain: 'eip155:1', contract: example(0xb003), displayName: 'Grove Pass' },
  ],
  districts: [
    { key: 'plum-arcade', name: 'Plum Arcade', accent: '#c77dff', monument: { collection: 'orchard-sprites', tokenId: '1007', artwork: '/brand-media/samples/orchard-sprite-1007.svg' }, proofyRule: null },
    { key: 'citrus-strand', name: 'Citrus Strand', accent: '#ffd166', monument: null, proofyRule: null },
    { key: 'fig-terrace', name: 'Fig Terrace', accent: '#ef476f', monument: { collection: 'neon-seeds', tokenId: '2003', artwork: '/brand-media/samples/neon-seed-2003.svg' }, proofyRule: { verificationRuleId: 77, label: 'Orchard Elder role' } },
    { key: 'pear-commons', name: 'Pear Commons', accent: '#a7e07a', monument: null, proofyRule: null },
    { key: 'kiwi-docks', name: 'Kiwi Docks', accent: '#06d6a0', monument: { collection: 'grove-pass', tokenId: '3001', artwork: null }, proofyRule: null },
    { key: 'cherry-row', name: 'Cherry Row', accent: '#ff6b9a', monument: null, proofyRule: { verificationRuleId: 78, label: 'Holds 3+ Neon Seeds' } },
  ],
}

export const keysOf = (b: { districts: { key: string }[] }) => b.districts.map((d) => d.key)
