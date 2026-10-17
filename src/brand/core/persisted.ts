import { MONUMENTS } from '../../config/monuments'
import type { WorldCityState } from '../../world/cityState'
import type { BrandCityConfig } from './config'
import type { BrandCityState } from './sampleCity'

/**
 * A PERSISTENT city's state, as the standard renderer draws it: exactly what is stored, and
 * nothing more. A world's city state version 1 is an empty city, so this is an empty city:
 * no residents, no buildings, no monument holders, no Capital, no Crown, and every district
 * with its founding ward open. The civic world (plaza, squares, monument pads, roads) is drawn
 * from the configuration, so an empty city is still a whole city. Nothing is simulated.
 */
export function persistedBrandCityState(config: Pick<BrandCityConfig, 'districts'>, stored: WorldCityState): BrandCityState {
  const monuments = {} as BrandCityState['monuments']
  for (const m of MONUMENTS) monuments[m.id] = { holder: null, sinceClock: 0 }
  const open: Readonly<Record<string, number>> = stored.openWards
  const wards: Record<string, number> = {}
  for (const d of config.districts) wards[d.key] = open[d.key] ?? 1
  return { users: {}, buildings: {}, nfts: {}, wards, monuments, capital: { holder: null, sinceClock: 0 }, crown: { holder: null, sinceClock: 0 } }
}
