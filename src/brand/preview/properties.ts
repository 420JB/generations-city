import { wardName } from '../../game/allocation'
import { parseAssetKey } from '../../world/asset'
import { worldBuildingId, type WorldBuildingRecord, type WorldCityState } from '../../world/cityState'
import { formatPlotId } from '../../world/plots'
import { districtPlots, type LoadedBrandCity } from '../load'

/**
 * THE PLAYER'S PROPERTY HOME (P1-C2-E2): what a persistent city's page can say about the properties a
 * signed-in player FOUNDED, and the city around them, from exactly two server answers and nothing else:
 *
 *   - the city as stored (`world.state`): every property's NFT, collection, district, exact plot and the
 *     city sequence that activated it;
 *   - `viewer.originalActivations`: the ids of the properties the server's permanent record says this
 *     session's player originally activated, matched on the Proofy identity of the session (never on
 *     anything the page sends).
 *
 * A founding is permanent and is not ownership: who holds an NFT now is not known to this page, so
 * nothing here says "owned" or "yours" for the present. Nothing here is written anywhere.
 */

/** A property the signed-in player founded, exactly as the city stores it. */
export interface FoundedProperty {
  buildingId: string
  propertyId: string
  /** CAIP-19 key of the NFT. */
  asset: string
  /** The collection key the NFT was activated under. */
  collection: string
  /** Canonical decimal, exact. */
  tokenId: string
  districtKey: string
  ward: number
  plot: number
  plotId: string
  /** The city sequence its activation produced. */
  sequence: number
  /** Its place in the city's founding order: 1 for the city's first property. */
  order: number
}

const bySequence = (a: { sequence: number }, b: { sequence: number }) => a.sequence - b.sequence

/** Each stored property's place in the city's founding order (1 for the first), by the sequence that activated it. */
export function foundingOrder(state: WorldCityState): Map<string, number> {
  return new Map((Object.values(state.buildings) as WorldBuildingRecord[]).slice().sort(bySequence).map((b, i) => [b.propertyId, i + 1]))
}

/**
 * The properties `originalActivations` names that the stored city holds, most recently founded first. An id the city
 * does not hold is left out (the page never invents a property), and so is a repeated one.
 */
export function foundedProperties(state: WorldCityState, originalActivations: readonly string[]): FoundedProperty[] {
  const order = foundingOrder(state)
  const buildings = state.buildings as Readonly<Record<string, WorldBuildingRecord>>
  const out: FoundedProperty[] = []
  for (const id of new Set(originalActivations)) {
    const buildingId = worldBuildingId(id)
    const b = Object.hasOwn(buildings, buildingId) ? buildings[buildingId] : undefined
    const tokenId = b && parseAssetKey(b.asset)?.tokenId
    if (!b || !tokenId) continue
    out.push({
      buildingId,
      propertyId: b.propertyId,
      asset: b.asset,
      collection: b.collection,
      tokenId,
      districtKey: b.districtKey,
      ward: b.ward,
      plot: b.plot,
      plotId: formatPlotId(b.districtKey, b.ward, b.plot),
      sequence: b.sequence,
      order: order.get(b.propertyId)!,
    })
  }
  return out.sort((a, b) => b.sequence - a.sequence)
}

/** Another property of the same district, as the city shows it to everyone: its NFT and plot, never who placed it. */
export interface NeighbourProperty {
  buildingId: string
  collection: string
  tokenId: string
  ward: number
  plot: number
}

/** A district of the city, and how many properties stand in it. */
export interface DistrictTally {
  key: string
  properties: number
}

/** The city and district around one property, as the stored city says. */
export interface PropertyContext {
  /** Properties in the whole city. */
  cityProperties: number
  district: { key: string; properties: number; wardsOpen: number; freePlots: number }
  /** Other properties of its district, closest plots first (by ward, then plot), at most `limit`. */
  neighbours: NeighbourProperty[]
  /** How many other properties its district holds beyond `neighbours`. */
  moreNeighbours: number
  /** Every other district of the city, in configuration order. */
  others: DistrictTally[]
}

/** What the stored city says around a building, or null for a building it does not hold. */
export function propertyContext(city: LoadedBrandCity, buildingId: string, limit = 4): PropertyContext | null {
  const { state, config } = city
  const b = Object.hasOwn(state.buildings, buildingId) ? state.buildings[buildingId] : undefined
  if (!b) return null
  const all = Object.values(state.buildings)
  const counts = new Map<string, number>()
  for (const x of all) counts.set(x.districtId, (counts.get(x.districtId) ?? 0) + 1)
  const near = all
    .filter((x) => x.districtId === b.districtId && x.id !== b.id)
    .sort((x, y) => Math.abs(x.ward - b.ward) - Math.abs(y.ward - b.ward) || Math.abs(x.plot - b.plot) - Math.abs(y.plot - b.plot) || x.ward - y.ward || x.plot - y.plot)
  const neighbours = near.slice(0, limit).map((x) => ({ buildingId: x.id, collection: state.nfts[x.id]?.collection ?? '', tokenId: state.nfts[x.id]?.tokenId ?? String(x.friendId), ward: x.ward, plot: x.plot }))
  return {
    cityProperties: all.length,
    district: { key: b.districtId, properties: counts.get(b.districtId) ?? 0, wardsOpen: state.wards[b.districtId] ?? 1, freePlots: districtPlots(city, b.districtId).length },
    neighbours,
    moreNeighbours: near.length - neighbours.length,
    others: config.districts.filter((d) => d.key !== b.districtId).map((d) => ({ key: d.key, properties: counts.get(d.key) ?? 0 })),
  }
}

/** "Ward I · Plot 3", as the city's signage and claim card say it. */
export const plotAddress = (ward: number, plot: number) => `${wardName(ward)} · Plot ${plot + 1}`

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st. */
export function ordinal(n: number): string {
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${suffix}`
}
