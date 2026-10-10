import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { availablePlots, newBuilding } from '../game/allocation'
import { createGenesisState } from '../game/genesis'
import { createSeedState } from '../game/seed'
import type { GameState } from '../game/types'
import { wardCapacity } from '../game/world'
import { parseActivationCommitResponse, parsePlotId, type ActivationTypedData } from '../protocol/activation'
import { cityAcceptsActivation } from './eligibility'
import { COMMIT_REFUSAL_TEXT, DEFAULT_DEFERRAL_MS, isExpectedIntent, MAX_COMMIT_DEFERRALS, MAX_COMMIT_SENDS, MAX_DEFERRAL_MS, MESSAGES, parseRetryAfter } from './flow'
import { ALICE, BOB, createWorld, ORIGIN, refusal, SIGNATURE, USER, type Reply, type Step, type World } from './testWorld'

/** Everything the page could have written the signature to, watched for the whole of each test. */
const stores = { local: new Map<string, string>(), session: new Map<string, string>() }
const storage = (map: Map<string, string>) => ({ getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) })
const consoles = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const

beforeEach(() => {
  stores.local.clear()
  stores.session.clear()
  vi.stubGlobal('localStorage', storage(stores.local))
  vi.stubGlobal('sessionStorage', storage(stores.session))
  for (const method of consoles) vi.spyOn(console, method).mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The signature appears nowhere a page keeps things: no published state, no storage, no console. */
function expectSignatureKeptNowhere(w: World, signature = SIGNATURE) {
  const bare = signature.slice(2)
  for (const snapshot of [...w.published, w.flow.getSnapshot(), w.identity.getSnapshot(), w.transport.getSnapshot()]) expect(JSON.stringify(snapshot)).not.toContain(bare)
  expect([...stores.local.entries(), ...stores.session.entries()]).toEqual([])
  for (const method of consoles) expect(console[method]).not.toHaveBeenCalled()
  // And it is held in memory only while a commit is unresolved.
  expect(w.flow.holdsSignature()).toBe(w.flow.getSnapshot().phase === 'unresolved')
}

/** Words that are only true when the wallet never signed, or when it is proven that nothing was activated. */
const NEVER_SIGNED = /nothing was signed|nothing changed|never signed|did not sign/i
const NOT_ACTIVATED = /nothing was activated|was not activated|did not activate|not activated/i

/** Nothing the page ever showed, from the moment the signature was sent, said the wallet had not signed. */
function expectNoFalseClaim(w: World, alsoNot: RegExp | null = NOT_ACTIVATED) {
  const from = w.published.findIndex((snap) => snap.step === 'committing')
  expect(from).toBeGreaterThanOrEqual(0)
  for (const snap of w.published.slice(from)) {
    if (!snap.notice) continue
    expect(snap.notice.text).not.toMatch(NEVER_SIGNED)
    if (alsoNot) expect(snap.notice.text).not.toMatch(alsoNot)
  }
}

/** A well-formed commit answer for some Friend and plot, as the server would write it. */
function committedFor(tokenId: string, plotId: string) {
  const plot = parsePlotId(plotId)!
  return { status: 'committed', property: { id: `prop-${tokenId}`, tokenId, buildingId: `b-${tokenId}`, districtId: plot.districtId, ward: plot.ward, plot: plot.plot, plotId, activatedAt: '2026-10-09T12:01:00.000Z', sequence: 2 }, city: { id: 'main', instance: 'inst-1' } }
}

/** Rare City's own rate limit, as the server sends it. */
const limited = (retryAfter?: string): Reply => ({ status: 429, json: { error: 'rate_limited' }, headers: retryAfter === undefined ? undefined : { 'retry-after': retryAfter } })

/** A city whose district has every plot of its open ward taken, by account-owned properties. */
function cityWithFullWard(districtId: 'd8'): GameState {
  const game = createGenesisState()
  for (let plot = 0; plot < wardCapacity(0); plot++) {
    const b = newBuilding({ friendId: 9_000 + plot, ownerId: '11111111-2222-3333-4444-555555555555', address: { districtId, ward: 0, plot }, clock: 0 })
    game.buildings[b.id] = b
  }
  return game
}

describe('starting: only an owned Friend the server says has no property', () => {
  it('starts for an unactivated owned Friend and fixes the district from its family', async () => {
    const w = await createWorld()
    expect(w.flow.start('1204')).toBe(true)
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'choosing', friend: { tokenId: '1204', family: { id: 0, name: 'Skeleton' } }, districtId: 'd8', selected: null })
    w.flow.cancel()
    expect(w.flow.start('812')).toBe(true)
    expect(w.flow.getSnapshot()).toMatchObject({ friend: { tokenId: '812', family: { id: 2, name: 'Family' } }, districtId: 'd4' })
  })

  it('refuses a Friend that already has a property, one it does not own, and one whose property is unknown', async () => {
    const w = await createWorld({ unknownProperty: ['812'] })
    w.reviewPlot('1204')
    await w.flow.confirm()
    expect(w.friend('1204')?.property).toMatchObject({ plotId: 'd8-w0-p0' })
    expect(w.flow.start('1204')).toBe(false)
    expect(w.flow.start('999')).toBe(false)
    // No annotation means the server could not tell. That is not "has none".
    expect(w.friend('812')).toEqual({ tokenId: '812', family: { id: 2, name: 'Family' } })
    expect(w.flow.start('812')).toBe(false)
    expect(w.flow.getSnapshot().phase).toBe('idle')
  })

  it('refuses when nobody is signed in, and in a simulated demo city', async () => {
    const visitor = await createWorld({ signedIn: false })
    expect(visitor.flow.start('1204')).toBe(false)

    const demo = await createWorld({ game: createSeedState() })
    expect(cityAcceptsActivation(demo.game())).toBe(false)
    expect(demo.flow.start('1204')).toBe(false)
    expect(cityAcceptsActivation(createGenesisState())).toBe(true)
  })

  it('refuses a token id the activation contract cannot carry', async () => {
    const w = await createWorld({ owned: [['9007199254740993', 0]] })
    expect(w.flow.start('9007199254740993')).toBe(false)
  })
})

describe('choosing a plot: page state only', () => {
  it('offers exactly the free plots of the family district and takes the exact one picked', async () => {
    const w = await createWorld()
    w.flow.start('1204')
    const offered = availablePlots(w.game(), 'd8')
    expect(offered).toHaveLength(wardCapacity(0))
    expect(w.flow.select({ districtId: 'd8', ward: 0, plot: 3 })).toBe(true)
    expect(w.flow.getSnapshot().selected).toEqual({ districtId: 'd8', ward: 0, plot: 3, newWard: false })
    // Picking again replaces the pick; nothing accumulates.
    expect(w.flow.select({ districtId: 'd8', ward: 0, plot: 5 })).toBe(true)
    expect(w.flow.getSnapshot().selected).toMatchObject({ ward: 0, plot: 5 })
  })

  it("cannot pick another family's district, a taken plot, or a plot that does not exist", async () => {
    const w = await createWorld()
    w.reviewPlot('1204', 0, 0)
    await w.flow.confirm()
    w.flow.start('812')
    expect(w.flow.getSnapshot().districtId).toBe('d4')
    // Skeleton's district is not Family's, free plot or not.
    expect(w.flow.select({ districtId: 'd8', ward: 0, plot: 1 })).toBe(false)
    expect(w.flow.select({ districtId: 'd4', ward: 0, plot: wardCapacity(0) })).toBe(false)
    expect(w.flow.select({ districtId: 'd4', ward: 1, plot: 0 })).toBe(false)
    expect(w.flow.getSnapshot().selected).toBeNull()
    expect(w.flow.review()).toBe(false)

    w.flow.cancel()
    const other = await createWorld({ owned: [['1204', 0], ['1300', 0]] })
    other.reviewPlot('1204', 0, 2)
    await other.flow.confirm()
    other.flow.start('1300')
    expect(other.flow.select({ districtId: 'd8', ward: 0, plot: 2 })).toBe(false)
    expect(other.flow.select({ districtId: 'd8', ward: 0, plot: 4 })).toBe(true)
  })

  it('previewing, picking, reviewing, going back and cancelling send nothing and ask the wallet for nothing', async () => {
    const w = await createWorld()
    const before = { requests: w.requests.length, wallet: w.wallet.calls.length, sequence: w.server.sequence }
    w.flow.start('1204')
    w.flow.select({ districtId: 'd8', ward: 0, plot: 0 })
    w.flow.select({ districtId: 'd8', ward: 0, plot: 6 })
    w.flow.clearSelection()
    w.flow.select({ districtId: 'd8', ward: 0, plot: 1 })
    expect(w.flow.review()).toBe(true)
    expect(w.flow.getSnapshot().phase).toBe('review')
    w.flow.back()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'choosing', selected: { ward: 0, plot: 1 } })
    w.flow.review()
    expect(w.flow.cancel()).toBe(true)

    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', friend: null, selected: null, result: null })
    expect(w.requests.length).toBe(before.requests)
    expect(w.wallet.calls.length).toBe(before.wallet)
    expect(w.posts()).toEqual([])
    expect([w.server.sequence, w.server.mutations, w.server.intents.size]).toEqual([before.sequence, 0, 0])
    expect(Object.keys(w.server.game.buildings)).toEqual([])
    expect(w.friend('1204')?.property).toBeNull()
  })

  it('previews the next Ward when every open Ward is full, and choosing in it opens nothing', async () => {
    const w = await createWorld({ game: cityWithFullWard('d8') })
    w.flow.start('1204')
    const offered = availablePlots(w.game(), 'd8')
    expect(offered.every((c) => c.ward === 1 && c.newWard)).toBe(true)
    expect(offered).toHaveLength(wardCapacity(1))
    expect(w.flow.select({ districtId: 'd8', ward: 0, plot: 0 })).toBe(false)
    expect(w.flow.select({ districtId: 'd8', ward: 1, plot: 2 })).toBe(true)
    expect(w.flow.getSnapshot().selected).toEqual({ districtId: 'd8', ward: 1, plot: 2, newWard: true })
    w.flow.review()
    w.flow.cancel()
    expect(w.server.game.wards.d8).toBe(1)
    expect(w.game().wards.d8).toBe(1)
    expect(w.posts()).toEqual([])

    // Confirmed, the exact next-Ward plot goes to the server, which is the one that opens the Ward.
    w.reviewPlot('1204', 1, 2)
    await w.flow.confirm()
    expect(w.intentPosts()[0].body).toEqual({ tokenId: '1204', plotId: 'd8-w1-p2' })
    expect(w.server.game.wards.d8).toBe(2)
    expect(w.flow.getSnapshot().result).toMatchObject({ plotId: 'd8-w1-p2', ward: 1, plot: 2 })
  })

  it('unpicks a plot somebody else takes while it is being looked at', async () => {
    const w = await createWorld()
    w.reviewPlot('1204', 0, 3)
    const taken = newBuilding({ friendId: 5, ownerId: '11111111-2222-3333-4444-555555555555', address: { districtId: 'd8', ward: 0, plot: 3 }, clock: 1 })
    w.server.game = { ...w.server.game, buildings: { [taken.id]: taken } }
    w.server.sequence += 1
    await w.transport.refresh()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'choosing', selected: null, notice: { kind: 'plot-taken', text: MESSAGES.plotTaken } })
    expect(w.posts()).toEqual([])
  })

  it('ends quietly when the session ends while choosing', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.session = null
    await w.identity.refresh()
    expect(w.flow.getSnapshot().phase).toBe('idle')
    expect(w.posts()).toEqual([])
  })
})

describe('confirming: the intent, the signature and the commit', () => {
  it('asks for an intent only on confirm, with the exact Friend and the exact zero-based plot id', async () => {
    const w = await createWorld()
    w.reviewPlot('1204', 0, 0)
    expect(w.intentPosts()).toEqual([])
    await w.flow.confirm()
    expect(w.intentPosts()).toHaveLength(1)
    expect(w.intentPosts()[0].raw).toBe('{"tokenId":"1204","plotId":"d8-w0-p0"}')
  })

  it('hands the wallet the server typed data exactly as sent, through eth_signTypedData_v4', async () => {
    const w = await createWorld()
    w.reviewPlot('1204', 0, 4)
    await w.flow.confirm()
    const issued = [...w.server.intents.values()][0].typedData
    const [request] = w.wallet.signRequests()
    expect(w.wallet.signRequests()).toHaveLength(1)
    expect(request.params).toEqual([ALICE.toLowerCase(), JSON.stringify(issued)])
    const signed = JSON.parse(request.params![1] as string) as ActivationTypedData
    expect(signed).toEqual(issued)
    expect(signed.message).toMatchObject({ tokenId: '1204', plotId: 'd8-w0-p4', ward: 0, plot: 4, districtId: 'd8', familyId: 0, wallet: ALICE })
    // A signature and nothing else: the wallet was never asked to send, approve or switch anything.
    expect(new Set(w.wallet.methods())).toEqual(new Set(['eth_accounts', 'eth_chainId', 'eth_signTypedData_v4']))
  })

  it('commits with exactly the intent id and the signature, then shows the property', async () => {
    const w = await createWorld()
    const reads = { friends: w.friendReads(), city: w.cityReads() }
    w.reviewPlot('1204', 0, 0)
    await w.flow.confirm()

    const intentId = [...w.server.intents.keys()][0]
    expect(w.commitPosts()).toHaveLength(1)
    expect(w.commitPosts()[0].raw).toBe(JSON.stringify({ intentId, signature: SIGNATURE }))
    // Left the flow, pointing at the building the server reported.
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', friend: null, selected: null, step: null, notice: null, result: { seq: 1, tokenId: '1204', buildingId: 'b-1204', districtId: 'd8', ward: 0, plot: 0, plotId: 'd8-w0-p0', existing: false, pending: false } })
    // My Friends and the city were read again, and both show it.
    expect(w.friendReads()).toBeGreaterThan(reads.friends)
    expect(w.cityReads()).toBeGreaterThan(reads.city)
    expect(w.friend('1204')?.property).toMatchObject({ buildingId: 'b-1204', plotId: 'd8-w0-p0' })
    expect(w.game().buildings['b-1204']).toMatchObject({ friendId: 1204, ownerId: USER, districtId: 'd8', ward: 0, plot: 0 })
    // One building, one change, and the Friend cannot be activated twice.
    expect([Object.keys(w.game().buildings), w.server.mutations, w.server.sequence]).toEqual([['b-1204'], 1, 2])
    expect(w.flow.start('1204')).toBe(false)
    expectSignatureKeptNowhere(w)
  })

  it('refuses before asking for anything when the wallet is on another account', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.wallet.selectAccount(BOB)
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'review', notice: { kind: 'account-changed', text: MESSAGES.accountChanged } })
    expect([w.posts(), w.wallet.signRequests()]).toEqual([[], []])
    // Back on the signed-in account, the same review goes through.
    w.wallet.selectAccount(ALICE)
    await w.flow.confirm()
    expect(w.flow.getSnapshot().result).toMatchObject({ buildingId: 'b-1204' })
  })

  it('does not sign when the account changes after the intent was issued', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.intents.push(() => {
      w.wallet.selectAccount(BOB)
      return 'ok'
    })
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'review', notice: { kind: 'account-changed' } })
    expect(w.intentPosts()).toHaveLength(1)
    expect([w.wallet.signRequests(), w.commitPosts(), w.server.mutations]).toEqual([[], [], 0])
  })

  it('refuses on the wrong network, and goes on once the wallet has switched', async () => {
    const w = await createWorld({ wallet: { chainId: 1 } })
    w.reviewPlot('1204')
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'review', notice: { kind: 'wrong-chain', text: MESSAGES.wrongChain } })
    expect([w.posts(), w.wallet.signRequests()]).toEqual([[], []])

    await w.flow.switchChain()
    expect(w.wallet.state.chainId).toBe(4663)
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'review', notice: null })
    await w.flow.confirm()
    expect(w.flow.getSnapshot().result).toMatchObject({ buildingId: 'b-1204' })
  })

  it('refuses when no wallet account is connected to the page', async () => {
    const w = await createWorld({ wallet: { accounts: [] } })
    w.reviewPlot('1204')
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'review', notice: { kind: 'no-wallet' } })
    expect(w.posts()).toEqual([])
  })

  it('a declined signature commits nothing and can be tried again', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.wallet.fail.set('eth_signTypedData_v4', Object.assign(new Error('User rejected the request.'), { code: 4001 }))
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'review', selected: { ward: 0, plot: 0 }, notice: { kind: 'wallet-declined', text: MESSAGES.declined } })
    expect([w.commitPosts(), w.server.mutations]).toEqual([[], 0])

    w.wallet.fail.set('eth_signTypedData_v4', Object.assign(new Error('Request already pending'), { code: -32002 }))
    await w.flow.confirm()
    expect(w.flow.getSnapshot().notice?.kind).toBe('wallet-busy')
    w.wallet.fail.set('eth_signTypedData_v4', new Error('boom'))
    await w.flow.confirm()
    expect(w.flow.getSnapshot().notice?.kind).toBe('wallet-error')
    expect(w.commitPosts()).toEqual([])

    w.wallet.fail.clear()
    await w.flow.confirm()
    expect(w.flow.getSnapshot().result).toMatchObject({ buildingId: 'b-1204' })
    expect(w.server.mutations).toBe(1)
  })

  it('never signs a message that is not the activation that was reviewed', async () => {
    const tampering: ((t: ActivationTypedData) => unknown)[] = [
      (t) => ({ ...t, message: { ...t.message, plotId: 'd8-w0-p1', plot: 1 } }),
      (t) => ({ ...t, message: { ...t.message, tokenId: '812' } }),
      (t) => ({ ...t, message: { ...t.message, wallet: BOB } }),
      (t) => ({ ...t, message: { ...t.message, site: 'https://evil.example' } }),
      (t) => ({ ...t, message: { ...t.message, statement: 'Approve all tokens.' } }),
      (t) => ({ ...t, message: { ...t.message, extra: 'x' } }),
      (t) => ({ ...t, domain: { ...t.domain, chainId: 1 } }),
      (t) => ({ ...t, domain: { ...t.domain, verifyingContract: BOB } }),
      (t) => ({ ...t, types: { ...t.types, PropertyActivation: [...t.types.PropertyActivation, { name: 'spender', type: 'address' }] } }),
      (t) => ({ ...t, primaryType: 'Permit' }),
      () => 'not typed data',
    ]
    for (const tamper of tampering) {
      const w = await createWorld()
      w.server.tamper = tamper
      w.reviewPlot('1204')
      await w.flow.confirm()
      expect(w.flow.getSnapshot(), String(tamper)).toMatchObject({ phase: 'review', notice: { kind: 'unrecognised-intent', text: MESSAGES.unrecognisedIntent } })
      expect([w.wallet.signRequests(), w.commitPosts()], String(tamper)).toEqual([[], []])
    }
  })

  it('isExpectedIntent accepts the real message and compares without repairing it', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    await w.flow.confirm()
    const [intentId, issued] = [...w.server.intents.entries()][0]
    const intent = { intentId, expiresAt: new Date(Number(issued.typedData.message.expiresAt)).toISOString(), typedData: issued.typedData, digest: `0x${'d'.repeat(64)}` }
    const expected = { tokenId: '1204', plotId: 'd8-w0-p0', family: { id: 0, name: 'Skeleton' as const }, wallet: ALICE.toLowerCase(), origin: ORIGIN }
    expect(isExpectedIntent(intent, expected)).toBe(true)
    expect(isExpectedIntent(intent, { ...expected, plotId: 'd8-w0-p1' })).toBe(false)
    expect(isExpectedIntent(intent, { ...expected, family: { id: 1, name: 'Mask' } })).toBe(false)
    expect(isExpectedIntent({ ...intent, expiresAt: '2026-10-09T13:00:00.000Z' }, expected)).toBe(false)
    expect(isExpectedIntent({ ...intent, intentId: 'f'.repeat(64) }, expected)).toBe(false)
  })
})

describe('a wallet answer that is not a 65-byte signature', () => {
  const answers: [string, unknown, number | null][] = [
    ['a contract-wallet blob', `0x${'ab'.repeat(416)}`, 416],
    ['an ERC-6492 wrapper', `0x${'cd'.repeat(700)}${'6492'.repeat(16)}`, 732],
    ['64 bytes', `0x${'ab'.repeat(64)}`, 64],
    ['66 bytes', `0x${'ab'.repeat(66)}`, 66],
    ['an empty answer', '0x', 0],
    ['not hex', 'signature', null],
    ['not text', { r: '0x1', s: '0x2', v: 27 }, null],
    ['nothing', null, null],
  ]
  it.each(answers)('%s is never sent, kept or logged', async (_name, answer, byteLength) => {
    const w = await createWorld({ wallet: { signature: answer } })
    w.reviewPlot('1204')
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'review', selected: { ward: 0, plot: 0 }, notice: { kind: 'unsupported-signing-mode', text: MESSAGES.unsupportedSigning, byteLength } })
    expect(MESSAGES.unsupportedSigning).toContain('This wallet signing mode is not supported yet')
    // The intent was issued; the answer went nowhere.
    expect(w.intentPosts()).toHaveLength(1)
    expect([w.commitPosts(), w.server.mutations]).toEqual([[], 0])
    expect(w.requests.every((r) => typeof answer !== 'string' || answer.length < 4 || !(r.raw ?? '').includes(answer))).toBe(true)
    if (typeof answer === 'string' && answer.length > 10) expectSignatureKeptNowhere(w, answer)
    // Nothing is left to retry with: the only way on is a fresh confirm, or out.
    await w.flow.retryCommit()
    expect(w.commitPosts()).toEqual([])
    expect(w.flow.cancel()).toBe(true)
  })

  it('goes through after the wallet is switched to a standard signature', async () => {
    const w = await createWorld({ wallet: { signature: `0x${'ab'.repeat(416)}` } })
    w.reviewPlot('1204')
    await w.flow.confirm()
    expect(w.flow.getSnapshot().notice?.kind).toBe('unsupported-signing-mode')
    w.wallet.state.signature = SIGNATURE
    await w.flow.confirm()
    expect(w.flow.getSnapshot().result).toMatchObject({ buildingId: 'b-1204' })
    expect(w.commitPosts()).toHaveLength(1)
  })
})

describe('a commit whose answer is lost', () => {
  it('is a success, with no second signature, when My Friends shows the property', async () => {
    const w = await createWorld()
    w.reviewPlot('1204', 0, 2)
    w.server.script.commits.push('lost')
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', result: { tokenId: '1204', buildingId: 'b-1204', plotId: 'd8-w0-p2', existing: false } })
    expect([w.intentPosts().length, w.wallet.signRequests().length, w.commitPosts().length, w.server.mutations]).toEqual([1, 1, 1, 1])
    expect(Object.keys(w.game().buildings)).toEqual(['b-1204'])
    expectSignatureKeptNowhere(w)
  })

  it('also when the server answers that it could not tell what happened', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.commits.push('lost-as-503')
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', result: { buildingId: 'b-1204' } })
    expect([w.intentPosts().length, w.wallet.signRequests().length, w.commitPosts().length, w.server.mutations]).toEqual([1, 1, 1, 1])
  })

  it('sends the same intent and the same signature again when the property is not there', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    // Never arrived, then a bad gateway page, then the real server.
    w.server.script.commits.push('network-error', { status: 502 })
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', result: { buildingId: 'b-1204' } })
    const commits = w.commitPosts()
    expect(commits).toHaveLength(3)
    expect(new Set(commits.map((c) => c.raw)).size).toBe(1)
    expect(commits[0].body).toEqual({ intentId: [...w.server.intents.keys()][0], signature: SIGNATURE })
    // One intent, one signature, one change to the city, and the pauses it was told to take.
    expect([w.intentPosts().length, w.wallet.signRequests().length, w.server.mutations, w.server.intents.size]).toEqual([1, 1, 1, 1])
    expect(w.waits).toEqual([10, 20])
    expectSignatureKeptNowhere(w)
  })

  it('a retry of a commit that had gone through returns the same property and changes nothing more', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    // The commit lands, the answer is lost, and My Friends cannot be read either. The session is as it was.
    w.server.script.commits.push(() => {
      w.server.friendsUnavailable = true
      return 'lost'
    })
    await w.flow.confirm()
    expect(w.commitPosts()).toHaveLength(2)
    expect(new Set(w.commitPosts().map((c) => c.raw)).size).toBe(1)
    // The page could not read it back, and says so; the activation is not in doubt.
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', notice: null, result: { buildingId: 'b-1204', existing: false, pending: true } })
    expect([w.server.mutations, w.wallet.signRequests().length, w.intentPosts().length]).toEqual([1, 1, 1])
    expectSignatureKeptNowhere(w)
  })

  it('when the session ends before the answer arrives, it stops without claiming anything and never signs again', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    // The commit lands and its answer is lost; then the session ends. The server refuses everything after that.
    w.server.script.commits.push(() => {
      w.server.session = null
      return 'lost'
    })
    await w.flow.confirm()
    // The same commit was sent again and refused for want of a session, as the real server refuses it.
    expect(w.commitPosts()).toHaveLength(2)
    expect(new Set(w.commitPosts().map((c) => c.raw)).size).toBe(1)
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'stopped', step: null, result: null, notice: { kind: 'not_authenticated', text: COMMIT_REFUSAL_TEXT.not_authenticated } })
    expect(w.flow.getSnapshot().notice!.text).toBe('Your session ended before Rare City could confirm the activation. Sign in again, then check My Friends before trying again.')
    expectNoFalseClaim(w)
    expect([w.server.mutations, w.wallet.signRequests().length, w.intentPosts().length]).toEqual([1, 1, 1])
    expectSignatureKeptNowhere(w)

    // Signed in again, My Friends says what happened, and the Friend cannot be activated twice.
    expect(w.flow.cancel()).toBe(true)
    w.server.session = ALICE
    await w.identity.refresh()
    await w.identity.loadFriends()
    expect(w.friend('1204')?.property).toMatchObject({ buildingId: 'b-1204', plotId: 'd8-w0-p0' })
    expect(w.flow.start('1204')).toBe(false)
    expect([w.wallet.signRequests().length, w.intentPosts().length]).toEqual([1, 1])
  })

  it('stops after a bounded number of re-sends and can be tried again without signing', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.commits.push('network-error', 'network-error', 'network-error')
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'unresolved', step: null, selected: { ward: 0, plot: 0 }, notice: { kind: 'commit-unknown', text: MESSAGES.commitUnknown } })
    expect(w.commitPosts()).toHaveLength(3)
    expect(w.waits).toEqual([10, 20])
    expectSignatureKeptNowhere(w)

    await w.flow.retryCommit()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', result: { buildingId: 'b-1204' } })
    expect(w.commitPosts()).toHaveLength(4)
    expect(new Set(w.commitPosts().map((c) => c.raw)).size).toBe(1)
    expect([w.intentPosts().length, w.wallet.signRequests().length, w.server.mutations]).toEqual([1, 1, 1])
  })

  it('never loops for ever: the sends for one signature are capped, then the signature is dropped', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    for (let i = 0; i < 50; i++) w.server.script.commits.push('network-error')
    await w.flow.confirm()
    for (let i = 0; i < 20 && w.flow.getSnapshot().phase === 'unresolved'; i++) await w.flow.retryCommit()
    expect(w.commitPosts()).toHaveLength(MAX_COMMIT_SENDS)
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'stopped', notice: { kind: 'commit-unknown', text: MESSAGES.commitExhausted } })
    expect(w.flow.holdsSignature()).toBe(false)
    await w.flow.retryCommit()
    expect(w.commitPosts()).toHaveLength(MAX_COMMIT_SENDS)
    expect([w.intentPosts().length, w.wallet.signRequests().length, w.server.mutations]).toEqual([1, 1, 0])
    expect(w.flow.cancel()).toBe(true)
    expect(w.flow.getSnapshot().phase).toBe('idle')
  })

  it('cannot be cancelled while the signature is on its way, and stopping afterwards forgets it', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    let release!: () => void
    const held = new Promise<void>((done) => (release = done))
    w.server.script.commits.push(async (): Promise<Step> => {
      await held
      return 'network-error'
    })
    w.server.script.commits.push('network-error', 'network-error')
    const running = w.flow.confirm()
    await vi.waitFor(() => expect(w.flow.getSnapshot()).toMatchObject({ phase: 'working', step: 'committing' }))
    expect(w.flow.cancel()).toBe(false)
    expect(w.flow.getSnapshot().phase).toBe('working')
    release()
    await running
    expect(w.flow.getSnapshot().phase).toBe('unresolved')
    expect(w.flow.holdsSignature()).toBe(true)

    const reads = w.friendReads()
    expect(w.flow.cancel()).toBe(true)
    expect(w.flow.holdsSignature()).toBe(false)
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', result: null })
    // Nothing is left to send, and My Friends is read so the page shows what really happened.
    await w.flow.retryCommit()
    expect(w.commitPosts()).toHaveLength(3)
    await vi.waitFor(() => expect(w.friendReads()).toBeGreaterThan(reads))
  })

  it('a cancel while the wallet is open discards whatever the wallet then returns', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.wallet.hooks.beforeSign = () => {
      expect(w.flow.getSnapshot()).toMatchObject({ phase: 'working', step: 'signing' })
      expect(w.flow.cancel()).toBe(true)
    }
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', result: null })
    expect([w.commitPosts(), w.server.mutations]).toEqual([[], 0])
    expectSignatureKeptNowhere(w)
  })
})

describe('what the server refuses', () => {
  it('a plot somebody else took: back to the map with the city read again, and another plot works', async () => {
    const w = await createWorld()
    w.reviewPlot('1204', 0, 0)
    w.server.script.commits.push(() => {
      // Somebody else's activation lands on the same plot first.
      const rival = newBuilding({ friendId: 77, ownerId: '11111111-2222-3333-4444-555555555555', address: { districtId: 'd8', ward: 0, plot: 0 }, clock: 1 })
      w.server.game = { ...w.server.game, buildings: { [rival.id]: rival } }
      w.server.sequence += 1
      return 'ok'
    })
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'choosing', selected: null, friend: { tokenId: '1204' }, districtId: 'd8', notice: { kind: 'plot_unavailable' } })
    expect(w.flow.getSnapshot().notice?.text).toContain('Choose another plot')
    // The taken plot is no longer on offer; a free one is.
    expect(w.game().buildings['b-77']).toBeDefined()
    expect(w.flow.select({ districtId: 'd8', ward: 0, plot: 0 })).toBe(false)
    expect(w.flow.select({ districtId: 'd8', ward: 0, plot: 1 })).toBe(true)
    w.flow.review()
    await w.flow.confirm()
    expect(w.flow.getSnapshot().result).toMatchObject({ buildingId: 'b-1204', plotId: 'd8-w0-p1' })
    expect(w.intentPosts().map((r) => r.body)).toEqual([{ tokenId: '1204', plotId: 'd8-w0-p0' }, { tokenId: '1204', plotId: 'd8-w0-p1' }])
  })

  it('an expired intent needs a fresh review, a fresh intent and a fresh signature', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.commits.push(refusal(410, 'intent_expired'))
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'review', selected: { ward: 0, plot: 0 }, notice: { kind: 'intent_expired' } })
    expect(w.flow.holdsSignature()).toBe(false)
    expect(w.flow.getSnapshot().notice?.text).toContain('Confirm again to start a fresh one')
    // The old signature is gone: there is nothing to re-send.
    await w.flow.retryCommit()
    expect(w.commitPosts()).toHaveLength(1)

    await w.flow.confirm()
    expect(w.flow.getSnapshot().result).toMatchObject({ buildingId: 'b-1204' })
    expect([w.intentPosts().length, w.wallet.signRequests().length, w.commitPosts().length]).toEqual([2, 2, 2])
    expect(w.commitPosts()[0].raw).not.toBe(w.commitPosts()[1].raw)
  })

  it('activation switched off is said plainly, signs nothing, and never spins', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.intents.push(refusal(403, 'activation_disabled'))
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'stopped', step: null, gateClosed: true, result: null, notice: { kind: 'activation_disabled' } })
    expect(w.flow.getSnapshot().notice?.text).toContain('Activation is not open in this city yet')
    expect([w.wallet.signRequests(), w.commitPosts(), w.server.mutations]).toEqual([[], [], 0])
    expect(w.flow.cancel()).toBe(true)
    // Remembered, so My Friends can say so; a later answer is still the server's to give.
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', gateClosed: true })
    expect(w.flow.start('1204')).toBe(true)
  })

  it('ownership the server cannot check is temporary and fails closed', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.intents.push(refusal(503, 'ownership_unavailable'))
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'review', notice: { kind: 'ownership_unavailable' } })
    expect(w.flow.getSnapshot().notice?.text).toMatch(/nothing was activated.*temporary/i)
    expect([w.wallet.signRequests(), w.server.mutations]).toEqual([[], 0])

    // At the commit it is the same answer, and the signature already given can be sent again.
    w.server.script.commits.push(refusal(503, 'ownership_unavailable'))
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'unresolved', notice: { kind: 'ownership_unavailable' } })
    expect([w.commitPosts().length, w.server.mutations]).toEqual([1, 0])
    await w.flow.retryCommit()
    expect(w.flow.getSnapshot().result).toMatchObject({ buildingId: 'b-1204' })
    expect([w.wallet.signRequests().length, w.commitPosts().length, w.server.mutations]).toEqual([1, 2, 1])
    expect(w.commitPosts()[0].raw).toBe(w.commitPosts()[1].raw)
  })

  it('a Friend that turns out to be activated already resolves to its existing property', async () => {
    const w = await createWorld()
    w.reviewPlot('1204', 0, 5)
    w.server.script.intents.push(() => {
      // Another tab activated it a moment ago.
      const b = newBuilding({ friendId: 1204, ownerId: USER, address: { districtId: 'd8', ward: 0, plot: 0 }, clock: 1 })
      w.server.game = { ...w.server.game, buildings: { [b.id]: b } }
      w.server.sequence += 1
      w.server.properties.set('1204', { id: 'prop-1204', buildingId: b.id, districtId: 'd8', ward: 0, plot: 0, plotId: 'd8-w0-p0', activatedAt: '2026-10-09T11:00:00.000Z' })
      return 'ok'
    })
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', result: { tokenId: '1204', buildingId: 'b-1204', plotId: 'd8-w0-p0', existing: true } })
    expect([w.wallet.signRequests(), w.commitPosts()]).toEqual([[], []])
    expect(w.friend('1204')?.property).toMatchObject({ plotId: 'd8-w0-p0' })
    expect(w.game().buildings['b-1204']).toBeDefined()
  })

  it('and says so, without an error loop, when the existing property cannot be read', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.intents.push(refusal(409, 'friend_already_activated'))
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'stopped', notice: { kind: 'friend_already_activated', text: MESSAGES.alreadyActivated } })
  })

  const atIntent: [string, number, string][] = [
    ['not_authenticated', 401, 'stopped'],
    ['unsupported_chain', 400, 'stopped'],
    ['invalid_request', 400, 'review'],
    ['friend_not_owned', 403, 'stopped'],
    ['plot_invalid', 422, 'choosing'],
    ['plot_unavailable', 409, 'choosing'],
    ['ownership_inconsistent', 503, 'review'],
    ['activation_conflict', 409, 'review'],
    ['city_not_activatable', 409, 'stopped'],
    ['city_inconsistent', 503, 'stopped'],
    ['activation_unavailable', 503, 'review'],
    ['rate_limited', 429, 'review'],
    ['origin_mismatch', 403, 'review'],
    ['something_new', 418, 'review'],
  ]
  it.each(atIntent)('%s at the intent lands somewhere the person can act, having signed nothing', async (code, status, phase) => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.intents.push(refusal(status, code))
    await w.flow.confirm()
    const snap = w.flow.getSnapshot()
    expect(snap).toMatchObject({ phase, step: null, notice: { kind: code } })
    expect(snap.selected === null).toBe(phase === 'choosing')
    expect(snap.notice!.text.length).toBeGreaterThan(20)
    // The words are for a person: no code, no table, no stack.
    expect(snap.notice!.text).not.toMatch(/_|sql|select |postgres|exception|stack|0x[0-9a-f]{8}/i)
    expect([w.wallet.signRequests(), w.commitPosts(), w.server.mutations]).toEqual([[], [], 0])
    expect(w.flow.cancel()).toBe(true)
  })

  const atCommit: [string, number, string][] = [
    ['intent_superseded', 409, 'review'],
    ['intent_session_mismatch', 403, 'review'],
    ['intent_expired', 410, 'review'],
    ['signature_invalid', 403, 'review'],
    ['intent_not_found', 404, 'stopped'],
    ['invalid_request', 400, 'stopped'],
    ['unsupported_chain', 400, 'stopped'],
    ['family_mismatch', 409, 'stopped'],
    ['friend_not_owned', 403, 'stopped'],
    ['not_authenticated', 401, 'stopped'],
    ['activation_disabled', 403, 'stopped'],
    ['city_not_activatable', 409, 'stopped'],
    ['city_inconsistent', 503, 'stopped'],
    ['activation_conflict', 409, 'unresolved'],
    ['ownership_unavailable', 503, 'unresolved'],
    ['ownership_inconsistent', 503, 'unresolved'],
  ]
  it.each(atCommit)('%s at the commit is final for that signature unless it can safely be re-sent', async (code, status, phase) => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.commits.push(refusal(status, code))
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase, step: null, notice: { kind: code, text: COMMIT_REFUSAL_TEXT[code] } })
    expect([w.commitPosts().length, w.server.mutations]).toEqual([1, 0])
    // Said after the wallet signed: never that it did not.
    expectNoFalseClaim(w, null)
    // Only an unresolved commit still holds a signature to send.
    await w.flow.retryCommit()
    expect(w.commitPosts().length).toBe(phase === 'unresolved' ? 2 : 1)
    expectSignatureKeptNowhere(w)
  })

  it('every refusal the commit route gives has its own commit-time words and a place to land', () => {
    // The codes `commit` in server/src/activation/service.ts and its route can answer with, less the two that are not refusals here.
    const given = [...atCommit.map(([code]) => code), 'plot_unavailable', 'friend_already_activated'].sort()
    expect(Object.keys(COMMIT_REFUSAL_TEXT).sort()).toEqual(given)
    // Not refusals at the commit: one means "could not tell", the other "wait".
    for (const code of ['activation_unavailable', 'rate_limited', 'plot_invalid']) expect(COMMIT_REFUSAL_TEXT[code], code).toBeUndefined()
  })

  it('a server that cannot be reached for the intent changes nothing and signs nothing', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.intents.push('network-error')
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'review', notice: { kind: 'network', text: MESSAGES.network } })
    expect(w.wallet.signRequests()).toEqual([])
  })
})

describe('wording once the wallet has signed', () => {
  // Checked before the server looks the intent up: they say this send was turned away, and nothing about an earlier one.
  const beforeLookup = ['activation_disabled', 'not_authenticated', 'unsupported_chain', 'invalid_request', 'intent_not_found']

  it('never says nothing was signed or nothing changed, whatever the refusal', () => {
    for (const [code, text] of Object.entries(COMMIT_REFUSAL_TEXT)) {
      expect(text, code).not.toMatch(NEVER_SIGNED)
      expect(text.length, code).toBeGreaterThan(20)
      expect(text, code).not.toMatch(/_|sql|select |postgres|exception|stack|0x[0-9a-f]{8}/i)
    }
    for (const text of [MESSAGES.commitUnknown, MESSAGES.commitExhausted]) {
      expect(text).not.toMatch(NEVER_SIGNED)
      expect(text).not.toMatch(NOT_ACTIVATED)
      expect(text).toContain('My Friends')
    }
  })

  it('says the Friend was not activated only where the refusal proves it, and points at My Friends where it does not', () => {
    for (const code of beforeLookup) {
      expect(COMMIT_REFUSAL_TEXT[code], code).not.toMatch(NOT_ACTIVATED)
      expect(COMMIT_REFUSAL_TEXT[code], code).toMatch(/check My Friends before trying again/i)
    }
    expect(COMMIT_REFUSAL_TEXT.activation_disabled).toBe('Activation is currently disabled, so Rare City could not complete this activation. Check My Friends before trying again.')
    expect(COMMIT_REFUSAL_TEXT.not_authenticated).toBe('Your session ended before Rare City could confirm the activation. Sign in again, then check My Friends before trying again.')
    // These are answered only for an intent that was not committed.
    for (const code of ['intent_expired', 'signature_invalid', 'plot_unavailable']) expect(COMMIT_REFUSAL_TEXT[code], code).toMatch(NOT_ACTIVATED)
  })

  it('activation switched off at the commit: stopped, said as it is, and the signature is gone', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.commits.push(refusal(403, 'activation_disabled'))
    await w.flow.confirm()
    expect(w.wallet.signRequests()).toHaveLength(1)
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'stopped', gateClosed: true, result: null, notice: { kind: 'activation_disabled', text: COMMIT_REFUSAL_TEXT.activation_disabled } })
    // At the intent the same code is said differently, and there it is true: nothing had been signed.
    expect(COMMIT_REFUSAL_TEXT.activation_disabled).not.toContain('Nothing was signed')
    expectNoFalseClaim(w)
    expectSignatureKeptNowhere(w)
    expect(w.flow.cancel()).toBe(true)
  })

  it('a session that expired between the signature and the commit: stopped, and My Friends is where to look', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    // The session runs out while the wallet is open. Nothing is scripted: the server refuses by itself.
    w.wallet.hooks.beforeSign = () => {
      w.server.session = null
    }
    await w.flow.confirm()
    expect(w.commitPosts()).toHaveLength(1)
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'stopped', result: null, notice: { kind: 'not_authenticated', text: COMMIT_REFUSAL_TEXT.not_authenticated } })
    expect([w.server.mutations, w.wallet.signRequests().length, w.intentPosts().length]).toEqual([0, 1, 1])
    expectNoFalseClaim(w)
    expectSignatureKeptNowhere(w)
    // The page learns it is signed out, so My Friends asks for a sign-in rather than offering Activate.
    await vi.waitFor(() => expect(w.identity.getSnapshot().viewer.status).toBe('anonymous'))
  })
})

describe('a commit answer that settles nothing is never a failure', () => {
  const unsettling: [string, Reply][] = [
    ['502 with an unknown JSON code', refusal(502, 'bad_gateway')],
    ['an unknown 4xx code', refusal(400, 'bad_request')],
    ['an unknown 5xx code', refusal(500, 'internal_error')],
    ['a code nobody has heard of', refusal(418, 'something_new')],
    ['a boundary code that is not an activation answer', refusal(403, 'origin_mismatch')],
    ['a known code under a gateway status', refusal(502, 'intent_expired')],
    ['a known code under another wrong status', refusal(500, 'signature_invalid')],
    ['a code the commit route never gives', refusal(422, 'plot_invalid')],
    ['rate_limited under a status that is not 429', refusal(503, 'rate_limited')],
    ['activation_unavailable', refusal(503, 'activation_unavailable')],
    ['a proxy HTML page', { status: 502 }],
    ['malformed JSON in an error', { status: 502, text: '{"error":"intent_exp' }],
    ['an error body that is not an object', { status: 500, json: 'intent_expired' }],
    ['an unreadable 200', { status: 200 }],
    ['malformed JSON in a 200', { status: 200, text: '{"status":"committed","property":' }],
    ['a 200 that is not a commit', { status: 200, json: { ok: true } }],
    ['a 200 with half a property', { status: 200, json: { status: 'committed', property: { tokenId: '1204', plotId: 'd8-w0-p0' }, city: { id: 'main', instance: 'inst-1' } } }],
    ['a 200 for another Friend', { status: 200, json: committedFor('812', 'd4-w0-p0') }],
    ['a 200 for another plot', { status: 200, json: committedFor('1204', 'd8-w0-p5') }],
    ['no answer at all', 'network-error'],
  ]

  it.each(unsettling)('%s, after the commit landed: the property is found and nothing is signed again', async (_name, answer) => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.commits.push({ workThen: answer })
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', notice: null, result: { tokenId: '1204', buildingId: 'b-1204', plotId: 'd8-w0-p0', existing: false, pending: false } })
    // My Friends answered it: one intent, one signature, one commit, one change.
    expect([w.intentPosts().length, w.wallet.signRequests().length, w.commitPosts().length, w.server.mutations, w.server.intents.size]).toEqual([1, 1, 1, 1, 1])
    expect(w.published.some((snap) => snap.notice !== null && w.published.indexOf(snap) > w.published.findIndex((p) => p.step === 'committing'))).toBe(false)
    expectSignatureKeptNowhere(w)
  })

  it.each(unsettling)('%s, with nothing committed: the same intent and signature are kept and sent again', async (_name, answer) => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.commits.push(answer, answer, answer)
    const reads = w.friendReads()
    await w.flow.confirm()
    // Unknown, not failed: still the same try, with the signature held and a way to send it again.
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'unresolved', step: null, result: null, selected: { ward: 0, plot: 0 }, notice: { kind: 'commit-unknown', text: MESSAGES.commitUnknown } })
    expect(w.flow.holdsSignature()).toBe(true)
    expectNoFalseClaim(w)
    // My Friends was read after every one of them, before anything was sent again.
    expect(w.friendReads() - reads).toBe(3)
    expect(w.commitPosts()).toHaveLength(3)
    expect(w.waits).toEqual([10, 20])
    expect([w.intentPosts().length, w.wallet.signRequests().length, w.server.mutations, w.server.intents.size]).toEqual([1, 1, 0, 1])

    await w.flow.retryCommit()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', result: { tokenId: '1204', buildingId: 'b-1204', existing: false } })
    // Four sends of one body: the intent id and the signature never changed, and the wallet was asked once.
    expect(w.commitPosts()).toHaveLength(4)
    expect(new Set(w.commitPosts().map((c) => c.raw))).toEqual(new Set([JSON.stringify({ intentId: [...w.server.intents.keys()][0], signature: SIGNATURE })]))
    expect([w.intentPosts().length, w.wallet.signRequests().length, w.server.mutations, w.server.intents.size]).toEqual([1, 1, 1, 1])
    expectSignatureKeptNowhere(w)
  })

  it('the answers for another Friend and another plot are well formed: it is the mismatch that is refused', () => {
    expect(parseActivationCommitResponse(committedFor('812', 'd4-w0-p0'))).not.toBeNull()
    expect(parseActivationCommitResponse(committedFor('1204', 'd8-w0-p5'))).not.toBeNull()
  })

  it('a committed answer for the wrong Friend points the page nowhere and activates nothing by itself', async () => {
    const w = await createWorld()
    w.reviewPlot('1204', 0, 3)
    w.server.script.commits.push({ status: 200, json: committedFor('812', 'd4-w0-p0') })
    await w.flow.confirm()
    // Not believed. My Friends showed no property, so the same commit went again and the real answer came back.
    expect(w.commitPosts()).toHaveLength(2)
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', result: { seq: 1, tokenId: '1204', buildingId: 'b-1204', plotId: 'd8-w0-p3' } })
    expect(w.published.some((snap) => snap.result?.tokenId === '812' || snap.result?.buildingId === 'b-812')).toBe(false)
    expect(w.friend('812')?.property).toBeNull()
    expect([Object.keys(w.game().buildings), w.server.mutations, w.wallet.signRequests().length]).toEqual([['b-1204'], 1, 1])
  })

  it('after an unknown answer, a refusal is believed only once My Friends has been read: the property there wins', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    // The commit lands, its answer is lost, and My Friends is down for the first look. The re-send is then refused at the gate.
    w.server.script.commits.push(
      () => {
        w.server.friendsUnavailable = true
        return 'lost'
      },
      () => {
        w.server.friendsUnavailable = false
        return refusal(403, 'activation_disabled')
      },
    )
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', notice: null, result: { buildingId: 'b-1204', existing: false, pending: false } })
    expect([w.commitPosts().length, w.server.mutations, w.wallet.signRequests().length, w.intentPosts().length]).toEqual([2, 1, 1, 1])
    expectNoFalseClaim(w)
  })

  it('and where My Friends shows no property, a known refusal is still the definite answer it always was', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.commits.push('network-error', refusal(410, 'intent_expired'))
    const reads = w.friendReads()
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'review', step: null, selected: { ward: 0, plot: 0 }, notice: { kind: 'intent_expired', text: COMMIT_REFUSAL_TEXT.intent_expired } })
    // Read once after the lost answer and once more before the refusal was believed.
    expect(w.friendReads() - reads).toBe(2)
    expect(w.flow.holdsSignature()).toBe(false)
    expect([w.commitPosts().length, w.server.mutations]).toEqual([2, 0])
    // A fresh confirm is a fresh intent and a fresh signature, because the old one is proven dead.
    await w.flow.confirm()
    expect(w.flow.getSnapshot().result).toMatchObject({ buildingId: 'b-1204' })
    expect([w.intentPosts().length, w.wallet.signRequests().length, w.server.mutations]).toEqual([2, 2, 1])
  })
})

describe('finishing never leaves the page waiting', () => {
  const failing: [string, (w: World) => void][] = [
    ['My Friends cannot be read back', (w) => void (w.faults.loadFriends = true)],
    ['the city cannot be read back', (w) => void (w.faults.cityRefresh = true)],
    ['neither can be read back', (w) => void Object.assign(w.faults, { loadFriends: true, cityRefresh: true })],
  ]
  it.each(failing)('a commit succeeds and %s: the flow ends, with the property and an honest "not shown yet"', async (_name, fail) => {
    const w = await createWorld()
    w.reviewPlot('1204', 0, 4)
    w.server.script.commits.push(() => {
      fail(w)
      return 'ok'
    })
    await w.flow.confirm()
    // Out of "Checking with Rare City…", holding nothing, and not a failure: the server's own answer is the result.
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', step: null, notice: null, friend: null, result: { seq: 1, tokenId: '1204', buildingId: 'b-1204', plotId: 'd8-w0-p4', existing: false, pending: true } })
    expect(w.flow.holdsSignature()).toBe(false)
    expect([w.commitPosts().length, w.server.mutations, w.wallet.signRequests().length]).toEqual([1, 1, 1])
    expectSignatureKeptNowhere(w)

    // The person is free: leaving works, and reading again shows what the server already had.
    expect(w.flow.cancel()).toBe(true)
    Object.assign(w.faults, { loadFriends: false, cityRefresh: false })
    await w.identity.loadFriends()
    await w.transport.refresh()
    expect(w.friend('1204')?.property).toMatchObject({ plotId: 'd8-w0-p4' })
    expect(w.game().buildings['b-1204']).toBeDefined()
    expect(w.flow.start('1204')).toBe(false)
    // Another Friend can be activated straight away, and that one is read back.
    w.reviewPlot('812')
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', result: { seq: 2, tokenId: '812', pending: false } })
  })

  it('a lost answer, then every read failing: still ends, as unresolved while unknown and as done once known', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.faults.loadFriends = true
    w.server.script.commits.push('lost')
    await w.flow.confirm()
    // My Friends could not say, so the same commit was sent again and the server reported the property.
    expect(w.commitPosts()).toHaveLength(2)
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', notice: null, result: { buildingId: 'b-1204', existing: false, pending: true } })
    expect([w.server.mutations, w.wallet.signRequests().length]).toEqual([1, 1])
  })

  it('an existing property found while the city cannot be read: ends on that property, not on "Checking"', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.intents.push(() => {
      w.server.properties.set('1204', { id: 'prop-1204', buildingId: 'b-1204', districtId: 'd8', ward: 0, plot: 0, plotId: 'd8-w0-p0', activatedAt: '2026-10-09T11:00:00.000Z' })
      w.faults.cityRefresh = true
      return 'ok'
    })
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', result: { buildingId: 'b-1204', existing: true, pending: true } })
  })

  it('a refusal whose re-read of the city fails still lands where the refusal says', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.commits.push(() => {
      w.faults.cityRefresh = true
      return refusal(409, 'plot_unavailable')
    })
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'choosing', step: null, selected: null, notice: { kind: 'plot_unavailable', text: COMMIT_REFUSAL_TEXT.plot_unavailable } })
    expect(w.flow.holdsSignature()).toBe(false)
    expect(w.flow.cancel()).toBe(true)
  })
})

describe('an answer whose headers arrive and whose body never finishes', () => {
  /** Every state the page showed once the signature had gone, and none of them was a notice. */
  const noticesAfterSending = (w: World) => w.published.slice(w.published.findIndex((snap) => snap.step === 'committing')).filter((snap) => snap.notice !== null)

  it('a commit that landed and answered 200 with a body that stalls: unknown, My Friends is read, and it is the success it was', async () => {
    const w = await createWorld({ timeoutMs: 30 })
    w.reviewPlot('1204', 0, 2)
    w.server.script.commits.push({ workThen: { status: 200, stalled: true } })
    const reads = w.friendReads()
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', step: null, notice: null, result: { tokenId: '1204', buildingId: 'b-1204', plotId: 'd8-w0-p2', existing: false, pending: false } })
    // One intent, one signature, one commit and one change: My Friends answered what the lost body could not.
    expect([w.intentPosts().length, w.wallet.signRequests().length, w.commitPosts().length, w.server.mutations, w.server.intents.size]).toEqual([1, 1, 1, 1, 1])
    expect(w.friendReads()).toBeGreaterThan(reads)
    expect(noticesAfterSending(w)).toEqual([])
    expectSignatureKeptNowhere(w)
  })

  const stalledAs: [string, number][] = [
    ['a success', 200],
    ["one of Rare City's refusals", 403],
    ['an outage', 503],
  ]
  it.each(stalledAs)('a commit answered as %s whose body stalls, with nothing committed: never a failure, and the same signature is sent again', async (_name, status) => {
    const w = await createWorld({ timeoutMs: 30 })
    w.reviewPlot('1204')
    w.server.script.commits.push({ status, stalled: true }, { status, stalled: true }, { status, stalled: true })
    const reads = w.friendReads()
    await w.flow.confirm()
    // Out of the wait by the flow's own deadline, three times over, and still the same try.
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'unresolved', step: null, result: null, selected: { ward: 0, plot: 0 }, notice: { kind: 'commit-unknown', text: MESSAGES.commitUnknown } })
    expect(w.flow.holdsSignature()).toBe(true)
    expectNoFalseClaim(w)
    expect([w.commitPosts().length, w.friendReads() - reads, w.waits]).toEqual([3, 3, [10, 20]])
    expect([w.intentPosts().length, w.wallet.signRequests().length, w.server.mutations, w.server.intents.size]).toEqual([1, 1, 0, 1])

    await w.flow.retryCommit()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', result: { tokenId: '1204', buildingId: 'b-1204', existing: false } })
    expect(new Set(w.commitPosts().map((c) => c.raw))).toEqual(new Set([JSON.stringify({ intentId: [...w.server.intents.keys()][0], signature: SIGNATURE })]))
    expect([w.commitPosts().length, w.intentPosts().length, w.wallet.signRequests().length, w.server.mutations, w.server.intents.size]).toEqual([4, 1, 1, 1, 1])
    expectSignatureKeptNowhere(w)
  })

  it('a commit succeeds and the city answer stalls while it is read back: the flow ends, with the property and an honest "not shown yet"', async () => {
    const w = await createWorld({ timeoutMs: 30 })
    w.reviewPlot('1204', 0, 4)
    w.server.script.commits.push(() => {
      w.server.cityStalls = true
      return 'ok'
    })
    const reads = w.cityReads()
    await w.flow.confirm()
    // Not left on "Checking with Rare City…": each read of the city was given up on in its turn.
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', step: null, notice: null, friend: null, result: { seq: 1, tokenId: '1204', buildingId: 'b-1204', plotId: 'd8-w0-p4', existing: false, pending: true } })
    expect(w.cityReads() - reads).toBe(3)
    expect(w.transport.getSnapshot().connection).toMatchObject({ status: 'stale', message: 'Cannot reach Rare City. Retrying…' })
    expect(w.flow.holdsSignature()).toBe(false)
    expect([w.commitPosts().length, w.server.mutations, w.wallet.signRequests().length, w.intentPosts().length]).toEqual([1, 1, 1, 1])
    expectSignatureKeptNowhere(w)

    // The person is free, and the next read that gets through shows what the server already had.
    expect(w.flow.cancel()).toBe(true)
    w.server.cityStalls = false
    await w.transport.refresh()
    expect(w.game().buildings['b-1204']).toMatchObject({ friendId: 1204, districtId: 'd8', ward: 0, plot: 4 })
    expect(w.flow.start('1204')).toBe(false)
  })

  it('a refusal whose re-read of the city stalls still lands where the refusal says, and drops the signature', async () => {
    const w = await createWorld({ timeoutMs: 30 })
    w.reviewPlot('1204')
    w.server.script.commits.push(() => {
      w.server.cityStalls = true
      return refusal(409, 'plot_unavailable')
    })
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'choosing', step: null, selected: null, notice: { kind: 'plot_unavailable', text: COMMIT_REFUSAL_TEXT.plot_unavailable } })
    expect(w.flow.holdsSignature()).toBe(false)
    expect([w.commitPosts().length, w.server.mutations, w.wallet.signRequests().length]).toEqual([1, 0, 1])
    expect(w.flow.cancel()).toBe(true)
  })

  it('an existing property found while the city answer stalls: ends on that property, not on "Checking"', async () => {
    const w = await createWorld({ timeoutMs: 30 })
    w.reviewPlot('1204')
    w.server.script.intents.push(() => {
      w.server.properties.set('1204', { id: 'prop-1204', buildingId: 'b-1204', districtId: 'd8', ward: 0, plot: 0, plotId: 'd8-w0-p0', activatedAt: '2026-10-09T11:00:00.000Z' })
      w.server.cityStalls = true
      return 'ok'
    })
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', result: { buildingId: 'b-1204', existing: true, pending: true } })
    expect([w.wallet.signRequests(), w.commitPosts()]).toEqual([[], []])
  })
})

describe('a commit turned away by a rate limit', () => {
  it('reads Retry-After as seconds or a date, and as nothing when it is neither', () => {
    const at = Date.parse('2026-10-09T12:00:00.000Z')
    expect(parseRetryAfter('42', at)).toBe(42_000)
    expect(parseRetryAfter(' 7 ', at)).toBe(7_000)
    expect(parseRetryAfter('0', at)).toBe(0)
    expect(parseRetryAfter('Fri, 09 Oct 2026 12:00:30 GMT', at)).toBe(30_000)
    expect(parseRetryAfter('Fri, 09 Oct 2026 11:00:00 GMT', at)).toBe(0)
    for (const header of [null, '', '  ', 'soon', '-5', '1.5', '1e3', '0x10']) expect(parseRetryAfter(header, at), String(header)).toBeNull()
  })

  it('honours Retry-After: nothing is sent before it, however often it is asked, and then the same signature goes', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.commits.push(limited('42'))
    const reads = w.friendReads()
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'unresolved', step: null, result: null, notice: { kind: 'rate_limited', waitSeconds: 42 } })
    expect(w.flow.getSnapshot().notice!.text).toBe('Rare City is limiting how often an activation can be sent. Wait about 42 seconds, then try again.')
    expect(w.flow.holdsSignature()).toBe(true)
    // Not re-sent automatically, no pause taken on its behalf, and (nothing being unaccounted for) My Friends not asked.
    expect([w.commitPosts().length, w.waits, w.friendReads() - reads]).toEqual([1, [], 0])
    expectNoFalseClaim(w)

    // Asked again at once, and again a moment before the time: nothing leaves the page.
    for (let i = 0; i < 25; i++) await w.flow.retryCommit()
    expect(w.commitPosts()).toHaveLength(1)
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'unresolved', notice: { kind: 'rate_limited', waitSeconds: 42 } })
    w.clock.now += 41_000
    await w.flow.retryCommit()
    expect(w.commitPosts()).toHaveLength(1)
    expect(w.flow.getSnapshot().notice).toMatchObject({ kind: 'rate_limited', waitSeconds: 1, text: 'Rare City is limiting how often an activation can be sent. Wait a second, then try again.' })

    // At the time, the same intent and the same signature are sent, and it goes through.
    w.clock.now += 1_000
    await w.flow.retryCommit()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', result: { buildingId: 'b-1204', existing: false } })
    expect(w.commitPosts()).toHaveLength(2)
    expect(new Set(w.commitPosts().map((c) => c.raw)).size).toBe(1)
    expect([w.intentPosts().length, w.wallet.signRequests().length, w.server.mutations]).toEqual([1, 1, 1])
    expectSignatureKeptNowhere(w)
  })

  it('waits a minute when the limit does not say how long, and never longer than the ceiling', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.commits.push(limited(), limited('86400'), limited('0'))
    await w.flow.confirm()
    expect(w.flow.getSnapshot().notice).toMatchObject({ kind: 'rate_limited', waitSeconds: DEFAULT_DEFERRAL_MS / 1000 })
    w.clock.now += DEFAULT_DEFERRAL_MS
    await w.flow.retryCommit()
    expect(w.flow.getSnapshot().notice).toMatchObject({ kind: 'rate_limited', waitSeconds: MAX_DEFERRAL_MS / 1000 })
    w.clock.now += MAX_DEFERRAL_MS
    await w.flow.retryCommit()
    // "Now" from a server that is still refusing is still a wait: at least a second.
    expect(w.flow.getSnapshot().notice).toMatchObject({ kind: 'rate_limited', waitSeconds: 1 })
    await w.flow.retryCommit()
    expect(w.commitPosts()).toHaveLength(3)
  })

  it('does not use up the sends: a signature at its last send survives a run of rate limits and still goes through', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    for (let i = 0; i < MAX_COMMIT_SENDS - 1; i++) w.server.script.commits.push('network-error')
    for (let i = 0; i < MAX_COMMIT_DEFERRALS - 1; i++) w.server.script.commits.push(limited('10'))
    await w.flow.confirm()
    for (let i = 0; i < 40 && w.flow.getSnapshot().phase === 'unresolved'; i++) {
      w.clock.now += 10_000
      await w.flow.retryCommit()
    }
    // Eight sends that got no answer, five that were turned away, and the ninth send landed.
    expect(w.commitPosts()).toHaveLength(MAX_COMMIT_SENDS + MAX_COMMIT_DEFERRALS - 1)
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', notice: null, result: { buildingId: 'b-1204', existing: false } })
    expect(new Set(w.commitPosts().map((c) => c.raw)).size).toBe(1)
    expect([w.intentPosts().length, w.wallet.signRequests().length, w.server.mutations]).toEqual([1, 1, 1])
    expectNoFalseClaim(w)
  })

  it('is bounded: after a fixed number of rate limits it stops, drops the signature, and sends no more', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    for (let i = 0; i < 50; i++) w.server.script.commits.push(limited('5'))
    await w.flow.confirm()
    for (let i = 0; i < 40 && w.flow.getSnapshot().phase === 'unresolved'; i++) {
      w.clock.now += 5_000
      await w.flow.retryCommit()
    }
    expect(w.commitPosts()).toHaveLength(MAX_COMMIT_DEFERRALS)
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'stopped', result: null, notice: { kind: 'commit-unknown', text: MESSAGES.commitExhausted } })
    expect(w.flow.holdsSignature()).toBe(false)
    w.clock.now += 3_600_000
    await w.flow.retryCommit()
    expect(w.commitPosts()).toHaveLength(MAX_COMMIT_DEFERRALS)
    expect([w.intentPosts().length, w.wallet.signRequests().length, w.server.mutations, w.waits]).toEqual([1, 1, 0, []])
    expectNoFalseClaim(w)
    expect(w.flow.cancel()).toBe(true)
  })

  it('never loops on its own: with the clock standing still, one send is all that ever leaves', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    for (let i = 0; i < 10; i++) w.server.script.commits.push(limited('30'))
    await w.flow.confirm()
    for (let i = 0; i < 200; i++) await w.flow.retryCommit()
    expect([w.commitPosts().length, w.waits]).toEqual([1, []])
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'unresolved', notice: { kind: 'rate_limited', waitSeconds: 30 } })
    expect(w.flow.holdsSignature()).toBe(true)
  })

  it('can be stopped while it waits, and stopping forgets the signature', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.commits.push(limited('60'))
    await w.flow.confirm()
    expect(w.flow.holdsSignature()).toBe(true)
    expect(w.flow.cancel()).toBe(true)
    expect(w.flow.holdsSignature()).toBe(false)
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', result: null })
    w.clock.now += 60_000
    await w.flow.retryCommit()
    expect([w.commitPosts().length, w.server.mutations]).toEqual([1, 0])
    expectSignatureKeptNowhere(w)
  })

  it('says nothing about an earlier send: with one unaccounted for, My Friends is read and the property found', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    // The commit lands, its answer is lost, My Friends is down; the re-send is turned away by the limit.
    w.server.script.commits.push(
      () => {
        w.server.friendsUnavailable = true
        return 'lost'
      },
      () => {
        w.server.friendsUnavailable = false
        return limited('20')
      },
    )
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', notice: null, result: { buildingId: 'b-1204', existing: false } })
    expect([w.commitPosts().length, w.server.mutations, w.wallet.signRequests().length]).toEqual([2, 1, 1])
  })

  it("a 429 that is not Rare City's own is a wait too, and proves nothing: My Friends is read", async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.commits.push({ workThen: { status: 429, headers: { 'retry-after': '15' } } })
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', result: { buildingId: 'b-1204' } })
    expect([w.commitPosts().length, w.server.mutations]).toEqual([1, 1])

    const other = await createWorld()
    other.reviewPlot('1204')
    other.server.script.commits.push({ status: 429, headers: { 'retry-after': '15' } })
    const reads = other.friendReads()
    await other.flow.confirm()
    expect(other.flow.getSnapshot()).toMatchObject({ phase: 'unresolved', notice: { kind: 'rate_limited', waitSeconds: 15 } })
    expect([other.commitPosts().length, other.friendReads() - reads, other.waits]).toEqual([1, 1, []])
  })
})

describe('the remembered gate', () => {
  it('is closed by the server saying so and opened again by the server issuing an intent, never by the page', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.intents.push(refusal(403, 'activation_disabled'))
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'stopped', gateClosed: true })
    // Closing, starting again and looking around are the page's doing: they change nothing about the gate.
    w.flow.cancel()
    w.reviewPlot('1204')
    w.flow.back()
    w.flow.review()
    expect(w.flow.getSnapshot().gateClosed).toBe(true)

    // The server issues an intent: activation works. A declined signature does not shut it again.
    w.wallet.fail.set('eth_signTypedData_v4', Object.assign(new Error('User rejected the request.'), { code: 4001 }))
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'review', gateClosed: false, notice: { kind: 'wallet-declined' } })
  })

  it('does not stay closed after a later activation succeeds in the same page', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.intents.push(refusal(403, 'activation_disabled'))
    await w.flow.confirm()
    w.flow.cancel()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', gateClosed: true })

    w.reviewPlot('1204')
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', gateClosed: false, result: { buildingId: 'b-1204', existing: false } })
    // And it closes again only on the server's word.
    w.reviewPlot('812')
    w.server.script.commits.push(refusal(403, 'activation_disabled'))
    await w.flow.confirm()
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'stopped', gateClosed: true })
  })

  it('is not moved by answers that say nothing about the gate', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.intents.push(refusal(403, 'activation_disabled'), refusal(503, 'ownership_unavailable'), 'network-error', refusal(429, 'rate_limited'))
    await w.flow.confirm()
    w.flow.cancel()
    w.reviewPlot('1204')
    for (let i = 0; i < 3; i++) {
      await w.flow.confirm()
      expect(w.flow.getSnapshot()).toMatchObject({ phase: 'review', gateClosed: true })
    }
  })
})

describe('guards against doing it twice', () => {
  it('a double click on confirm makes one intent, one signature and one commit', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    await Promise.all([w.flow.confirm(), w.flow.confirm(), w.flow.confirm()])
    expect(w.flow.getSnapshot()).toMatchObject({ phase: 'idle', result: { seq: 1, buildingId: 'b-1204' } })
    expect([w.intentPosts().length, w.wallet.signRequests().length, w.commitPosts().length, w.server.mutations, w.server.intents.size]).toEqual([1, 1, 1, 1, 1])
    // And once it is done there is no review left to confirm.
    await w.flow.confirm()
    expect([w.intentPosts().length, w.wallet.signRequests().length, w.commitPosts().length]).toEqual([1, 1, 1])
  })

  it('a second confirm while the wallet is open or the commit is in flight starts nothing', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.wallet.hooks.beforeSign = async () => {
      expect(w.flow.getSnapshot()).toMatchObject({ phase: 'working', step: 'signing' })
      await w.flow.confirm()
    }
    w.server.script.commits.push(async (): Promise<Step> => {
      expect(w.flow.getSnapshot()).toMatchObject({ phase: 'working', step: 'committing' })
      await w.flow.confirm()
      return 'ok'
    })
    await w.flow.confirm()
    expect(w.flow.getSnapshot().result).toMatchObject({ buildingId: 'b-1204' })
    expect([w.intentPosts().length, w.wallet.signRequests().length, w.commitPosts().length, w.server.mutations]).toEqual([1, 1, 1, 1])
  })

  it('a double click on "Try again" sends the commit once', async () => {
    const w = await createWorld()
    w.reviewPlot('1204')
    w.server.script.commits.push('network-error', 'network-error', 'network-error')
    await w.flow.confirm()
    expect(w.flow.getSnapshot().phase).toBe('unresolved')
    await Promise.all([w.flow.retryCommit(), w.flow.retryCommit(), w.flow.retryCommit()])
    expect(w.commitPosts()).toHaveLength(4)
    expect([w.intentPosts().length, w.wallet.signRequests().length, w.server.mutations]).toEqual([1, 1, 1])
  })

  it('retryCommit does nothing in any phase but an unresolved commit', async () => {
    const w = await createWorld()
    const quiet = async (phase: string, step: string | null = null) => {
      expect(w.flow.getSnapshot()).toMatchObject({ phase, step })
      const before = [w.posts().length, w.wallet.signRequests().length]
      await w.flow.retryCommit()
      expect([w.posts().length, w.wallet.signRequests().length], phase).toEqual(before)
      expect(w.flow.getSnapshot()).toMatchObject({ phase, step })
    }
    await quiet('idle')
    w.flow.start('1204')
    await quiet('choosing')
    w.flow.select({ districtId: 'd8', ward: 0, plot: 0 })
    w.flow.review()
    await quiet('review')

    // While working: asking for the intent, in the wallet, and with the commit in flight.
    w.server.script.intents.push(async (): Promise<Step> => {
      await quiet('working', 'intent')
      return 'ok'
    })
    w.wallet.hooks.beforeSign = () => quiet('working', 'signing')
    w.server.script.commits.push(async (): Promise<Step> => {
      await quiet('working', 'committing')
      return refusal(403, 'activation_disabled')
    })
    await w.flow.confirm()
    // Stopped: the signature is gone, so there is nothing a retry could send.
    await quiet('stopped')
    expect([w.intentPosts().length, w.wallet.signRequests().length, w.commitPosts().length, w.server.mutations]).toEqual([1, 1, 1, 0])
    w.flow.cancel()
    await quiet('idle')
  })
})
