import { districtOf, type District, type World } from './definition'
import { isPermanentKey, isWorldId } from './identity'
import { canOpenWard, wardAllowed, wardCapacityOf } from './layout'

/**
 * PERMANENT PLOT IDENTITY, and which plots a world can offer.
 *
 * A plot id is `<district key>-w<ward>-p<plot>`, the legacy spelling with any permanent
 * district key in place of `d1`..`d9`. Within one world it names one plot forever. Across
 * worlds a plot is (world id, plot id), written `<world id>:<plot id>`.
 *
 * Three questions, kept apart:
 *   parsePlotId        is this text a plot id at all?             (syntax only)
 *   resolvePlot        is it a plot of this world's layout?       (district, ward limit, capacity)
 *   availablePlotsIn   may a joining NFT take it, given occupancy? (open wards, buildings)
 */
export interface PlotRef {
  districtKey: string
  ward: number
  plot: number
  /** The canonical spelling: exactly the text that was parsed. */
  plotId: string
}

/** Ward and plot are each written canonically and below one million, as in the legacy contract. */
const PLOT_ID = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)-w(0|[1-9][0-9]{0,5})-p(0|[1-9][0-9]{0,5})$/

export function formatPlotId(districtKey: string, ward: number, plot: number): string {
  return `${districtKey}-w${ward}-p${plot}`
}

/**
 * Parse `<district key>-w<ward>-p<plot>`. Only the canonical spelling parses, so two texts
 * never name one plot. The suffix is anchored, so a key may itself contain `-w1` without ambiguity.
 */
export function parsePlotId(input: unknown): PlotRef | null {
  if (typeof input !== 'string') return null
  const match = PLOT_ID.exec(input)
  if (!match || !isPermanentKey(match[1])) return null
  return { districtKey: match[1], ward: Number(match[2]), plot: Number(match[3]), plotId: input }
}

/** A plot id that names a real plot of this world's layout, or null. Says nothing about whether it is free. */
export function resolvePlot(world: World, input: unknown): PlotRef | null {
  const ref = parsePlotId(input)
  if (!ref) return null
  const district = districtOf(world, ref.districtKey)
  if (!district || !wardAllowed(world, ref.ward)) return null
  return ref.plot < wardCapacityOf(world, district, ref.ward) ? ref : null
}

/** World-scoped plot identity. */
export interface WorldPlotRef {
  worldId: string
  plot: PlotRef
}

export function worldPlotKey(world: World, plot: PlotRef): string {
  return `${world.id}:${plot.plotId}`
}

/** Parse `<world id>:<plot id>` (syntax only; resolve the plot against its world separately). */
export function parseWorldPlotKey(input: unknown): WorldPlotRef | null {
  if (typeof input !== 'string') return null
  const colon = input.indexOf(':')
  if (colon < 0) return null
  const worldId = input.slice(0, colon)
  const plot = parsePlotId(input.slice(colon + 1))
  return isWorldId(worldId) && plot ? { worldId, plot } : null
}

/**
 * What the engine needs to know about a city's occupancy, and nothing more. An adapter
 * supplies it from whatever state model holds the city (see `legacyOccupancy`).
 */
export interface WorldOccupancy {
  /** Open wards per district key. A district absent here has only its founding ward open. */
  openWards: Readonly<Record<string, number>>
  /** Plot ids that hold a building. */
  occupied: ReadonlySet<string>
}

export interface PlotCandidate extends PlotRef {
  /** True when the plot lies in the next ward, which opens only if an NFT joins here. */
  newWard: boolean
}

const MAX_OCCUPANCY_PROBLEMS = 20

/**
 * Everything wrong with an occupancy for this world, or an empty list. Impossible state is
 * refused, never repaired: an unknown district, an open-ward count the layout does not
 * allow, an occupied text that is not a plot of this world, or a building in a ward that
 * is not open.
 */
export function occupancyProblems(world: World, occupancy: unknown): string[] {
  const problems: string[] = []
  const add = (detail: string) => problems.length < MAX_OCCUPANCY_PROBLEMS && problems.push(detail)
  if (typeof occupancy !== 'object' || occupancy === null) return ['occupancy is not an object']
  const { openWards, occupied } = occupancy as Record<string, unknown>
  if (typeof openWards !== 'object' || openWards === null || Array.isArray(openWards)) add('openWards is not an object')
  else
    for (const [key, open] of Object.entries(openWards)) {
      if (!districtOf(world, key)) add(`openWards names ${JSON.stringify(key)}, which is not a district of this world`)
      else if (!Number.isSafeInteger(open) || (open as number) < 1 || (open as number) > world.layout.wardLimit) add(`district ${key} has an impossible number of open wards: ${String(open)}`)
    }
  // Open-ward counts are only read once they are known to be sound.
  const wardsSound = problems.length === 0
  if (!(occupied instanceof Set)) add('occupied is not a Set')
  else
    for (const plotId of occupied as Set<unknown>) {
      const ref = resolvePlot(world, plotId)
      if (!ref) add(`${JSON.stringify(plotId)} is not a plot of this world`)
      else if (wardsSound && ref.ward >= openWardsOf(occupancy as WorldOccupancy, ref.districtKey)) add(`${ref.plotId} is in a ward that is not open`)
    }
  return problems
}

function assertOccupancy(world: World, occupancy: WorldOccupancy) {
  const problems = occupancyProblems(world, occupancy)
  if (problems.length > 0) throw new Error(`Impossible occupancy: ${problems.join('; ')}`)
}

function openWardsOf(occupancy: WorldOccupancy, districtKey: string): number {
  return Object.hasOwn(occupancy.openWards, districtKey) ? occupancy.openWards[districtKey] : 1
}

function candidatesIn(world: World, occupancy: WorldOccupancy, district: District): PlotCandidate[] {
  const open = openWardsOf(occupancy, district.key)
  const out: PlotCandidate[] = []
  for (let ward = 0; ward < open; ward++)
    for (let plot = 0; plot < wardCapacityOf(world, district, ward); plot++) {
      const plotId = formatPlotId(district.key, ward, plot)
      if (!occupancy.occupied.has(plotId)) out.push({ districtKey: district.key, ward, plot, plotId, newWard: false })
    }
  if (out.length > 0 || !canOpenWard(world, open)) return out
  return Array.from({ length: wardCapacityOf(world, district, open) }, (_, plot) => ({ districtKey: district.key, ward: open, plot, plotId: formatPlotId(district.key, open, plot), newWard: true }))
}

/**
 * Every plot a joining NFT may choose in a district: all free plots in the open wards or,
 * when every open ward is full, every plot of the next ward (previewed, not opened), if
 * the layout allows one more. Null for a district this world does not have. Throws on
 * impossible occupancy (see `occupancyProblems`). `WORLD_LIMITS.plotsPerDistrict` bounds
 * the list, and every plot in it resolves and can be chosen.
 */
export function availablePlotsIn(world: World, occupancy: WorldOccupancy, districtKey: string): PlotCandidate[] | null {
  const district = districtOf(world, districtKey)
  if (!district) return null
  assertOccupancy(world, occupancy)
  return candidatesIn(world, occupancy, district)
}

export type PlotChoice =
  | { ok: true; plot: PlotRef; openedWard: boolean; openWards: number }
  | { ok: false; reason: 'unknown-plot' | 'plot-unavailable' }

/**
 * Check an exact, chosen plot against occupancy. Pure: nothing changes, and the caller
 * writes the result (and `openWards`, the district's count afterwards) only after its own
 * authoritative checks. This is not an allocator: it never chooses a plot. Throws on
 * impossible occupancy, as `availablePlotsIn` does.
 */
export function choosePlot(world: World, occupancy: WorldOccupancy, input: unknown): PlotChoice {
  assertOccupancy(world, occupancy)
  const ref = resolvePlot(world, input)
  if (!ref) return { ok: false, reason: 'unknown-plot' }
  const pick = candidatesIn(world, occupancy, districtOf(world, ref.districtKey)!).find((c) => c.ward === ref.ward && c.plot === ref.plot)
  if (!pick) return { ok: false, reason: 'plot-unavailable' }
  const open = openWardsOf(occupancy, ref.districtKey)
  return { ok: true, plot: ref, openedWard: pick.newWard, openWards: pick.newWard ? open + 1 : open }
}
