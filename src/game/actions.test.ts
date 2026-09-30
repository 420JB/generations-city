import { describe, expect, it } from 'vitest'
import { getDistrict } from '../config/districts'
import { DEMO_FAUCET_AMOUNT, DEMO_WALLET_START } from '../config/economy'
import { DEMO_PLAYER_ID } from '../config/identity'
import {
  claimFaucet,
  contribute,
  placeLandscape,
  purchaseFixture,
  rally,
  rivalTurn,
  setArchitecture,
  setBillboardImage,
  swapLandscape,
} from './actions'
import { buildBoard, cityHotlist } from './buildBoard'
import { buildSplit, tierFor, totalBuilt } from './economy'
import { buildingIdFor, createSeedState, SCENARIO } from './seed'
import { isValidState, loadState, saveState, STORAGE_KEY } from './persistence'

const P = DEMO_PLAYER_ID
const KING = buildingIdFor(SCENARIO.kingmakerFriend)
const CAP = buildingIdFor(SCENARIO.capitalFriend)
const MINE = buildingIdFor(SCENARIO.playerFriend)

describe('seed', () => {
  it('is deterministic', () => {
    expect(JSON.stringify(createSeedState())).toBe(JSON.stringify(createSeedState()))
  })
  it('has nine dense districts (founders + residents) and the scenario set up', () => {
    const s = createSeedState()
    const per = new Map<string, number>()
    for (const b of Object.values(s.buildings)) per.set(b.districtId, (per.get(b.districtId) ?? 0) + 1)
    expect(per.size).toBe(9)
    for (const n of per.values()) expect(n >= 19 && n <= 21).toBe(true)
    expect(s.buildings[MINE].ownerId).toBe(P)
    expect(tierFor(totalBuilt(s.buildings[MINE]))).toBe(4)
    expect(totalBuilt(s.buildings[KING])).toBe(9_962)
    expect(s.monuments.m4.holder).toBe('d2')
    expect(s.capital.holder).toBe('d3')
    expect(s.crown.holder).toBe(buildingIdFor(SCENARIO.crownHolderFriend))
  })
})

describe('contribution application', () => {
  it('advances Total and Community Build and records the patron', () => {
    const s = createSeedState()
    const before = buildSplit(s.buildings[KING])
    const r = contribute(s, KING, P, 10)
    expect(r.error).toBeUndefined()
    const after = buildSplit(r.state.buildings[KING])
    expect(after.total).toBe(before.total + 10)
    expect(after.community).toBe(before.community + 10)
    expect(after.owner).toBe(before.owner)
    expect(r.state.buildings[KING].patrons[P]).toBe(10)
    expect(r.state.wallets[P]).toBe(DEMO_WALLET_START - 10)
    // aggregate: one patron record per contributor
    const r2 = contribute(r.state, KING, P, 5)
    expect(r2.state.buildings[KING].patrons[P]).toBe(15)
  })

  it('Kingmaker scenario: 38 RF tiers #812 to T4 and steals the T4 Beacon', () => {
    const s = createSeedState()
    const r = contribute(s, KING, P, 38)
    const types = r.events.map((e) => e.type)
    expect(types).toContain('tier-up')
    expect(r.events).toContainEqual(expect.objectContaining({ type: 'monument-transfer', monumentId: 'm4', from: 'd2', to: 'd4' }))
    expect(r.state.monuments.m4.holder).toBe('d4')
    expect(r.state.counters[P].closerCount).toBe(1)
    expect(r.state.counters[P].kingmakerCount).toBe(1)
    const badges = r.state.badges[P].map((b) => b.badgeId)
    expect(badges).toEqual(expect.arrayContaining(['closer', 'kingmaker', 'good-neighbor']))
    expect(r.state.monumentHistory.m4.map((h) => h.holder)).toEqual(['d2', 'd4'])
    expect(r.state.monumentHistory.m4[0].toClock).toBe(r.state.clock)
    expect(r.state.radio[0].headline).toMatch(/STOLEN/)
    // Capital tie keeps the incumbent
    expect(r.state.capital.holder).toBe('d3')
    // Lower-tier monuments untouched
    expect(r.state.monuments.m3.holder).toBe(s.monuments.m3.holder)
  })

  it('Capital scenario: after the Beacon, #288 to T3 makes District 4 the Capital', () => {
    const s1 = contribute(createSeedState(), KING, P, 38).state
    const need = 2_500 - totalBuilt(s1.buildings[CAP])
    const r = contribute(s1, CAP, P, need)
    expect(r.state.capital.holder).toBe('d4')
    expect(r.state.capitalHistory.map((h) => h.holder)).toEqual(['d3', 'd4'])
    expect(r.state.badges[P].map((b) => b.badgeId)).toEqual(expect.arrayContaining(['capital-maker', 'capital-citizen']))
  })

  it('Crown race: overtaking the tallest building transfers the Crown', () => {
    const s = createSeedState()
    const challenger = buildingIdFor(SCENARIO.crownChallengerFriend)
    const holder = buildingIdFor(SCENARIO.crownHolderFriend)
    const gap = totalBuilt(s.buildings[holder]) - totalBuilt(s.buildings[challenger])
    const tie = contribute(s, challenger, P, gap)
    expect(tie.state.crown.holder).toBe(holder)
    const r = contribute(tie.state, challenger, P, 1)
    expect(r.state.crown.holder).toBe(challenger)
    const newOwner = r.state.buildings[challenger].ownerId
    expect(r.state.badges[newOwner].map((b) => b.badgeId)).toContain('crowned')
    expect(r.state.crownHistory).toHaveLength(2)
  })

  it('rejects invalid amounts and insufficient simulated RF', () => {
    const s = createSeedState()
    expect(contribute(s, KING, P, 0).error).toBeTruthy()
    expect(contribute(s, KING, P, 1.5).error).toBeTruthy()
    expect(contribute(s, KING, P, DEMO_WALLET_START + 1).error).toMatch(/simulated/i)
    const r = claimFaucet(s, P)
    expect(r.state.wallets[P]).toBe(DEMO_WALLET_START + DEMO_FAUCET_AMOUNT)
  })

  it('owner direct build advances Owner Build and does not count as Closer', () => {
    const s = createSeedState()
    const r = contribute(s, MINE, P, 100)
    const a = buildSplit(r.state.buildings[MINE])
    const b = buildSplit(s.buildings[MINE])
    expect(a.owner).toBe(b.owner + 100)
    expect(a.community).toBe(b.community)
    expect(r.state.buildings[MINE].patrons[P]).toBeUndefined()
  })
})

describe('fixtures and customization', () => {
  it('fixture purchase increases both Owner Build and Total Build', () => {
    const s = createSeedState()
    const before = buildSplit(s.buildings[MINE])
    const r = purchaseFixture(s, MINE, P, 'premium-roof')
    expect(r.error).toBeUndefined()
    const after = buildSplit(r.state.buildings[MINE])
    expect(after.owner).toBe(before.owner + 1_200)
    expect(after.total).toBe(before.total + 1_200)
    expect(r.state.buildings[MINE].fixtures).toContain('premium-roof')
    expect(purchaseFixture(r.state, MINE, P, 'premium-roof').error).toMatch(/Already/)
  })
  it('only the owner can buy fixtures or change architecture', () => {
    const s = createSeedState()
    expect(purchaseFixture(s, KING, P, 'tree').error).toMatch(/owner/)
    expect(setArchitecture(s, KING, P, 'facade', 'brick').error).toMatch(/owner/)
    expect(setBillboardImage(s, KING, P, null).error).toMatch(/owner/)
  })
  it('architecture options respect unlock requirements', () => {
    const s = createSeedState()
    expect(setArchitecture(s, MINE, P, 'roof', 'crown-deck').error).toMatch(/Premium Roof/)
    const bought = purchaseFixture(s, MINE, P, 'premium-roof').state
    const r = setArchitecture(bought, MINE, P, 'roof', 'crown-deck')
    expect(r.error).toBeUndefined()
    expect(r.state.buildings[MINE].architecture.roof).toBe('crown-deck')
  })
  it('Self Made badge unlocks by pushing owner share past 75%', () => {
    let s = createSeedState()
    expect(s.badges[P].map((b) => b.badgeId)).not.toContain('self-made')
    s = purchaseFixture(s, MINE, P, 'premium-roof').state
    s = purchaseFixture(s, MINE, P, 'crest').state
    expect(s.badges[P].map((b) => b.badgeId)).toContain('self-made')
  })
  it('landscaping places, clears and swaps within bounded slots', () => {
    let s = createSeedState()
    const start = s.buildings[MINE].landscapeSlots
    expect(start.slice(0, 2)).toEqual(['tree', 'bench'])
    s = placeLandscape(s, MINE, P, 2, 'lamp').state
    expect(s.buildings[MINE].landscapeSlots[2]).toBe('lamp')
    expect(s.buildings[MINE].landscapeInventory.lamp).toBe(0)
    s = swapLandscape(s, MINE, P, 0, 2).state
    expect(s.buildings[MINE].landscapeSlots.slice(0, 3)).toEqual(['lamp', 'bench', 'tree'])
    expect(placeLandscape(s, MINE, P, 7, null).error).toMatch(/locked/)
    s = placeLandscape(s, MINE, P, 1, null).state
    expect(s.buildings[MINE].landscapeInventory.bench).toBe(1)
  })
  it('billboard requires the fixture and accepts only image data URLs', () => {
    const s = createSeedState()
    expect(setBillboardImage(s, MINE, P, 'data:image/png;base64,AAAA').error).toMatch(/fixture/)
    const bought = purchaseFixture(s, MINE, P, 'billboard').state
    expect(setBillboardImage(bought, MINE, P, 'javascript:alert(1)').error).toBeTruthy()
    const r = setBillboardImage(bought, MINE, P, 'data:image/png;base64,AAAA')
    expect(r.state.buildings[MINE].billboard.image).toBe('data:image/png;base64,AAAA')
    expect(setBillboardImage(r.state, MINE, P, null).state.buildings[MINE].billboard.image).toBeNull()
  })
})

describe('badges are permanent', () => {
  it('Crowned stays after losing the Crown', () => {
    const s = createSeedState()
    const holderOwner = s.buildings[buildingIdFor(SCENARIO.crownHolderFriend)].ownerId
    expect(s.badges[holderOwner].map((b) => b.badgeId)).toContain('crowned')
    const r = contribute(s, buildingIdFor(SCENARIO.crownChallengerFriend), P, 5_000)
    expect(r.state.crown.holder).not.toBe(buildingIdFor(SCENARIO.crownHolderFriend))
    expect(r.state.badges[holderOwner].map((b) => b.badgeId)).toContain('crowned')
  })
})

describe('build board', () => {
  it('surfaces the Kingmaker opportunity for internal district d4', () => {
    const s = createSeedState()
    const board = buildBoard(s, 'd4')
    expect(board.impact[0].buildingId).toBe(KING)
    expect(board.impact[0].rfNeeded).toBe(38)
    expect(board.impact[0].lines[0]).toBe(`Captures The Grand Fountain from ${getDistrict('d2').name}.`)
    expect(board.closest[0].buildingId).toBe(KING)
    expect(board.monuments.find((m) => m.monumentId === 'm4')?.status).toBe('capture-next')
    expect(board.capital.mode).toBe('offense')
    expect(cityHotlist(s)[0].buildingId).toBe(KING)
  })
  it('rally posts to District Radio', () => {
    const r = rally(createSeedState(), CAP, P)
    expect(r.state.radio[0].kind).toBe('rally')
    expect(r.state.radio[0].detail).toMatch(/63 RF needed for Tier 3/)
  })
  it('rival turn is deterministic and uses the shared economy path', () => {
    const s = contribute(createSeedState(), KING, P, 38).state
    const a = rivalTurn(s, P)
    const b = rivalTurn(s, P)
    expect(a.error).toBeUndefined()
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state))
    expect(a.events.some((e) => e.type === 'tier-up')).toBe(true)
  })
})

describe('persistence', () => {
  it('round-trips and rejects stale state', () => {
    const mem = new Map<string, string>()
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
    const s = contribute(createSeedState(), KING, P, 38).state
    saveState(storage, s)
    const loaded = loadState(storage)
    expect(loaded.restored).toBe(true)
    expect(loaded.state.monuments.m4.holder).toBe('d4')
    mem.set(STORAGE_KEY, '{"version":1}')
    expect(loadState(storage).restored).toBe(false)
    mem.set(STORAGE_KEY, 'not json')
    expect(loadState(storage).state.monuments.m4.holder).toBe('d2')
    expect(isValidState(null)).toBe(false)
  })
})
