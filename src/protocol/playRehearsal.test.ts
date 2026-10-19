import { describe, expect, it } from 'vitest'
import { parseRehearsalActivationResponse, parseRehearsalAssetsResponse } from './playRehearsal'

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
    const body = { rehearsal: MARK, fresh: true, sequence: 2, property: PROPERTY }
    expect(parseRehearsalActivationResponse(body)).toEqual(body)
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
