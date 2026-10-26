import { DEFAULT_ARCHITECTURE } from '../../config/architecture'
import { LANDSCAPE_MAX_SLOTS } from '../../config/economy'
import type { LandscapeKind } from '../../config/fixtures'
import type { CityUser } from '../../config/identity'
import { MONUMENTS, type MonumentId } from '../../config/monuments'
import { capitalHolderIn, computeMonumentHoldersIn, tallestBuilding } from '../../game/competition'
import { tierFor } from '../../game/economy'
import { prng, seededArchitecture } from '../../game/seed'
import type { Building } from '../../game/types'
import { nftAsset } from '../../world/asset'
import type { World } from '../../world/definition'
import { availablePlotsIn, choosePlot, occupancyProblems, type PlotRef, type WorldOccupancy } from '../../world/plots'
import { worldProperty } from '../../world/property'
import type { BrandCityConfig } from './config'

/**
 * A SIMULATED brand city state for the preview: who stands where, and how far each
 * building has progressed. Nothing here is persisted, spendable or real ownership.
 *
 * Residents join one at a time, in order, exactly as players would: each takes one of the
 * plots the engine offers (`availablePlotsIn`), confirmed by `choosePlot`. So every plot is a
 * real plot of the world, no two residents share one, and the engine alone decides when a
 * ward opens: only when every open ward is full. The sample never names a ward.
 * Building ids are the engine's V2 property ids. Monument holders, the Capital and the Crown
 * come from the standard competition rules.
 */
/** `floodlights`: the building's Architect exterior lighting, where a saved design has one (see `SceneBuilding`). */
export type BrandBuilding = Omit<Building, 'districtId'> & { districtId: string; floodlights?: string }

export interface SampleDistrictSpec {
  /** Build progress of the district's first residents, in the order they joined. */
  residents: number[]
  /**
   * Small homes that joined next (Rare City's filler mix: Tiers 0 to 2): a count, or `'fill'`
   * for as many as it takes to fill every plot of the open wards.
   */
  filler?: number | 'fill'
  /** Build progress of the latest residents, who joined after everyone else. */
  newcomers?: number[]
}

export interface SampleCitySpec {
  seed: number
  /** Sample member handles; residents are spread over them. */
  owners: string[]
  districts: Readonly<Record<string, SampleDistrictSpec>>
}

export interface SampleNft {
  collection: string
  tokenId: string
}

export interface BrandCityState {
  users: Record<string, CityUser>
  buildings: Record<string, BrandBuilding>
  /** Which NFT each building is (preview metadata). */
  nfts: Record<string, SampleNft>
  wards: Record<string, number>
  monuments: Record<MonumentId, { holder: string | null; sinceClock: number }>
  capital: { holder: string | null; sinceClock: number }
  crown: { holder: string | null; sinceClock: number }
}

const LANDSCAPE: LandscapeKind[] = ['tree', 'shrub', 'planter', 'bench', 'lamp']
/** The same filler mix and progress ranges as Rare City's demo seed. */
const FILLER_TIERS = [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2] as const
/**
 * The mix in a ward that has filled and been superseded by the next: its residents have had
 * time to build, so it holds no bare foundations (a full ward of them reads as empty plots).
 */
const SETTLED_TIERS = FILLER_TIERS.filter((t) => t > 0)
const FILLER_RANGES: Record<number, [number, number]> = { 0: [10, 45], 1: [150, 380], 2: [650, 1_500] }
/** Token numbers of collection i start here, so a city's sample token numbers never collide. */
const TOKEN_BASE = 1000

export function buildSampleCity(config: BrandCityConfig, world: World, spec: SampleCitySpec): BrandCityState {
  const rand = prng(spec.seed)
  const users: Record<string, CityUser> = {}
  spec.owners.forEach((handle, i) => {
    const id = `sample-${i + 1}`
    users[id] = { id, handle, friendId: TOKEN_BASE + i, hue: (i * 53 + 20) % 360 }
  })
  const ownerIds = Object.keys(users)
  const occupancy: { openWards: Record<string, number>; occupied: Set<string> } = { openWards: {}, occupied: new Set() }
  const buildings: Record<string, BrandBuilding> = {}
  const nfts: Record<string, SampleNft> = {}
  const nextToken = config.collections.map((_, i) => TOKEN_BASE * (i + 1))
  let cursor = 0

  // Pass 1: residents join, district by district, in order. Each takes a plot the engine offers.
  type Joiner = { districtKey: string; plot: PlotRef; progress: number | 'filler' }
  const joiners: Joiner[] = []
  const join = (districtKey: string, progress: number | 'filler') => {
    const offered = availablePlotsIn(world, occupancy, districtKey)
    if (!offered) throw new Error(`Sample district ${districtKey} is not a district of this world`)
    if (offered.length === 0) throw new Error(`Sample district ${districtKey} has no plot left to offer`)
    const choice = choosePlot(world, occupancy, offered[Math.floor(rand() * offered.length)].plotId)
    if (!choice.ok) throw new Error(`Sample plot in ${districtKey} is not available: ${choice.reason}`)
    occupancy.occupied.add(choice.plot.plotId)
    occupancy.openWards[districtKey] = choice.openWards
    joiners.push({ districtKey, plot: choice.plot, progress })
  }
  /** True while a plot in an already open ward is free (the next joiner would not open a ward). */
  const openWardHasRoom = (districtKey: string) => availablePlotsIn(world, occupancy, districtKey)!.some((c) => !c.newWard)
  for (const d of config.districts) {
    const s = spec.districts[d.key]
    if (!s) continue
    for (const progress of s.residents) join(d.key, progress)
    if (s.filler === 'fill') while (openWardHasRoom(d.key)) join(d.key, 'filler')
    else for (let i = 0; i < (s.filler ?? 0); i++) join(d.key, 'filler')
    for (const progress of s.newcomers ?? []) join(d.key, progress)
  }

  // Pass 2: what each resident has built, now that every district's newest ward is known.
  let fillerIndex = 0
  for (const j of joiners) {
    const superseded = j.plot.ward < (occupancy.openWards[j.districtKey] ?? 1) - 1
    let progress = j.progress
    if (progress === 'filler') {
      const tiers = superseded ? SETTLED_TIERS : FILLER_TIERS
      const [lo, hi] = FILLER_RANGES[tiers[fillerIndex++ % tiers.length]]
      progress = Math.round(lo + rand() * (hi - lo))
    }
    const ci = cursor % config.collections.length
    const collection = config.collections[ci]
    const tokenId = String(nextToken[ci]++)
    const asset = nftAsset({ chain: collection.chain, contract: collection.contract, tokenId })
    const property = asset && worldProperty(world, asset)
    if (!property) throw new Error(`Sample NFT ${collection.key} #${tokenId} is not from this world`)
    const ownerId = ownerIds[cursor % ownerIds.length]
    cursor++
    const tier = tierFor(progress)
    const slots: (LandscapeKind | null)[] = Array(LANDSCAPE_MAX_SLOTS).fill(null)
    for (let k = 0; k < Math.min(tier + 1, 5); k++) slots[k] = LANDSCAPE[Math.floor(rand() * LANDSCAPE.length)]
    buildings[property.buildingId] = {
      id: property.buildingId,
      friendId: Number(tokenId),
      ownerId,
      districtId: j.districtKey,
      ward: j.plot.ward,
      plot: j.plot.plot,
      ownerBuilt: progress,
      patrons: {},
      architecture: tier === 0 ? { ...DEFAULT_ARCHITECTURE } : seededArchitecture(rand, tier),
      fixtures: tier >= 3 ? ['entrance-upgrade', 'crest', 'premium-facade', 'premium-roof'] : [],
      landscapeInventory: {},
      landscapeSlots: slots,
      billboard: { image: null, updatedClock: null },
      milestones: Array.from({ length: tier }, (_, k) => ({ tier: k + 1, clock: 0, byUserId: ownerId })),
    }
    nfts[property.buildingId] = { collection: collection.key, tokenId }
  }
  const problems = occupancyProblems(world, occupancy satisfies WorldOccupancy)
  if (problems.length > 0) throw new Error(`Impossible sample occupancy: ${problems.join('; ')}`)

  const keys = config.districts.map((d) => d.key)
  const list = Object.values(buildings)
  const holders = computeMonumentHoldersIn(keys, list, {})
  const monuments = {} as BrandCityState['monuments']
  for (const m of MONUMENTS) monuments[m.id] = { holder: holders[m.id], sinceClock: 0 }
  const wards: Record<string, number> = {}
  for (const key of keys) wards[key] = occupancy.openWards[key] ?? 1
  return {
    users,
    buildings,
    nfts,
    wards,
    monuments,
    capital: { holder: capitalHolderIn(keys, list, null), sinceClock: 0 },
    crown: { holder: tallestBuilding(list, null), sinceClock: 0 },
  }
}
