import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StoredPropertyCard, type StoredProperty } from './rehearsal'

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
