import { BADGES } from '../config/badges'
import { DISTRICT_IDS, type DistrictId } from '../config/districts'
import { PATRON_LEVELS } from '../config/economy'
import { friendLabel } from '../config/identity'
import { getMonument, MONUMENTS, type MonumentId } from '../config/monuments'
import { contribute } from './actions'
import { capitalScore, districtTierCounts } from './competition'
import { rfToNextTier, tierFloor, tierFor, totalBuilt } from './economy'
import { badgeLabel, districtName } from './narration'
import { capitalGain, projectImpact } from './projection'
import { homeDistrict } from './season'
import type { GameEvent, GameState } from './types'

/**
 * DISTRICT RADIO · RALLY CALLS
 *
 * Derived, never persisted: a short personalised list of where the player's RF matters
 * right now. Candidates come from the existing projection/Capital maths; every shortlisted
 * spend is then run through the real pure `contribute()` so each card's monument / Capital /
 * Crown / badge claims are exactly what that spend would do. Nothing here changes rules.
 */
export type RallyKind = 'monument' | 'monument-defense' | 'capital' | 'capital-defense' | 'crown' | 'badge' | 'near-tier'

export interface RallyCall {
  id: string
  kind: RallyKind
  /** Small category tag shown on the card. */
  label: 'MONUMENT' | 'CAPITAL' | 'CROWN' | 'BADGE' | 'NEAR TIER'
  headline: string
  reason: string
  /** Badges (with level) the player would earn/upgrade with exactly this spend. */
  badges: string[]
  buildingId: string
  friendId: number
  districtId: DistrictId
  rfNeeded: number
  targetTier: number
  /** Building is in the player's season Home District (or owned by the player). */
  home: boolean
}

/** Rank order (lower = higher priority). */
const RANK: Record<RallyKind, number> = {
  monument: 0,
  'monument-defense': 1,
  capital: 2,
  'capital-defense': 3,
  crown: 4,
  badge: 5,
  'near-tier': 6,
}
const LABEL: Record<RallyKind, RallyCall['label']> = {
  monument: 'MONUMENT',
  'monument-defense': 'MONUMENT',
  capital: 'CAPITAL',
  'capital-defense': 'CAPITAL',
  crown: 'CROWN',
  badge: 'BADGE',
  'near-tier': 'NEAR TIER',
}
const STRATEGIC = new Set<RallyKind>(['monument', 'monument-defense', 'capital', 'capital-defense', 'crown'])

export const RALLY_LIMITS = {
  /** Hard cap on cards. */
  max: 4,
  /** Filler (badge / near-tier) cards only top the list up to this many. */
  fillTo: 3,
  /** Defensive moves and Crown bids are only suggested within this budget. */
  defenseMaxRF: 2_500,
  crownMaxRF: 5_000,
  /** Near-tier: within 10% of the tier span, capped. */
  nearFraction: 0.1,
  nearMaxRF: 250,
  /** Capital lead considered under threat (one Tier 4 crossing is worth 20 points). */
  capitalThreatLead: 20,
} as const

const BADGE_ORDER = ['prestige', 'strategy', 'architect', 'patron']

function nearLimit(tier: number): number {
  const span = tierFloor(tier + 1) - tierFloor(tier)
  return Math.max(10, Math.min(RALLY_LIMITS.nearMaxRF, span * RALLY_LIMITS.nearFraction))
}

interface Candidate {
  buildingId: string
  amount: number
  /** Set when this spend is suggested to protect a Home District monument. */
  defends?: { monumentId: MonumentId; rival: DistrictId }
  /** Set when this spend is suggested to protect the Home District's Capital lead. */
  capitalDefense?: { rival: DistrictId; lead: number; points: number }
}

function list(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

export function radioDispatches(state: GameState, playerId: string): RallyCall[] {
  const home = homeDistrict(state, playerId)
  const wallet = state.wallets[playerId] ?? Number.POSITIVE_INFINITY
  const buildings = Object.values(state.buildings).sort((a, b) => a.id.localeCompare(b.id))
  // Personalised: Home District buildings plus the player's own property.
  const relevant = buildings.filter((b) => !home || b.districtId === home || b.ownerId === playerId)
  const counts = districtTierCounts(buildings)
  const candidates = new Map<string, Candidate>()
  const add = (c: Candidate) => {
    if (c.amount < 1 || c.amount > wallet) return
    const prev = candidates.get(c.buildingId)
    // Keep one spend per building: prefer the defensive framing, else the cheaper spend.
    if (!prev || (c.defends && !prev.defends) || (c.capitalDefense && !prev.capitalDefense && !prev.defends)) candidates.set(c.buildingId, c)
  }

  // 1. Next-tier spends that change the map (projection), or that are genuinely close.
  const near: Candidate[] = []
  for (const b of relevant) {
    const total = totalBuilt(b)
    const need = rfToNextTier(total)
    if (need === null || need > wallet) continue
    const p = projectImpact(state, b.id, need)
    // Map-changing moves only count for the Home District (never hand a rival a monument/Capital).
    const forHome = !home || b.districtId === home
    const strategic = (forHome && (p.monumentChanges.some((c) => c.to === b.districtId) || p.capitalChange?.to === b.districtId)) || (b.ownerId === playerId && !!p.crownChange)
    if (strategic) add({ buildingId: b.id, amount: need })
    else if (need <= nearLimit(tierFor(total))) near.push({ buildingId: b.id, amount: need })
  }
  near.sort((a, b) => a.amount - b.amount || a.buildingId.localeCompare(b.buildingId)).slice(0, 8).forEach(add)

  if (home) {
    const homeBuildings = relevant.filter((b) => b.districtId === home)
    // 2. Monument defense: a Home monument a rival can tie or take with one tier-up.
    for (const m of MONUMENTS) {
      if (state.monuments[m.id].holder !== home) continue
      const rival = DISTRICT_IDS.filter((d) => d !== home).sort((a, z) => counts[z][m.tier] - counts[a][m.tier] || DISTRICT_IDS.indexOf(a) - DISTRICT_IDS.indexOf(z))[0]
      if (counts[rival][m.tier] + 1 < counts[home][m.tier]) continue
      const best = homeBuildings
        .filter((b) => tierFor(totalBuilt(b)) < m.tier)
        .map((b) => ({ b, need: tierFloor(m.tier) - totalBuilt(b) }))
        .sort((a, z) => a.need - z.need)[0]
      if (best && best.need <= RALLY_LIMITS.defenseMaxRF) add({ buildingId: best.b.id, amount: best.need, defends: { monumentId: m.id, rival } })
    }
    // 3. Capital defense: best Capital points per RF when the lead is within one big tier-up.
    if (state.capital.holder === home) {
      const scores = Object.fromEntries(DISTRICT_IDS.map((d) => [d, capitalScore(counts[d])])) as Record<DistrictId, number>
      const rival = DISTRICT_IDS.filter((d) => d !== home).sort((a, z) => scores[z] - scores[a])[0]
      const lead = scores[home] - scores[rival]
      if (lead <= RALLY_LIMITS.capitalThreatLead) {
        const best = homeBuildings
          .map((b) => {
            const t = tierFor(totalBuilt(b))
            const need = rfToNextTier(totalBuilt(b))
            return need === null ? null : { b, need, points: capitalGain(t, t + 1) }
          })
          .filter((x): x is NonNullable<typeof x> => !!x && x.need <= RALLY_LIMITS.defenseMaxRF)
          .sort((a, z) => z.points / z.need - a.points / a.need || a.need - z.need)[0]
        if (best) add({ buildingId: best.b.id, amount: best.need, capitalDefense: { rival, lead, points: best.points } })
      }
    }
  }

  // 4. Crown: one of the player's own buildings within reach of the tallest.
  const crownId = state.crown.holder
  if (crownId) {
    const crownTotal = totalBuilt(state.buildings[crownId])
    for (const b of relevant.filter((x) => x.ownerId === playerId && x.id !== crownId)) {
      const need = crownTotal - totalBuilt(b) + 1
      if (need <= RALLY_LIMITS.crownMaxRF) add({ buildingId: b.id, amount: need })
    }
  }

  // Simulate each shortlisted spend through the real action path and read its outcomes.
  const calls: Described[] = []
  for (const c of candidates.values()) {
    const r = contribute(state, c.buildingId, playerId, c.amount)
    if (r.error) continue
    const call = describe(state, playerId, home, c, r.events)
    if (call) calls.push(call)
  }
  calls.sort(
    (a, b) =>
      RANK[a.kind] - RANK[b.kind] ||
      Number(b.home) - Number(a.home) ||
      // Capital routes rank by Capital points per RF (as the Build Board does); others by RF.
      b.capitalPoints / b.rfNeeded - a.capitalPoints / a.rfNeeded ||
      a.rfNeeded - b.rfNeeded ||
      b.badges.length - a.badges.length ||
      a.buildingId.localeCompare(b.buildingId),
  )
  // One card per objective (e.g. a single "TAKE THE CAPITAL"): the cheapest route wins.
  const seen = new Set<string>()
  const unique = calls.filter((c) => {
    const key = STRATEGIC.has(c.kind) ? c.objective : `building:${c.buildingId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const strategic = unique.filter((c) => STRATEGIC.has(c.kind)).slice(0, RALLY_LIMITS.max)
  const filler = unique.filter((c) => !STRATEGIC.has(c.kind) && !strategic.some((s) => s.buildingId === c.buildingId)).slice(0, Math.max(0, RALLY_LIMITS.fillTo - strategic.length))
  return [...strategic, ...filler].map((d): RallyCall => {
    const call: Partial<Described> = { ...d }
    delete call.objective
    delete call.capitalPoints
    return call as RallyCall
  })
}

/** Internal: a call plus its dedupe objective and Capital points (for ranking Capital routes). */
type Described = RallyCall & { objective: string; capitalPoints: number }

function describe(state: GameState, playerId: string, home: DistrictId | null, c: Candidate, events: GameEvent[]): Described | null {
  const b = state.buildings[c.buildingId]
  const own = b.ownerId === playerId
  const name = own ? `Your #${b.friendId}` : friendLabel(b.friendId)
  const total = totalBuilt(b)
  const targetTier = tierFor(total + c.amount)
  const captures = events.flatMap((e) => (e.type === 'monument-transfer' && e.to === b.districtId ? [e] : []))
  const capital = events.find((e) => e.type === 'capital-change' && e.to === b.districtId)
  const crown = events.some((e) => e.type === 'crown-transfer' && e.to === b.id) && own
  // A spend that would move a monument or the Capital to a rival district is never suggested.
  if (home && b.districtId !== home && (captures.length || capital)) return null
  const badges = events
    .flatMap((e) => (e.type === 'badge' && e.userId === playerId ? [e] : []))
    .sort((x, y) => BADGE_ORDER.indexOf(BADGES.find((d) => d.id === x.badgeId)?.category ?? '') - BADGE_ORDER.indexOf(BADGES.find((d) => d.id === y.badgeId)?.category ?? ''))
    .map((e) => badgeLabel(e.badgeId, e.level))
  const patron = events.flatMap((e) => (e.type === 'patron-level' && e.userId === playerId ? [PATRON_LEVELS.find((l) => l.id === e.level)] : []))[0]
  const district = districtName(b.districtId)
  const step = `${name} is ${c.amount.toLocaleString('en-US')} RF from Tier ${targetTier}.`

  const extras: string[] = []
  let kind: RallyKind
  let objective = `building:${b.id}`
  let headline: string
  let reason: string
  if (captures.length) {
    kind = 'monument'
    const m = getMonument(captures[0].monumentId)
    objective = `monument:${m.id}`
    headline = `TAKE ${m.name.toUpperCase()}`
    reason = `${step} Tiering it up ${captures[0].from ? `captures ${m.name} from ${districtName(captures[0].from)}` : `claims the unclaimed ${m.name}`}.`
    if (captures.length > 1) extras.push(`Also moves ${list(captures.slice(1).map((x) => getMonument(x.monumentId).name))}.`)
    if (capital) extras.push(`Also makes ${district} the Capital.`)
    if (crown) extras.push('Also takes the City Crown.')
  } else if (c.defends) {
    kind = 'monument-defense'
    const m = getMonument(c.defends.monumentId)
    objective = `defend:${m.id}`
    headline = `DEFEND ${m.name.toUpperCase()}`
    reason = `${districtName(c.defends.rival)} is one tier-up from tying ${district} for ${m.name}. ${name} reaching Tier ${m.tier} (${c.amount.toLocaleString('en-US')} RF) widens the lead.`
  } else if (capital) {
    kind = 'capital'
    objective = 'capital'
    headline = 'TAKE THE CAPITAL'
    reason = `${name} needs ${c.amount.toLocaleString('en-US')} RF to Tier ${targetTier}. That move makes ${district} the Capital.`
    if (crown) extras.push('Also takes the City Crown.')
  } else if (c.capitalDefense) {
    kind = 'capital-defense'
    const { rival, lead, points } = c.capitalDefense
    objective = 'capital'
    headline = 'DEFEND THE CAPITAL'
    reason = `${step} It adds ${points} Capital points: ${district}'s lead over ${districtName(rival)} grows from ${lead} to ${lead + points}.`
  } else if (crown) {
    kind = 'crown'
    objective = 'crown'
    headline = 'TAKE THE CROWN'
    reason = `${name} is ${c.amount.toLocaleString('en-US')} RF from becoming the tallest building in Rare City.`
  } else if (badges.length) {
    kind = 'badge'
    headline = `EARN ${badges[0].toUpperCase()}`
    reason = step
  } else {
    kind = 'near-tier'
    headline = `${c.amount.toLocaleString('en-US')} RF TO TIER ${targetTier}`
    reason = `${name} is almost there.`
  }
  if (patron && patron.min >= 100) extras.push(`Earns your ${patron.label} on this building.`)
  const isCapital = kind === 'capital' || kind === 'capital-defense'
  return {
    objective,
    capitalPoints: isCapital ? capitalGain(tierFor(total), targetTier) : 0,
    id: `${kind}:${b.id}`,
    kind,
    label: LABEL[kind],
    headline,
    reason: [reason, ...extras].join(' '),
    badges,
    buildingId: b.id,
    friendId: b.friendId,
    districtId: b.districtId,
    rfNeeded: c.amount,
    targetTier,
    home: b.districtId === home || b.ownerId === playerId,
  }
}
