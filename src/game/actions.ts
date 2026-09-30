import { ARCH_OPTIONS, type ArchitectureSlot } from '../config/architecture'
import { CRITICAL_THRESHOLD_FRACTION, DEMO_FAUCET_AMOUNT, LANDSCAPE_MAX_SLOTS } from '../config/economy'
import { getFixture, LANDSCAPE_KINDS, type FixtureId, type LandscapeKind } from '../config/fixtures'
import { MONUMENTS, type MonumentId } from '../config/monuments'
import type { DistrictId } from '../config/districts'
import { allocatePlot, newBuilding } from './allocation'
import { recordSeasonActivity } from './season'
import { evaluateAllBadges, EMPTY_COUNTERS } from './badges'
import { capitalHolder, computeMonumentHolders, tallestBuilding } from './competition'
import {
  architectLevel,
  landscapeCapacity,
  patronLevel,
  rfToNextTier,
  stageFor,
  tierFloor,
  tierFor,
  totalBuilt,
} from './economy'
import { alertEntry, appendRadio, describeImpact, radioFromEvents, rallyEntry } from './narration'
import { impactScore, projectImpact } from './projection'
import type { ActionResult, Building, GameEvent, GameState, UserCounters } from './types'

const MAX_SINGLE_SPEND = 1_000_000

function fail(state: GameState, error: string): ActionResult {
  return { state, events: [], error }
}

function bumpCounter(s: GameState, userId: string, key: keyof UserCounters, by = 1) {
  const prev = s.counters[userId] ?? EMPTY_COUNTERS
  s.counters = { ...s.counters, [userId]: { ...prev, [key]: prev[key] + by } }
}

/** Is an architecture option available to this building right now? */
export function optionUnlocked(b: Building, slot: ArchitectureSlot, optionId: string): { ok: boolean; reason?: string } {
  const opt = ARCH_OPTIONS[slot].find((o) => o.id === optionId)
  if (!opt) return { ok: false, reason: 'Unknown option' }
  const tier = tierFor(totalBuilt(b))
  if (opt.minTier && tier < opt.minTier) return { ok: false, reason: `Requires Tier ${opt.minTier}` }
  if (opt.minArchitectLevel && architectLevel(b.ownerBuilt) < opt.minArchitectLevel)
    return { ok: false, reason: `Requires Architect Lv ${opt.minArchitectLevel}` }
  if (opt.requiresFixture && !b.fixtures.includes(opt.requiresFixture))
    return { ok: false, reason: `Requires ${getFixture(opt.requiresFixture).name}` }
  return { ok: true }
}

/**
 * The single path through which any simulated RF enters a building. Handles the
 * owner/community split, tier + stage changes, Closer/Kingmaker, monuments, Capital,
 * Crown, patron recognition, badges and District Radio. Pure: returns a new state.
 */
export function applyBuildRF(
  state: GameState,
  params: { buildingId: string; userId: string; amount: number; extraEvents?: GameEvent[]; mutate?: (b: Building) => void },
): ActionResult {
  const { buildingId, userId, amount } = params
  const prevB = state.buildings[buildingId]
  if (!prevB) return fail(state, 'Unknown building')
  if (!state.users[userId]) return fail(state, 'Unknown user')
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_SINGLE_SPEND) return fail(state, 'Invalid amount')
  const wallet = state.wallets[userId]
  if (wallet !== undefined && wallet < amount) return fail(state, 'Not enough simulated RF')

  const asOwner = prevB.ownerId === userId
  const b: Building = { ...prevB, patrons: { ...prevB.patrons } }
  if (asOwner) b.ownerBuilt += amount
  else b.patrons[userId] = (b.patrons[userId] ?? 0) + amount
  params.mutate?.(b)

  const s: GameState = {
    ...state,
    clock: state.clock + 1,
    buildings: { ...state.buildings, [buildingId]: b },
    wallets: wallet !== undefined ? { ...state.wallets, [userId]: wallet - amount } : state.wallets,
  }
  const events: GameEvent[] = [...(params.extraEvents ?? []), { type: 'build', buildingId, userId, amount, asOwner }]

  const beforeTotal = totalBuilt(prevB)
  const afterTotal = totalBuilt(b)
  const fromTier = tierFor(beforeTotal)
  const toTier = tierFor(afterTotal)
  const tierCrossed = toTier > fromTier

  if (tierCrossed) {
    b.milestones = [...b.milestones]
    for (let t = fromTier + 1; t <= toTier; t++) b.milestones.push({ tier: t, clock: s.clock, byUserId: userId })
    events.push({ type: 'tier-up', buildingId, fromTier, toTier, byUserId: userId })
    if (!asOwner) bumpCounter(s, userId, 'closerCount', toTier - fromTier)
  } else if (stageFor(afterTotal) !== stageFor(beforeTotal)) {
    events.push({ type: 'stage-up', buildingId, tier: toTier, stage: stageFor(afterTotal) })
  }

  if (!asOwner) {
    const before = patronLevel(prevB.patrons[userId] ?? 0)
    const after = patronLevel(b.patrons[userId])
    if (after && after !== before) events.push({ type: 'patron-level', buildingId, userId, level: after })
  }

  // Monuments — cumulative tier counts, incumbent keeps ties.
  const list = Object.values(s.buildings)
  const incumbents: Partial<Record<MonumentId, DistrictId | null>> = {}
  for (const m of MONUMENTS) incumbents[m.id] = state.monuments[m.id].holder
  const holders = computeMonumentHolders(list, incumbents, b.districtId)
  let monumentsMoved = 0
  for (const m of MONUMENTS) {
    const from = state.monuments[m.id].holder
    const to = holders[m.id]
    if (from === to) continue
    monumentsMoved += 1
    s.monuments = { ...s.monuments, [m.id]: { holder: to, sinceClock: s.clock } }
    const hist = s.monumentHistory[m.id].map((h) => (h.toClock === null ? { ...h, toClock: s.clock } : h))
    if (to) hist.push({ holder: to, fromClock: s.clock, toClock: null, byUserId: userId, byBuildingId: buildingId })
    s.monumentHistory = { ...s.monumentHistory, [m.id]: hist }
    events.push({ type: 'monument-transfer', monumentId: m.id, from, to, byUserId: userId, buildingId })
  }
  if (monumentsMoved > 0 && tierCrossed) bumpCounter(s, userId, 'kingmakerCount', monumentsMoved)

  // Capital — weighted cumulative tier score, prestige only.
  const cap = capitalHolder(list, state.capital.holder, b.districtId)
  if (cap !== state.capital.holder) {
    s.capital = { holder: cap, sinceClock: s.clock }
    s.capitalHistory = s.capitalHistory.map((h) => (h.toClock === null ? { ...h, toClock: s.clock } : h))
    if (cap) s.capitalHistory.push({ holder: cap, fromClock: s.clock, toClock: null, byUserId: userId, byBuildingId: buildingId })
    events.push({ type: 'capital-change', from: state.capital.holder, to: cap, byUserId: userId })
    bumpCounter(s, userId, 'capitalCaptures')
    const citizens = new Set(list.filter((x) => x.districtId === cap).map((x) => x.ownerId))
    for (const c of [...citizens].sort()) bumpCounter(s, c, 'capitalReigns')
  }

  // City Crown — tallest building, individual competition.
  const crown = tallestBuilding(list, state.crown.holder)
  if (crown !== state.crown.holder) {
    s.crown = { holder: crown, sinceClock: s.clock }
    s.crownHistory = s.crownHistory.map((h) => (h.toClock === null ? { ...h, toClock: s.clock } : h))
    if (crown) {
      s.crownHistory.push({ holder: crown, fromClock: s.clock, toClock: null, byUserId: userId, byBuildingId: buildingId })
      bumpCounter(s, s.buildings[crown].ownerId, 'crownedCount')
    }
    events.push({ type: 'crown-transfer', from: state.crown.holder, to: crown, byUserId: userId })
  }

  // Seasonal layer: activity is tracked separately from permanent progress.
  s.season = recordSeasonActivity(state.season, buildingId, userId, amount, Math.max(0, toTier - fromTier))

  const badgeResult = evaluateAllBadges(s)
  s.badges = badgeResult.badges
  events.push(...badgeResult.events)

  const radio = radioFromEvents(s, events)
  const alerts = criticalAlerts(s)
  s.alertKeys = [...s.alertKeys, ...alerts.keys]
  s.radio = appendRadio(s.radio, [...radio, ...alerts.entries])

  return { state: s, events }
}

/** Radio alerts for buildings within a critical distance of a tier that changes the map. */
export function criticalAlerts(state: GameState) {
  const entries = []
  const keys: string[] = []
  for (const b of Object.values(state.buildings).sort((x, y) => x.id.localeCompare(y.id))) {
    const total = totalBuilt(b)
    const need = rfToNextTier(total)
    if (need === null) continue
    const tier = tierFor(total)
    const span = tierFloor(tier + 1) - tierFloor(tier)
    if (need > span * CRITICAL_THRESHOLD_FRACTION) continue
    const key = `${b.id}:${tier + 1}`
    if (state.alertKeys.includes(key)) continue
    const p = projectImpact(state, b.id, need)
    if (impactScore(p) < 100) continue
    keys.push(key)
    entries.push(alertEntry(state, b.id, need, tier + 1, describeImpact(state, p)))
  }
  return { entries, keys }
}

/** Contribution or owner direct-build of simulated RF. */
export function contribute(state: GameState, buildingId: string, userId: string, amount: number): ActionResult {
  return applyBuildRF(state, { buildingId, userId, amount })
}

/**
 * Owner fixture purchase. Customization is construction: the price flows into
 * Owner Build and Total Build through the same path as a direct build.
 */
export function purchaseFixture(state: GameState, buildingId: string, userId: string, fixtureId: FixtureId): ActionResult {
  const b = state.buildings[buildingId]
  if (!b) return fail(state, 'Unknown building')
  if (b.ownerId !== userId) return fail(state, 'Only the owner can buy fixtures')
  const def = getFixture(fixtureId)
  if (tierFor(totalBuilt(b)) < def.minTier) return fail(state, `Requires Tier ${def.minTier}`)
  if (!def.repeatable && b.fixtures.includes(fixtureId)) return fail(state, 'Already installed')
  return applyBuildRF(state, {
    buildingId,
    userId,
    amount: def.price,
    extraEvents: [{ type: 'fixture', buildingId, fixtureId }],
    mutate: (nb) => {
      if (def.kind === 'landscape') {
        const kind = fixtureId as LandscapeKind
        const cap = landscapeCapacity(nb.ownerBuilt)
        const slots = [...nb.landscapeSlots]
        const empty = slots.findIndex((x, i) => x === null && i < cap)
        if (empty >= 0) slots[empty] = kind
        else nb.landscapeInventory = { ...nb.landscapeInventory, [kind]: (nb.landscapeInventory[kind] ?? 0) + 1 }
        nb.landscapeSlots = slots
      } else {
        nb.fixtures = [...nb.fixtures, fixtureId]
      }
    },
  })
}

function ownerEdit(state: GameState, buildingId: string, userId: string, edit: (b: Building) => string | void): ActionResult {
  const prev = state.buildings[buildingId]
  if (!prev) return fail(state, 'Unknown building')
  if (prev.ownerId !== userId) return fail(state, 'Only the owner can change this building')
  const b: Building = { ...prev }
  const err = edit(b)
  if (err) return fail(state, err)
  return { state: { ...state, clock: state.clock + 1, buildings: { ...state.buildings, [buildingId]: b } }, events: [] }
}

export function setArchitecture(state: GameState, buildingId: string, userId: string, slot: ArchitectureSlot, optionId: string): ActionResult {
  return ownerEdit(state, buildingId, userId, (b) => {
    const check = optionUnlocked(b, slot, optionId)
    if (!check.ok) return check.reason
    b.architecture = { ...b.architecture, [slot]: optionId }
  })
}

/** Place an inventory item into a slot (or clear with null). Occupied items return to inventory. */
export function placeLandscape(state: GameState, buildingId: string, userId: string, slot: number, kind: LandscapeKind | null): ActionResult {
  return ownerEdit(state, buildingId, userId, (b) => {
    if (slot < 0 || slot >= landscapeCapacity(b.ownerBuilt)) return 'Slot locked'
    if (kind && !LANDSCAPE_KINDS.includes(kind)) return 'Unknown item'
    if (kind && (b.landscapeInventory[kind] ?? 0) < 1) return 'None in inventory'
    const slots = [...b.landscapeSlots]
    const inv = { ...b.landscapeInventory }
    const current = slots[slot]
    if (current) inv[current] = (inv[current] ?? 0) + 1
    if (kind) inv[kind] = (inv[kind] ?? 0) - 1
    slots[slot] = kind
    b.landscapeSlots = slots
    b.landscapeInventory = inv
  })
}

export function swapLandscape(state: GameState, buildingId: string, userId: string, a: number, z: number): ActionResult {
  return ownerEdit(state, buildingId, userId, (b) => {
    const cap = landscapeCapacity(b.ownerBuilt)
    if (a < 0 || z < 0 || a >= cap || z >= cap || a >= LANDSCAPE_MAX_SLOTS || z >= LANDSCAPE_MAX_SLOTS) return 'Slot locked'
    const slots = [...b.landscapeSlots]
    ;[slots[a], slots[z]] = [slots[z], slots[a]]
    b.landscapeSlots = slots
  })
}

export function setBillboardImage(state: GameState, buildingId: string, userId: string, image: string | null): ActionResult {
  return ownerEdit(state, buildingId, userId, (b) => {
    if (!b.fixtures.includes('billboard')) return 'Billboard fixture not installed'
    if (image !== null && !/^data:image\/(jpeg|png|webp);base64,/.test(image)) return 'Unsupported image'
    b.billboard = { image, updatedClock: state.clock + 1 }
  })
}

export function rally(state: GameState, buildingId: string, userId: string): ActionResult {
  const b = state.buildings[buildingId]
  if (!b) return fail(state, 'Unknown building')
  const total = totalBuilt(b)
  const need = rfToNextTier(total)
  const lines = need === null ? [] : describeImpact(state, projectImpact(state, buildingId, need))
  const s = { ...state, clock: state.clock + 1 }
  s.radio = appendRadio(state.radio, [rallyEntry(s, buildingId, userId, need, need === null ? null : tierFor(total) + 1, lines)])
  return { state: s, events: [] }
}

export function claimFaucet(state: GameState, userId: string): ActionResult {
  if (state.wallets[userId] === undefined) return fail(state, 'No simulated wallet')
  return {
    state: { ...state, clock: state.clock + 1, wallets: { ...state.wallets, [userId]: state.wallets[userId] + DEMO_FAUCET_AMOUNT } },
    events: [],
  }
}

/**
 * Deterministic rival turn: a district other than the player's funds its most
 * impactful near-tier building (preferring monument/Capital swings, then closeness).
 */
export function rivalTurn(state: GameState, playerId: string): ActionResult {
  const playerDistricts = new Set(Object.values(state.buildings).filter((b) => b.ownerId === playerId).map((b) => b.districtId))
  const candidates = Object.values(state.buildings)
    .filter((b) => !playerDistricts.has(b.districtId) && b.ownerId !== playerId)
    .map((b) => {
      const need = rfToNextTier(totalBuilt(b))
      return { b, need, score: need === null ? -1 : impactScore(projectImpact(state, b.id, need)) }
    })
    .filter((c) => c.need !== null && c.need <= 6_000)
    .sort((x, y) => y.score - x.score || (x.need ?? 0) - (y.need ?? 0) || x.b.id.localeCompare(y.b.id))
  const pick = candidates[0]
  if (!pick || pick.need === null) return fail(state, 'Rivals are regrouping')
  const donor = Object.values(state.buildings)
    .filter((x) => x.districtId === pick.b.districtId && x.ownerId !== pick.b.ownerId && x.ownerId !== playerId)
    .map((x) => x.ownerId)
    .sort()[0] ?? pick.b.ownerId
  return applyBuildRF(state, { buildingId: pick.b.id, userId: donor, amount: pick.need })
}

/**
 * A Friend becomes active in Generations City: it receives the next free plot in its
 * district, opening a new outer ward when every open plot is taken. In production the
 * Friend ID and district would come from the identity adapter; the demo simulates them.
 */
export function joinCity(state: GameState, districtId: DistrictId): ActionResult {
  const alloc = allocatePlot(state, districtId)
  if (!alloc) return fail(state, 'This district has reached the demo expansion limit')
  const seq = state.residentSeq + 1
  const friendId = 20_000 + seq
  const userId = `resident-${seq}`
  const s: GameState = {
    ...state,
    clock: state.clock + 1,
    residentSeq: seq,
    wards: alloc.wards,
    users: { ...state.users, [userId]: { id: userId, handle: `resident${seq}`, friendId, hue: (seq * 67) % 360 } },
    counters: { ...state.counters, [userId]: { ...EMPTY_COUNTERS } },
    badges: { ...state.badges, [userId]: [] },
  }
  const b = newBuilding({ friendId, ownerId: userId, address: alloc.address, clock: s.clock })
  s.buildings = { ...state.buildings, [b.id]: b }
  // Late joiners are welcome mid-season; their first Friend becomes their Representative.
  s.season = {
    ...state.season,
    joinedClock: { ...state.season.joinedClock, [userId]: s.clock },
    representatives: { ...state.season.representatives, [userId]: { buildingId: b.id, districtId, chosenClock: s.clock } },
  }
  const events: GameEvent[] = []
  if (alloc.openedWard) events.push({ type: 'ward-opened', districtId, ward: alloc.address.ward })
  events.push({ type: 'resident-joined', buildingId: b.id, districtId, ward: alloc.address.ward, plot: alloc.address.plot })
  s.radio = appendRadio(state.radio, radioFromEvents(s, events))
  return { state: s, events }
}

/** SEARCH: resolve a Friend ID to its property, however large the city becomes. */
export function findBuildingByFriend(state: GameState, friendId: number): Building | null {
  for (const b of Object.values(state.buildings)) if (b.friendId === friendId) return b
  return null
}
