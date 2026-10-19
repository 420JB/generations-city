import { describe, expect, it } from 'vitest'
import { emptyWorldCityState, parseWorldCityState, WORLD_CITY_STATE_VERSION } from '../../world/cityState'
import {
  establishedCollections,
  evolutionProblems,
  geometryOf,
  geometryProblems,
  governingProblems,
  judgeWorldConfig,
  judgeWorldConfigAs,
  parseWorldFoundation,
  parseWorldGeometry,
  sameFoundation,
  sameGeometry,
  WORLD_CONFIG_JUDGE,
  WORLD_CONFIG_JUDGE_V2,
  type FoundationCollection,
  type WorldFoundation,
} from './evolution'
import type { PlayCityDocument } from './playConfig'

const WORLD = '0199f1a2-7c3d-7e4f-8a5b-6c7d8e9f0a1b'
const OTHER_WORLD = '0199f1a2-7c3d-7e4f-8a5b-6c7d8e9f0a1c'

/** A Rare City Play document (schema v1), as an admin publishes it. */
function doc(): Doc {
  return {
    cityName: 'Harborlight',
    brand: { name: 'Harborlight Collective', logo: '/brand-media/samples/harborlight-logo.svg' },
    capital: { name: 'Beacon Hall', crest: null },
    collections: [{ key: 'keepers', chain: 'eip155:8453', contract: '0x000000000000000000000000000000000000a001', displayName: 'Harbor Keepers' }],
    districts: [
      { key: 'quay', name: 'Lantern Quay', accent: '#ff9f43', monument: { collection: 'keepers', tokenId: '1004', artwork: null }, proofyRule: null },
      { key: 'tide', name: 'Tidewater', accent: '#2ec4b6', monument: null, proofyRule: null },
      { key: 'compass', name: 'Compass Row', accent: '#5aa9ff', monument: null, proofyRule: { verificationRuleId: 41, label: 'Verified Captain role' } },
      { key: 'gull', name: 'Gull Point', accent: '#c8a2ff', monument: null, proofyRule: null },
    ],
  }
}
type Doc = PlayCityDocument

function founded(document: Doc = doc()): { foundation: WorldFoundation; known: FoundationCollection[] } {
  const j = judgeWorldConfig(document, WORLD, null)
  if (j.verdict !== 'accepted') throw new Error('fixture invalid')
  return { foundation: j.foundation, known: j.foundation.collections }
}

const judgeAgainst = (prior: ReturnType<typeof founded>, change: (d: Doc) => void) => {
  const d = doc()
  change(d)
  return judgeWorldConfig(d, WORLD, prior.foundation)
}

describe('a world\'s foundation', () => {
  it('records the layout, every district\'s geometry in order, and the collections', () => {
    const { foundation } = founded()
    expect(foundation.layout.key).toBe('standard-radial-even')
    expect(foundation.layout.geometryFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(foundation.districts.map((d) => d.key)).toEqual(['quay', 'tide', 'compass', 'gull'])
    expect(foundation.collections).toEqual([{ key: 'keepers', chain: 'eip155:8453', contract: '0x000000000000000000000000000000000000a001' }])
  })

  it('does not depend on the world id or on presentation', () => {
    const a = judgeWorldConfig(doc(), WORLD, null)
    const d = doc()
    d.cityName = 'Other'
    d.districts[0].accent = '#000000'
    const b = judgeWorldConfig(d, OTHER_WORLD, null)
    if (a.verdict !== 'accepted' || b.verdict !== 'accepted') throw new Error('invalid')
    expect(sameFoundation(a.foundation, b.foundation)).toBe(true)
  })

  it('reads back exactly what it stores, and nothing else', () => {
    const { foundation } = founded()
    expect(parseWorldFoundation(JSON.parse(JSON.stringify(foundation)))).toEqual(foundation)
    expect(parseWorldFoundation({ ...foundation, extra: 1 })).toBeNull()
    expect(parseWorldFoundation({ ...foundation, districts: [] })).toBeNull()
    expect(parseWorldFoundation({ ...foundation, layout: { ...foundation.layout, geometryFingerprint: 'ABC' } })).toBeNull()
    expect(parseWorldFoundation({ ...foundation, districts: [foundation.districts[0], foundation.districts[0]] })).toBeNull()
    expect(parseWorldFoundation({ ...foundation, collections: [{ ...foundation.collections[0], contract: '0x000000000000000000000000000000000000A001' }] })).toBeNull()
    expect(parseWorldFoundation(null)).toBeNull()
  })
})

describe('judging a configuration for a world', () => {
  it('founds on a valid document and refuses an invalid one as invalid', () => {
    expect(judgeWorldConfig(doc(), WORLD, null).verdict).toBe('accepted')
    const bad = judgeWorldConfig({ ...doc(), camera: { zoom: 2 } }, WORLD, null)
    expect(bad).toMatchObject({ verdict: 'rejected', code: 'config_invalid', problems: [{ path: 'camera' }] })
    expect(judgeWorldConfig(doc(), 'rare-city', null)).toMatchObject({ verdict: 'rejected', code: 'config_invalid' })
  })

  it('accepts any presentation change: names, accents, media, monuments and rules', () => {
    const prior = founded()
    const j = judgeAgainst(prior, (d) => {
      d.cityName = 'Harborlight Reach'
      d.brand = { name: 'Harborlight', logo: null }
      d.capital = { name: 'Lighthouse', crest: '/brand-media/samples/harborlight-logo.svg' }
      d.collections[0].displayName = 'Keepers'
      d.districts[0] = { ...d.districts[0], name: 'Old Quay', accent: '#123456', monument: null }
      d.districts[1].proofyRule = { verificationRuleId: 7, label: 'Holder' }
      d.districts[2].proofyRule = null
    })
    expect(j.verdict).toBe('accepted')
    if (j.verdict === 'accepted') expect(sameFoundation(j.foundation, prior.foundation)).toBe(true)
  })

  it('accepts a new collection: several collections share one city', () => {
    const j = judgeAgainst(founded(), (d) => d.collections.push({ key: 'gulls', chain: 'eip155:1', contract: '0x000000000000000000000000000000000000b002', displayName: 'Gulls' }))
    expect(j.verdict).toBe('accepted')
  })

  const moved: [string, (d: Doc) => void, string][] = [
    ['reordered districts', (d) => d.districts.reverse(), 'would move'],
    ['an added district', (d) => d.districts.push({ key: 'reef', name: 'Reef', accent: '#aaaaaa', monument: null, proofyRule: null }), 'cannot be added'],
    ['a removed district', (d) => d.districts.pop(), 'cannot be removed'],
    ['a renamed district key', (d) => (d.districts[1].key = 'tides'), 'cannot be removed or renamed'],
  ]
  for (const [label, change, says] of moved) {
    it(`accepts ${label} (geometry is not part of a verdict), refuses it as governing once a property froze the geometry, and world-evolution-v2 rejected it`, () => {
      const prior = founded()
      const j = judgeAgainst(prior, change)
      expect(j.verdict).toBe('accepted')
      if (j.verdict !== 'accepted') return
      expect(sameGeometry(j.foundation, prior.foundation)).toBe(false)
      // Before any property: nothing is frozen, so it may govern.
      expect(governingProblems(prior.known, j.foundation, null)).toEqual([])
      // After the first property: the frozen geometry is the founding one here, and it cannot move.
      const frozen = governingProblems(prior.known, j.foundation, geometryOf(prior.foundation))
      expect(frozen.length).toBeGreaterThan(0)
      expect(frozen.map((p) => p.detail).join(' | ')).toContain(says)
      expect(frozen.map((p) => p.detail).join(' | ')).toMatch(/first property/)
      // The old judge's rule, kept to check its recorded verdicts.
      const d = doc()
      change(d)
      expect(judgeWorldConfigAs(WORLD_CONFIG_JUDGE_V2, d, WORLD, prior.foundation)).toMatchObject({ verdict: 'rejected', code: 'config_incompatible' })
      expect(geometryProblems(prior.foundation, j.foundation, 'founding').map((p) => p.detail).join(' | ')).toContain(says)
    })
  }

  it('freezes on whatever geometry governed the first property, not the founding one', () => {
    const prior = founded()
    const six = judgeAgainst(prior, (d) => d.districts.push({ key: 'reef', name: 'Reef', accent: '#aaaaaa', monument: null, proofyRule: null }, { key: 'dune', name: 'Dune', accent: '#bbbbbb', monument: null, proofyRule: null }))
    if (six.verdict !== 'accepted') throw new Error('six districts should be a valid city')
    expect(six.foundation.districts).toHaveLength(6)
    const frozen = geometryOf(six.foundation)
    // The six-district version, renamed and recoloured, still governs; the founding four-district version no longer can.
    const recoloured = judgeAgainst(prior, (d) => {
      d.cityName = 'Harborlight Six'
      d.districts.push({ key: 'reef', name: 'Coral Reef', accent: '#000000', monument: null, proofyRule: null }, { key: 'dune', name: 'Dunes', accent: '#111111', monument: null, proofyRule: null })
    })
    if (recoloured.verdict !== 'accepted') throw new Error('invalid')
    expect(governingProblems(prior.known, recoloured.foundation, frozen)).toEqual([])
    expect(governingProblems(prior.known, prior.foundation, frozen).map((p) => p.detail)).toContain('the city was fixed by its first property with 6 districts; their number cannot change')
  })

  const incompatible: [string, (d: Doc) => void, string][] = [
    ['a removed collection', (d) => (d.collections[0] = { key: 'gulls', chain: 'eip155:1', contract: '0x000000000000000000000000000000000000b002', displayName: 'Gulls' }), 'cannot be removed'],
    ['a collection pointed at another contract', (d) => (d.collections[0].contract = '0x000000000000000000000000000000000000a002'), 'cannot be pointed at another contract'],
    ['a collection moved to another chain', (d) => (d.collections[0].chain = 'eip155:1'), 'cannot be pointed at another contract'],
  ]
  for (const [label, change, says] of incompatible) {
    it(`rejects ${label} as incompatible, saying why`, () => {
      const j = judgeAgainst(founded(), (d) => {
        change(d)
        // Monuments must still name a collection of the document, or the document is merely invalid.
        for (const x of d.districts) if (x.monument && !d.collections.some((c) => c.key === x.monument!.collection)) x.monument = null
      })
      expect(j.verdict).toBe('rejected')
      if (j.verdict !== 'rejected') return
      expect(j.code).toBe('config_incompatible')
      expect(j.problems.map((p) => p.detail).join(' | ')).toContain(says)
    })
  }

  it('rejects a contract re-entered under a new key', () => {
    const j = judgeAgainst(founded(), (d) => d.collections.push({ ...d.collections[0], key: 'keepers-2', displayName: 'Again' }))
    // The document itself refuses a repeated contract before the world is asked.
    expect(j).toMatchObject({ verdict: 'rejected', code: 'config_invalid' })
    const prior = founded()
    const moved = evolutionProblems(prior.foundation, prior.known, { ...prior.foundation, collections: [{ ...prior.known[0], key: 'renamed' }] })
    expect(moved.map((p) => p.detail)).toEqual(['collection keepers is part of this city and cannot be removed', 'this contract is already in this city as collection keepers'])
  })

  it('judges a version against the foundation alone, so no other version can change its verdict', () => {
    const prior = founded()
    // A version without a collection some other version added is still a valid city on this foundation.
    expect(judgeAgainst(prior, () => undefined).verdict).toBe('accepted')
    const withGulls = judgeAgainst(prior, (d) => d.collections.push({ key: 'gulls', chain: 'eip155:1', contract: '0x000000000000000000000000000000000000b002', displayName: 'Gulls' }))
    expect(withGulls.verdict).toBe('accepted')
    // So is a version naming a non-founding key for another contract: whether it may GOVERN is a separate question.
    expect(judgeAgainst(prior, (d) => d.collections.push({ key: 'gulls', chain: 'eip155:1', contract: '0x000000000000000000000000000000000000b003', displayName: 'Gulls' })).verdict).toBe('accepted')
  })

  it('lets a version govern only if it keeps every collection the governing history established', () => {
    const prior = founded()
    const gulls = { key: 'gulls', chain: 'eip155:1', contract: '0x000000000000000000000000000000000000b002' }
    const established = establishedCollections(prior.foundation, [[...prior.known, gulls]])
    expect(established).toEqual([...prior.known, gulls])
    // The founding document again (an older version re-activated, or the same content re-published) cannot govern.
    expect(governingProblems(established, prior.foundation, null)).toEqual([{ path: 'collections', detail: 'collection gulls is part of this city and cannot be removed' }])
    // Nor can one pointing gulls elsewhere, or naming its contract under another key.
    expect(governingProblems(established, { ...prior.foundation, collections: [...prior.known, { ...gulls, contract: '0x000000000000000000000000000000000000b003' }] }, null).map((p) => p.detail)).toEqual([
      'collection gulls names eip155:1 0x000000000000000000000000000000000000b002 in this city; a collection key cannot be pointed at another contract',
    ])
    expect(governingProblems(established, { ...prior.foundation, collections: [...prior.known, gulls, { ...gulls, key: 'terns' }] }, null).map((p) => p.detail)).toEqual(['this contract is already in this city as collection gulls'])
    // Keeping it, and adding more, governs.
    expect(governingProblems(established, { ...prior.foundation, collections: [...prior.known, gulls, { key: 'terns', chain: 'eip155:1', contract: '0x000000000000000000000000000000000000b004' }] }, geometryOf(prior.foundation))).toEqual([])
    // A key keeps the first contract the history gave it.
    expect(establishedCollections(prior.foundation, [[gulls], [{ ...gulls, contract: '0x000000000000000000000000000000000000b003' }]])).toEqual([...prior.known, gulls])
  })

  it('names its rules, and judges again only by rules it has', () => {
    expect(WORLD_CONFIG_JUDGE.length).toBeLessThanOrEqual(100)
    // v3: verdicts against the founding collections alone; geometry is frozen by the first property and checked when governing.
    expect(WORLD_CONFIG_JUDGE).toBe('rare-city/play-config-v1+world-evolution-v3')
    expect(WORLD_CONFIG_JUDGE_V2).toBe('rare-city/play-config-v1+world-evolution-v2')
    const { foundation } = founded()
    expect(judgeWorldConfigAs(WORLD_CONFIG_JUDGE, doc(), WORLD, foundation)?.verdict).toBe('accepted')
    expect(judgeWorldConfigAs(WORLD_CONFIG_JUDGE_V2, doc(), WORLD, foundation)?.verdict).toBe('accepted')
    expect(judgeWorldConfigAs('hand', doc(), WORLD, foundation)).toBeNull()
  })

  it('reads a stored geometry back exactly, and compares geometries by layout, districts and order', () => {
    const { foundation } = founded()
    const g = geometryOf(foundation)
    expect(g).toEqual({ layout: foundation.layout, districts: foundation.districts })
    expect(parseWorldGeometry(JSON.parse(JSON.stringify(g.layout)), JSON.parse(JSON.stringify(g.districts)))).toEqual(g)
    expect(parseWorldGeometry({ ...g.layout, extra: 1 }, g.districts)).toBeNull()
    expect(parseWorldGeometry(g.layout, [])).toBeNull()
    expect(parseWorldGeometry(g.layout, [g.districts[0], g.districts[0]])).toBeNull()
    expect(parseWorldGeometry(g.layout, [{ ...g.districts[0], geometryFingerprint: 'x' }])).toBeNull()
    expect(sameGeometry(foundation, g)).toBe(true)
    expect(sameGeometry(g, { ...g, districts: [...g.districts].reverse() })).toBe(false)
    expect(sameGeometry(g, { ...g, layout: { ...g.layout, key: 'other' } })).toBe(false)
  })
})

describe('a world city\'s stored state (version 1)', () => {
  it('is founded empty, and only an empty state of exactly this shape is read', () => {
    expect(emptyWorldCityState()).toEqual({ version: WORLD_CITY_STATE_VERSION, buildings: {}, openWards: {} })
    expect(JSON.stringify(emptyWorldCityState())).toBe('{"version":1,"buildings":{},"openWards":{}}')
    expect(parseWorldCityState(JSON.parse('{"openWards":{},"buildings":{},"version":1}'))).toEqual(emptyWorldCityState())
    for (const bad of [
      null,
      [],
      { version: 2, buildings: {}, openWards: {} },
      { version: 1, buildings: { 'b-1': {} }, openWards: {} },
      { version: 1, buildings: {}, openWards: { quay: 2 } },
      { version: 1, buildings: {}, openWards: {}, users: {} },
      { version: 1, buildings: {} },
      { version: 1, buildings: [], openWards: {} },
      { version: 5, buildings: {}, users: {} },
    ])
      expect(parseWorldCityState(bad), JSON.stringify(bad)).toBeNull()
  })
})
