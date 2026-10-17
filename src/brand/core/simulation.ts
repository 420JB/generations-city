import type { BrandCityConfig } from './config'
import type { SampleCitySpec, SampleDistrictSpec } from './sampleCity'

/**
 * THE STANDARD SIMULATED SKYLINE for a configured city that has no real properties yet.
 *
 * A city opened from a real Proofy Play configuration has real names, districts, collections
 * and rules, but nobody has claimed or built anything (claims are the next milestone). An
 * empty city is only foundation plots, which shows none of the buildings and lighting, so
 * the preview draws the same simulated progress for every brand: district N always gets
 * profile N below, whatever the brand. Nothing in the configuration can change it, and it is
 * labelled simulated wherever it is shown.
 *
 * The profiles are the two sample brands' districts (samples/index.ts), in a fixed order.
 */
const PROFILES: readonly SampleDistrictSpec[] = [
  { residents: [262_000, 61_000, 54_000, 12_400, 9_100, 3_050, 2_640, 820, 610, 150, 120, 60, 40, 20], filler: 26 },
  { residents: [58_000, 14_200, 11_100, 2_800, 700, 640, 300, 110, 90, 30], filler: 30 },
  { residents: [16_400, 4_100, 2_700, 900, 520, 200, 140, 120, 105], filler: 'fill', newcomers: [3_000, 650, 210, 90] },
  { residents: [12_500, 3_100, 1_200, 600, 180, 70], filler: 24 },
  { residents: [60_500, 13_000, 2_600, 2_520, 700, 300, 100, 40], filler: 18 },
  { residents: [10_500, 2_600, 650, 180, 90], filler: 16 },
  { residents: [5_200, 2_600, 1_100, 520, 200, 160, 130, 115, 105], filler: 'fill', newcomers: [2_600, 600, 120] },
  { residents: [15_000, 2_700, 800, 300, 100], filler: 19 },
  { residents: [12_000, 2_900, 700, 140], filler: 18 },
]

/** As many members as the Harborlight sample (the count, not the names, decides who owns what). */
const OWNERS = ['member-a', 'member-b', 'member-c', 'member-d', 'member-e', 'member-f', 'member-g', 'member-h']

/**
 * Fixed seed: the simulation depends only on how many districts there are, never on brand
 * text. It is the Harborlight sample's seed, and the first four profiles are Harborlight's
 * districts, so a four-district city draws exactly the sample preview's Harborlight skyline:
 * the browser tests compare the two cities element for element.
 */
const SEED = 0x4a1b

export function standardSimulation(config: Pick<BrandCityConfig, 'districts'>): SampleCitySpec {
  const districts: Record<string, SampleDistrictSpec> = {}
  config.districts.forEach((d, i) => {
    districts[d.key] = PROFILES[i % PROFILES.length]
  })
  return { seed: SEED, owners: OWNERS, districts }
}
