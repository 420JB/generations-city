import type { PressOwner } from './constructionPress'

/**
 * An Architect design SAVE, kept until the server's answer says what it did (P1-C2-E4A). The same rule as a construction
 * press (`constructionPress.ts`), kept apart from it, so neither book ever sends the other's request.
 *
 * The server saves each save id at most once, and only as exactly the design it was first sent with: the same id again
 * returns the design it saved, for the same player, property, catalog, choices and base revision, and saves nothing
 * more; the id with anything else is refused (`action_conflict`). So a save whose answer is not known (never came, came
 * back as a failure that does not say whether it was written, could not be read) is sent again EXACTLY AS FIRST SENT,
 * whatever the player has previewed since, until the server answers it. An uncertain answer can never make the page say
 * a design was saved, and can never apply a different design under the same id. Only an answer that settles it frees the
 * next save to take a new id:
 *
 *   - a saved design (new, or the one this save already made), or
 *   - a refusal the server decides after it found no save under that id (not a property, not the controller, nobody
 *     named, not open here, not a catalog choice, the property moved on, already that design): nothing was saved.
 *
 * `action_conflict` (the id names a different save) also ends it, and confirms nothing.
 *
 * While a save is unresolved, no other save of that player in that world gets an id. It is kept in this browser's
 * storage, so a reload or a relaunch still checks it before anything new is saved. What is kept is only which request to
 * repeat, never a result, and never a session secret.
 *
 * CATALOG VERSIONS (P1-C2-E4B, P1-C2-E4C). A save kept by an earlier page (catalog v1: a facade and a roof, no other
 * treatment; catalog v2: no entrance or landscaping) is still a save, and is sent again exactly as it was kept, with no
 * treatment added: the server answers it with its original receipt if it was recorded, and refuses it (`design_retired`,
 * settling: nothing was saved) if it never was. It never becomes a save of the current catalog.
 */
export interface DesignSave {
  actionId: string
  worldId: string
  discordUserId: string
  propertyId: string
  baseRevision: number
  catalog: string
  facade: string
  roof: string
  /** Absent only in a save an earlier page kept (catalog v1): both absent, or both present. */
  windows?: string
  lighting?: string
  /** Absent only in a save an earlier page kept (catalog v1 or v2): both absent, or both present beside windows and lighting. */
  entrance?: string
  landscaping?: string
}

export type DesignSettlement = 'settled' | 'conflict' | 'unknown'

/** Refusals decided after the server found no save under the id, under the city's lock: this save wrote nothing. */
const SETTLING_REFUSALS: ReadonlySet<string> = new Set(['unknown_property', 'not_current_controller', 'control_unverified', 'design_not_open', 'design_unsupported', 'design_retired', 'design_stale', 'design_unchanged'])

/** What an answer says about the save it answered: a design, a settling refusal, a conflict, or nothing known. */
export function designSettlementOf(outcome: { ok: true } | { ok: false; problem: { code: string | null } }): DesignSettlement {
  if (outcome.ok) return 'settled'
  if (outcome.problem.code === 'action_conflict') return 'conflict'
  return outcome.problem.code !== null && SETTLING_REFUSALS.has(outcome.problem.code) ? 'settled' : 'unknown'
}

/**
 * Refusals a design load or save shares with construction and placement, said as what happened to the DESIGN: never a
 * build, a spend or a placement. A refusal the server decided before writing may say no revision was recorded; one whose
 * outcome the page cannot know (a conflict at the same moment, a server that holds changes) never says nothing was saved,
 * and an id already recorded for another save says nothing about how that other save went.
 */
export const DESIGN_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  not_current_controller:
    'This local server’s test file does not name you as this NFT’s current controller (LOCAL TEST control, not verified by Proofy), so you are not authorized to change this property’s design. Founding a property, or contributing to it as a patron, does not grant that. No design revision was recorded.',
  control_unverified:
    'Current LOCAL TEST control of this NFT could not be established: this local server’s test file names no current controller for it, so nobody can change this property’s design. No design revision was recorded.',
  mutations_held: 'Design changes are not available in this city on this server.',
  sequence_conflict: 'Another change reached this city at the same moment. Check this save again, with the same request, before you try anything else: one save is never applied twice.',
  action_conflict:
    'This save’s id is already recorded for a different design save, so this request was not applied under it. How that other save went is not known here: check this property’s saved design and history before you save again.',
})
export interface DesignSaveBook {
  /** The save of this player in this world whose answer is not known, if any. */
  unresolved(): DesignSave | null
  /** The save to send: the unresolved one if there is one, exactly as first sent, else a new one, kept before it is sent. */
  next(request: Omit<DesignSave, 'actionId' | 'worldId' | 'discordUserId'>): DesignSave
  /** The server's answer to `save` is known: forget it. */
  settle(save: DesignSave): void
}

type SaveStorage = Pick<Storage, 'getItem' | 'setItem'>

const KEY = 'rare-city-design-saves'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const isId = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && ID.test(v)

/** Whether a kept entry is a save, strictly: everything it is resent with. Anything else in storage is not one. */
const isSave = (v: unknown): v is DesignSave => {
  const p = v as Record<string, unknown> | null
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof p.actionId === 'string' &&
    UUID.test(p.actionId) &&
    typeof p.worldId === 'string' &&
    typeof p.discordUserId === 'string' &&
    typeof p.propertyId === 'string' &&
    Number.isSafeInteger(p.baseRevision) &&
    (p.baseRevision as number) >= 0 &&
    isId(p.catalog) &&
    isId(p.facade) &&
    isId(p.roof) &&
    // Each pair of treatments, or (a save an earlier page kept) neither; never an entrance or landscaping without windows and lighting.
    ((p.windows === undefined && p.lighting === undefined && p.entrance === undefined && p.landscaping === undefined) ||
      (isId(p.windows) && isId(p.lighting) && ((p.entrance === undefined && p.landscaping === undefined) || (isId(p.entrance) && isId(p.landscaping)))))
  )
}
/** A kept save exactly as it is resent, and no other field kept: a save kept without some treatments stays without them. */
const saveOf = (p: DesignSave): DesignSave => ({
  actionId: p.actionId,
  worldId: p.worldId,
  discordUserId: p.discordUserId,
  propertyId: p.propertyId,
  baseRevision: p.baseRevision,
  catalog: p.catalog,
  facade: p.facade,
  roof: p.roof,
  ...(p.windows !== undefined && p.lighting !== undefined ? { windows: p.windows, lighting: p.lighting } : {}),
  ...(p.windows !== undefined && p.lighting !== undefined && p.entrance !== undefined && p.landscaping !== undefined ? { entrance: p.entrance, landscaping: p.landscaping } : {}),
})
const owns = (who: PressOwner) => (p: DesignSave) => p.worldId === who.worldId && p.discordUserId === who.discordUserId

/** This page's saves, if storage cannot keep them (a private window, blocked site data): they last as long as the page. */
const memory: DesignSave[] = []

/** The saves of `who`, kept in `storage` (the browser's `localStorage` when there is one) and in this page's memory. */
export function designBook(who: PressOwner, storage: SaveStorage | null = defaultStorage(), newId: () => string = () => crypto.randomUUID()): DesignSaveBook {
  const read = (): DesignSave[] => {
    try {
      const kept: unknown = JSON.parse(storage?.getItem(KEY) ?? '[]')
      if (Array.isArray(kept)) return [...kept.filter(isSave).map(saveOf), ...memory.filter((m) => !kept.some((k) => isSave(k) && k.actionId === m.actionId))]
    } catch {
      // Unreadable or unavailable: this page's own saves still count.
    }
    return [...memory]
  }
  const write = (all: DesignSave[]) => {
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
    next(request) {
      const held = unresolved()
      if (held) return held
      const save: DesignSave = saveOf({ ...request, actionId: newId(), worldId: who.worldId, discordUserId: who.discordUserId })
      write([...read(), save])
      return save
    },
    settle(save) {
      write(read().filter((p) => p.actionId !== save.actionId))
    },
  }
}

function defaultStorage(): SaveStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
