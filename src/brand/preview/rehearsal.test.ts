import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CitySceneContext } from '../../ui/city/scene'
import { loadBrandCity } from '../load'
import { HARBORLIGHT } from '../samples'
import { DistrictPanel } from './panels'
import { AssignedDistrict, StoredPropertyCard, type AssignedTicket, type StoredProperty } from './rehearsal'

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
