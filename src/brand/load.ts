import type { World } from '../world/definition'
import { availablePlotsIn, formatPlotId, type PlotCandidate } from '../world/plots'
import type { CityScene } from '../ui/city/scene'
import { parseBrandCityConfig, type BrandCityConfig, type ConfigProblem } from './core/config'
import { compileBrandWorld } from './core/layout'
import { buildSampleCity, type BrandCityState, type SampleCitySpec } from './core/sampleCity'
import { brandScene } from './scene'

/**
 * One configured city, ready for the standard renderer: the validated configuration, its
 * compiled world (the engine's authority on districts and plots), a simulated state and the
 * scene the renderer draws.
 */
export interface LoadedBrandCity {
  config: Readonly<BrandCityConfig>
  world: World
  state: BrandCityState
  scene: CityScene
}

export type BrandCityLoad = { ok: true; city: LoadedBrandCity } | { ok: false; problems: ConfigProblem[] }

/** Validate a configuration that arrived as data, compile its world and build the simulated city. */
export function loadBrandCity(rawConfig: unknown, spec: SampleCitySpec): BrandCityLoad {
  const parsed = parseBrandCityConfig(rawConfig)
  if (!parsed.ok) return parsed
  const compiled = compileBrandWorld(parsed.config)
  if (!compiled.ok) return { ok: false, problems: compiled.problems.map((p) => ({ path: `world:${p.code}`, detail: p.detail })) }
  const state = buildSampleCity(parsed.config, compiled.world, spec)
  return { ok: true, city: { config: parsed.config, world: compiled.world, state, scene: brandScene(parsed.config, compiled.world, state.nfts) } }
}

/** Plots a joining member could take in a district, as the engine computes them from the city's occupancy. */
export function districtPlots(city: LoadedBrandCity, districtKey: string): PlotCandidate[] {
  const occupied = new Set(Object.values(city.state.buildings).map((b) => formatPlotId(b.districtId, b.ward, b.plot)))
  return availablePlotsIn(city.world, { openWards: city.state.wards, occupied }, districtKey) ?? []
}
