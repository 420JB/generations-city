import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { parseRehearsalPropertyLegacy, REHEARSAL_MARK, type RehearsalArchitectView, type RehearsalCityDesign, type RehearsalPropertyLegacy } from '../../protocol/playRehearsal'
import { nftAsset } from '../../world/asset'
import { emptyWorldCityState, worldBuildingId, type WorldCityState } from '../../world/cityState'
import { LOCAL_TEST_CONSTRUCTION_RECIPE, proposePropertyConstruction } from '../../world/construction'
import { proposePropertyActivation } from '../../world/gameplay'
import { worldProperty } from '../../world/property'
import { parseBrandCityConfig } from '../core/config'
import { compileBrandWorld } from '../core/layout'
import { loadPersistedBrandCity, type LoadedBrandCity } from '../load'
import { HARBORLIGHT } from '../samples'
import { ArchitectRecord } from './architect'
import { LegacyRecord } from './legacy'
import { emptyRelation, RELATIONS } from './portfolio'

/**
 * ARCHITECT PORTFOLIO AND PROPERTY LEGACY (P1-C2-E5A), the page's side: the legacy answer is parsed exactly (its sums must
 * agree, and nothing more is believed), and both are said as the server answered them: founding apart from control, a
 * patron's units apart from a controller's, the viewer's own part apart from the property's total, design revisions by
 * relation only, and no rank, reward or verified ownership anywhere.
 */
const WORLD = '0199f1a2-7c3d-7e4f-8a5b-6c7d8e9f0a1b'

/** A stored city with three properties at Tier 0, 1 and 2. */
function city(): { loaded: LoadedBrandCity; ids: string[] } {
  const parsed = parseBrandCityConfig({ ...(HARBORLIGHT.config as object), worldId: WORLD })
  if (!parsed.ok) throw new Error('sample invalid')
  const c = parsed.config
  const compiled = compileBrandWorld(c)
  if (!compiled.ok) throw new Error('world')
  const collection = c.collections[0]
  let state: WorldCityState = emptyWorldCityState()
  let sequence = 1
  const ids: string[] = []
  for (const [i, tokenId] of ['10', '11', '12'].entries()) {
    const asset = nftAsset({ chain: collection.chain, contract: collection.contract, tokenId })!
    const next = proposePropertyActivation(compiled.world, state, sequence, { asset, plotId: `${c.districts[0].key}-w0-p${i}` })
    if (!next.ok) throw new Error(next.reason)
    state = next.transition.state
    sequence = next.transition.to
    ids.push(worldBuildingId(worldProperty(compiled.world, asset)!.propertyId))
  }
  for (const [id, steps] of [
    [ids[1], 2],
    [ids[2], 5],
  ] as const)
    for (let s = 0; s < steps; s++) {
      const built = proposePropertyConstruction(state, sequence, { buildingId: id, recipe: LOCAL_TEST_CONSTRUCTION_RECIPE })
      if (!built.ok) throw new Error(built.reason)
      state = built.transition.state
      sequence = built.transition.to
    }
  const loaded = loadPersistedBrandCity(c, state, compiled.world.layout.geometryFingerprint)
  if (!loaded.ok) throw new Error('load')
  return { loaded: loaded.city, ids }
}

const { loaded, ids } = city()
const pid = (buildingId: string) => buildingId.slice(2)
const RECIPE = { key: 'local-test-tier2-v1', unitsPerAction: 50, tierThresholds: [100, 250], provisional: true as const }
const AT = '2026-10-26T12:00:00.000Z'

/**
 * The Tier 2 property after a transfer, as its founder (the viewer) sees it: era 2 is the current controller's (not the
 * viewer's), era 1 was the viewer's; patrons built in era 1; one patron step before any controller was named; four design
 * revisions, v1 to v3, the newest saved by the current controller.
 */
const legacy: RehearsalPropertyLegacy = {
  rehearsal: REHEARSAL_MARK,
  resource: 'local-test-credit',
  recipe: RECIPE,
  property: { propertyId: pid(ids[2]), buildingId: ids[2], tier: 2, built: 250, nextTierAt: null, maxTier: 2, activatedSequence: 4, foundingOrder: 3 },
  founding: 'viewer',
  open: true,
  control: 'other',
  investment: { currentController: 50, previousControllers: 100, community: 100, total: 250 },
  yours: { ownerUnits: 100, currentEraOwnerUnits: 0, earlierEraOwnerUnits: 100, patronUnits: 0, actions: 2 },
  eras: [
    { era: 2, current: true, yours: false, ownerUnits: 50, patronUnits: 0, actions: 1, tierBefore: 1, tierAfter: 2, firstSequence: 12, lastSequence: 12 },
    { era: 1, current: false, yours: true, ownerUnits: 100, patronUnits: 50, actions: 3, tierBefore: 0, tierAfter: 1, firstSequence: 6, lastSequence: 9 },
  ],
  eraCount: 2,
  unattributed: { patronUnits: 50, actions: 1 },
  contributors: { owners: 2, patrons: 2 },
  designs: [
    { revision: 4, catalog: 'architect-design-v3', facade: 'jade', roof: 'terrace', windows: 'grid', lighting: 'standard', entrance: 'portico', landscaping: 'courtyard', color: null, by: 'other', savedBy: 'current-controller', atCitySequence: 12, at: AT },
    { revision: 3, catalog: 'architect-design-v3', facade: 'jade', roof: 'terrace', windows: 'grid', lighting: 'standard', entrance: 'portico', landscaping: 'garden', color: null, by: 'viewer', savedBy: 'earlier-controller', atCitySequence: 9, at: AT },
    { revision: 2, catalog: 'architect-design-v2', facade: 'copper', roof: 'spire', windows: 'arched', lighting: 'warm', entrance: null, landscaping: null, color: null, by: 'viewer', savedBy: 'earlier-controller', atCitySequence: 8, at: AT },
    { revision: 1, catalog: 'architect-design-v1', facade: 'brick', roof: 'dome', windows: null, lighting: null, entrance: null, landscaping: null, color: null, by: 'viewer', savedBy: 'earlier-controller', atCitySequence: 7, at: AT },
  ],
  designCount: 4,
}

const bad = (patch: (v: Record<string, unknown> & { investment: Record<string, number>; yours: Record<string, number>; eras: Record<string, unknown>[]; designs: Record<string, unknown>[] }) => void) => {
  const v = structuredClone(legacy) as unknown as Parameters<typeof patch>[0]
  patch(v)
  return parseRehearsalPropertyLegacy(v)
}

/** No rank, level, XP, badge or reward, and no claim of verified or present ownership. */
const NEVER = /\b(rank(ed)?|level \d|xp|badge|leaderboard|reward(ed)? you|you own|owned by you|verified owner|holds? the nft now)\b/i
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ')

describe('the property legacy answer is parsed exactly (P1-C2-E5A)', () => {
  it('parses an answer whose sums agree, and refuses one that does not add up, says more, or claims more', () => {
    expect(parseRehearsalPropertyLegacy(structuredClone(legacy))).toEqual(legacy)
    // The three investments are the lifetime units, which are the property's built units.
    expect(bad((v) => (v.investment.community = 50))).toBeNull()
    expect(bad((v) => (v.investment.total = 300))).toBeNull()
    // The current controller's units are exactly the current era's owner units; only the newest era may be current, once.
    expect(
      bad((v) => {
        v.investment.currentController = 0
        v.investment.previousControllers = 150
      }),
    ).toBeNull()
    expect(bad((v) => (v.eras[1].current = true))).toBeNull()
    expect(bad((v) => v.eras.reverse())).toBeNull()
    // With every era listed, the eras and the unattributed patron units are the lifetime units.
    expect(bad((v) => ((v.unattributed as Record<string, number>).patronUnits = 100))).toBeNull()
    expect(bad((v) => ((v.eras[1].patronUnits as number) = 100))).toBeNull()
    // The viewer's own part is within the property's, and its eras add up.
    expect(
      bad((v) => {
        v.yours.currentEraOwnerUnits = 100
        v.yours.earlierEraOwnerUnits = 0
      }),
    ).toBeNull()
    expect(bad((v) => (v.yours.patronUnits = 150))).toBeNull()
    expect(bad((v) => (v.yours.ownerUnits = 50))).toBeNull()
    expect(bad((v) => (v.yours.actions = 0))).toBeNull()
    // Revisions newest first and consecutive, ending at the count; each a choice of the catalog it names.
    expect(bad((v) => v.designs.reverse())).toBeNull()
    expect(bad((v) => (v.designCount = 5))).toBeNull()
    expect(bad((v) => (v.designs[3].windows = 'grid'))).toBeNull()
    expect(bad((v) => (v.designs[0].savedBy = 'owner'))).toBeNull()
    expect(bad((v) => (v.designs[0].by = 'Bea'))).toBeNull()
    // Nothing more is believed: no rank, reward, verified ownership, or name.
    expect(bad((v) => (v.rank = 1))).toBeNull()
    expect(bad((v) => (v.yours.xp = 10))).toBeNull()
    expect(bad((v) => ((v.rehearsal as Record<string, unknown>).verified = true))).toBeNull()
    expect(bad((v) => (v.resource = 'proofy-points'))).toBeNull()
    expect(bad((v) => (v.founding = 'owner'))).toBeNull()
    expect(bad((v) => (v.control = 'verified'))).toBeNull()
    expect(bad((v) => (v.eras[0].controller = '222222222222222222'))).toBeNull()
    expect(bad((v) => ((v.property as Record<string, unknown>).buildingId = ids[1]))).toBeNull()
    // A property nobody built: no era, no investment, no design.
    const empty = {
      ...structuredClone(legacy),
      property: { ...legacy.property, tier: 0, built: 0, nextTierAt: 100 },
      investment: { currentController: 0, previousControllers: 0, community: 0, total: 0 },
      yours: { ownerUnits: 0, currentEraOwnerUnits: 0, earlierEraOwnerUnits: 0, patronUnits: 0, actions: 0 },
      eras: [],
      eraCount: 0,
      unattributed: { patronUnits: 0, actions: 0 },
      contributors: { owners: 0, patrons: 0 },
      designs: [],
      designCount: 0,
    }
    expect(parseRehearsalPropertyLegacy(empty)).toEqual(empty)
  })
})

describe('the property legacy is said as the server answered it (P1-C2-E5A)', () => {
  const render = (l: RehearsalPropertyLegacy) => renderToStaticMarkup(createElement(LegacyRecord, { city: loaded, buildingId: l.property.buildingId, legacy: l }))

  it('keeps founding, control, controller eras, patrons and the viewer\'s own part apart', () => {
    const html = render(legacy)
    const said = text(html)
    expect(html).toContain('data-founding="viewer"')
    expect(said).toContain('Founded by you')
    expect(said).toContain('The 3rd property founded in')
    expect(said).toContain('Your founding credit is permanent. It stays yours when the NFT changes hands, and founding is not control of the NFT.')
    expect(html).toContain('data-control="other"')
    expect(said).toContain('names another player as this NFT’s current controller.')
    expect(said).toContain('not verified NFT ownership')
    expect(said).toContain('never an earlier controller’s own record')
    // The investment split, by whose it is, and the lifetime units once.
    expect(html).toMatch(/data-current-controller="50" data-previous-controllers="100" data-community="100" data-total="250"/)
    expect(html).toContain('aria-label="250 lifetime test units: 50 by the current controller in the latest recorded era, 100 by earlier controllers, 100 by patrons"')
    // The viewer's own part: theirs, under earlier control (the current controller is another player), never added to the total again.
    expect(said).toContain('100 test units as its controller (100 under earlier control) · 0 test units as a patron · 2 steps.')
    expect(said).toContain('It is part of the lifetime total above, never added to it again.')
    // Recorded building eras newest first, the one whose controller is named now marked; never a full transfer history.
    expect([...html.matchAll(/data-testid="legacy-era" data-era="(\d)" data-current="(true|false)" data-yours="(true|false)"/g)].map((m) => m.slice(1))).toEqual([
      ['2', 'true', 'false'],
      ['1', 'false', 'true'],
    ])
    expect(said).toContain('Era 2 · controlled by another player · the controller named now')
    expect(said).toContain('Era 1 · controlled by you 100 test units')
    expect(said).toContain('Recorded building eras')
    expect(said).toContain('These eras are recorded when building activity occurs under a named test controller. Changes of control without building activity may not appear, so this is not a full ownership or transfer history.')
    // M1. Patron units built while nobody was named: apart from the eras, placed before none of them.
    expect(said).toContain('While no controller was named · 50 test units by patrons · 1 step. Built at times when the test file named nobody as controller: before, between or after the recorded eras.')
    expect(said).not.toMatch(/Before any controller|current uninterrupted|continuous control/i)
    expect(html).not.toMatch(/<li[^>]*data-testid="legacy-era-unattributed"/)
    expect(said).not.toMatch(NEVER)
  })

  it('tells every design revision by its catalog and by relation only, and never as construction or progress', () => {
    const html = render(legacy)
    const said = text(html)
    expect([...html.matchAll(/data-testid="legacy-design" data-revision="(\d)" data-catalog="([^"]+)" data-by="(\w+)" data-saved-by="([\w-]+)"/g)].map((m) => m.slice(1))).toEqual([
      ['4', 'architect-design-v3', 'other', 'current-controller'],
      ['3', 'architect-design-v3', 'viewer', 'earlier-controller'],
      ['2', 'architect-design-v2', 'viewer', 'earlier-controller'],
      ['1', 'architect-design-v1', 'viewer', 'earlier-controller'],
    ])
    expect(said).toContain(
      'Revision 4 · saved design · Jade · Roof terrace · Standard grid · Standard lighting · Grand portico · Stone courtyard (chosen before exterior colors could be chosen: its facade material’s own color) Saved by the player named test controller now, while test controller',
    )
    expect([...html.matchAll(/data-testid="legacy-design-by">([^<]+)</g)].map((m) => m[1])).toEqual([
      'Saved by the player named test controller now, while test controller',
      'Saved by you while test controller',
      'Saved by you while test controller',
      'Saved by you while test controller',
    ])
    expect(said).toContain('Copper · Spire · Classic arched · Warm floodlights (chosen before entrances and landscaping could be chosen: standard entrance and grounds)')
    expect(said).toContain('Brick · Dome (chosen before windows and lighting could be chosen: standard windows, lighting, entrance and grounds)')
    expect(said).toContain('A design is free: a revision adds no construction units, test credits, tier or progress.')
    // The preview is the saved (newest) revision, drawn by the city's own sprite.
    expect(html).toMatch(/data-testid="legacy-thumb" data-facade="jade" data-roof="terrace"[^>]*data-entrance="portico" data-landscaping="courtyard"/)
    // Five revisions shown at first; more open with a button.
    const many = { ...legacy, designs: Array.from({ length: 7 }, (_, i) => ({ ...legacy.designs[0], revision: 7 - i })), designCount: 7 }
    expect([...render(many).matchAll(/data-testid="legacy-design"/g)]).toHaveLength(5)
    expect(render(many)).toContain('Show all 7 revisions')
  })

  it('says a property nobody built, never designed, whose founder was not recorded and that nobody controls, as exactly that', () => {
    const l: RehearsalPropertyLegacy = {
      ...legacy,
      property: { ...legacy.property, propertyId: pid(ids[0]), buildingId: ids[0], tier: 0, built: 0, nextTierAt: 100, foundingOrder: 1, activatedSequence: 2 },
      founding: 'unrecorded',
      control: 'unknown',
      investment: { currentController: 0, previousControllers: 0, community: 0, total: 0 },
      yours: { ownerUnits: 0, currentEraOwnerUnits: 0, earlierEraOwnerUnits: 0, patronUnits: 0, actions: 0 },
      eras: [],
      eraCount: 0,
      unattributed: { patronUnits: 0, actions: 0 },
      contributors: { owners: 0, patrons: 0 },
      designs: [],
      designCount: 0,
    }
    const said = text(render(l))
    expect(said).toContain('Founder not recorded')
    expect(said).toContain('its founder is unknown to everyone')
    expect(said).toContain('No current controller is named for this NFT on this local server.')
    expect(said).toContain('Nothing has been built here yet')
    expect(said).toContain('You have not built on this property.')
    expect(said).toContain('No era recorded yet: nobody has built here while a controller was named.')
    expect(said).not.toContain('While no controller was named')
    expect(said).toContain('Never redesigned')
    expect(said).toContain('Standard design')
    expect(said).not.toMatch(NEVER)
    // Not open in this city: nobody is in control here, said so.
    expect(text(render({ ...l, open: false }))).toContain('Construction and design are not open in this city on this local server')
  })

  /** The audit's M1 shape: B's era 1 (sequence 3), then the file names nobody and a patron builds (sequence 4). */
  const afterEra: RehearsalPropertyLegacy = {
    ...legacy,
    property: { ...legacy.property, propertyId: pid(ids[1]), buildingId: ids[1], tier: 1, built: 100, nextTierAt: 250 },
    founding: 'other',
    control: 'unknown',
    investment: { currentController: 0, previousControllers: 50, community: 50, total: 100 },
    yours: { ownerUnits: 0, currentEraOwnerUnits: 0, earlierEraOwnerUnits: 0, patronUnits: 50, actions: 1 },
    eras: [{ era: 1, current: false, yours: false, ownerUnits: 50, patronUnits: 0, actions: 1, tierBefore: 0, tierAfter: 0, firstSequence: 3, lastSequence: 3 }],
    eraCount: 1,
    unattributed: { patronUnits: 50, actions: 1 },
    contributors: { owners: 1, patrons: 1 },
    designs: [],
    designCount: 0,
  }

  it('M1/I. a patron step after an era, while nobody is named, is counted once and never said to precede the era; nobody is made current', () => {
    expect(parseRehearsalPropertyLegacy(structuredClone(afterEra))).toEqual(afterEra)
    const html = render(afterEra)
    const said = text(html)
    expect(said).toContain('While no controller was named · 50 test units by patrons · 1 step.')
    expect(said).toContain('before, between or after the recorded eras')
    expect(said).not.toMatch(/Before any controller|before the recorded eras\./)
    // Once: in the patrons' total and the no-controller line, never inside an era too.
    expect(html).toMatch(/data-current-controller="0" data-previous-controllers="50" data-community="50" data-total="100"/)
    expect([...html.matchAll(/data-testid="legacy-era-unattributed"/g)]).toHaveLength(1)
    expect(html).toMatch(/data-testid="legacy-era" data-era="1" data-current="false" data-yours="false" data-owner-units="50" data-patron-units="0"/)
    // No era is the current controller's, and nobody is named controller now.
    expect(html).not.toContain('data-current="true"')
    expect(said).not.toContain('the controller named now')
    expect(said).toContain('No current controller is named for this NFT on this local server.')
    // Even with the eras' list cut short, the no-controller units are still told (they belong to no era).
    expect(text(render({ ...afterEra, eraCount: 25 }))).toContain('While no controller was named')
  })

  it('M2/L1. B → C → B with no building between: one recorded era, never a full transfer history; A → B → A designs never placed in today\'s control', () => {
    // B built in era 1; the file named C, then B again, and nobody built meanwhile: still one recorded era, whose controller is named now.
    const bcb: RehearsalPropertyLegacy = {
      ...afterEra,
      control: 'viewer',
      investment: { currentController: 50, previousControllers: 0, community: 0, total: 50 },
      property: { ...afterEra.property, tier: 0, built: 50, nextTierAt: 100 },
      yours: { ownerUnits: 50, currentEraOwnerUnits: 50, earlierEraOwnerUnits: 0, patronUnits: 0, actions: 1 },
      eras: [{ ...afterEra.eras[0], current: true, yours: true }],
      unattributed: { patronUnits: 0, actions: 0 },
      contributors: { owners: 1, patrons: 0 },
    }
    const said = text(render(bcb))
    expect(said).toContain('Recorded building eras 1')
    expect(said).toContain('Changes of control without building activity may not appear, so this is not a full ownership or transfer history.')
    expect(said).toContain('Era 1 · controlled by you · the controller named now')
    expect(said).not.toMatch(/under control you hold now|uninterrupted|since era|ever since|full transfer history is/i)
    // A saved (revision 1), B controlled, A controls again and is named now: A's revision is A's, of no stated period.
    const aba: RehearsalPropertyLegacy = {
      ...bcb,
      designs: [
        { ...legacy.designs[0], revision: 2, by: 'other', savedBy: 'earlier-controller' },
        { ...legacy.designs[1], revision: 1, by: 'viewer', savedBy: 'current-controller' },
      ],
      designCount: 2,
    }
    const html = render(aba)
    expect([...html.matchAll(/data-testid="legacy-design-by">([^<]+)</g)].map((m) => m[1])).toEqual(['Saved by another player while test controller', 'Saved by you while test controller'])
    expect(text(html)).not.toMatch(/as the current test controller|under your earlier test control|current control period/i)
    // With nobody named now, no revision is said to be the current controller's.
    const nobody = text(render({ ...aba, control: 'unknown', eras: [{ ...bcb.eras[0], current: false }], investment: { currentController: 0, previousControllers: 50, community: 0, total: 50 }, yours: { ...bcb.yours, currentEraOwnerUnits: 0, earlierEraOwnerUnits: 50 }, designs: aba.designs.map((d) => ({ ...d, savedBy: 'earlier-controller' as const })) }))
    expect(nobody).not.toMatch(/named test controller now|the controller named now/)
  })

  it('M2. your part splits owner units as the server does: latest recorded era only while its controller is named, otherwise earlier control', () => {
    /** Renders a server-shaped answer (checked by the strict parser first): your part's line and the lifetime split. */
    const part = (l: RehearsalPropertyLegacy) => {
      expect(parseRehearsalPropertyLegacy(structuredClone(l))).toEqual(l)
      const html = render(l)
      return { html, line: text(html.match(/<p[^>]*data-testid="legacy-yours-line"[^>]*>.*?<\/p>/)?.[0] ?? '').trim(), said: text(html) }
    }
    const FALSE_HISTORY = /in earlier eras|earlier numbered era|ever since|uninterrupted|continuously|all along/i
    // Bea built 50 as controller in era 1 (sequence 3), her only recorded era; nobody built after.
    const beaEra = { ...afterEra.eras[0], yours: true }
    const bea: RehearsalPropertyLegacy = {
      ...afterEra,
      founding: 'viewer',
      property: { ...afterEra.property, tier: 0, built: 50, nextTierAt: 100 },
      investment: { currentController: 0, previousControllers: 50, community: 0, total: 50 },
      yours: { ownerUnits: 50, currentEraOwnerUnits: 0, earlierEraOwnerUnits: 50, patronUnits: 0, actions: 1 },
      eras: [beaEra],
      eraCount: 1,
      unattributed: { patronUnits: 0, actions: 0 },
      contributors: { owners: 1, patrons: 0 },
    }

    // A. The file names another player now, and nobody has built since: her 50 are hers, under earlier control, in the one era.
    const a = part({ ...bea, control: 'other' })
    expect(a.line).toBe('50 test units as its controller (50 under earlier control) · 0 test units as a patron · 1 step.')
    expect(a.said).toContain('Recorded building eras 1')
    expect(a.said).toContain('Era 1 · controlled by you')
    expect(a.said).toContain('names another player as this NFT’s current controller.')
    expect(a.line).not.toMatch(/latest recorded era|named now/)
    expect(a.said).not.toMatch(FALSE_HISTORY)
    expect(a.html).toMatch(/data-current-controller="0" data-previous-controllers="50" data-community="0" data-total="50"/)
    expect(a.html).toContain('data-testid="legacy-lifetime">50<')

    // B. The file names nobody now, and Cy then builds as a patron (the audit's shape): the same, and nobody is current.
    const b = part({ ...bea, control: 'unknown', property: afterEra.property, investment: afterEra.investment, unattributed: afterEra.unattributed, contributors: afterEra.contributors })
    expect(b.line).toBe('50 test units as its controller (50 under earlier control) · 0 test units as a patron · 1 step.')
    expect(b.said).toContain('No current controller is named for this NFT on this local server.')
    expect(b.said).not.toMatch(/named now/)
    expect(b.said).not.toMatch(FALSE_HISTORY)
    expect(b.html).toMatch(/data-current-controller="0" data-previous-controllers="50" data-community="50" data-total="100"/)
    expect(b.html).toContain('data-testid="legacy-lifetime">100<')

    // C. B → C → B, nobody building meanwhile: one era, its controller named now; said without any claim she held it throughout.
    const c = part({ ...bea, control: 'viewer', investment: { currentController: 50, previousControllers: 0, community: 0, total: 50 }, yours: { ...bea.yours, currentEraOwnerUnits: 50, earlierEraOwnerUnits: 0 }, eras: [{ ...beaEra, current: true }] })
    expect(c.line).toBe('50 test units as its controller (50 in the latest recorded era, whose controller is named now) · 0 test units as a patron · 1 step.')
    expect(c.line).not.toContain('under earlier control')
    expect(c.said).toContain('Changes of control without building activity may not appear, so this is not a full ownership or transfer history.')
    expect(c.said).not.toMatch(FALSE_HISTORY)
    expect(c.html).toMatch(/data-current-controller="50" data-previous-controllers="0" data-community="0" data-total="50"/)

    // Both parts at once (A → B → A, both built): each said once, neither invented.
    const both = part({
      ...bea,
      control: 'viewer',
      property: { ...bea.property, tier: 1, built: 150, nextTierAt: 250 },
      investment: { currentController: 50, previousControllers: 100, community: 0, total: 150 },
      yours: { ownerUnits: 100, currentEraOwnerUnits: 50, earlierEraOwnerUnits: 50, patronUnits: 0, actions: 2 },
      eras: [
        { ...beaEra, era: 3, current: true, firstSequence: 5, lastSequence: 5 },
        { ...beaEra, era: 2, yours: false, firstSequence: 4, lastSequence: 4 },
        beaEra,
      ],
      eraCount: 3,
      contributors: { owners: 2, patrons: 0 },
    })
    expect(both.line).toBe('100 test units as its controller (50 in the latest recorded era, whose controller is named now; 50 under earlier control) · 0 test units as a patron · 2 steps.')

    // D. Patron only: no owner part is said at all, the patron units are.
    const d = part(afterEra)
    expect(d.line).toBe('0 test units as its controller · 50 test units as a patron · 1 step.')
    expect(d.said).not.toMatch(FALSE_HISTORY)
    expect(d.html).toMatch(/data-testid="legacy-yours" data-owner-units="0" data-current-era-owner-units="0" data-earlier-era-owner-units="0" data-patron-units="50"/)
  })
})

describe('the Architect portfolio groups the server\'s record by relationship, never merging them (P1-C2-E5A)', () => {
  const standing = { kind: 'ready' as const, role: 'owner' as const, units: 50 }
  const property = (buildingId: string, over: Partial<RehearsalArchitectView['properties'][number]>): RehearsalArchitectView['properties'][number] => ({
    propertyId: pid(buildingId),
    buildingId,
    asset: loaded.state.nfts[buildingId] ? `${loaded.config.collections[0].chain}/erc721:${loaded.config.collections[0].contract}/${loaded.state.nfts[buildingId].tokenId}` : '',
    collection: loaded.config.collections[0].key,
    districtKey: loaded.state.buildings[buildingId].districtId,
    plotId: `${loaded.state.buildings[buildingId].districtId}-w0-p0`,
    ward: 0,
    plot: 0,
    founded: false,
    control: 'other',
    tier: 0,
    built: 0,
    nextTierAt: 100,
    standing,
    yours: { ownerUnits: 0, currentEraOwnerUnits: 0, earlierEraOwnerUnits: 0, patronUnits: 0, actions: 0, tiersCompleted: 0, lastSequence: null },
    ...over,
  })
  const view: RehearsalArchitectView = {
    rehearsal: REHEARSAL_MARK,
    resource: 'local-test-credit',
    recipe: RECIPE,
    credits: { available: 100, recorded: 100, pending: 0 },
    totals: { ownerUnits: 150, currentEraOwnerUnits: 50, earlierEraOwnerUnits: 100, patronUnits: 50, ownerActions: 3, patronActions: 1, tiersCompleted: 2, propertiesDeveloped: 3, propertiesDevelopedAsOwner: 2 },
    properties: [
      // Controlled now (not founded); founded and built under earlier control; supported as a patron only.
      property(ids[1], { control: 'viewer', tier: 1, built: 100, nextTierAt: 250, yours: { ownerUnits: 50, currentEraOwnerUnits: 50, earlierEraOwnerUnits: 0, patronUnits: 0, actions: 1, tiersCompleted: 1, lastSequence: 9 } }),
      property(ids[2], { founded: true, tier: 2, built: 250, nextTierAt: null, standing: { kind: 'complete' }, yours: { ownerUnits: 100, currentEraOwnerUnits: 0, earlierEraOwnerUnits: 100, patronUnits: 0, actions: 2, tiersCompleted: 1, lastSequence: 8 } }),
      property(ids[0], { control: 'unknown', built: 50, yours: { ownerUnits: 0, currentEraOwnerUnits: 0, earlierEraOwnerUnits: 0, patronUnits: 50, actions: 1, tiersCompleted: 0, lastSequence: 7 } }),
    ],
    propertyCount: 3,
  }
  const { facade, roof, windows, lighting, entrance, landscaping, color } = legacy.designs[0]
  const designs: Record<string, RehearsalCityDesign> = { [ids[2]]: { propertyId: pid(ids[2]), buildingId: ids[2], revision: 4, catalog: 'architect-design-v3', facade, roof, windows, lighting, entrance, landscaping, color } }
  const render = (v: RehearsalArchitectView, d: Record<string, RehearsalCityDesign> | null = designs) =>
    renderToStaticMarkup(createElement(ArchitectRecord, { city: loaded, view: v, designs: d, onView: () => {}, onDesign: () => {}, onLegacy: () => {} }))

  it('counts each relationship from its own record, lists each property once, and offers its legacy', () => {
    const html = render(view)
    const counts = Object.fromEntries([...html.matchAll(/data-testid="portfolio-filter-(\w+)" data-count="(\d+)"/g)].map((m) => [m[1], Number(m[2])]))
    expect(counts).toEqual({ all: 3, controlled: 1, founded: 1, patron: 1, earlier: 1 })
    expect(html).toContain('aria-pressed="true" data-testid="portfolio-filter-all"')
    expect([...html.matchAll(/data-testid="architect-property"/g)]).toHaveLength(3)
    expect([...html.matchAll(/data-testid="architect-property-legacy"/g)]).toHaveLength(3)
    // Only the property the player controls now offers its design view.
    expect([...html.matchAll(/data-testid="architect-property-design"/g)]).toHaveLength(1)
    // Its own building and its patronage are separate groups.
    const said = text(html)
    expect(said).toContain('Your own building · as the NFT’s test controller')
    expect(said).toContain('Your patronage · others’ properties, never your own building')
    expect(said).not.toMatch(NEVER)
  })

  it('says each property\'s saved design as the city draws it, or the standard one; and says when counts are of a partial list', () => {
    const html = render(view)
    expect(text(html)).toContain('Design: Jade · Roof terrace · Standard grid · Standard lighting · Grand portico · Stone courtyard · revision 4')
    expect([...html.matchAll(/Design: the standard design every new building starts with/g)]).toHaveLength(2)
    // Without the city's designs the page says nothing about them, rather than calling every building standard.
    expect(render(view, null)).not.toContain('architect-property-design-summary')
    expect(render({ ...view, propertyCount: 60 })).toContain('Counts are of the 3 properties with your most recent activity, of 60.')
  })

  it('L2/D. an empty relationship of a capped list is said of the listed properties only; of a whole list, of all of them', () => {
    // A capped list (the server lists 50 of 52): nothing absolute about the two not listed.
    for (const r of RELATIONS.filter((x) => x.key !== 'all')) {
      const said = emptyRelation(r.key, 50, 52)
      expect(said, r.key).toMatch(/^None of the 50 properties listed here .+\. Properties not listed may; your totals above count every property\.$/)
      expect(said, r.key).not.toMatch(/^You (have|are)|none of these properties/)
    }
    expect(emptyRelation('earlier', 50, 52)).toBe('None of the 50 properties listed here has your owner units under a control that has since ended. Properties not listed may; your totals above count every property.')
    // The whole record listed: true of every property, said so.
    expect(emptyRelation('earlier', 3, 3)).toBe('You have no owner units under a control that has since ended.')
    expect(emptyRelation('all', 50, 52)).toBe('')
    // The rendered list says the counts are partial, and the totals are the server's, of every property.
    const html = render({ ...view, propertyCount: 52 })
    expect(html).toContain('Counts are of the 3 properties with your most recent activity, of 52.')
    expect(html).toMatch(/data-testid="architect-totals" data-owner-units="150" data-current-era-owner-units="50" data-earlier-era-owner-units="100" data-patron-units="50"/)
  })

  it('B → C → B with no building between: the latest recorded building era, never uninterrupted control; totals and filters as the server says', () => {
    // B built 50 on the property (era 1). The file named C (nobody built), then B again. B's view after, as the server answers it.
    const yoursB = { ownerUnits: 50, currentEraOwnerUnits: 50, earlierEraOwnerUnits: 0, patronUnits: 0, actions: 1, tiersCompleted: 0, lastSequence: 3 }
    const bcb: RehearsalArchitectView = {
      ...view,
      totals: { ownerUnits: 50, currentEraOwnerUnits: 50, earlierEraOwnerUnits: 0, patronUnits: 0, ownerActions: 1, patronActions: 0, tiersCompleted: 0, propertiesDeveloped: 1, propertiesDevelopedAsOwner: 1 },
      properties: [property(ids[1], { control: 'viewer', built: 50, yours: yoursB })],
      propertyCount: 1,
    }
    const counts = (html: string) => Object.fromEntries([...html.matchAll(/data-testid="portfolio-filter-(\w+)" data-count="(\d+)"/g)].map((m) => [m[1], Number(m[2])]))
    const html = render(bcb, null)
    const said = text(html)
    expect(said).toContain('Latest recorded building era 50')
    expect(said).toContain('Under earlier control 0')
    expect(said).toContain('changes of control without building may not appear: this is not a record of continuous ownership or of every NFT transfer.')
    expect(said).not.toMatch(/hold now|you have held|uninterrupted|ever since|since you (first )?built|held continuously|all along/i)
    expect(html).toMatch(/data-testid="architect-totals" data-owner-units="50" data-current-era-owner-units="50" data-earlier-era-owner-units="0" data-patron-units="0"/)
    expect(counts(html)).toEqual({ all: 1, controlled: 1, founded: 0, patron: 0, earlier: 0 })
    // The read cannot tell this from B never losing control, so the page says the same, true of both.
    const never = { ...bcb, properties: [property(ids[1], { control: 'viewer', built: 50, yours: { ...yoursB } })] }
    expect(render(never, null)).toBe(html)
    // While C was named, B's 50 were under earlier control and C's own building was 0: the copy follows the server's split.
    const underC = render({ ...bcb, totals: { ...bcb.totals, currentEraOwnerUnits: 0, earlierEraOwnerUnits: 50 }, properties: [property(ids[1], { control: 'other', built: 50, yours: { ...yoursB, currentEraOwnerUnits: 0, earlierEraOwnerUnits: 50 } })] }, null)
    expect(text(underC)).toContain('Latest recorded building era 0')
    expect(text(underC)).toContain('Under earlier control 50')
    expect(counts(underC)).toEqual({ all: 1, controlled: 0, founded: 0, patron: 0, earlier: 1 })
  })
})
