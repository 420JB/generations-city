import { WORLD } from '../../config/world'
import { compileWorld, type CompiledWorld, type RadialWedgeParams, type WorldDefinition } from '../../world/definition'
import type { BrandCityConfig } from './config'

/**
 * Where a brand city's districts stand: the STANDARD radial layout, divided evenly.
 *
 * A brand chooses how many districts it has, not their geometry. Ward bands, plot rows,
 * streets and plot spacing are Rare City's own (`config/world.ts`); the wedges split the
 * full turn evenly, District 1 at the back of the map as in Rare City. So four districts
 * are four 90° wedges, six are six 60° wedges: a real city of that many districts, not
 * nine wedges with some renamed.
 */
export const STANDARD_RADIAL_PARAMS: Readonly<RadialWedgeParams> = Object.freeze({
  coreWardInner: WORLD.coreWard.inner,
  coreWardOuter: WORLD.coreWard.outer,
  firstPlotRadius: WORLD.firstPlotRadius,
  wardDepth: WORLD.wardDepth,
  rowOffsets: Object.freeze([...WORLD.wardRowOffsets]) as readonly number[],
  plotSpacing: WORLD.plotSpacing,
  marginDeg: WORLD.districtMarginDeg,
})

/** Layout preset key for the standard even split (a permanent key; never reuse it for other geometry). */
export const STANDARD_LAYOUT_KEY = 'standard-radial-even'

/** Centre and span of district `index` (0-based) of `count`. */
export function brandWedge(index: number, count: number): { centerDeg: number; spanDeg: number } {
  const spanDeg = 360 / count
  return { centerDeg: -135 + index * spanDeg, spanDeg }
}

/** The generic engine's definition of a brand city. Collections and districts come from the configuration; everything else is standard. */
export function brandWorldDefinition(config: BrandCityConfig): WorldDefinition {
  const n = config.districts.length
  return {
    worldId: config.worldId,
    districts: config.districts.map((d) => ({ key: d.key })),
    collections: config.collections.map((c) => ({ key: c.key, chain: c.chain, contract: c.contract, standard: 'erc721' as const })),
    layout: {
      kind: 'radial-wedge',
      key: STANDARD_LAYOUT_KEY,
      params: { ...STANDARD_RADIAL_PARAMS, rowOffsets: [...STANDARD_RADIAL_PARAMS.rowOffsets] },
      districts: config.districts.map((d, i) => ({ district: d.key, ...brandWedge(i, n) })),
      maxWards: null,
    },
    buildingIds: 'property-v1',
  }
}

/** Compile a brand city through the generic world engine (all of its validation applies). */
export function compileBrandWorld(config: BrandCityConfig): CompiledWorld {
  return compileWorld(brandWorldDefinition(config))
}
