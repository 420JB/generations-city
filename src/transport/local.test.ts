import { describe, expect, it } from 'vitest'
import { DISTRICT_IDS } from '../config/districts'
import { DEMO_PLAYER_ID } from '../config/identity'
import {
  claimFaucet,
  contribute,
  joinAtPlot,
  joinCity,
  placeLandscape,
  purchaseFixture,
  rally,
  rivalTurn,
  setArchitecture,
  setBillboardImage,
  setBillboardMessage,
  swapLandscape,
} from '../game/actions'
import { availablePlots } from '../game/allocation'
import { applyCityCommand } from '../game/commands'
import { isDemoCommand } from '../game/demoCommands'
import { buildSplit, tierFor, totalBuilt } from '../game/economy'
import { simulateDistrictGrowth } from '../game/growth'
import { STORAGE_KEY } from '../game/persistence'
import { buildingIdFor, createSeedState, SCENARIO } from '../game/seed'
import type { ActionResult, GameState } from '../game/types'
import { createLocalTransport, DEMO_VIEWER, type LocalStorageLike } from './local'
import { resolveClientMode } from './mode'
import type { ClientCommand, Viewer } from './types'

const P = DEMO_PLAYER_ID
const KING = buildingIdFor(SCENARIO.kingmakerFriend)
const CAP = buildingIdFor(SCENARIO.capitalFriend)
const MINE = buildingIdFor(SCENARIO.playerFriend)
const CHALLENGER = buildingIdFor(SCENARIO.crownChallengerFriend)
const IMAGE = 'data:image/png;base64,AAAA'

/**
 * The reducer body `src/ui/store.ts` shipped before the transport seam (8efb47b), kept
 * verbatim as the reference: direct engine calls with the demo player hard-wired.
 */
function legacyRun(game: GameState, action: ClientCommand): ActionResult {
  switch (action.type) {
    case 'contribute':
      return contribute(game, action.buildingId, P, action.amount)
    case 'fixture':
      return purchaseFixture(game, action.buildingId, P, action.fixtureId)
    case 'architecture':
      return setArchitecture(game, action.buildingId, P, action.slot, action.optionId)
    case 'landscape-place':
      return placeLandscape(game, action.buildingId, P, action.slot, action.kind)
    case 'landscape-swap':
      return swapLandscape(game, action.buildingId, P, action.a, action.b)
    case 'billboard':
      return setBillboardImage(game, action.buildingId, P, action.image)
    case 'billboard-message':
      return setBillboardMessage(game, action.buildingId, P, action.message)
    case 'rally':
      return rally(game, action.buildingId, P)
    case 'faucet':
      return claimFaucet(game, P)
    case 'rival':
      return rivalTurn(game, P)
    case 'join':
      return joinCity(game, action.districtId)
    case 'join-at':
      return joinAtPlot(game, { districtId: action.districtId, ward: action.ward, plot: action.plot })
    case 'grow':
      return simulateDistrictGrowth(game, action.districtId)
    case 'reset':
      return { state: createSeedState(), events: [] }
  }
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const writes: string[] = []
  const removes: string[] = []
  const storage: LocalStorageLike = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      writes.push(k)
      data.set(k, v)
    },
    removeItem: (k) => {
      removes.push(k)
      data.delete(k)
    },
  }
  return { storage, data, writes, removes }
}

/** Feed the same commands to the legacy reducer and the local transport, comparing every step. */
function expectParity(commands: ClientCommand[]) {
  const transport = createLocalTransport(memoryStorage().storage)
  let game = createSeedState()
  expect(transport.getSnapshot().game).toEqual(game)
  commands.forEach((command, i) => {
    const before = transport.getSnapshot()
    const expected = legacyRun(game, command)
    transport.send(command)
    const after = transport.getSnapshot()
    expect(after.seq, `seq after #${i} ${command.type}`).toBe(i + 1)
    if (expected.error) {
      expect(after.error).toEqual({ seq: i + 1, message: expected.error })
      expect(after.game).toBe(before.game)
      expect(after.last).toBe(before.last)
    } else {
      expect(after.error).toBeNull()
      expect(after.game, `state after #${i} ${command.type}`).toEqual(expected.state)
      expect(after.last).toEqual({ seq: i + 1, events: expected.events, action: command.type })
      game = expected.state
    }
  })
  return { transport, game }
}

describe('local transport parity with the direct engine', () => {
  it('a contribution resolves the tier, the monument and patron recognition identically', () => {
    const { game } = expectParity([{ type: 'contribute', buildingId: KING, amount: 38 }])
    const seed = createSeedState()
    expect(tierFor(totalBuilt(seed.buildings[KING]))).toBe(3)
    expect(tierFor(totalBuilt(game.buildings[KING]))).toBe(4)
    expect(seed.monuments.m4.holder).toBe('d2')
    expect(game.monuments.m4.holder).toBe('d4')
    expect(game.badges[P].map((b) => b.badgeId)).toEqual(expect.arrayContaining(['closer', 'kingmaker']))
  })

  it('keeps owner build and patron build in separate accounts', () => {
    const { game } = expectParity([
      { type: 'contribute', buildingId: MINE, amount: 500 },
      { type: 'contribute', buildingId: KING, amount: 38 },
    ])
    const seed = createSeedState()
    expect(game.buildings[MINE].ownerBuilt).toBe(seed.buildings[MINE].ownerBuilt + 500)
    expect(game.buildings[MINE].patrons[P]).toBeUndefined()
    expect(game.buildings[KING].ownerBuilt).toBe(seed.buildings[KING].ownerBuilt)
    expect(game.buildings[KING].patrons[P]).toBe(38)
    expect(buildSplit(game.buildings[KING]).community).toBe(buildSplit(seed.buildings[KING]).community + 38)
    expect(game.wallets[P]).toBe(seed.wallets[P] - 538)
  })

  it('moves the Capital and the City Crown identically', () => {
    const seed = createSeedState()
    const { game } = expectParity([
      { type: 'contribute', buildingId: KING, amount: 38 },
      { type: 'contribute', buildingId: CAP, amount: 63 },
      { type: 'contribute', buildingId: CHALLENGER, amount: 5_000 },
    ])
    expect(game.capital.holder).toBe('d4')
    expect(game.capital.holder).not.toBe(seed.capital.holder)
    expect(game.crown.holder).toBe(CHALLENGER)
    expect(game.crown.holder).not.toBe(seed.crown.holder)
    expect(game.capitalHistory).toHaveLength(seed.capitalHistory.length + 1)
    expect(game.crownHistory).toHaveLength(seed.crownHistory.length + 1)
  })

  it('places a joining Friend on exactly the chosen plot, opening the next ward when needed', () => {
    const seed = createSeedState()
    // Family (d4) is full at seed: every candidate is in the not-yet-open Ward II.
    const pick = availablePlots(seed, 'd4').find((c) => c.plot === 17)!
    expect(pick).toMatchObject({ ward: 1, newWard: true })
    // Any district with a free plot in a ward that is already open.
    const open = DISTRICT_IDS.flatMap((d) => availablePlots(seed, d)).filter((c) => !c.newWard).at(-1)!
    const { game } = expectParity([
      { type: 'join-at', districtId: 'd4', ward: pick.ward, plot: pick.plot },
      { type: 'join-at', districtId: open.districtId, ward: open.ward, plot: open.plot },
      // The same plot again is taken now: rejected, nothing changes.
      { type: 'join-at', districtId: open.districtId, ward: open.ward, plot: open.plot },
    ])
    expect(game.wards.d4).toBe(seed.wards.d4 + 1)
    expect(game.buildings[`b-${20_000 + seed.residentSeq + 1}`]).toMatchObject({ districtId: 'd4', ward: 1, plot: 17 })
    expect(game.buildings[`b-${20_000 + seed.residentSeq + 2}`]).toMatchObject({ districtId: open.districtId, ward: open.ward, plot: open.plot })
    expect(game.residentSeq).toBe(seed.residentSeq + 2)
  })

  it('matches across every command type in one long session, including rejections and reset', () => {
    expectParity([
      { type: 'contribute', buildingId: KING, amount: 38 },
      { type: 'rival' },
      { type: 'contribute', buildingId: 'b-nope', amount: 10 },
      { type: 'contribute', buildingId: MINE, amount: 0 },
      { type: 'faucet' },
      { type: 'contribute', buildingId: MINE, amount: 12_000 },
      { type: 'fixture', buildingId: MINE, fixtureId: 'billboard' },
      { type: 'billboard', buildingId: MINE, image: IMAGE },
      { type: 'billboard-message', buildingId: MINE, message: 'Open house on the roof deck' },
      { type: 'billboard-message', buildingId: MINE, message: 'see https://example.com' },
      { type: 'fixture', buildingId: MINE, fixtureId: 'tree' },
      { type: 'fixture', buildingId: MINE, fixtureId: 'bench' },
      { type: 'landscape-swap', buildingId: MINE, a: 0, b: 1 },
      { type: 'landscape-place', buildingId: MINE, slot: 0, kind: null },
      { type: 'architecture', buildingId: MINE, slot: 'lighting', optionId: 'cool' },
      { type: 'architecture', buildingId: KING, slot: 'lighting', optionId: 'cool' },
      { type: 'rally', buildingId: CAP },
      { type: 'join', districtId: 'd2' },
      { type: 'grow', districtId: 'd4' },
      { type: 'rival' },
      { type: 'billboard', buildingId: MINE, image: null },
      { type: 'reset' },
      { type: 'contribute', buildingId: CAP, amount: 63 },
    ])
  })
})

describe('local transport reads', () => {
  it('previewing or cancelling a placement never touches the city', () => {
    const mem = memoryStorage()
    const transport = createLocalTransport(mem.storage)
    let notified = 0
    transport.subscribe(() => notified++)
    const before = transport.getSnapshot()
    const frozen = JSON.stringify(before.game)
    const writes = mem.writes.length

    for (const d of ['d1', 'd4', 'd7'] as const) expect(availablePlots(transport.getSnapshot().game, d).length).toBeGreaterThan(0)

    expect(transport.getSnapshot()).toBe(before)
    expect(JSON.stringify(transport.getSnapshot().game)).toBe(frozen)
    expect(before.game.residentSeq).toBe(createSeedState().residentSeq)
    expect(mem.writes).toHaveLength(writes)
    expect(notified).toBe(0)
  })

  it('a rejected command reports the error and leaves state, events and storage alone', () => {
    const mem = memoryStorage()
    const transport = createLocalTransport(mem.storage)
    const before = transport.getSnapshot()
    const saved = mem.data.get(STORAGE_KEY)
    const writes = mem.writes.length
    const taken = Object.values(before.game.buildings).find((b) => b.districtId === 'd1')!

    transport.send({ type: 'join-at', districtId: 'd1', ward: taken.ward, plot: taken.plot })

    const after = transport.getSnapshot()
    expect(after.error).toEqual({ seq: 1, message: 'That plot is not available for this Friend' })
    expect(after.game).toBe(before.game)
    expect(after.last).toBeNull()
    expect(mem.writes).toHaveLength(writes)
    expect(mem.data.get(STORAGE_KEY)).toBe(saved)
  })

  it('notifies subscribers once per command and stops after unsubscribe', () => {
    const transport = createLocalTransport(null)
    let notified = 0
    const unsubscribe = transport.subscribe(() => notified++)
    transport.send({ type: 'faucet' })
    transport.send({ type: 'contribute', buildingId: 'b-nope', amount: 1 })
    expect(notified).toBe(2)
    unsubscribe()
    transport.send({ type: 'faucet' })
    expect(notified).toBe(2)
  })
})

describe('local transport viewer', () => {
  it('resolves the local demo viewer to the demo player', () => {
    expect(createLocalTransport(null).getSnapshot().viewer).toEqual({ userId: DEMO_PLAYER_ID, source: 'demo' })
    expect(DEMO_VIEWER.userId).toBe(DEMO_PLAYER_ID)
  })

  it('acts as whichever viewer the transport was given, not a hard-wired demo player', () => {
    const seed = createSeedState()
    const ownerId = seed.buildings[KING].ownerId
    expect(ownerId).not.toBe(DEMO_PLAYER_ID)
    const viewer: Viewer = { userId: ownerId, source: 'session' }
    const transport = createLocalTransport(null, viewer)

    transport.send({ type: 'contribute', buildingId: KING, amount: 38 })

    const snap = transport.getSnapshot()
    expect(snap.viewer).toBe(viewer)
    expect(snap.game).toEqual(contribute(seed, KING, ownerId, 38).state)
    expect(snap.game.buildings[KING].ownerBuilt).toBe(seed.buildings[KING].ownerBuilt + 38)
    expect(snap.game.buildings[KING].patrons[DEMO_PLAYER_ID]).toBeUndefined()
    expect(snap.game.wallets[DEMO_PLAYER_ID]).toBe(seed.wallets[DEMO_PLAYER_ID])
  })

  it('refuses owner-only edits from a viewer who is not the owner', () => {
    const transport = createLocalTransport(null)
    transport.send({ type: 'architecture', buildingId: KING, slot: 'lighting', optionId: 'cool' })
    expect(transport.getSnapshot().error?.message).toBe('Only the owner can change this building')
  })
})

describe('local transport persistence compatibility', () => {
  it('keeps the legacy storage key', () => {
    expect(STORAGE_KEY).toBe('generations-city:state:v5')
  })

  it('writes the city on start and after every successful command', () => {
    const mem = memoryStorage()
    const transport = createLocalTransport(mem.storage)
    expect(mem.writes).toEqual([STORAGE_KEY])
    expect(JSON.parse(mem.data.get(STORAGE_KEY)!)).toEqual(createSeedState())
    expect(transport.getSnapshot().restored).toBe(false)

    transport.send({ type: 'contribute', buildingId: KING, amount: 38 })
    expect(mem.writes).toEqual([STORAGE_KEY, STORAGE_KEY])
    expect(JSON.parse(mem.data.get(STORAGE_KEY)!)).toEqual(JSON.parse(JSON.stringify(transport.getSnapshot().game)))
  })

  it('restores a city saved by the pre-seam build', () => {
    const saved = contribute(createSeedState(), KING, P, 38).state
    const mem = memoryStorage({ [STORAGE_KEY]: JSON.stringify(saved) })
    const snap = createLocalTransport(mem.storage).getSnapshot()
    expect(snap.restored).toBe(true)
    expect(snap.game).toEqual(JSON.parse(JSON.stringify(saved)))
    expect(snap.game.monuments.m4.holder).toBe('d4')
  })

  it('falls back to the seed for corrupt or stale saves', () => {
    for (const raw of ['{not json', JSON.stringify({ ...createSeedState(), version: 4 })]) {
      const snap = createLocalTransport(memoryStorage({ [STORAGE_KEY]: raw }).storage).getSnapshot()
      expect(snap.restored).toBe(false)
      expect(snap.game).toEqual(createSeedState())
    }
  })

  it('reset clears the saved city and stores the seed again', () => {
    const mem = memoryStorage()
    const transport = createLocalTransport(mem.storage)
    transport.send({ type: 'contribute', buildingId: KING, amount: 38 })
    transport.send({ type: 'reset' })
    expect(mem.removes).toEqual([STORAGE_KEY])
    expect(transport.getSnapshot().game).toEqual(createSeedState())
    expect(transport.getSnapshot().last).toEqual({ seq: 2, events: [], action: 'reset' })
    expect(JSON.parse(mem.data.get(STORAGE_KEY)!)).toEqual(createSeedState())
  })

  it('still runs when storage is unavailable or throws', () => {
    const broken: LocalStorageLike = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    for (const storage of [null, broken]) {
      const transport = createLocalTransport(storage)
      transport.send({ type: 'contribute', buildingId: KING, amount: 38 })
      transport.send({ type: 'reset' })
      expect(transport.getSnapshot().game).toEqual(createSeedState())
    }
  })
})

describe('command vocabulary', () => {
  it('separates demo-only controls from player intents', () => {
    for (const type of ['faucet', 'rival', 'join', 'join-at', 'grow']) expect(isDemoCommand({ type })).toBe(true)
    for (const type of ['contribute', 'fixture', 'architecture', 'landscape-place', 'landscape-swap', 'billboard', 'billboard-message', 'rally', 'reset'])
      expect(isDemoCommand({ type })).toBe(false)
  })

  it('applies a player intent as a pure function of state, actor and command', () => {
    const seed = createSeedState()
    const frozen = JSON.stringify(seed)
    const r = applyCityCommand(seed, P, { type: 'contribute', buildingId: KING, amount: 38 })
    expect(r).toEqual(contribute(createSeedState(), KING, P, 38))
    expect(JSON.stringify(seed)).toBe(frozen)
  })
})

describe('client mode', () => {
  it('defaults to the local demo', () => {
    expect(resolveClientMode(undefined)).toBe('local-demo')
    expect(resolveClientMode('')).toBe('local-demo')
    expect(resolveClientMode('local-demo')).toBe('local-demo')
    expect(resolveClientMode('server')).toBe('server')
  })

  it('rejects unknown modes instead of falling back', () => {
    expect(() => resolveClientMode('prod')).toThrow(/Unknown VITE_APP_MODE/)
  })
})
