import type { PreviewMember } from '../core/eligibility'
import type { SampleCitySpec } from '../core/sampleCity'

/**
 * TWO SIMULATED BRANDS for the local preview. Everything here is made up: the brands, the
 * collections (example contracts), the token ids, the members, the Proofy rule references
 * (`source: 'sample'`, ids that name no real rule) and every building's progress.
 *
 * The configurations are deliberately untyped input: the preview passes them through
 * `parseBrandCityConfig` exactly as it would a configuration it received.
 *
 * Only the preview entry point may import this module (pinned by samples.test.ts).
 */
export interface SampleBrand {
  config: unknown
  city: SampleCitySpec
  /** Simulated viewers the preview can switch between. null = a visitor who is not signed in. */
  members: readonly (PreviewMember | null)[]
}

const example = (n: number) => `0x${'0'.repeat(36)}${n.toString(16).padStart(4, '0')}`

export const HARBORLIGHT: SampleBrand = {
  config: {
    worldId: 'a7c1e000-0000-4000-8000-00000000000a',
    cityName: 'Harborlight',
    brand: { name: 'Harborlight Collective', logo: '/brand-media/samples/harborlight-logo.svg' },
    capital: { name: 'Beacon Hall', crest: '/brand-media/samples/harborlight-logo.svg' },
    collections: [
      { key: 'harbor-keepers', chain: 'eip155:8453', contract: example(0xa001), displayName: 'Harbor Keepers' },
      { key: 'tide-pass', chain: 'eip155:1', contract: example(0xa002), displayName: 'Tide Pass' },
    ],
    districts: [
      { key: 'lantern-quay', name: 'Lantern Quay', accent: '#ff9f43', monument: { collection: 'harbor-keepers', tokenId: '1004', artwork: '/brand-media/samples/harbor-keeper-1004.svg' }, gate: null },
      { key: 'tidewater', name: 'Tidewater', accent: '#2ec4b6', monument: { collection: 'tide-pass', tokenId: '2002', artwork: '/brand-media/samples/tide-pass-2002.svg' }, gate: null },
      { key: 'saltmarsh', name: 'Saltmarsh', accent: '#7bd389', monument: null, gate: null },
      { key: 'compass-row', name: 'Compass Row', accent: '#5aa9ff', monument: null, gate: { source: 'sample', verificationRuleId: 9001, label: 'Verified Captain role' } },
    ],
  },
  city: {
    seed: 0x4a1b,
    owners: ['quaymaster', 'saltwind', 'gullwatch', 'netmender', 'brinewright', 'tidecaller', 'ropewalk', 'harborlamp'],
    districts: {
      'lantern-quay': { residents: [262_000, 61_000, 54_000, 12_400, 9_100, 3_050, 2_640, 820, 610, 150, 120, 60, 40, 20], filler: 26 },
      tidewater: { residents: [58_000, 14_200, 11_100, 2_800, 700, 640, 300, 110, 90, 30], filler: 30 },
      saltmarsh: { residents: [16_400, 4_100, 2_700, 900, 520, 200, 140, 120, 105], filler: 'fill', newcomers: [3_000, 650, 210, 90] },
      'compass-row': { residents: [12_500, 3_100, 1_200, 600, 180, 70], filler: 24 },
    },
  },
  members: [
    null,
    { id: 'deckhand', label: 'Deckhand · no Captain role', answers: { 9001: false } },
    { id: 'captain', label: 'Captain · Verified Captain role', answers: { 9001: true } },
  ],
}

export const NEON_ORCHARD: SampleBrand = {
  config: {
    worldId: 'a7c1e000-0000-4000-8000-00000000000b',
    cityName: 'Neon Orchard',
    brand: { name: 'Neon Orchard', logo: '/brand-media/samples/neon-orchard-logo.svg' },
    capital: { name: 'The Glasshouse', crest: '/brand-media/samples/neon-orchard-logo.svg' },
    collections: [
      { key: 'orchard-sprites', chain: 'eip155:8453', contract: example(0xb001), displayName: 'Orchard Sprites' },
      { key: 'neon-seeds', chain: 'eip155:42161', contract: example(0xb002), displayName: 'Neon Seeds' },
      { key: 'grove-pass', chain: 'eip155:1', contract: example(0xb003), displayName: 'Grove Pass' },
    ],
    districts: [
      { key: 'plum-arcade', name: 'Plum Arcade', accent: '#c77dff', monument: { collection: 'orchard-sprites', tokenId: '1007', artwork: '/brand-media/samples/orchard-sprite-1007.svg' }, gate: null },
      { key: 'citrus-strand', name: 'Citrus Strand', accent: '#ffd166', monument: null, gate: null },
      { key: 'fig-terrace', name: 'Fig Terrace', accent: '#ef476f', monument: { collection: 'neon-seeds', tokenId: '2003', artwork: '/brand-media/samples/neon-seed-2003.svg' }, gate: { source: 'sample', verificationRuleId: 9101, label: 'Orchard Elder role' } },
      { key: 'pear-commons', name: 'Pear Commons', accent: '#a7e07a', monument: null, gate: null },
      // A monument NFT whose artwork is not available: the standard fallback stands in for it.
      { key: 'kiwi-docks', name: 'Kiwi Docks', accent: '#06d6a0', monument: { collection: 'grove-pass', tokenId: '3001', artwork: null }, gate: null },
      { key: 'cherry-row', name: 'Cherry Row', accent: '#ff6b9a', monument: null, gate: { source: 'sample', verificationRuleId: 9102, label: 'Holds 3+ Neon Seeds' } },
    ],
  },
  city: {
    seed: 0x0c4a,
    owners: ['plumbob', 'zest', 'figment', 'pearl', 'kiwibird', 'cherrybomb', 'sprout', 'grovekeeper', 'neonleaf'],
    districts: {
      'plum-arcade': { residents: [271_000, 52_000, 51_000, 11_000, 3_000, 900, 400, 120], filler: 18 },
      'citrus-strand': { residents: [60_500, 13_000, 2_600, 2_520, 700, 300, 100, 40], filler: 18 },
      'fig-terrace': { residents: [10_500, 2_600, 650, 180, 90], filler: 16 },
      'pear-commons': { residents: [5_200, 2_600, 1_100, 520, 200, 160, 130, 115, 105], filler: 'fill', newcomers: [2_600, 600, 120] },
      'kiwi-docks': { residents: [15_000, 2_700, 800, 300, 100], filler: 19 },
      'cherry-row': { residents: [12_000, 2_900, 700, 140], filler: 18 },
    },
  },
  members: [
    null,
    { id: 'sprout', label: 'Sprout · roles not checked yet', answers: {} },
    { id: 'elder', label: 'Elder · Orchard Elder role', answers: { 9101: true, 9102: false } },
    { id: 'grower', label: 'Grower · Elder + 3 Neon Seeds', answers: { 9101: true, 9102: true } },
  ],
}

export const SAMPLE_BRANDS: readonly SampleBrand[] = [HARBORLIGHT, NEON_ORCHARD]
