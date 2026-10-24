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

  it('keeps the intent it was made for (C2-E3B): a Tier 2 press resent later is the same press, even if the page now shows another tier', () => {
    const kept = storage()
    const book = pressBook({ ...ADA, worldId: 'w-ada-6' }, kept, newId)
    const press = book.next(P1, 'owner', { recipe: 'local-test-tier2-v1', tier: 1 })
    expect(press).toMatchObject({ propertyId: P1, role: 'owner', worldId: 'w-ada-6', discordUserId: ADA.discordUserId, intent: { recipe: 'local-test-tier2-v1', tier: 1 } })
    // The page reloaded and now draws Tier 2 (another tab finished it): the press is resent exactly, intent and id unchanged.
    const again = pressBook({ ...ADA, worldId: 'w-ada-6' }, kept, newId).next(P2, 'patron', { recipe: 'local-test-tier3-v9', tier: 2 })
    expect(again).toEqual(press)
    // What is kept is only the request to repeat and what it was for: no credential, token, balance or result.
    const stored = JSON.parse(kept.items.get('rare-city-construction-presses')!) as Record<string, unknown>[]
    expect(Object.keys(stored[0]).sort()).toEqual(['actionId', 'discordUserId', 'intent', 'propertyId', 'role', 'worldId'])
    expect(JSON.stringify(stored)).not.toMatch(/token|session|secret|cookie|balance|credits/i)
  })

  it('a press kept by the E3A page (no intent) is still the press to resend, its intent read as null', () => {
    const legacy = { actionId: newId(), ...ADA, worldId: 'w-ada-7', propertyId: P1, role: 'owner' }
    expect(pressBook({ ...ADA, worldId: 'w-ada-7' }, storage({ 'rare-city-construction-presses': JSON.stringify([legacy]) }), newId).next(P2, 'patron')).toEqual({ ...legacy, intent: null })
  })
})

describe('an unresolved press survives whatever its display-only intent says (independent audit L1)', () => {
  const KEY = 'rare-city-construction-presses'
  const kept = (worldId: string, intent: unknown, extra: Record<string, unknown> = {}) => ({ actionId: newId(), ...ADA, worldId, propertyId: P1, role: 'owner', ...extra, ...(intent === undefined ? {} : { intent }) })

  it('a malformed, missing, legacy, unknown or null intent reads as null; the press keeps its id, player, world, property and role, and is resent as first sent', () => {
    const cases: [string, unknown][] = [
      ['malformed object', { recipe: 7, tier: 'x' }],
      ['missing', undefined],
      ['legacy string', 'local-test-tier1-v1'],
      ['unknown shape', { recipeKey: 'local-test-tier2-v1', level: 1 }],
      ['array', ['local-test-tier2-v1', 1]],
      ['tier above 64', { recipe: 'local-test-tier2-v1', tier: 65 }],
      ['negative tier', { recipe: 'local-test-tier2-v1', tier: -1 }],
      ['fractional tier', { recipe: 'local-test-tier2-v1', tier: 1.5 }],
      ['tier as text', { recipe: 'local-test-tier2-v1', tier: '1' }],
      ['recipe too long', { recipe: 'x'.repeat(65), tier: 1 }],
      ['null', null],
    ]
    cases.forEach(([label, intent], i) => {
      const worldId = `w-l1-${i}`
      const press = kept(worldId, intent)
      const store = storage({ [KEY]: JSON.stringify([press]) })
      const book = pressBook({ ...ADA, worldId }, store, newId)
      const identity = { actionId: press.actionId, worldId, discordUserId: ADA.discordUserId, propertyId: P1, role: 'owner' }
      expect(book.unresolved(), label).toEqual({ ...identity, intent: null })
      // Pressing anything (another property, another role, a new intent) sends this press again, under its own id.
      expect(book.next(P2, 'patron', { recipe: 'local-test-tier2-v1', tier: 2 }), label).toEqual({ ...identity, intent: null })
      // A reload: still the same press.
      expect(pressBook({ ...ADA, worldId }, store, newId).unresolved()?.actionId, label).toBe(press.actionId)
    })
  })

  it('a readable intent is kept as written, without any field besides recipe and tier', () => {
    const press = kept('w-l1-ok', { recipe: 'local-test-tier2-v1', tier: 1, note: 'extra' })
    expect(pressBook({ ...ADA, worldId: 'w-l1-ok' }, storage({ [KEY]: JSON.stringify([press]) }), newId).unresolved()).toEqual({ ...press, intent: { recipe: 'local-test-tier2-v1', tier: 1 } })
  })

  it('an entry whose id or identity does not read is still not a press, whatever its intent: nothing is normalized into one', () => {
    const intent = { recipe: 'local-test-tier2-v1', tier: 1 }
    for (const [label, entry] of [
      ['action id not a uuid', kept('w-l1-bad', intent, { actionId: 'not-a-uuid' })],
      ['no action id', kept('w-l1-bad', intent, { actionId: undefined })],
      ['world not text', kept('w-l1-bad', intent, { worldId: 7 })],
      ['player not text', kept('w-l1-bad', intent, { discordUserId: 111111111 })],
      ['no property', kept('w-l1-bad', intent, { propertyId: null })],
      ['unknown role', kept('w-l1-bad', intent, { role: 'admin' })],
    ] as const) {
      const book = pressBook({ ...ADA, worldId: 'w-l1-bad' }, storage({ [KEY]: JSON.stringify([entry]) }), newId)
      expect(book.unresolved(), label).toBeNull()
    }
  })

  it('another player or world never inherits it; its property and role are never taken from a later press', () => {
    const press = kept('w-l1-own', { recipe: 7 })
    const store = storage({ [KEY]: JSON.stringify([press]) })
    expect(pressBook({ worldId: 'w-l1-own', discordUserId: '222222222222222222' }, store, newId).unresolved()).toBeNull()
    expect(pressBook({ ...ADA, worldId: 'w-l1-other' }, store, newId).unresolved()).toBeNull()
    const again = pressBook({ ...ADA, worldId: 'w-l1-own' }, store, newId).next(P2, 'patron')
    expect([again.actionId, again.propertyId, again.role]).toEqual([press.actionId, P1, 'owner'])
  })

  it('keeps nothing but the press: a stored entry carrying a session ref, token or cookie is kept without them', () => {
    const tainted = kept('w-l1-taint', { recipe: 'local-test-tier2-v1', tier: 1, sessionRef: 'ref' }, { sessionRef: 'ref-x', token: 'tok', cookie: 'rc_play=abc', balance: 99 })
    const store = storage({ [KEY]: JSON.stringify([tainted]) })
    // Another player's press in the same browser writes the list again.
    pressBook({ worldId: 'w-l1-taint', discordUserId: '222222222222222222' }, store, newId).next(P2, 'patron')
    const stored = JSON.parse(store.items.get(KEY)!) as Record<string, unknown>[]
    expect(stored.find((p) => p.actionId === tainted.actionId)).toEqual({ actionId: tainted.actionId, ...ADA, worldId: 'w-l1-taint', propertyId: P1, role: 'owner', intent: { recipe: 'local-test-tier2-v1', tier: 1 } })
    expect(JSON.stringify(stored)).not.toMatch(/token|session|secret|cookie|balance|credits|rc_play/i)
  })
})
