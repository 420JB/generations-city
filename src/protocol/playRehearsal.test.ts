import { describe, expect, it } from 'vitest'
import { parseRehearsalActivationResponse, parseRehearsalAssetsResponse, parseRehearsalTicketResponse } from './playRehearsal'

const MAX_UINT256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
const CONTRACT = '0x000000000000000000000000000000000000a001'
const ASSET = `eip155:8453/erc721:${CONTRACT}/${MAX_UINT256}`
const MARK = { kind: 'local-test-assets', verified: false }
const ID = '0e1c5997-06ed-8b56-bde2-4bb0a4daad0a'
const PROPERTY = { id: ID, buildingId: `b-${ID}`, asset: ASSET, collection: 'harbor-keepers', plotId: 'tidewater-w0-p3', districtKey: 'tidewater', ward: 0, plot: 3, sequence: 2, configVersion: 1, activatedAt: '2026-10-18T21:20:00.000Z' }

describe('local rehearsal answers, as the page reads them', () => {
  it('reads the test NFTs exactly, marked as unverified rehearsal data, uint256 token ids as text', () => {
    const body = { rehearsal: MARK, assets: [{ asset: ASSET, chain: 'eip155:8453', contract: CONTRACT, tokenId: MAX_UINT256 }] }
    expect(parseRehearsalAssetsResponse(body)).toEqual(body)
    expect(parseRehearsalAssetsResponse({ ...body, rehearsal: { kind: 'local-test-assets', verified: true } })).toBeNull()
    expect(parseRehearsalAssetsResponse({ assets: body.assets })).toBeNull()
    // An asset whose parts disagree with its id, or a non-canonical id, is not read.
    expect(parseRehearsalAssetsResponse({ rehearsal: MARK, assets: [{ ...body.assets[0], tokenId: '1' }] })).toBeNull()
    expect(parseRehearsalAssetsResponse({ rehearsal: MARK, assets: [{ ...body.assets[0], asset: `eip155:8453/erc721:${CONTRACT}/0${MAX_UINT256}` }] })).toBeNull()
  })

  it('reads an activation only when the property is self-consistent and carries no session or player', () => {
    const TICKET_ID = '019a0b1c-2d3e-7f40-8a5b-6c7d8e9f0a1b'
    const body = { rehearsal: MARK, fresh: true, sequence: 2, property: PROPERTY, consumedTicket: TICKET_ID }
    expect(parseRehearsalActivationResponse(body)).toEqual(body)
    // A repeat consumed nothing; an answer that does not say which ticket it consumed, or says it oddly, is not read.
    expect(parseRehearsalActivationResponse({ ...body, fresh: false, consumedTicket: null })).toEqual({ ...body, fresh: false, consumedTicket: null })
    for (const consumed of [undefined, 'ticket', 7, TICKET_ID.toUpperCase()]) expect(parseRehearsalActivationResponse({ ...body, consumedTicket: consumed })).toBeNull()
    expect(parseRehearsalActivationResponse({ ...body, property: { ...PROPERTY, sessionRef: 'x' } })).toEqual(body)
    for (const bad of [
      { ...PROPERTY, buildingId: 'b-other' },
      { ...PROPERTY, plotId: 'tidewater-w0-p4' },
      { ...PROPERTY, asset: 'eip155:8453/erc721:0xAB/1' },
      { ...PROPERTY, sequence: 1 },
      { ...PROPERTY, activatedAt: 'yesterday' },
    ])
      expect(parseRehearsalActivationResponse({ ...body, property: bad })).toBeNull()
    expect(parseRehearsalActivationResponse({ ...body, rehearsal: undefined })).toBeNull()
  })
})

describe('district tickets, as the page reads them', () => {
  const HASH = 'a'.repeat(64)
  const FALLBACK = { id: '019a0b1c-2d3e-7f40-8a5b-6c7d8e9f0a1b', kind: 'fallback', districtKey: 'lantern-quay', slot: { ordinal: 4, generation: 2, epoch: 1 }, rule: null, configVersion: 3, layoutGeometryFingerprint: HASH, issuedAt: '2026-10-20T10:00:00.000Z', expiresAt: '2026-10-20T10:15:00.000Z' }
  const RULE = { ...FALLBACK, kind: 'rule', districtKey: 'tidewater', slot: null, rule: { ref: 'captains-to-tidewater', asset: ASSET } }

  it('reads a fallback ticket, a rule ticket and no ticket, each marked as rehearsal data', () => {
    for (const ticket of [FALLBACK, RULE, null]) {
      const body = { rehearsal: MARK, ticket, fresh: true }
      expect(parseRehearsalTicketResponse(body)).toEqual(body)
    }
    // Extra fields (a session, a player) are never carried through.
    expect(parseRehearsalTicketResponse({ rehearsal: MARK, ticket: { ...FALLBACK, actor: 'x', sessionRef: 'y' }, fresh: false })).toEqual({ rehearsal: MARK, ticket: FALLBACK, fresh: false })
  })

  it('refuses a ticket that is not exactly one kind, or not rehearsal data', () => {
    const bad = [
      { ...FALLBACK, slot: null },
      { ...FALLBACK, rule: RULE.rule },
      { ...FALLBACK, slot: { ordinal: -1, generation: 1, epoch: 1 } },
      { ...FALLBACK, slot: { ordinal: 0, generation: 0, epoch: 1 } },
      { ...FALLBACK, slot: { ordinal: 0, generation: 1, epoch: 0 } },
      { ...RULE, slot: FALLBACK.slot },
      { ...RULE, rule: { ref: '', asset: ASSET } },
      { ...RULE, rule: { ref: 'r', asset: 'not-an-asset' } },
      { ...FALLBACK, kind: 'manual' },
      { ...FALLBACK, districtKey: 'Lantern Quay' },
      { ...FALLBACK, id: 'ticket-1' },
      { ...FALLBACK, configVersion: 0 },
      { ...FALLBACK, layoutGeometryFingerprint: HASH.toUpperCase() },
      { ...FALLBACK, expiresAt: 'soon' },
    ]
    for (const ticket of bad) expect(parseRehearsalTicketResponse({ rehearsal: MARK, ticket, fresh: false }), JSON.stringify(ticket)).toBeNull()
    expect(parseRehearsalTicketResponse({ rehearsal: { kind: 'local-test-assets', verified: true }, ticket: FALLBACK, fresh: false })).toBeNull()
    expect(parseRehearsalTicketResponse({ rehearsal: MARK, ticket: FALLBACK })).toBeNull()
  })
})
