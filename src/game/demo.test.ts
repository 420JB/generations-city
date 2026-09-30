import { describe, expect, it } from 'vitest'
import { DEMO_PLAYER_ID } from '../config/identity'
import { contribute, purchaseFixture } from './actions'
import { demoProgress } from './demo'
import { buildingIdFor, createSeedState, SCENARIO } from './seed'

describe('demo guide progress', () => {
  it('starts incomplete and tracks the guided loop', () => {
    const s = createSeedState()
    const p0 = demoProgress(s)
    expect(p0).toMatchObject({ tierUp: false, captured: false, capital: false, customized: false, primaryComplete: false, kingmakerNeed: 38 })
    const s1 = contribute(s, buildingIdFor(SCENARIO.kingmakerFriend), DEMO_PLAYER_ID, 38).state
    expect(demoProgress(s1)).toMatchObject({ tierUp: true, captured: true, primaryComplete: true, capital: false })
    const s2 = contribute(s1, buildingIdFor(SCENARIO.capitalFriend), DEMO_PLAYER_ID, 63).state
    expect(demoProgress(s2).capital).toBe(true)
    const s3 = purchaseFixture(s2, buildingIdFor(SCENARIO.playerFriend), DEMO_PLAYER_ID, 'tree').state
    expect(demoProgress(s3).customized).toBe(true)
  })
  it('a fresh seed (RESET DEMO) is incomplete again', () => {
    expect(demoProgress(createSeedState()).primaryComplete).toBe(false)
  })
})
