import type { ConstructionRole } from '../../protocol/playRehearsal'
import type { ConstructionOutcome } from './construction'

/**
 * A LOCAL TEST construction press, kept until the server's answer says what it did (P1-C2-E3A, independent audit M1).
 *
 * The server builds each press id at most once: the same id again returns the construction it made, for exactly the
 * same player, property and role, and builds nothing more. So a press whose answer is not known (never came, came back
 * as a failure that does not say whether it was written, could not be read) is sent again with the SAME id, exactly as
 * it was first sent, until the server answers it. Only an answer that settles it frees the next press to take a new id:
 *
 *   - a construction (new, or the one this press already made), or
 *   - a refusal the server decides after it found no construction under that id (no property, not the controller, the
 *     controller as a patron, the top tier, not enough credits): nothing was built by this press.
 *
 * `action_conflict` (the id names a different construction) also ends the press, and confirms nothing.
 *
 * While a press is unresolved, no other press of that player in that world gets an id: whatever is asked, the unresolved
 * one is what is sent. It is kept in this browser's storage, so a reload or a relaunch (a new session of the same player)
 * still asks about it before anything new is spent. What is kept is only which request to repeat: never a balance, a tier
 * or a result, which only the server's answer gives.
 */
export interface ConstructionPress {
  actionId: string
  worldId: string
  discordUserId: string
  propertyId: string
  role: ConstructionRole
}

/** The player and world a page acts for: a press is never sent for another. */
export interface PressOwner {
  worldId: string
  discordUserId: string
}

export type PressSettlement = 'settled' | 'conflict' | 'unknown'

/** Refusals decided after the server found no construction under the press's id, under the city's lock: this press built nothing. */
const SETTLING_REFUSALS: ReadonlySet<string> = new Set(['unknown_property', 'control_unverified', 'not_current_controller', 'controller_builds_as_owner', 'construction_complete', 'insufficient_test_credits'])

/** What an answer says about the press it answered. Anything but a construction or a settling refusal is not known. */
export function settlementOf(outcome: ConstructionOutcome): PressSettlement {
  if (outcome.ok) return 'settled'
  if (outcome.problem.code === 'action_conflict') return 'conflict'
  return outcome.problem.code !== null && SETTLING_REFUSALS.has(outcome.problem.code) ? 'settled' : 'unknown'
}

export interface PressBook {
  /** The press of this player in this world whose answer is not known, if any. */
  unresolved(): ConstructionPress | null
  /** The press to send for a build of `propertyId` as `role`: the unresolved one if there is one, exactly as first sent, else a new one, kept before it is sent. */
  next(propertyId: string, role: ConstructionRole): ConstructionPress
  /** The server's answer to `press` is known: forget it. */
  settle(press: ConstructionPress): void
}

type PressStorage = Pick<Storage, 'getItem' | 'setItem'>

const KEY = 'rare-city-construction-presses'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const isPress = (v: unknown): v is ConstructionPress => {
  const p = v as Record<string, unknown> | null
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof p.actionId === 'string' &&
    UUID.test(p.actionId) &&
    typeof p.worldId === 'string' &&
    typeof p.discordUserId === 'string' &&
    typeof p.propertyId === 'string' &&
    (p.role === 'owner' || p.role === 'patron')
  )
}
const owns = (who: PressOwner) => (p: ConstructionPress) => p.worldId === who.worldId && p.discordUserId === who.discordUserId

/** This page's presses, if storage cannot keep them (a private window, blocked site data): they last as long as the page. */
const memory: ConstructionPress[] = []

/** The presses of `who`, kept in `storage` (the browser's `localStorage` when there is one) and in this page's memory. */
export function pressBook(who: PressOwner, storage: PressStorage | null = defaultStorage(), newId: () => string = () => crypto.randomUUID()): PressBook {
  const read = (): ConstructionPress[] => {
    try {
      const kept: unknown = JSON.parse(storage?.getItem(KEY) ?? '[]')
      if (Array.isArray(kept)) return [...kept.filter(isPress), ...memory.filter((m) => !kept.some((k) => isPress(k) && k.actionId === m.actionId))]
    } catch {
      // Unreadable or unavailable: this page's own presses still count.
    }
    return [...memory]
  }
  const write = (all: ConstructionPress[]) => {
    memory.splice(0, memory.length, ...all)
    try {
      storage?.setItem(KEY, JSON.stringify(all))
    } catch {
      // Kept in memory only.
    }
  }
  const unresolved = () => read().find(owns(who)) ?? null
  return {
    unresolved,
    next(propertyId, role) {
      const held = unresolved()
      if (held) return held
      const press: ConstructionPress = { actionId: newId(), worldId: who.worldId, discordUserId: who.discordUserId, propertyId, role }
      write([...read(), press])
      return press
    },
    settle(press) {
      write(read().filter((p) => p.actionId !== press.actionId))
    },
  }
}

function defaultStorage(): PressStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
