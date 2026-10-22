import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CitySceneContext } from '../../ui/city/scene'
import { loadBrandCity } from '../load'
import { HARBORLIGHT } from '../samples'
import { DistrictPanel } from './panels'
import { districtPlots } from '../load'
import type { Placement } from './PreviewApp'
import { AssignedDistrict, ClaimCountdown, RehearsalPlotPanel, StoredPropertyCard, type AssignedTicket, type PlacementRehearsal, type StoredProperty } from './rehearsal'

const stored = (activator: StoredProperty['activator']): StoredProperty => ({
  propertyId: '0199f1a2-7c3d-7e4f-8a5b-6c7d8e9f0a1c',
  asset: 'eip155:8453/erc721:0x000000000000000000000000000000000000a001/812',
  collection: 'harbor-keepers',
  districtKey: 'tidewater',
  ward: 0,
  plot: 2,
  sequence: 2,
  activator,
})
const card = (activator: StoredProperty['activator']) => renderToStaticMarkup(createElement(StoredPropertyCard, { stored: stored(activator), cityName: 'Harborlight' }))

describe('a stored property\'s original activator, as the card says it', () => {
  it('says "you" only for the viewer\'s own recorded activation', () => {
    expect(card('viewer')).toContain('Originally activated by you.')
    expect(card('viewer')).toContain('data-activator="viewer"')
    expect(card('viewer')).toContain('data-activated-by-viewer="true"')
  })

  it('says a recorded activator is recorded, and names nobody', () => {
    expect(card('other')).toContain('Its original activator is recorded permanently and privately.')
    expect(card('other')).toContain('data-activated-by-viewer="false"')
  })

  it('never claims a record that does not exist: a property placed before activators were kept reads as unknown, to everyone', () => {
    const html = card('unrecorded')
    expect(html).toContain('Its original activator is unknown: it was placed before original activators were recorded, and none was recorded for it.')
    expect(html).toContain('data-activator="unrecorded"')
    expect(html).not.toMatch(/recorded permanently|activated by you/)
  })
})

describe('the district a rehearsal player is assigned, as the page says it', () => {
  const loaded = loadBrandCity(HARBORLIGHT.config, HARBORLIGHT.city)
  if (!loaded.ok) throw new Error('sample city does not load')
  const city = loaded.city
  const player = { id: 'play-player', kind: 'player' as const, label: 'Ada', answers: {} }
  const panel = (districtId: string, props: { rehearsal?: boolean; assigned?: string | null; selectAsset?: boolean; onEnter?: () => void }) =>
    renderToStaticMarkup(
      createElement(CitySceneContext.Provider, { value: city.scene }, createElement(DistrictPanel, { city, districtId, member: player, onDistrict: () => {}, onWarp: () => {}, onChoosePlot: () => {}, onClose: () => {}, ...props })),
    )
  const ticket: AssignedTicket = { id: '019a0b1c-2d3e-7f40-8a5b-6c7d8e9f0a1b', districtKey: 'tidewater', kind: 'fallback', slot: { ordinal: 1, generation: 2, epoch: 1 }, rule: null, authorization: null, expiresAt: '2026-10-20T10:15:00.000Z' }

  it('offers no district choice in a rehearsal: only the assigned district, or a way to be assigned one', () => {
    expect(panel('tidewater', { rehearsal: true, assigned: 'tidewater' })).toContain('Choose your plot · local rehearsal')
    // Another district, gated or not, leads to the assigned one.
    for (const other of ['lantern-quay', 'compass-row']) expect(panel(other, { rehearsal: true, assigned: 'tidewater' })).toContain('Go to your district: Tidewater')
    expect(panel('lantern-quay', { rehearsal: true, assigned: null, onEnter: () => {} })).toContain('Get your district · local rehearsal')
    expect(panel('lantern-quay', { rehearsal: true, assigned: null })).toMatch(/disabled=""[^>]*data-testid="choose-plot"[^>]*>No test NFT to place/)
    for (const html of [panel('tidewater', { rehearsal: true, assigned: 'tidewater' }), panel('saltmarsh', { rehearsal: true, assigned: 'tidewater' })]) expect(html).not.toMatch(/Choose a plot · local rehearsal|chosen by you/)
  })

  it('in a city whose every district is restricted, offers selecting the NFT first, from any district, and still no district choice', () => {
    for (const d of ['lantern-quay', 'compass-row']) {
      const html = panel(d, { rehearsal: true, assigned: null, selectAsset: true, onEnter: () => {} })
      expect(html).toContain('Select your test NFT · local rehearsal')
      expect(html).not.toMatch(/disabled=""[^>]*data-testid="choose-plot"/)
    }
  })

  it('leaves the preview page as it was: a simulated viewer still previews any district', () => {
    const html = panel('lantern-quay', {})
    expect(html).toContain('Choose a plot · preview')
    expect(html).not.toContain('data-assigned')
  })

  it('names the assignment and its basis: the rotation slot or the rule, and until when', () => {
    const fallback = renderToStaticMarkup(createElement(AssignedDistrict, { ticket, name: 'Tidewater District' }))
    expect(fallback).toContain('data-district="tidewater"')
    expect(fallback).toContain('data-ordinal="1"')
    expect(fallback).toContain('data-generation="2"')
    expect(fallback).toContain('Tidewater District</b> · slot 2 · until')
    expect(fallback).toContain("the city&#x27;s rotation, slot 2")
    const rule = renderToStaticMarkup(createElement(AssignedDistrict, { ticket: { ...ticket, kind: 'rule', slot: null, rule: { ref: 'captains-to-tidewater', asset: 'eip155:1/erc721:0x000000000000000000000000000000000000a002/1' } }, name: 'Tidewater District' }))
    expect(rule).toContain('data-kind="rule"')
    expect(rule).toContain('· by rule ·')
    expect(rule).toContain('explicit district rule captains-to-tidewater for this NFT')
    expect(rule).toContain('data-restricted=""')
    // A restricted district: said as such, with its rule, and that the yes was local test data, not Proofy.
    const restricted = renderToStaticMarkup(
      createElement(AssignedDistrict, { ticket: { ...ticket, kind: 'rule', slot: null, rule: { ref: 'captains-to-tidewater', asset: 'eip155:1/erc721:0x000000000000000000000000000000000000a002/1' }, authorization: { verificationRuleId: 62, source: 'local-fixture' } }, name: 'Tidewater District' }),
    )
    expect(restricted).toContain('data-restricted="62"')
    expect(restricted).toContain('· restricted, by rule ·')
    expect(restricted).toContain('Proofy rule 62 answered yes in this server&#x27;s local test file (not verified by Proofy)')
  })
})

describe('the player\'s claim, as the panel and the countdown say it (P1-C2-E1)', () => {
  const loaded = loadBrandCity(HARBORLIGHT.config, HARBORLIGHT.city)
  if (!loaded.ok) throw new Error('sample city does not load')
  const city = loaded.city
  const district = city.config.districts[0].key
  const soon = (ms: number) => new Date(Date.now() + ms).toISOString()
  const fallback = (expiresAt: string): AssignedTicket => ({ id: '019a0b1c-2d3e-7f40-8a5b-6c7d8e9f0a1b', districtKey: district, kind: 'fallback', slot: { ordinal: 0, generation: 1, epoch: 1 }, rule: null, authorization: null, expiresAt })
  const restricted = (expiresAt: string): AssignedTicket => ({ ...fallback(expiresAt), kind: 'rule', slot: null, rule: { ref: 'captains', asset: 'eip155:1/erc721:0x000000000000000000000000000000000000a002/1' }, authorization: { verificationRuleId: 62, source: 'local-fixture' } })
  const nfts = [
    { asset: 'eip155:1/erc721:0x000000000000000000000000000000000000a002/1', collectionName: 'Harbor Keepers', tokenId: '1' },
    { asset: 'eip155:1/erc721:0x000000000000000000000000000000000000a002/2', collectionName: 'Harbor Keepers', tokenId: '2' },
  ]
  const never = () => new Promise<never>(() => {})
  const rehearsal = (over: Partial<PlacementRehearsal>): PlacementRehearsal => ({ nfts, placed: 0, ticket: null, ticketNote: null, clockOffset: 0, awaitingAsset: false, enter: never, assign: never, leave: never, activate: never, ...over })
  const placement: Placement = { districtId: district, candidates: districtPlots(city, district).map((c) => ({ districtId: c.districtKey, ward: c.ward, plot: c.plot, newWard: c.newWard, plotId: c.plotId })), selected: null }
  const render = (r: PlacementRehearsal) =>
    renderToStaticMarkup(createElement(CitySceneContext.Provider, { value: city.scene }, createElement(RehearsalPlotPanel, { city, placement, rehearsal: r, onCancel: () => {}, onAssigned: () => {}, onLeave: () => {}, onActivated: () => {} })))

  it('counts down from the ticket\'s end, as a timer a screen reader can read', () => {
    const end = soon(600_000)
    const html = renderToStaticMarkup(createElement(ClaimCountdown, { expiresAt: end, clockOffset: 0 }))
    expect(html).toContain('role="timer"')
    expect(html).toContain(`data-expires-at="${end}"`)
    expect(html).toMatch(/aria-label="Claim time left: (10 minutes|9 minutes 59 seconds)"/)
    expect(html).toMatch(/>(10:00|09:59)</)
    expect(html).toContain('data-state="open"')
  })

  it('reads the server\'s clock: a browser ten minutes fast still shows the time the server gives', () => {
    // The ticket ends in 15 minutes by the server; this browser's clock is 10 minutes ahead of it (offset -600 s).
    const html = renderToStaticMarkup(createElement(ClaimCountdown, { expiresAt: soon(900_000 - 600_000), clockOffset: -600_000 }))
    expect(html).toMatch(/>(15:00|14:59)</)
  })

  it('says nearly over, and over', () => {
    expect(renderToStaticMarkup(createElement(ClaimCountdown, { expiresAt: soon(90_000), clockOffset: 0 }))).toContain('data-state="ending"')
    const over = renderToStaticMarkup(createElement(ClaimCountdown, { expiresAt: soon(-1_000), clockOffset: 0 }))
    expect(over).toContain('data-state="ended"')
    expect(over).toContain('aria-label="Claim time is up"')
    expect(over).toContain('>00:00<')
  })

  it('a default assignment: names the district and its basis, shows the claim time, and holds no plot', () => {
    const html = render(rehearsal({ ticket: fallback(soon(840_000)) }))
    expect(html).toContain('data-testid="claim-countdown"')
    expect(html).toContain('DEFAULT ASSIGNMENT')
    expect(html).toContain("the city&#x27;s rotation, slot 1")
    expect(html).toContain('No plot is held: until you activate, another player may take any free plot.')
    expect(html).toContain('data-step="nft"')
    expect(html).toContain('Select the test NFT you want to place.')
    // No confirmation before an NFT, its district and a plot are all valid.
    expect(html).not.toContain('data-testid="rehearsal-confirm"')
    expect(html).toMatch(/disabled=""[^>]*data-testid="rehearsal-review"/)
  })

  it('a restricted district reached by rule: says so, and that the yes was local test data, never verified', () => {
    const html = render(rehearsal({ ticket: restricted(soon(840_000)) }))
    expect(html).toContain('DISTRICT RULE')
    expect(html).toContain('RESTRICTED · LOCAL TEST RESULT')
    expect(html).toContain('Not verified by Proofy')
    expect(html.replace(/not verified/gi, '')).not.toMatch(/verified/i)
  })

  it('a city whose every district is restricted: asks for the NFT first, and no claim time runs', () => {
    const html = render(rehearsal({ awaitingAsset: true }))
    expect(html).toContain('Every district of this city is restricted.')
    expect(html).not.toContain('data-testid="claim-countdown"')
    expect(html).toContain('data-step="nft"')
  })

  it('a claim whose time ran out offers nothing to confirm while the server is asked', () => {
    const html = render(rehearsal({ ticket: fallback(soon(-2_000)), nfts: [nfts[0]] }))
    expect(html).toContain('data-step="ended"')
    expect(html).toContain('Your claim time is up. Checking with the server…')
    expect(html).toContain('data-assigned="no"')
    expect(html).toMatch(/disabled=""[^>]*data-testid="rehearsal-review"/)
  })

  it('shows the district\'s own color next to its name', () => {
    const html = renderToStaticMarkup(createElement(AssignedDistrict, { ticket: fallback(soon(60_000)), name: 'Lantern Quay District', color: '#ff9f43' }))
    expect(html).toContain('class="assigned-swatch"')
    expect(html).toContain('--dc:#ff9f43')
    expect(html).toContain('Lantern Quay District</b> · slot 1 · until')
  })
})
