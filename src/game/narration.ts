import { getBadge, BADGE_LEVEL_NAMES } from '../config/badges'
import { getDistrict, type DistrictId } from '../config/districts'
import { friendLabel } from '../config/identity'
import { getMonument } from '../config/monuments'
import { PATRON_LEVELS } from '../config/economy'
import { formatRF, heightMeters, totalBuilt } from './economy'
import type { GameEvent, GameState, RadioEntry } from './types'
import { wardName } from './allocation'
import type { ImpactProjection } from './projection'

export function handleOf(state: GameState, userId: string | null): string {
  if (!userId) return 'the founders'
  return state.users[userId] ? `@${state.users[userId].handle}` : `@${userId}`
}

/** Official family name for running text ("Sparkling → Family"). */
export function districtName(id: DistrictId | null): string {
  return id ? getDistrict(id).name : 'no district'
}

/** Signage form for headlines ("FAMILY DISTRICT IS THE NEW CAPITAL"). */
export function districtTitle(id: DistrictId | null): string {
  return id ? getDistrict(id).title : 'no district'
}

export function buildingLabel(state: GameState, buildingId: string | null): string {
  if (!buildingId) return 'no building'
  const b = state.buildings[buildingId]
  return b ? friendLabel(b.friendId) : buildingId
}

export function badgeLabel(badgeId: string, level: number): string {
  const def = getBadge(badgeId)
  if (!def) return badgeId
  return def.thresholds.length > 1 ? `${def.name} · ${BADGE_LEVEL_NAMES[level - 1]}` : def.name
}

/** Human-readable strategic consequence lines for a projection. */
export function describeImpact(state: GameState, p: ImpactProjection): string[] {
  const lines: string[] = []
  const district = state.buildings[p.buildingId].districtId
  for (const c of p.monumentChanges) {
    const m = getMonument(c.monumentId)
    if (c.to === district)
      lines.push(c.from ? `Captures ${m.name} from ${districtName(c.from)}.` : `Claims the unclaimed ${m.name}.`)
    else lines.push(`${m.name} moves to ${districtName(c.to)}.`)
  }
  for (const t of p.monumentTies) lines.push(`Ties ${districtName(t.holder)} for ${getMonument(t.monumentId).name}.`)
  if (p.capitalChange) lines.push(`${districtName(p.capitalChange.to)} becomes the Capital.`)
  if (p.capitalTie) lines.push(`Ties ${districtName(p.capitalTie)} for the Capital.`)
  if (p.crownChange) lines.push(`Takes the City Crown as the tallest building.`)
  return lines
}

/** Ids are assigned when entries are appended to state (see `appendRadio`). */
function entry(state: GameState, e: Omit<RadioEntry, 'id' | 'clock'>): RadioEntry {
  return { id: '', clock: state.clock, ...e }
}

export const RADIO_LIMIT = 80

const RADIO_PRIORITY: Record<RadioEntry['kind'], number> = {
  capital: 0,
  monument: 1,
  growth: 2,
  crown: 2,
  'tier-up': 3,
  patron: 4,
  rally: 5,
  alert: 6,
  system: 7,
}

/** Newest batch goes on top, ordered by importance within the batch. */
export function appendRadio(radio: RadioEntry[], entries: RadioEntry[]): RadioEntry[] {
  const stamped = entries
    .map((e, i) => ({ ...e, id: `r${e.clock}-${i}-${e.kind}` }))
    .sort((a, b) => RADIO_PRIORITY[a.kind] - RADIO_PRIORITY[b.kind])
  return [...stamped, ...radio].slice(0, RADIO_LIMIT)
}

/** Convert game events into District Radio broadcasts. Personal events stay out of radio. */
export function radioFromEvents(state: GameState, events: GameEvent[]): RadioEntry[] {
  const out: RadioEntry[] = []
  for (const e of events) {
    if (e.type === 'tier-up') {
      const b = state.buildings[e.buildingId]
      const closer = e.byUserId !== b.ownerId
      out.push(
        entry(state, {
          kind: 'tier-up',
          headline: `${friendLabel(b.friendId)} reached Tier ${e.toTier}`,
          detail: closer
            ? `Closed by ${handleOf(state, e.byUserId)} · ${districtName(b.districtId)}`
            : `Built by owner ${handleOf(state, b.ownerId)} · ${districtName(b.districtId)}`,
          districtId: b.districtId,
          buildingId: b.id,
        }),
      )
    } else if (e.type === 'monument-transfer') {
      const m = getMonument(e.monumentId)
      out.push(
        entry(state, {
          kind: 'monument',
          headline: e.from ? `${m.name} STOLEN` : `${m.name} CLAIMED`,
          detail: e.from
            ? `${districtName(e.to)} takes it from ${districtName(e.from)} · Kingmaker ${handleOf(state, e.byUserId)}`
            : `The ${districtTitle(e.to)} raises the first ${m.short} · ${handleOf(state, e.byUserId)}`,
          districtId: e.to,
          buildingId: e.buildingId,
        }),
      )
    } else if (e.type === 'capital-change') {
      out.push(
        entry(state, {
          kind: 'capital',
          headline: `${districtTitle(e.to).toUpperCase()} IS THE NEW CAPITAL`,
          detail: `${districtName(e.to)} overtakes ${districtName(e.from)} for City Hall · sparked by ${handleOf(state, e.byUserId)}`,
          districtId: e.to,
          buildingId: null,
        }),
      )
    } else if (e.type === 'crown-transfer') {
      const b = e.to ? state.buildings[e.to] : null
      out.push(
        entry(state, {
          kind: 'crown',
          headline: `CITY CROWN → ${buildingLabel(state, e.to)}`,
          detail: b
            ? `Now the tallest building in Generations City at ${heightMeters(totalBuilt(b))} m · owner ${handleOf(state, b.ownerId)}`
            : 'The Crown is vacant.',
          districtId: b?.districtId ?? null,
          buildingId: e.to,
        }),
      )
    } else if (e.type === 'ward-opened') {
      out.push(
        entry(state, {
          kind: 'growth',
          headline: `${districtTitle(e.districtId).toUpperCase()} OPENS ${wardName(e.ward).toUpperCase()}`,
          detail: 'Every open plot was taken, so the district expands outward. The city grows with its community.',
          districtId: e.districtId,
          buildingId: null,
        }),
      )
    } else if (e.type === 'resident-joined') {
      const b = state.buildings[e.buildingId]
      out.push(
        entry(state, {
          kind: 'growth',
          headline: `${friendLabel(b.friendId)} moved in`,
          detail: `New property in ${districtName(e.districtId)} · ${wardName(e.ward)}, plot ${e.plot + 1} · ${handleOf(state, b.ownerId)}`,
          districtId: e.districtId,
          buildingId: e.buildingId,
        }),
      )
    } else if (e.type === 'patron-level') {
      const lvl = PATRON_LEVELS.find((l) => l.id === e.level)
      if (!lvl || lvl.min < 2_500) continue
      const b = state.buildings[e.buildingId]
      out.push(
        entry(state, {
          kind: 'patron',
          headline: `${handleOf(state, e.userId)} earned a ${lvl.label}`,
          detail: `on ${friendLabel(b.friendId)} · ${districtName(b.districtId)}`,
          districtId: b.districtId,
          buildingId: b.id,
        }),
      )
    }
  }
  return out
}

export function alertEntry(state: GameState, buildingId: string, need: number, nextTier: number, lines: string[]): RadioEntry {
  const b = state.buildings[buildingId]
  return entry(state, {
    kind: 'alert',
    headline: `${friendLabel(b.friendId)} is ${formatRF(need)} RF from Tier ${nextTier}`,
    detail: lines[0] ?? 'Critical threshold in reach.',
    districtId: b.districtId,
    buildingId,
  })
}

export function rallyEntry(state: GameState, buildingId: string, userId: string, need: number | null, nextTier: number | null, lines: string[]): RadioEntry {
  const b = state.buildings[buildingId]
  return entry(state, {
    kind: 'rally',
    headline: `RALLY ${friendLabel(b.friendId).toUpperCase()}`,
    detail:
      need === null
        ? `${handleOf(state, userId)} rallies support for a Tier 6 landmark.`
        : `${formatRF(need)} RF needed for Tier ${nextTier}. ${lines[0] ?? 'Every RF raises the skyline.'} — ${handleOf(state, userId)}`,
    districtId: b.districtId,
    buildingId,
  })
}
