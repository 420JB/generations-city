/**
 * Central demo balancing values for Rare City.
 * All RF in this build is SIMULATED — these numbers never touch a chain.
 */

/** Total RF Built required to reach each major tier (index 0 = Tier 1). */
export const TIER_THRESHOLDS = [100, 500, 2_500, 10_000, 50_000, 250_000] as const
export const MAX_TIER = TIER_THRESHOLDS.length
/** Intermediate construction stages inside every major tier. */
export const STAGES_PER_TIER = 10
/** Soft ceiling used to keep staging Tier 6 buildings after the final threshold. */
export const TIER6_STAGE_CEILING = 1_000_000

/**
 * Height curve anchors: [total RF built, floors]. Height is interpolated between anchors
 * so every contribution moves the skyline and the tallest-building race stays readable.
 */
export const HEIGHT_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [100, 2.5],
  [500, 4.5],
  [2_500, 8],
  [10_000, 14],
  [50_000, 26],
  [250_000, 44],
  [1_000_000, 56],
]
export const METERS_PER_FLOOR = 4.2

/**
 * Capital score weights per cumulative tier count. A Tier 5 building contributes
 * w1 + w2 + w3 + w4 + w5. Capital control is prestige only — no multipliers.
 */
export const CAPITAL_WEIGHTS: Record<number, number> = { 1: 1, 2: 3, 3: 8, 4: 20, 5: 45, 6: 100 }

/** Patron recognition by cumulative RF from one contributor to one building. */
export const PATRON_LEVELS = [
  { id: 'supporter', label: 'Supporter', min: 1 },
  { id: 'plaque', label: 'Entrance Plaque', min: 100 },
  { id: 'marker', label: 'Friend Marker', min: 500 },
  { id: 'banner', label: 'Facade Banner', min: 2_500 },
  { id: 'crest', label: 'Illuminated Patron Crest', min: 10_000 },
  { id: 'grand', label: 'Grand Patron', min: 50_000 },
] as const
export type PatronLevelId = (typeof PATRON_LEVELS)[number]['id']
/** At most this many patron identities are rendered on a building exterior. */
export const MAX_VISIBLE_PATRONS = 3

/** Owner Build (personal spend only) unlocks Architect levels. */
export const ARCHITECT_LEVELS = [0, 250, 1_000, 4_000, 12_000, 40_000] as const
/** Landscaping slots available = base + architect level, capped by lot size. */
export const LANDSCAPE_BASE_SLOTS = 3
export const LANDSCAPE_MAX_SLOTS = 8

/** Billboard fixture requires this tier. */
export const BILLBOARD_MIN_TIER = 4
export const BILLBOARD_MAX_UPLOAD_BYTES = 5 * 1024 * 1024
export const BILLBOARD_OUTPUT = { width: 480, height: 240, quality: 0.82 } as const
export const BILLBOARD_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

/** Contribution quick amounts shown in the UI. */
export const QUICK_AMOUNTS = [10, 50, 100, 250] as const

/** Starting simulated wallet for the demo player, plus the demo faucet amount. */
export const DEMO_WALLET_START = 25_000
export const DEMO_FAUCET_AMOUNT = 10_000

/** Build Board / radio alert: a building this close (fraction of tier span) is "critical". */
export const CRITICAL_THRESHOLD_FRACTION = 0.03
