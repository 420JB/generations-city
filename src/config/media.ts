/**
 * PROPERTY MEDIA LADDER. Taller buildings unlock more valuable visual real estate.
 * The owner always controls their own building's media (one image, owner-only edits).
 * No ad marketplace, rentals or payments exist; this is presentation + progression only.
 */
export interface MediaTier {
  id: 'facade' | 'skyline' | 'landmark'
  minTier: number
  label: string
  description: string
}

export const MEDIA_TIERS: readonly MediaTier[] = [
  { id: 'facade', minTier: 4, label: 'Facade billboard', description: 'A lit billboard mounted on the tower facade.' },
  { id: 'skyline', minTier: 5, label: 'Skyline rooftop billboard', description: 'A large rooftop billboard seen across the district.' },
  { id: 'landmark', minTier: 6, label: 'Landmark crown screen', description: 'A gold-framed crown screen visible city-wide.' },
]

export function mediaTierFor(tier: number): MediaTier | null {
  let out: MediaTier | null = null
  for (const m of MEDIA_TIERS) if (tier >= m.minTier) out = m
  return out
}

export function nextMediaTier(tier: number): MediaTier | null {
  return MEDIA_TIERS.find((m) => m.minTier > tier) ?? null
}
