import type { ArchitectureConfig } from '../config/architecture'
import type { DistrictId } from '../config/districts'
import type { FixtureId, LandscapeKind } from '../config/fixtures'
import type { MonumentId } from '../config/monuments'
import type { DemoUser } from '../config/identity'

export type { DistrictId, MonumentId, FixtureId, LandscapeKind, ArchitectureConfig, DemoUser }

export interface Milestone {
  tier: number
  clock: number
  byUserId: string
}

export interface BillboardState {
  /** Browser-local compressed data URL, or null when no image is set. */
  image: string | null
  updatedClock: number | null
  /** Optional plain-text, link-free owner message (absent in older saves). */
  message?: string | null
}

export interface Building {
  id: string
  friendId: number
  ownerId: string
  districtId: DistrictId
  /** Ward (neighbourhood) inside the district. 0 = district core. */
  ward: number
  /** Plot index inside the ward. */
  plot: number
  /** RF personally spent by the owner (direct build + fixtures). */
  ownerBuilt: number
  /** Aggregated contributions by other users: userId -> cumulative RF. Community Build = sum. */
  patrons: Record<string, number>
  architecture: ArchitectureConfig
  /** One-time upgrade fixtures owned. */
  fixtures: FixtureId[]
  /** Owned landscaping items not currently placed. */
  landscapeInventory: Partial<Record<LandscapeKind, number>>
  /** Placed landscaping in bounded lot slots (length = LANDSCAPE_MAX_SLOTS). */
  landscapeSlots: (LandscapeKind | null)[]
  billboard: BillboardState
  milestones: Milestone[]
}

export interface Holding<T> {
  holder: T | null
  sinceClock: number
}

export interface HistoryEntry<T> {
  holder: T
  fromClock: number
  toClock: number | null
  /** Who caused the change (null for seed). */
  byUserId: string | null
  byBuildingId: string | null
}

export interface BadgeAward {
  badgeId: string
  /** 1-based level (1 = Bronze / unlevelled). */
  level: number
  clock: number
}

export interface UserCounters {
  closerCount: number
  kingmakerCount: number
  capitalCaptures: number
  capitalReigns: number
  crownedCount: number
}

export type RadioKind = 'tier-up' | 'monument' | 'capital' | 'crown' | 'alert' | 'rally' | 'patron' | 'growth' | 'system'

export interface RadioEntry {
  id: string
  clock: number
  kind: RadioKind
  headline: string
  detail: string
  districtId: DistrictId | null
  buildingId: string | null
}

/** A player's seasonal allegiance: one Representative Friend decides the Home District. */
export interface Representative {
  buildingId: string
  districtId: DistrictId
  /** Clock when chosen; locked for the rest of the season. */
  chosenClock: number
}

/** Seasonal activity for one building, kept apart from its permanent tier/RF. */
export interface SeasonActivity {
  rf: number
  tierUps: number
  builders: string[]
}

/** Seasonal layer. Resets each season; permanent world state does not. */
export interface SeasonState {
  id: string
  name: string
  number: number
  representatives: Record<string, Representative>
  activity: Record<string, SeasonActivity>
  /** Clock at which each player joined during this season (late-join / residency). */
  joinedClock: Record<string, number>
}

export interface GameState {
  version: number
  clock: number
  users: Record<string, DemoUser>
  buildings: Record<string, Building>
  wallets: Record<string, number>
  monuments: Record<MonumentId, Holding<DistrictId>>
  monumentHistory: Record<MonumentId, HistoryEntry<DistrictId>[]>
  capital: Holding<DistrictId>
  capitalHistory: HistoryEntry<DistrictId>[]
  crown: Holding<string>
  crownHistory: HistoryEntry<string>[]
  badges: Record<string, BadgeAward[]>
  counters: Record<string, UserCounters>
  radio: RadioEntry[]
  /** Keys of threshold alerts already announced, to avoid repeats. */
  alertKeys: string[]
  /** Index of the next scripted rival move. */
  rivalCursor: number
  /** Number of open wards per district (>= 1). The city grows as wards open. */
  wards: Record<DistrictId, number>
  /** Deterministic counter for simulated newly-joining residents. */
  residentSeq: number
  /** Seasonal competition layer (separate from permanent progress). */
  season: SeasonState
}

export type GameEvent =
  | { type: 'build'; buildingId: string; userId: string; amount: number; asOwner: boolean }
  | { type: 'stage-up'; buildingId: string; tier: number; stage: number }
  | { type: 'tier-up'; buildingId: string; fromTier: number; toTier: number; byUserId: string }
  | { type: 'monument-transfer'; monumentId: MonumentId; from: DistrictId | null; to: DistrictId | null; byUserId: string; buildingId: string }
  | { type: 'capital-change'; from: DistrictId | null; to: DistrictId | null; byUserId: string }
  | { type: 'crown-transfer'; from: string | null; to: string | null; byUserId: string }
  | { type: 'badge'; userId: string; badgeId: string; level: number }
  | { type: 'patron-level'; buildingId: string; userId: string; level: string }
  | { type: 'fixture'; buildingId: string; fixtureId: FixtureId }
  | { type: 'resident-joined'; buildingId: string; districtId: DistrictId; ward: number; plot: number }
  /** `simulatedResidents` is set only by the demo-only growth simulator. */
  | { type: 'ward-opened'; districtId: DistrictId; ward: number; simulatedResidents?: number }

export interface ActionResult {
  state: GameState
  events: GameEvent[]
  error?: string
}
