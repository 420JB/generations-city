import { assetKey, nftAsset, parseAssetKey, type NftAsset } from './asset'
import {
  emptyWorldCityState,
  POPULATED_WORLD_CITY_STATE_VERSION,
  worldBuildingId,
  type PopulatedWorldCityState,
  type WorldBuildingRecord,
  type WorldCityState,
} from './cityState'
import { districtOf, type World } from './definition'
import { wardCapacityOf } from './layout'
import { availablePlotsIn, choosePlot, formatPlotId, occupancyProblems, resolvePlot, type PlotCandidate, type PlotRef, type WorldOccupancy } from './plots'
import { worldProperty, type WorldProperty } from './property'

/**
 * PERSISTENT CITY GAMEPLAY, PURE (P1-C2-B2A): how a world's city moves from one stored state to
 * the next when a property is activated on an exact plot. Portable and deterministic: no clock,
 * no randomness, no database. The same world, state and request always give the same answer.
 *
 * Four steps, kept apart on purpose, so a caller can stop after any of them:
 *
 *   discover   `plotCandidatesOf`             which plots a joining NFT could choose now (read only)
 *   validate   `validatePropertyActivation`   may THIS NFT take THIS plot, given the city as stored?
 *   propose    `proposePropertyActivation`    the exact next state and the event that records it
 *   persist    (not here)                     the server writes a proposal only after its own
 *                                             authoritative checks, under the city's lock
 *
 * The plot is always the one the player chose (`choosePlot`): nothing here picks, suggests or
 * substitutes a plot, and nothing here allocates a district, a ticket or a turn.
 *
 * `replayPropertyActivations` runs the same proposals from the founded city, so a verifier can
 * rebuild a stored state from its property records and require byte equality.
 */
export const PROPERTY_ACTIVATED_EVENT = 'world.property.activated'

/** What a `world.property.activated` event records, besides what the caller adds (configuration version). */
export interface PropertyActivatedEvent {
  propertyId: string
  buildingId: string
  asset: string
  collection: string
  districtKey: string
  ward: number
  plot: number
  plotId: string
  /** True when this activation opened the district's next ward. */
  openedWard: boolean
  /** The district's open wards afterwards. */
  openWards: number
  /** The engine's geometry fingerprint of the district, as the property was placed. */
  districtGeometryFingerprint: string
}

/** The occupancy a stored state describes. */
export function worldOccupancyOf(state: WorldCityState): WorldOccupancy {
  const occupied = new Set<string>()
  for (const b of Object.values(state.buildings) as WorldBuildingRecord[]) occupied.add(formatPlotId(b.districtKey, b.ward, b.plot))
  return { openWards: { ...state.openWards }, occupied }
}

const MAX_PROBLEMS = 20

/**
 * Everything wrong with a stored state for this world, or an empty list. The world is the one
 * that governs the city (its geometry is the city's own). Checked:
 *   - every building is a property of this world: its NFT is from one of the world's collections,
 *     under that collection's key, and its property id and building key are the engine's;
 *   - every plot is a plot of the layout, in an open ward, and no two buildings share one;
 *   - each district's open wards are exactly one more than its highest occupied ward, written only
 *     when more than one is open (a ward opens only by placing a property in it);
 *   - buildings are stored in activation order, at sequences 2, 3, 4 ... with none missing.
 */
export function worldCityProblems(world: World, state: WorldCityState): string[] {
  const problems: string[] = []
  const add = (detail: string) => problems.length < MAX_PROBLEMS && problems.push(detail)
  const records = Object.entries(state.buildings) as [string, WorldBuildingRecord][]
  const plots = new Set<string>()
  const highest = new Map<string, number>()
  records.forEach(([key, b], i) => {
    if (b.sequence !== i + 2) add(`building ${key} is stored at position ${i + 1} with sequence ${b.sequence}; buildings are stored in activation order from sequence 2`)
    const parsed = parseAssetKey(b.asset)
    const property = parsed && worldProperty(world, parsed)
    if (!property) add(`building ${key} is NFT ${b.asset}, which is not from a collection of this world`)
    else {
      if (property.propertyId !== b.propertyId || key !== worldBuildingId(property.propertyId) || property.buildingId !== key) add(`building ${key} does not carry its NFT's property id in this world`)
      if (property.collection.key !== b.collection) add(`building ${key} names collection ${b.collection}; its NFT is in collection ${property.collection.key}`)
    }
    const plotId = formatPlotId(b.districtKey, b.ward, b.plot)
    if (!resolvePlot(world, plotId)) add(`building ${key} stands on ${plotId}, which is not a plot of this world`)
    if (plots.has(plotId)) add(`two buildings stand on ${plotId}`)
    plots.add(plotId)
    highest.set(b.districtKey, Math.max(highest.get(b.districtKey) ?? 0, b.ward))
  })
  if (records.length === 0 && state.version === POPULATED_WORLD_CITY_STATE_VERSION) add('a version 2 city holds no building')
  for (const p of occupancyProblems(world, worldOccupancyOf(state))) add(p)
  for (const district of world.districts) {
    const expected = (highest.get(district.key) ?? 0) + 1
    const stored = Object.hasOwn(state.openWards, district.key) ? (state.openWards as Record<string, number>)[district.key] : undefined
    if (expected > 1 ? stored !== expected : stored !== undefined) add(`district ${district.key} records ${stored ?? 1} open wards; its highest occupied ward makes it ${expected}`)
  }
  return problems
}

function assertSound(world: World, state: WorldCityState) {
  const problems = worldCityProblems(world, state)
  if (problems.length > 0) throw new Error(`Impossible world city state: ${problems.join('; ')}`)
}

/** One district's wards and the plots a joining NFT could choose in it now. */
export interface DistrictPlots {
  districtKey: string
  openWards: number
  /** Every open ward: how many plots it has and how many hold a building. */
  wards: { ward: number; capacity: number; occupied: number }[]
  /**
   * Exactly `availablePlotsIn`: every free plot of the open wards or, when they are all full,
   * every plot of the next ward (`newWard`), or none when the layout allows no more. Read only:
   * nothing is reserved, and a candidate can be taken by someone else at any time.
   */
  candidates: PlotCandidate[]
}

/** Discovery: every district of the world, in its order. Throws on an impossible state. */
export function plotCandidatesOf(world: World, state: WorldCityState): DistrictPlots[] {
  assertSound(world, state)
  const occupancy = worldOccupancyOf(state)
  const perWard = new Map<string, number>()
  for (const plotId of occupancy.occupied) {
    const ref = resolvePlot(world, plotId)!
    const k = `${ref.districtKey}|${ref.ward}`
    perWard.set(k, (perWard.get(k) ?? 0) + 1)
  }
  return world.districts.map((district) => {
    const openWards = Object.hasOwn(occupancy.openWards, district.key) ? occupancy.openWards[district.key] : 1
    const wards = Array.from({ length: openWards }, (_, ward) => ({ ward, capacity: wardCapacityOf(world, district, ward), occupied: perWard.get(`${district.key}|${ward}`) ?? 0 }))
    return { districtKey: district.key, openWards, wards, candidates: availablePlotsIn(world, occupancy, district.key)! }
  })
}

/** A request to place one NFT on one exact plot the player chose. */
export interface PropertyActivationRequest {
  asset: NftAsset
  plotId: string
}

export type PropertyActivationRefusal =
  /** The asset is not a canonical NFT. */
  | 'invalid-asset'
  /** The NFT is not from any of the world's collections. */
  | 'asset-not-in-world'
  /** The NFT already has its property in this world. */
  | 'asset-already-placed'
  /** The plot id is not a plot of this world's layout. */
  | 'unknown-plot'
  /** The plot is taken, or lies in a ward that cannot open now. */
  | 'plot-unavailable'

export type ValidatedActivation = { ok: true; property: WorldProperty; plot: PlotRef; openedWard: boolean; openWards: number } | { ok: false; reason: PropertyActivationRefusal }

/**
 * Validation: may this NFT take this exact plot in the city as stored? Pure, and the same
 * answer every time. Throws on an impossible state (see `worldCityProblems`).
 */
export function validatePropertyActivation(world: World, state: WorldCityState, request: PropertyActivationRequest): ValidatedActivation {
  assertSound(world, state)
  const asset = nftAsset(request.asset)
  if (!asset || assetKey(asset) !== assetKey(request.asset) || asset.standard !== request.asset.standard) return { ok: false, reason: 'invalid-asset' }
  const property = worldProperty(world, asset)
  if (!property) return { ok: false, reason: 'asset-not-in-world' }
  if (Object.hasOwn(state.buildings, property.buildingId)) return { ok: false, reason: 'asset-already-placed' }
  const choice = choosePlot(world, worldOccupancyOf(state), request.plotId)
  if (!choice.ok) return { ok: false, reason: choice.reason }
  return { ok: true, property, plot: choice.plot, openedWard: choice.openedWard, openWards: choice.openWards }
}

/** The exact change one activation makes: from the city at `from` to the city at `to`. */
export interface PropertyTransition {
  from: number
  to: number
  property: WorldProperty
  plot: PlotRef
  building: WorldBuildingRecord
  districtGeometryFingerprint: string
  /** The city's state at `to`. */
  state: PopulatedWorldCityState
  event: PropertyActivatedEvent
}

export type ProposedActivation = { ok: true; transition: PropertyTransition } | { ok: false; reason: PropertyActivationRefusal }

/**
 * Proposal: the next state of a city at `sequence`, and the event recording it, if the request
 * is valid. Nothing is written. The new building is appended after every existing one, and a
 * district's open-ward count is written only once it exceeds one, so a state has one spelling
 * and replaying the same proposals rebuilds it byte for byte.
 */
export function proposePropertyActivation(world: World, state: WorldCityState, sequence: number, request: PropertyActivationRequest): ProposedActivation {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error(`Invalid city sequence ${sequence}`)
  const valid = validatePropertyActivation(world, state, request)
  if (!valid.ok) return valid
  const { property, plot, openedWard, openWards } = valid
  const to = sequence + 1
  const building: WorldBuildingRecord = { propertyId: property.propertyId, asset: property.assetKey, collection: property.collection.key, districtKey: plot.districtKey, ward: plot.ward, plot: plot.plot, sequence: to }
  const nextOpen: Record<string, number> = { ...state.openWards }
  if (openWards > 1) nextOpen[plot.districtKey] = openWards
  const next: PopulatedWorldCityState = { version: POPULATED_WORLD_CITY_STATE_VERSION, buildings: { ...state.buildings, [property.buildingId]: building }, openWards: nextOpen }
  const fingerprint = districtOf(world, plot.districtKey)!.geometryFingerprint
  return {
    ok: true,
    transition: {
      from: sequence,
      to,
      property,
      plot,
      building,
      districtGeometryFingerprint: fingerprint,
      state: next,
      event: {
        propertyId: property.propertyId,
        buildingId: property.buildingId,
        asset: property.assetKey,
        collection: property.collection.key,
        districtKey: plot.districtKey,
        ward: plot.ward,
        plot: plot.plot,
        plotId: plot.plotId,
        openedWard,
        openWards,
        districtGeometryFingerprint: fingerprint,
      },
    },
  }
}

/** One recorded activation to replay: the world that governed it, what was asked, and the sequence it produced. */
export interface RecordedActivation {
  world: World
  request: PropertyActivationRequest
  sequence: number
}

export type Replay = { ok: true; state: WorldCityState; transitions: PropertyTransition[] } | { ok: false; index: number; detail: string }

/**
 * Rebuild a city from its founding: every recorded activation, in order, must be a valid proposal
 * on the city before it and produce exactly its recorded sequence (2, 3, 4 ...).
 */
export function replayPropertyActivations(steps: readonly RecordedActivation[]): Replay {
  let state: WorldCityState = emptyWorldCityState()
  let sequence = 1
  const transitions: PropertyTransition[] = []
  for (const [index, step] of steps.entries()) {
    if (step.sequence !== sequence + 1) return { ok: false, index, detail: `activation ${index + 1} is recorded at sequence ${step.sequence}; the city was at ${sequence}` }
    let proposed: ProposedActivation
    try {
      proposed = proposePropertyActivation(step.world, state, sequence, step.request)
    } catch (err) {
      return { ok: false, index, detail: err instanceof Error ? err.message : String(err) }
    }
    if (!proposed.ok) return { ok: false, index, detail: `activation ${index + 1} (${assetKey(step.request.asset)} on ${step.request.plotId}) is refused on replay: ${proposed.reason}` }
    transitions.push(proposed.transition)
    state = proposed.transition.state
    sequence = proposed.transition.to
  }
  return { ok: true, state, transitions }
}
