import { describe, expect, it } from 'vitest'
import type { ConstructionOutcome } from './construction'
import { pressBook, settlementOf } from './constructionPress'

/** A browser storage: what a reload of the page reads again. */
function storage(seed: Record<string, string> = {}) {
  const items = new Map(Object.entries(seed))
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), items }
}
let ids = 0
const newId = () => `0190aaaa-0000-4000-8000-${String(++ids).padStart(12, '0')}`
const ADA = { worldId: 'w-ada-1', discordUserId: '111111111111111111' }
const P1 = '0190aaaa-0000-8000-8000-000000000001'
const P2 = '0190aaaa-0000-8000-8000-000000000002'
const refused = (code: string | null): ConstructionOutcome => ({ ok: false, problem: { message: 'x', kind: 'retry', code } })

describe('a construction press, kept until its answer is known (independent audit M1)', () => {
  it('only a construction, or a refusal decided after no construction was found under the id, settles a press; action_conflict ends it apart', () => {
    const built = { ok: true, fresh: false, construction: {} as never, view: null } as ConstructionOutcome
    expect(settlementOf(built)).toBe('settled')
    for (const code of ['insufficient_test_credits', 'construction_complete', 'not_current_controller', 'control_unverified', 'controller_builds_as_owner', 'unknown_property']) expect(settlementOf(refused(code))).toBe('settled')
    expect(settlementOf(refused('action_conflict'))).toBe('conflict')
    // A lost or unreadable answer, a 503 of any kind, a session that must be checked again: not known.
    for (const code of [null, 'construction_unconfirmed', 'play_session_unavailable', 'world_unavailable', 'installation_unverified', 'rate_limited', 'sequence_conflict', 'play_session_required', 'play_actor_mismatch', 'invalid_request', 'mutations_held', 'construction_not_open'])
      expect(settlementOf(refused(code))).toBe('unknown')
  })

  it('an unresolved press is sent again exactly as first sent, whatever is pressed next; a settled one frees a new id', () => {
    const book = pressBook({ ...ADA, worldId: 'w-ada-2' }, storage(), newId)
    expect(book.unresolved()).toBeNull()
    const first = book.next(P1, 'owner')
    expect(book.unresolved()).toEqual(first)
    // Two rapid presses, another role, another property: all the same request.
    expect(book.next(P1, 'owner')).toEqual(first)
    expect(book.next(P1, 'patron')).toEqual(first)
    expect(book.next(P2, 'patron')).toEqual(first)
    book.settle(first)
    expect(book.unresolved()).toBeNull()
    const second = book.next(P2, 'patron')
    expect(second.actionId).not.toBe(first.actionId)
    expect(second).toMatchObject({ propertyId: P2, role: 'patron' })
  })

  it('is kept across a reload (and a relaunch: a new session of the same player), and never for another player or world', () => {
    const kept = storage()
    const press = pressBook({ ...ADA, worldId: 'w-ada-3' }, kept, newId).next(P1, 'owner')
    // The page loaded again: a new book on the same storage.
    expect(pressBook({ ...ADA, worldId: 'w-ada-3' }, kept, newId).unresolved()).toEqual(press)
    expect(pressBook({ worldId: 'w-ada-3', discordUserId: '222222222222222222' }, kept, newId).unresolved()).toBeNull()
    expect(pressBook({ ...ADA, worldId: 'w-other' }, kept, newId).unresolved()).toBeNull()
    // Bea's own press in the same browser gets its own id; Ada's stays.
    const bea = pressBook({ worldId: 'w-ada-3', discordUserId: '222222222222222222' }, kept, newId).next(P1, 'patron')
    expect(bea.actionId).not.toBe(press.actionId)
    expect(pressBook({ ...ADA, worldId: 'w-ada-3' }, kept, newId).unresolved()).toEqual(press)
  })

  it('without storage (a private window, blocked site data) the page still keeps it; a stored entry that is not a press is ignored', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    const book = pressBook({ ...ADA, worldId: 'w-ada-4' }, broken, newId)
    const press = book.next(P1, 'owner')
    expect(book.next(P1, 'owner')).toEqual(press)
    expect(pressBook({ ...ADA, worldId: 'w-ada-4' }, null, newId).unresolved()).toEqual(press)
    book.settle(press)
    expect(book.unresolved()).toBeNull()

    const junk = storage({ 'rare-city-construction-presses': JSON.stringify([{ actionId: 'not-a-uuid', worldId: 'w-ada-5', discordUserId: ADA.discordUserId, propertyId: P1, role: 'owner' }, { ...ADA, worldId: 'w-ada-5', role: 'admin' }]) })
    expect(pressBook({ ...ADA, worldId: 'w-ada-5' }, junk, newId).unresolved()).toBeNull()
    expect(pressBook({ ...ADA, worldId: 'w-ada-5' }, storage({ 'rare-city-construction-presses': '{' }), newId).unresolved()).toBeNull()
  })
})
