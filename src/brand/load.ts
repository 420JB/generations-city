import type { WorldCityState } from '../world/cityState'
import type { World } from '../world/definition'
import { worldCityProblems } from '../world/gameplay'
import { availablePlotsIn, formatPlotId, type PlotCandidate } from '../world/plots'
import type { CityScene } from '../ui/city/scene'
import { parseBrandCityConfig, type BrandCityConfig, type ConfigProblem } from './core/config'
import { compileBrandWorld } from './core/layout'
import { persistedBrandCityState } from './core/persisted'
import { buildSampleCity, type BrandCityState, type SampleCitySpec } from './core/sampleCity'
import { brandScene } from './scene'

/**
 * One configured city, ready for the standard renderer: the validated configuration, its
 * compiled world (the engine's authority on districts and plots), its state (simulated for
 * the sample preview, as stored for a persistent city) and the scene the renderer draws.
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
  return loadParsedBrandCity(parsed.config, spec)
}

/** The same, for a configuration that was already validated (for example one read from Proofy Play). */
export function loadParsedBrandCity(config: Readonly<BrandCityConfig>, spec: SampleCitySpec): BrandCityLoad {
  const compiled = compileBrandWorld(config)
  if (!compiled.ok) return { ok: false, problems: compiled.problems.map((p) => ({ path: `world:${p.code}`, detail: p.detail })) }
  const state = buildSampleCity(config, compiled.world, spec)
  return { ok: true, city: { config, world: compiled.world, state, scene: brandScene(config, compiled.world, state.nfts) } }
}

/**
 * A PERSISTENT city: a configuration the world accepted, drawn with the state the world
 * stored. The compiled geometry must be the world's own (`geometryFingerprint`: the geometry the
 * server says the city is drawn on, frozen once it has a property), or nothing is drawn: a city is
 * never shown on districts that are not its own. Nor is a stored state the
 * engine finds impossible on that geometry (a building on no plot, a property id that is not its
 * NFT's, wards that do not add up): it is refused, never drawn in part.
 */
export function loadPersistedBrandCity(config: Readonly<BrandCityConfig>, stored: WorldCityState, geometryFingerprint: string): BrandCityLoad {
  const compiled = compileBrandWorld(config)
  if (!compiled.ok) return { ok: false, problems: compiled.problems.map((p) => ({ path: `world:${p.code}`, detail: p.detail })) }
  if (compiled.world.layout.geometryFingerprint !== geometryFingerprint) return { ok: false, problems: [{ path: 'districts', detail: 'this configuration does not draw this city\'s districts' }] }
  const problems = worldCityProblems(compiled.world, stored)
  if (problems.length > 0) return { ok: false, problems: problems.map((detail) => ({ path: 'state', detail })) }
  const state = persistedBrandCityState(config, stored)
  return { ok: true, city: { config, world: compiled.world, state, scene: brandScene(config, compiled.world, state.nfts) } }
}

/** Plots a joining member could take in a district, as the engine computes them from the city's occupancy. */
export function districtPlots(city: LoadedBrandCity, districtKey: string): PlotCandidate[] {
  const occupied = new Set(Object.values(city.state.buildings).map((b) => formatPlotId(b.districtId, b.ward, b.plot)))
  return availablePlotsIn(city.world, { openWards: city.state.wards, occupied }, districtKey) ?? []
}
