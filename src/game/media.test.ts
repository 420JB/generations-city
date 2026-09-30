import { describe, expect, it } from 'vitest'
import { DEMO_PLAYER_ID } from '../config/identity'
import { contribute, purchaseFixture, setBillboardImage, setBillboardMessage } from './actions'
import { BILLBOARD_MESSAGE_MAX, containsLink, LINK_NOT_ALLOWED, validateBillboardMessage } from './media'
import { isValidState, loadState, STORAGE_KEY } from './persistence'
import { buildingIdFor, createSeedState, SCENARIO } from './seed'

const P = DEMO_PLAYER_ID
const MINE = buildingIdFor(SCENARIO.playerFriend)
const IMG = 'data:image/jpeg;base64,AAAA'

function withBillboard() {
  return purchaseFixture(createSeedState(), MINE, P, 'billboard').state
}

describe('billboard message link blocking', () => {
  it.each([
    'https://example.com',
    'http://example.com',
    'www.example.com',
    'example.com',
    'foo.xyz',
    'visit sub.example.co.uk today',
    'mail me@example.com',
    '[my site](somewhere)',
    '<a href="x">hi</a>',
    'mailto:me',
    'javascript:alert(1)',
    'ipfs://bafy',
    'HTTPS://EXAMPLE.COM',
    'data:text/html,hi',
    'server at 192.168.0.1',
  ])('rejects %j', (text) => {
    expect(containsLink(text)).toBe(true)
    expect(validateBillboardMessage(text)).toEqual({ ok: false, error: LINK_NOT_ALLOWED })
  })

  it.each(['Rare Friends meetup tonight', 'Follow @example on Twitter', 'New collection launching Friday', 'Built by @demo-player', 'Tier 4 by 3.5 billion friends! e.g. you', 'About: us. Data: none'])(
    'accepts %j',
    (text) => {
      expect(containsLink(text)).toBe(false)
      expect(validateBillboardMessage(`  ${text}  `)).toEqual({ ok: true, value: text })
    },
  )

  it('trims, treats empty as removal and enforces 180 characters', () => {
    expect(validateBillboardMessage('   ')).toEqual({ ok: true, value: null })
    expect(validateBillboardMessage('a'.repeat(BILLBOARD_MESSAGE_MAX)).ok).toBe(true)
    expect(validateBillboardMessage('a'.repeat(BILLBOARD_MESSAGE_MAX + 1)).ok).toBe(false)
  })
})

describe('billboard message action and persistence', () => {
  it('owner can set, edit and remove a message; invalid text is refused unchanged', () => {
    let s = withBillboard()
    s = setBillboardMessage(s, MINE, P, '  Rare Friends meetup tonight  ').state
    expect(s.buildings[MINE].billboard.message).toBe('Rare Friends meetup tonight')
    const bad = setBillboardMessage(s, MINE, P, 'see example.com')
    expect(bad.error).toBe(LINK_NOT_ALLOWED)
    expect(bad.state.buildings[MINE].billboard.message).toBe('Rare Friends meetup tonight')
    // Replacing the image keeps the message; clearing the message removes it.
    s = setBillboardImage(s, MINE, P, IMG).state
    expect(s.buildings[MINE].billboard).toMatchObject({ image: IMG, message: 'Rare Friends meetup tonight' })
    s = setBillboardMessage(s, MINE, P, '').state
    expect(s.buildings[MINE].billboard.message).toBeNull()
  })

  it('only the owner with a billboard fixture can write a message', () => {
    expect(setBillboardMessage(createSeedState(), MINE, P, 'hi').error).toMatch(/not installed/)
    const s = withBillboard()
    expect(setBillboardMessage(s, buildingIdFor(SCENARIO.kingmakerFriend), P, 'hi').error).toMatch(/owner/)
  })

  it('older saves without a message field still load', () => {
    const s = setBillboardImage(withBillboard(), MINE, P, IMG).state
    const legacy = JSON.parse(JSON.stringify(s))
    delete legacy.buildings[MINE].billboard.message
    expect(isValidState(legacy)).toBe(true)
    const loaded = loadState({ getItem: (k: string) => (k === STORAGE_KEY ? JSON.stringify(legacy) : null) })
    expect(loaded.restored).toBe(true)
    expect(loaded.state.buildings[MINE].billboard.image).toBe(IMG)
    expect(loaded.state.buildings[MINE].billboard.message ?? null).toBeNull()
    // And the economy still runs on it.
    expect(contribute(loaded.state, MINE, P, 10).error).toBeUndefined()
  })
})
