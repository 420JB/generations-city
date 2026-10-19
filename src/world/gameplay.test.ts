import { describe, expect, it } from 'vitest'
import { compileBrandWorld } from '../brand/core/layout'
import { parsePlayCityConfig } from '../brand/core/playConfig'
import { persistedBrandCityState } from '../brand/core/persisted'
import { loadPersistedBrandCity } from '../brand/load'
import { parsePlayCityResponse, projectWorldDistricts } from '../protocol/play'
import { assetKey, nftAsset, parseAssetKey, type NftAsset } from './asset'
import { emptyWorldCityState, parseWorldCityState, worldCityStateText, type WorldCityState } from './cityState'
import type { World } from './definition'
import { plotCandidatesOf, proposePropertyActivation, replayPropertyActivations, validatePropertyActivation, worldCityProblems, type PropertyTransition } from './gameplay'
import { worldProperty } from './property'

const WORLD_4 = '01890a5d-ac96-774b-bcce-b302099a8057'
const WORLD_6 = '01890a5d-ac96-774b-bcce-b302099a8058'
const contract = (n: number) => `0x${'0'.repeat(36)}${n.toString(16).padStart(4, '0')}`
const district = (key: string) => ({ key, name: key.toUpperCase(), accent: '#5aa9ff', monument: null, proofyRule: null })
/** Four districts, two collections on two chains. */
const DOC_4 = {
  cityName: 'Harborlight',
  brand: { name: 'Harborlight', logo: null },
  capital: { name: 'Beacon Hall', crest: null },
  collections: [
    { key: 'harbor-keepers', chain: 'eip155:8453', contract: contract(0xa001), displayName: 'Harbor Keepers' },
    { key: 'tide-pass', chain: 'eip155:1', contract: contract(0xa002), displayName: 'Tide Pass' },
  ],
  districts: ['lantern-quay', 'tidewater', 'saltmarsh', 'compass-row'].map(district),
}
/** Six districts, three collections on three chains. */
const DOC_6 = {
  ...DOC_4,
  cityName: 'Neon Orchard',
  collections: [
    { key: 'orchard-sprites', chain: 'eip155:8453', contract: contract(0xb001), displayName: 'Orchard Sprites' },
    { key: 'neon-seeds', chain: 'eip155:42161', contract: contract(0xb002), displayName: 'Neon Seeds' },
    { key: 'grove-pass', chain: 'eip155:1', contract: contract(0xb003), displayName: 'Grove Pass' },
  ],
  districts: ['plum', 'citrus', 'fig', 'pear', 'kiwi', 'cherry'].map(district),
}

function worldOf(doc: unknown, worldId: string) {
  const parsed = parsePlayCityConfig(doc, worldId)
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems))
  const compiled = compileBrandWorld(parsed.config)
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.problems))
  return { config: parsed.config, world: compiled.world }
}
const W4 = worldOf(DOC_4, WORLD_4)
const W6 = worldOf(DOC_6, WORLD_6)

const nft = (chain: string, c: string, tokenId: string): NftAsset => nftAsset({ chain, contract: c, tokenId })!
const keeper = (id: number | string) => nft('eip155:8453', contract(0xa001), String(id))
const tide = (id: number | string) => nft('eip155:1', contract(0xa002), String(id))

/** Apply proposals in order, failing loudly. */
function play(world: World, steps: { asset: NftAsset; plotId: string }[], from: WorldCityState = emptyWorldCityState(), sequence = 1) {
  let state = from
  let seq = sequence
  const transitions: PropertyTransition[] = []
  for (const s of steps) {
    const p = proposePropertyActivation(world, state, seq, s)
    if (!p.ok) throw new Error(`${s.plotId}: ${p.reason}`)
    transitions.push(p.transition)
    state = p.transition.state
    seq = p.transition.to
  }
  return { state, sequence: seq, transitions }
}

describe('persistent city gameplay: candidate discovery', () => {
  for (const [label, w, n] of [['four', W4, 4], ['six', W6, 6]] as const)
    it(`offers every plot of the founding ward in each of ${label} districts of an empty city, and nothing else`, () => {
      const plots = plotCandidatesOf(w.world, emptyWorldCityState())
      expect(plots.map((d) => d.districtKey)).toEqual(w.config.districts.map((d) => d.key))
      expect(plots).toHaveLength(n)
      for (const d of plots) {
        expect(d.openWards).toBe(1)
        expect(d.wards).toEqual([{ ward: 0, capacity: d.wards[0].capacity, occupied: 0 }])
        expect(d.candidates.length).toBe(d.wards[0].capacity)
        expect(d.candidates.every((c) => c.ward === 0 && !c.newWard)).toBe(true)
      }
    })

  it('districts of different widths hold different numbers of plots', () => {
    const four = plotCandidatesOf(W4.world, emptyWorldCityState())[0].wards[0].capacity
    const six = plotCandidatesOf(W6.world, emptyWorldCityState())[0].wards[0].capacity
    expect(four).toBeGreaterThan(six)
  })

  it('projects exactly the engine discovery onto the wire, in district order', () => {
    const projected = projectWorldDistricts(W6.world, emptyWorldCityState())
    expect(projected.map((d) => [d.key, d.spanDeg])).toEqual(W6.world.districts.map((d) => [d.key, 60]))
    expect(projected[0].candidates.plotIds[0]).toBe('plum-w0-p0')
    expect(projected[0].candidates.newWard).toBe(false)
    expect(projected[0].geometryFingerprint).toBe(W6.world.districts[0].geometryFingerprint)
  })
})

describe('persistent city gameplay: validation and proposal', () => {
  it('places the NFT on exactly the plot the player chose, and records it all', () => {
    const p = proposePropertyActivation(W4.world, emptyWorldCityState(), 1, { asset: keeper(812), plotId: 'tidewater-w0-p7' })
    expect(p.ok).toBe(true)
    if (!p.ok) return
    const t = p.transition
    const id = worldProperty(W4.world, keeper(812))!.propertyId
    expect(t).toMatchObject({ from: 1, to: 2, plot: { districtKey: 'tidewater', ward: 0, plot: 7, plotId: 'tidewater-w0-p7' } })
    expect(t.state).toEqual({
      version: 2,
      buildings: { [`b-${id}`]: { propertyId: id, asset: 'eip155:8453/erc721:0x000000000000000000000000000000000000a001/812', collection: 'harbor-keepers', districtKey: 'tidewater', ward: 0, plot: 7, sequence: 2 } },
      openWards: {},
    })
    expect(t.event).toEqual({
      propertyId: id,
      buildingId: `b-${id}`,
      asset: 'eip155:8453/erc721:0x000000000000000000000000000000000000a001/812',
      collection: 'harbor-keepers',
      districtKey: 'tidewater',
      ward: 0,
      plot: 7,
      plotId: 'tidewater-w0-p7',
      openedWard: false,
      openWards: 1,
      districtGeometryFingerprint: W4.world.districts[1].geometryFingerprint,
    })
    expect(worldCityProblems(W4.world, t.state)).toEqual([])
  })

  it('refuses what is not allowed, and says why', () => {
    const { state } = play(W4.world, [{ asset: keeper(1), plotId: 'lantern-quay-w0-p0' }])
    const v = (asset: NftAsset, plotId: string) => validatePropertyActivation(W4.world, state, { asset, plotId })
    expect(v(nft('eip155:8453', contract(0xffff), '1'), 'lantern-quay-w0-p1')).toEqual({ ok: false, reason: 'asset-not-in-world' })
    // The same contract on another chain is another collection, not this world's.
    expect(v(nft('eip155:1', contract(0xa001), '1'), 'lantern-quay-w0-p1')).toEqual({ ok: false, reason: 'asset-not-in-world' })
    expect(v(keeper(1), 'lantern-quay-w0-p1')).toEqual({ ok: false, reason: 'asset-already-placed' })
    expect(v(keeper(2), 'lantern-quay-w0-p0')).toEqual({ ok: false, reason: 'plot-unavailable' })
    expect(v(keeper(2), 'nowhere-w0-p0')).toEqual({ ok: false, reason: 'unknown-plot' })
    expect(v(keeper(2), 'lantern-quay-w0-p99999')).toEqual({ ok: false, reason: 'unknown-plot' })
    // Ward 1 is not offered while ward 0 has room.
    expect(v(keeper(2), 'lantern-quay-w1-p0')).toEqual({ ok: false, reason: 'plot-unavailable' })
    expect(v({ ...keeper(2), tokenId: '02' }, 'lantern-quay-w0-p1')).toEqual({ ok: false, reason: 'invalid-asset' })
    expect(v(keeper(2), 'lantern-quay-w0-p1')).toMatchObject({ ok: true, plot: { plotId: 'lantern-quay-w0-p1' }, openedWard: false, openWards: 1 })
  })

  it('accepts the whole uint256 range and keeps every collection apart', () => {
    const max = (1n << 256n) - 1n
    const { state } = play(W4.world, [
      { asset: keeper(max.toString()), plotId: 'saltmarsh-w0-p0' },
      { asset: tide(max.toString()), plotId: 'saltmarsh-w0-p1' },
      { asset: keeper((max - 1n).toString()), plotId: 'saltmarsh-w0-p2' },
    ])
    const buildings = Object.values(state.buildings)
    expect(buildings.map((b) => b.collection)).toEqual(['harbor-keepers', 'tide-pass', 'harbor-keepers'])
    expect(new Set(buildings.map((b) => b.propertyId)).size).toBe(3)
    expect(parseAssetKey(buildings[0].asset)?.tokenId).toBe(max.toString())
  })

  it('gives the same NFT a different property in every world', () => {
    const shared = { ...DOC_6, collections: [...DOC_6.collections, DOC_4.collections[0]] }
    const other = worldOf(shared, WORLD_6)
    const a = proposePropertyActivation(W4.world, emptyWorldCityState(), 1, { asset: keeper(7), plotId: 'tidewater-w0-p0' })
    const b = proposePropertyActivation(other.world, emptyWorldCityState(), 1, { asset: keeper(7), plotId: 'plum-w0-p0' })
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) expect(a.transition.property.propertyId).not.toBe(b.transition.property.propertyId)
  })
})

describe('persistent city gameplay: deterministic ward progression', () => {
  it('opens the next ward only when every open ward is full, and only by placing a property in it', () => {
    const w = W6.world
    const ward0 = plotCandidatesOf(w, emptyWorldCityState())[0].candidates
    // Fill ward 0 of the first district, out of order, on the exact plots chosen.
    const order = [...ward0].reverse()
    const filled = play(w, order.map((c, i) => ({ asset: nft('eip155:8453', contract(0xb001), String(100 + i)), plotId: c.plotId })))
    const after = plotCandidatesOf(w, filled.state)[0]
    expect(after.openWards).toBe(1)
    expect(after.wards).toEqual([{ ward: 0, capacity: ward0.length, occupied: ward0.length }])
    expect(after.candidates.length).toBeGreaterThan(ward0.length)
    expect(after.candidates.every((c) => c.ward === 1 && c.newWard)).toBe(true)
    expect(filled.state.openWards).toEqual({})
    // Ward 2 is never offered, and the next ward is opened by the player's exact choice in it.
    expect(validatePropertyActivation(w, filled.state, { asset: nft('eip155:1', contract(0xb003), '1'), plotId: 'plum-w2-p0' })).toEqual({ ok: false, reason: 'plot-unavailable' })
    const opened = proposePropertyActivation(w, filled.state, filled.sequence, { asset: nft('eip155:1', contract(0xb003), '1'), plotId: 'plum-w1-p5' })
    expect(opened.ok && opened.transition.event).toMatchObject({ openedWard: true, openWards: 2, plotId: 'plum-w1-p5' })
    if (!opened.ok) return
    expect(opened.transition.state.openWards).toEqual({ plum: 2 })
    const next = plotCandidatesOf(w, opened.transition.state)[0]
    expect(next.openWards).toBe(2)
    expect(next.candidates.every((c) => c.ward === 1 && !c.newWard)).toBe(true)
    expect(next.candidates.map((c) => c.plotId)).not.toContain('plum-w1-p5')
    // The other districts are untouched.
    expect(plotCandidatesOf(w, opened.transition.state).slice(1).every((d) => d.openWards === 1 && d.wards[0].occupied === 0)).toBe(true)
  })

  it('gives byte-identical states for the same proposals, and replay rebuilds them', () => {
    const steps = [
      { asset: keeper(1), plotId: 'compass-row-w0-p3' },
      { asset: tide(9), plotId: 'lantern-quay-w0-p0' },
      { asset: keeper(2), plotId: 'compass-row-w0-p0' },
    ]
    const a = play(W4.world, steps)
    const b = play(W4.world, steps)
    expect(worldCityStateText(a.state)).toBe(worldCityStateText(b.state))
    const replay = replayPropertyActivations(steps.map((s, i) => ({ world: W4.world, request: s, sequence: i + 2 })))
    expect(replay.ok).toBe(true)
    if (replay.ok) {
      expect(worldCityStateText(replay.state)).toBe(worldCityStateText(a.state))
      expect(replay.transitions.map((t) => t.event)).toEqual(a.transitions.map((t) => t.event))
    }
    // Stored order is activation order.
    expect(Object.values(a.state.buildings).map((b) => b.sequence)).toEqual([2, 3, 4])
  })

  it('refuses a replay that is out of order, has a gap, or repeats a plot or an NFT', () => {
    const r = (steps: [NftAsset, string, number][]) => replayPropertyActivations(steps.map(([asset, plotId, sequence]) => ({ world: W4.world, request: { asset, plotId }, sequence })))
    expect(r([[keeper(1), 'tidewater-w0-p0', 3]])).toMatchObject({ ok: false, index: 0 })
    expect(r([[keeper(1), 'tidewater-w0-p0', 2], [keeper(2), 'tidewater-w0-p1', 4]])).toMatchObject({ ok: false, index: 1 })
    expect(r([[keeper(1), 'tidewater-w0-p0', 2], [keeper(2), 'tidewater-w0-p0', 3]])).toMatchObject({ ok: false, index: 1, detail: expect.stringContaining('plot-unavailable') })
    expect(r([[keeper(1), 'tidewater-w0-p0', 2], [keeper(1), 'tidewater-w0-p1', 3]])).toMatchObject({ ok: false, index: 1, detail: expect.stringContaining('asset-already-placed') })
    expect(r([[keeper(1), 'tidewater-w1-p0', 2]])).toMatchObject({ ok: false, index: 0, detail: expect.stringContaining('plot-unavailable') })
  })
})

describe('persistent city gameplay: impossible states are refused, never repaired', () => {
  const base = play(W4.world, [
    { asset: keeper(1), plotId: 'tidewater-w0-p0' },
    { asset: tide(2), plotId: 'tidewater-w0-p1' },
  ]).state
  const [k1, k2] = Object.keys(base.buildings)
  const tamper = (f: (s: { version: 2; buildings: Record<string, Record<string, unknown>>; openWards: Record<string, number> }) => void): WorldCityState => {
    const copy = structuredClone(base) as never
    f(copy)
    return copy
  }

  it('finds nothing wrong with a state the engine made', () => {
    expect(worldCityProblems(W4.world, base)).toEqual([])
  })

  for (const [label, state, pattern] of [
    ['a building on a plot that does not exist', tamper((s) => (s.buildings[k1].plot = 99999)), /not a plot of this world/],
    ['two buildings on one plot', tamper((s) => (s.buildings[k2].plot = 0)), /two buildings stand on/],
    ['a property id that is not its NFT', tamper((s) => (s.buildings[k1].asset = 'eip155:8453/erc721:0x000000000000000000000000000000000000a001/3')), /does not carry its NFT's property id/],
    ['an NFT under another collection key', tamper((s) => (s.buildings[k1].collection = 'tide-pass')), /names collection tide-pass/],
    ['an NFT from no collection of the world', tamper((s) => (s.buildings[k1].asset = 'eip155:8453/erc721:0x000000000000000000000000000000000000ffff/1')), /not from a collection of this world/],
    ['a ward opened with nothing in it', tamper((s) => (s.openWards.tidewater = 2)), /records 2 open wards/],
    ['a ward in use that is not open', tamper((s) => (s.buildings[k1].ward = 1)), /not open|records 1 open wards/],
    ['buildings out of activation order', tamper((s) => ((s.buildings[k1].sequence = 3), (s.buildings[k2].sequence = 2))), /activation order/],
  ] as const)
    it(`detects ${label}`, () => {
      expect(worldCityProblems(W4.world, state).join('; ')).toMatch(pattern)
      expect(() => plotCandidatesOf(W4.world, state)).toThrow(/Impossible world city state/)
      expect(() => proposePropertyActivation(W4.world, state, 3, { asset: keeper(5), plotId: 'saltmarsh-w0-p0' })).toThrow(/Impossible world city state/)
    })

  it('reads only exact stored shapes', () => {
    expect(parseWorldCityState(JSON.parse(worldCityStateText(base)))).toEqual(base)
    expect(parseWorldCityState({ version: 2, buildings: {}, openWards: {} })).toBeNull()
    expect(parseWorldCityState({ version: 1, buildings: base.buildings, openWards: {} })).toBeNull()
    expect(parseWorldCityState({ ...base, extra: 1 })).toBeNull()
    expect(parseWorldCityState({ ...base, version: 3 })).toBeNull()
    expect(parseWorldCityState({ ...base, openWards: { tidewater: 1 } })).toBeNull()
    expect(parseWorldCityState({ ...base, buildings: { 'b-wrong': base.buildings[k1] } })).toBeNull()
    expect(parseWorldCityState({ ...base, buildings: { [k1]: { ...base.buildings[k1], owner: 'x' } } })).toBeNull()
    expect(parseWorldCityState({ ...base, buildings: { [k1]: { ...base.buildings[k1], sequence: 1 } } })).toBeNull()
    expect(parseWorldCityState({ ...base, buildings: { [k1]: { ...base.buildings[k1], asset: 'eip155:8453/erc721:0x000000000000000000000000000000000000A001/1' } } })).toBeNull()
  })
})

describe('persistent city as drawn and read', () => {
  const { state } = play(W4.world, [
    { asset: keeper(812), plotId: 'tidewater-w0-p0' },
    { asset: tide(3), plotId: 'lantern-quay-w0-p2' },
  ])

  it('draws each property as a Tier 0 building on its plot, with nothing invented', () => {
    const drawn = persistedBrandCityState(W4.config, state)
    const [b] = Object.values(drawn.buildings)
    expect(b).toMatchObject({ districtId: 'tidewater', ward: 0, plot: 0, ownerBuilt: 0, ownerId: '', fixtures: [], milestones: [], patrons: {} })
    expect(Object.values(drawn.nfts)).toEqual([
      { collection: 'harbor-keepers', tokenId: '812' },
      { collection: 'tide-pass', tokenId: '3' },
    ])
    expect(drawn.users).toEqual({})
    expect(drawn.crown.holder).toBeNull()
    expect(drawn.capital.holder).toBeNull()
    expect(Object.values(drawn.monuments).every((m) => m.holder === null)).toBe(true)
    expect(drawn.wards).toEqual({ 'lantern-quay': 1, tidewater: 1, saltmarsh: 1, 'compass-row': 1 })
  })

  it('loads a stored state only if the engine finds it possible on the founding geometry', () => {
    expect(loadPersistedBrandCity(W4.config, state, W4.world.layout.geometryFingerprint).ok).toBe(true)
    const bad = structuredClone(state) as { buildings: Record<string, { plot: number }> }
    Object.values(bad.buildings)[0].plot = 99999
    const refused = loadPersistedBrandCity(W4.config, bad as never, W4.world.layout.geometryFingerprint)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.problems[0]).toMatchObject({ path: 'state' })
  })

  it('reads a city answer with properties and its district projection, and refuses a malformed projection', () => {
    const body = {
      play: { environment: 'dev', gameKey: 'rare-city', installationId: '01a14800-0000-7000-8000-00000000000a', discordGuildId: '900000000000000001', configVersion: 1, configHash: 'a'.repeat(64), schemaVersion: 1 },
      viewer: {
        authenticated: true,
        player: { discordUserId: '111111111111111111', coreUserId: 'core-ada', displayName: 'Ada' },
        session: { ref: '01a14800-0000-4000-8000-000000000001', expiresAt: new Date().toISOString(), renewal: 'relaunch' },
        status: {
          guildMember: { status: 'unknown', reason: 'not-checked' },
          playEntitled: { status: 'unknown', reason: 'not-checked' },
          installationActive: { status: 'unknown', reason: 'not-checked' },
          brandAdmin: { status: 'unknown', reason: 'not-in-contract' },
          districtRules: { status: 'unknown', reason: 'not-checked' },
        },
        permissions: { viewCity: true, claim: false, build: false },
        originalActivations: [Object.values(state.buildings)[0].propertyId],
      },
      world: {
        id: WORLD_4,
        provisioned: true,
        created: false,
        foundedAt: new Date().toISOString(),
        sequence: 3,
        definition: { foundingConfigVersion: 1, governingConfigVersion: 1, layoutKey: 'standard-radial-even', geometryFingerprint: W4.world.layout.geometryFingerprint, districtGeometry: { frozen: true, atSequence: 2, configVersion: 1 } },
        state: JSON.parse(worldCityStateText(state)),
        districts: projectWorldDistricts(W4.world, state),
      },
      config: DOC_4,
    }
    const parsed = parsePlayCityResponse(JSON.parse(JSON.stringify(body)))
    expect(parsed?.world.state).toEqual(state)
    expect(parsed?.world.districts).toEqual(projectWorldDistricts(W4.world, state))
    expect(parsed?.world.districts[1].wards[0].occupied).toBe(1)
    expect(parsePlayCityResponse({ ...body, world: { ...body.world, districts: [] } })).toBeNull()
    expect(parsePlayCityResponse({ ...body, world: { ...body.world, districts: [{ ...body.world.districts[0], candidates: { plotIds: ['../x'], newWard: false } }] } })).toBeNull()
    expect(parsePlayCityResponse({ ...body, world: { ...body.world, districts: undefined } })).toBeNull()
    // A city with properties has frozen its geometry; one that says otherwise is not this city.
    expect(parsePlayCityResponse({ ...body, world: { ...body.world, definition: { ...body.world.definition, districtGeometry: { frozen: false } } } })).toBeNull()
    expect(parsed?.viewer.originalActivations).toEqual([Object.values(state.buildings)[0].propertyId])
    expect(assetKey(keeper(812))).toBe(state.buildings[Object.keys(state.buildings)[0]].asset)
  })
})
