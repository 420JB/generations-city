import { describe, expect, it } from 'vitest'
import { DEMO_PLAYER_ID } from '../config/identity'
import { contribute, rivalTurn } from './actions'
import { radioDispatches, RALLY_LIMITS, type RallyCall } from './dispatch'
import { badgeLabel } from './narration'
import { buildingIdFor, createSeedState, SCENARIO } from './seed'
import { homeDistrict } from './season'
import type { GameState } from './types'

const P = DEMO_PLAYER_ID
const KING = buildingIdFor(SCENARIO.kingmakerFriend)
const CAP = buildingIdFor(SCENARIO.capitalFriend)

/** Seed → #812 capture → #288 Capital → a rival move: the states the demo walks through. */
function journey(): GameState[] {
  const s0 = createSeedState()
  const s1 = contribute(s0, KING, P, 38).state
  const s2 = contribute(s1, CAP, P, 63).state
  const s3 = rivalTurn(s2, P).state
  return [s0, s1, s2, s3]
}

describe('District Radio · Rally Calls', () => {
  it('seeded state leads with the #812 Grand Fountain capture', () => {
    const calls = radioDispatches(createSeedState(), P)
    expect(calls[0]).toMatchObject({ kind: 'monument', label: 'MONUMENT', headline: 'TAKE THE GRAND FOUNTAIN', friendId: 812, rfNeeded: 38, targetTier: 4 })
    expect(calls[0].reason).toContain('captures The Grand Fountain from Sparkling')
    expect(calls[0].badges).toEqual(expect.arrayContaining([badgeLabel('kingmaker', 1), badgeLabel('closer', 1), badgeLabel('good-neighbor', 1)]))
  })

  it('drops the stale Fountain call once it is done and surfaces the Capital move', () => {
    const [, after] = journey()
    const calls = radioDispatches(after, P)
    expect(calls.some((c) => c.buildingId === KING)).toBe(false)
    expect(calls.some((c) => c.headline.includes('GRAND FOUNTAIN') && c.kind === 'monument')).toBe(false)
    const capital = calls.find((c) => c.kind === 'capital')!
    expect(capital).toMatchObject({ headline: 'TAKE THE CAPITAL', friendId: 288, rfNeeded: 63 })
    expect(capital.reason).toContain('makes Family the Capital')
    expect(capital.badges).toContain(badgeLabel('capital-maker', 1))
  })

  it('switches to defending the Capital once Family holds it', () => {
    const [, , held] = journey()
    const calls = radioDispatches(held, P)
    expect(calls.some((c) => c.kind === 'capital')).toBe(false)
    expect(calls.find((c) => c.kind === 'capital-defense')?.reason).toMatch(/lead over Colossus grows/)
  })

  it('never repeats a building or a strategic objective, and respects the card cap', () => {
    for (const s of journey()) {
      const calls = radioDispatches(s, P)
      expect(calls.length).toBeLessThanOrEqual(RALLY_LIMITS.max)
      expect(new Set(calls.map((c) => c.buildingId)).size).toBe(calls.length)
      expect(calls.filter((c) => c.kind === 'capital' || c.kind === 'capital-defense').length).toBeLessThanOrEqual(1)
      expect(new Set(calls.filter((c) => c.kind === 'monument').map((c) => c.headline)).size).toBe(calls.filter((c) => c.kind === 'monument').length)
    }
  })

  it('badge claims match exactly what the spend would award', () => {
    for (const s of journey()) {
      for (const c of radioDispatches(s, P)) {
        const r = contribute(s, c.buildingId, P, c.rfNeeded)
        expect(r.error).toBeUndefined()
        const earned = r.events.flatMap((e) => (e.type === 'badge' && e.userId === P ? [badgeLabel(e.badgeId, e.level)] : []))
        expect([...c.badges].sort(), `${c.id}`).toEqual(earned.sort())
      }
    }
  })

  it('only suggests map-changing moves that help the Home District', () => {
    for (const s of journey()) {
      const home = homeDistrict(s, P)
      for (const c of radioDispatches(s, P).filter((x: RallyCall) => x.kind !== 'badge' && x.kind !== 'near-tier' && x.kind !== 'crown')) {
        expect(c.districtId).toBe(home)
      }
    }
  })

  it('is derived, deterministic and never written into the City Feed', () => {
    const s = createSeedState()
    const before = JSON.stringify(s)
    expect(JSON.stringify(radioDispatches(s, P))).toBe(JSON.stringify(radioDispatches(s, P)))
    expect(JSON.stringify(s)).toBe(before)
  })

  it('does not suggest spends the player cannot afford', () => {
    const s = createSeedState()
    const broke = { ...s, wallets: { ...s.wallets, [P]: 20 } }
    expect(radioDispatches(broke, P).every((c) => c.rfNeeded <= 20)).toBe(true)
  })
})
