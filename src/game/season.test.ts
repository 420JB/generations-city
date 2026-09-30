import { describe, expect, it } from 'vitest'
import { SEASON_RULES } from '../config/season'
import { DEMO_PLAYER_ID } from '../config/identity'
import { contribute, joinCity } from './actions'
import { buildingIdFor, createSeedState, SCENARIO } from './seed'
import { chooseRepresentative, contributionAllegiance, emptySeason, homeDistrict, ownedFriends, permanentTier, seasonSignals, startNextSeason } from './season'

const P = DEMO_PLAYER_ID
const MINE = buildingIdFor(SCENARIO.playerFriend)
const SECOND = buildingIdFor(SCENARIO.playerSecondFriend)

describe('seasonal Representative / Home District', () => {
  it('seeds the demo player with a Representative in District 4 and a second Friend in District 7', () => {
    const s = createSeedState()
    expect(homeDistrict(s, P)).toBe('d4')
    expect(s.season.representatives[P].buildingId).toBe(MINE)
    expect(ownedFriends(s, P).map((b) => b.districtId).sort()).toEqual(['d4', 'd7'])
  })
  it('locks allegiance for the season: no switching to another owned Friend', () => {
    const s = createSeedState()
    const r = chooseRepresentative(s, P, SECOND)
    expect(r.error).toMatch(/locked until next season/)
    expect(homeDistrict(r.state, P)).toBe('d4')
  })
  it('a new season clears allegiance but keeps permanent progress; the choice then locks again', () => {
    let s = contribute(createSeedState(), buildingIdFor(SCENARIO.kingmakerFriend), P, 38).state
    const tier = permanentTier(s, buildingIdFor(SCENARIO.kingmakerFriend))
    const monument = s.monuments.m4.holder
    s = startNextSeason(s)
    expect(s.season.number).toBe(2)
    expect(homeDistrict(s, P)).toBeNull()
    expect(s.season.activity).toEqual({})
    expect(permanentTier(s, buildingIdFor(SCENARIO.kingmakerFriend))).toBe(tier)
    expect(s.monuments.m4.holder).toBe(monument)
    const pick = chooseRepresentative(s, P, SECOND)
    expect(pick.error).toBeUndefined()
    expect(homeDistrict(pick.state, P)).toBe('d7')
    expect(chooseRepresentative(pick.state, P, MINE).error).toMatch(/locked/)
  })
  it('only an owned Friend can represent a player', () => {
    const s = startNextSeason(createSeedState())
    expect(chooseRepresentative(s, P, buildingIdFor(SCENARIO.kingmakerFriend)).error).toMatch(/own/)
  })
  it('flags cross-district construction without prohibiting it', () => {
    const s = createSeedState()
    expect(contributionAllegiance(s, P, MINE)).toEqual({ allegiance: 'home', warning: null })
    expect(contributionAllegiance(s, P, buildingIdFor(SCENARIO.kingmakerFriend)).allegiance).toBe('home')
    const rival = contributionAllegiance(s, P, SECOND)
    expect(rival.allegiance).toBe('rival')
    expect(rival.warning).toBe(SEASON_RULES.crossDistrictWarning)
    expect(contributionAllegiance(s, P, buildingIdFor(SCENARIO.crownHolderFriend)).allegiance).toBe('rival')
    // Still allowed:
    expect(contribute(s, SECOND, P, 10).error).toBeUndefined()
    expect(contributionAllegiance(startNextSeason(s), P, SECOND).allegiance).toBe('unaligned')
  })
  it('tracks seasonal activity separately and exposes normalised preview signals', () => {
    let s = createSeedState()
    expect(seasonSignals(s).every((x) => x.activeBuildings === 0)).toBe(true)
    s = contribute(s, buildingIdFor(SCENARIO.kingmakerFriend), P, 38).state
    expect(s.season.activity[buildingIdFor(SCENARIO.kingmakerFriend)]).toEqual({ rf: 38, tierUps: 1, builders: [P] })
    const d4 = seasonSignals(s).find((x) => x.districtId === 'd4')!
    expect(d4.activeBuildings).toBe(1)
    expect(d4.activeShare).toBeCloseTo(1 / d4.buildings)
    expect(d4.tierUps).toBe(1)
  })
  it('late joiners may join mid-season and are recorded for residency rules', () => {
    const s = joinCity(createSeedState(), 'd9').state
    const userId = 'resident-1'
    expect(s.season.joinedClock[userId]).toBe(s.clock)
    expect(homeDistrict(s, userId)).toBe('d9')
    expect(SEASON_RULES.allowLateJoin).toBe(true)
    expect(emptySeason(3).name).toBe('Demo Season 3')
  })
  it('the Founding Ward grants prestige only', () => {
    const s = createSeedState()
    expect(s.badges[P].map((b) => b.badgeId)).toContain('founding-resident')
  })
})
