import { DEFAULT_ARCHITECTURE, type ArchitectureConfig } from '../config/architecture'
import { DEMO_WALLET_START, LANDSCAPE_MAX_SLOTS } from '../config/economy'
import { DISTRICT_IDS, getDistrict, type DistrictId } from '../config/districts'
import { DEMO_PLAYER_ID, NPC_HANDLES, type DemoUser } from '../config/identity'
import { MONUMENTS, type MonumentId } from '../config/monuments'
import type { LandscapeKind } from '../config/fixtures'
import { evaluateAllBadges, EMPTY_COUNTERS } from './badges'
import { capitalHolder, computeMonumentHolders, tallestBuilding } from './competition'
import { tierFor, totalBuilt } from './economy'
import { wardCapacity } from './world'
import { appendRadio } from './narration'
import { initialWards } from './allocation'
import { emptySeason } from './season'
import { STATE_VERSION } from './stateSchema'
import type { Building, GameState, HistoryEntry, RadioEntry } from './types'

export { STATE_VERSION }

/** Deterministic PRNG (mulberry32) so the seed city is identical every reset. */
export function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * [friendId, corePlot, totalRF, ownerShare 0..1, patronCount]  (all founders live in Ward I)
 * Totals are tuned so the demo has: a 38 RF Kingmaker tier-up, a near-flip Capital,
 * a tight Crown race, and several buildings sitting just under thresholds.
 */
type Row = [number, number, number, number, number]
const LAYOUT: Record<DistrictId, Row[]> = {
  d1: [
    [101, 0, 12_600, 0.55, 6],
    [117, 1, 3_050, 0.7, 3],
    [133, 2, 640, 0.6, 2],
    [148, 3, 2_380, 0.5, 4],
    [156, 5, 180, 0.9, 1],
    [162, 6, 71, 1, 0],
  ],
  d2: [
    [204, 0, 13_900, 0.5, 7],
    [212, 1, 10_450, 0.62, 6],
    [229, 2, 3_300, 0.55, 3],
    [236, 3, 2_960, 0.6, 4],
    [241, 4, 540, 0.8, 2],
    [258, 6, 1_120, 0.7, 2],
    [266, 5, 9_870, 0.58, 5],
  ],
  d3: [
    [505, 1, 179_900, 0.42, 14],
    [311, 0, 4_100, 0.6, 3],
    [327, 2, 2_720, 0.7, 2],
    [338, 3, 610, 0.75, 1],
    [344, 5, 95, 1, 0],
    [352, 6, 1_480, 0.66, 2],
  ],
  d4: [
    [4471, 6, 11_400, 0.72, 5],
    [812, 0, 9_962, 0.55, 6],
    [288, 2, 2_437, 0.65, 3],
    [419, 3, 14_250, 0.48, 7],
    [436, 4, 2_380, 0.6, 3],
    [447, 5, 520, 0.8, 1],
    [463, 1, 130, 1, 0],
  ],
  d5: [
    [520, 0, 5_600, 0.5, 4],
    [533, 1, 2_610, 0.55, 3],
    [546, 3, 488, 0.7, 2],
    [551, 4, 1_950, 0.62, 2],
    [569, 6, 240, 1, 0],
  ],
  d6: [
    [603, 1, 7_800, 0.6, 5],
    [615, 0, 2_540, 0.7, 2],
    [622, 2, 2_490, 0.64, 3],
    [638, 4, 760, 0.8, 1],
    [649, 5, 305, 1, 0],
    [657, 3, 1_020, 0.7, 1],
  ],
  d7: [
    [120, 1, 182_400, 0.61, 12],
    [714, 0, 3_880, 0.55, 3],
    [728, 2, 2_590, 0.7, 2],
    [733, 4, 505, 0.8, 1],
    [741, 5, 88, 1, 0],
  ],
  d8: [
    [806, 0, 10_900, 0.5, 6],
    [818, 1, 2_780, 0.6, 3],
    [824, 3, 2_475, 0.7, 2],
    [839, 2, 620, 0.75, 1],
    [845, 5, 1_760, 0.7, 2],
    [853, 6, 300, 1, 0],
  ],
  d9: [
    [901, 1, 6_300, 0.62, 4],
    [915, 0, 2_655, 0.55, 3],
    [922, 3, 530, 0.8, 1],
    [937, 2, 470, 0.8, 1],
    [948, 4, 150, 1, 0],
    [956, 6, 2_100, 0.6, 2],
  ],
}

/** Layout rows were authored against the original 7-lot district; map them to Ward I plots. */
const LEGACY_LOT_TO_PLOT = [6, 4, 8, 15, 11, 13, 20]

/** The demo player's building and the key scenario buildings, by Friend ID. */
export const SCENARIO = {
  playerFriend: 4471,
  kingmakerFriend: 812,
  capitalFriend: 288,
  crownHolderFriend: 120,
  crownChallengerFriend: 505,
  /** The demo player's second Friend: a small property in internal d7 (another family). */
  playerSecondFriend: 3710,
} as const

/**
 * Dense-city filler: every district gets the SAME tier mix of smaller resident buildings,
 * so all districts gain identical tier counts and capital points. Monument ownership,
 * the Capital race gaps and every seeded scenario are unchanged by density.
 */
const FILLER_TIERS = [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2] as const
const FILLER_RANGES: Record<number, [number, number]> = { 0: [10, 45], 1: [150, 380], 2: [650, 1_500] }

export function buildingIdFor(friendId: number): string {
  return `b-${friendId}`
}

const FACADES = ['slate', 'limestone', 'brick', 'obsidian', 'copper', 'jade', 'aurora']
const WINDOWS = ['grid', 'ribbon', 'arched', 'lattice']
const LIGHTS = ['warm', 'cool', 'warm', 'neon', 'gold']
const LANDSCAPE: LandscapeKind[] = ['tree', 'shrub', 'planter', 'bench', 'lamp']

function seededArchitecture(rand: () => number, tier: number): ArchitectureConfig {
  const pick = <T,>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)]
  const roofs = tier >= 4 ? ['spire', 'crown-deck', 'halo', 'terrace'] : tier >= 3 ? ['spire', 'terrace', 'dome'] : tier >= 2 ? ['terrace', 'dome', 'flat'] : ['flat']
  const tops = tier >= 4 ? ['helipad', 'beacon', 'antenna'] : tier >= 2 ? ['antenna', 'garden', 'none'] : ['none']
  return {
    facade: tier >= 3 ? pick(FACADES) : pick(FACADES.slice(0, 3)),
    roof: pick(roofs),
    windows: tier >= 4 ? pick([...WINDOWS, 'panoramic']) : pick(WINDOWS),
    entrance: tier >= 3 ? pick(['arch', 'portico', 'awning']) : pick(['simple', 'awning']),
    crest: tier >= 3 ? pick(['star', 'leaf', 'wave', 'sun', 'none']) : 'none',
    rooftop: pick(tops),
    lighting: pick(LIGHTS),
  }
}

function makeUsers(): Record<string, DemoUser> {
  const users: Record<string, DemoUser> = {
    [DEMO_PLAYER_ID]: { id: DEMO_PLAYER_ID, handle: 'demo-player', friendId: SCENARIO.playerFriend, hue: 172 },
  }
  NPC_HANDLES.forEach((handle, i) => {
    const id = `npc-${String(i + 1).padStart(2, '0')}`
    users[id] = { id, handle, friendId: 1000 + ((i * 137) % 8000), hue: (i * 47) % 360 }
  })
  return users
}

export function createSeedState(): GameState {
  const rand = prng(0x6e17c1)
  const users = makeUsers()
  const npcIds = Object.keys(users).filter((u) => u !== DEMO_PLAYER_ID)
  const buildings: Record<string, Building> = {}
  let npcCursor = 0

  for (const districtId of DISTRICT_IDS) {
    for (const [friendId, legacyLot, total, ownerShare, patronCount] of LAYOUT[districtId]) {
      const plot = LEGACY_LOT_TO_PLOT[legacyLot]
      const id = buildingIdFor(friendId)
      const isPlayer = friendId === SCENARIO.playerFriend
      const ownerId = isPlayer ? DEMO_PLAYER_ID : npcIds[npcCursor++ % npcIds.length]
      const ownerBuilt = Math.round(total * ownerShare)
      let community = total - ownerBuilt
      const patrons: Record<string, number> = {}
      if (patronCount === 0) {
        // No patrons: everything is owner-funded.
      } else if (isPlayer) {
        // Hand-tuned patron zone for the player's tower: banner, marker, plaque, supporters.
        const fixed: [string, number][] = [['npc-01', 1_600], ['npc-02', 720], ['npc-03', 450], ['npc-04', 290], ['npc-05', 132]]
        fixed.forEach(([u, v]) => (patrons[u] = v))
        community -= fixed.reduce((a, [, v]) => a + v, 0)
        patrons['npc-01'] += community
      } else {
        const donors = npcIds.filter((u) => u !== ownerId)
        const start = Math.floor(rand() * donors.length)
        const weights = Array.from({ length: patronCount }, (_, i) => 1 / (i + 1.3) + rand() * 0.2)
        const wsum = weights.reduce((a, w) => a + w, 0)
        let remaining = community
        weights.forEach((w, i) => {
          const u = donors[(start + i * 7) % donors.length]
          const amt = i === patronCount - 1 ? remaining : Math.max(1, Math.floor((community * w) / wsum))
          patrons[u] = (patrons[u] ?? 0) + amt
          remaining -= amt
        })
      }
      const tier = tierFor(total)
      const architecture = isPlayer
        ? { ...DEFAULT_ARCHITECTURE, facade: 'limestone', roof: 'terrace', windows: 'ribbon', rooftop: 'antenna', lighting: 'cool' }
        : tier === 0
          ? { ...DEFAULT_ARCHITECTURE }
          : seededArchitecture(rand, tier)
      const fixtures = isPlayer ? [] : tier >= 3 ? (['entrance-upgrade', 'crest', 'premium-facade', 'premium-roof'] as const).slice() : []
      const slots: (LandscapeKind | null)[] = Array(LANDSCAPE_MAX_SLOTS).fill(null)
      const nLand = isPlayer ? 2 : Math.min(tier + 1, 5)
      for (let i = 0; i < nLand; i++) slots[i] = isPlayer ? (['tree', 'bench'] as const)[i] : LANDSCAPE[Math.floor(rand() * LANDSCAPE.length)]
      const b: Building = {
        id,
        friendId,
        ownerId,
        districtId,
        ward: 0,
        plot,
        ownerBuilt,
        patrons,
        architecture,
        fixtures: [...fixtures],
        landscapeInventory: isPlayer ? { tree: 1, lamp: 1 } : {},
        landscapeSlots: slots,
        billboard: { image: null, updatedClock: null },
        milestones: Array.from({ length: tier }, (_, i) => ({ tier: i + 1, clock: 0, byUserId: ownerId })),
      }
      if (totalBuilt(b) !== total) throw new Error(`Seed mismatch for ${id}`)
      buildings[id] = b
    }
  }

  // Dense filler residents on the remaining Founding Ward plots.
  const fill = prng(0xd3e5e)
  DISTRICT_IDS.forEach((districtId, di) => {
    const used = new Set(Object.values(buildings).filter((b) => b.districtId === districtId).map((b) => b.plot))
    const free = Array.from({ length: wardCapacity(0) }, (_, i) => i).filter((i) => !used.has(i))
    FILLER_TIERS.forEach((tier, i) => {
      const plot = free[i]
      if (plot === undefined) return
      const friendId = 3000 + (di + 1) * 100 + i
      const [lo, hi] = FILLER_RANGES[tier]
      const total = Math.round(lo + fill() * (hi - lo))
      const isPlayer = friendId === SCENARIO.playerSecondFriend
      const ownerId = isPlayer ? DEMO_PLAYER_ID : npcIds[npcCursor++ % npcIds.length]
      const slots: (LandscapeKind | null)[] = Array(LANDSCAPE_MAX_SLOTS).fill(null)
      for (let k = 0; k < Math.min(tier + 1, 3); k++) slots[k] = LANDSCAPE[Math.floor(fill() * LANDSCAPE.length)]
      buildings[buildingIdFor(friendId)] = {
        id: buildingIdFor(friendId),
        friendId,
        ownerId,
        districtId,
        ward: 0,
        plot,
        ownerBuilt: total,
        patrons: {},
        architecture: tier === 0 ? { ...DEFAULT_ARCHITECTURE } : seededArchitecture(fill, tier),
        fixtures: [],
        landscapeInventory: {},
        landscapeSlots: slots,
        billboard: { image: null, updatedClock: null },
        milestones: Array.from({ length: tier }, (_, k) => ({ tier: k + 1, clock: 0, byUserId: ownerId })),
      }
    })
  })

  const list = Object.values(buildings)
  const holders = computeMonumentHolders(list, {})
  const monuments = {} as GameState['monuments']
  const monumentHistory = {} as GameState['monumentHistory']
  for (const m of MONUMENTS) {
    monuments[m.id as MonumentId] = { holder: holders[m.id], sinceClock: 0 }
    monumentHistory[m.id] = holders[m.id]
      ? [{ holder: holders[m.id]!, fromClock: 0, toClock: null, byUserId: null, byBuildingId: null }]
      : []
  }
  const cap = capitalHolder(list, null)
  const crown = tallestBuilding(list, null)
  const counters: GameState['counters'] = {}
  for (const u of Object.keys(users)) counters[u] = { ...EMPTY_COUNTERS }
  if (crown) counters[buildings[crown].ownerId].crownedCount = 1

  const hist = <T,>(holder: T | null): HistoryEntry<T>[] =>
    holder ? [{ holder, fromClock: 0, toClock: null, byUserId: null, byBuildingId: null }] : []

  const state: GameState = {
    version: STATE_VERSION,
    clock: 0,
    users,
    buildings,
    wallets: { [DEMO_PLAYER_ID]: DEMO_WALLET_START },
    monuments,
    monumentHistory,
    capital: { holder: cap, sinceClock: 0 },
    capitalHistory: hist(cap),
    crown: { holder: crown, sinceClock: 0 },
    crownHistory: hist(crown),
    badges: {},
    counters,
    radio: [],
    alertKeys: [],
    rivalCursor: 0,
    wards: initialWards(),
    residentSeq: 0,
    season: {
      ...emptySeason(1),
      // The demo player has already chosen Demo Friend #4471 (internal d4) this season.
      representatives: { [DEMO_PLAYER_ID]: { buildingId: buildingIdFor(SCENARIO.playerFriend), districtId: 'd4', chosenClock: 0 } },
    },
  }
  state.badges = evaluateAllBadges(state).badges

  const welcome: RadioEntry[] = [
    {
      id: '',
      clock: 0,
      kind: 'system',
      headline: 'DISTRICT RADIO ONLINE',
      detail: 'All RF in this demo is SIMULATED. No real tokens move. Every RF spent raises the skyline, and the city grows outward as new Friends join.',
      districtId: null,
      buildingId: null,
    },
    {
      id: '',
      clock: 0,
      kind: 'rally',
      headline: `RALLY DEMO FRIEND #${SCENARIO.kingmakerFriend}`,
      detail: `38 RF needed for Tier 4. Tier-up would capture The Grand Fountain for the ${getDistrict('d4').title}. — @nova.lane`,
      districtId: 'd4',
      buildingId: buildingIdFor(SCENARIO.kingmakerFriend),
    },
    {
      id: '',
      clock: 0,
      kind: 'crown',
      headline: 'CROWN RACE HEATS UP',
      detail: `Demo Friend #${SCENARIO.crownChallengerFriend} (${getDistrict('d3').name}) is closing on the Crown held by Demo Friend #${SCENARIO.crownHolderFriend}.`,
      districtId: 'd3',
      buildingId: buildingIdFor(SCENARIO.crownChallengerFriend),
    },
  ]
  state.radio = appendRadio([], welcome)
  return state
}
