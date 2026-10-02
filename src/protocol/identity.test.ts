import { describe, expect, it } from 'vitest'
import { parseChallengeResponse, parseFriendsResponse, parseViewerResponse } from './identity'

const ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const USER = '7b0c1c7e-3c53-4d0e-9a52-6a3f5d0f1a11'
const viewer = () => ({ authenticated: true, userId: USER, wallet: { address: ADDRESS, chainId: 4663 }, session: { expiresAt: '2026-10-09T12:00:00.000Z' } })
const friends = () => ({ wallet: { address: ADDRESS, chainId: 4663 }, source: 'robinhood-chain', asOfBlock: '77993355', friends: [{ tokenId: '812', family: { id: 2, name: 'Family' } }] })

describe('parseViewerResponse', () => {
  it('accepts anonymous and authenticated viewers', () => {
    expect(parseViewerResponse({ authenticated: false })).toEqual({ authenticated: false })
    expect(parseViewerResponse(JSON.parse(JSON.stringify(viewer())))).toEqual(viewer())
  })

  it('keeps only the contract, so nothing extra reaches the page', () => {
    expect(parseViewerResponse({ authenticated: false, userId: USER, wallet: { address: ADDRESS, chainId: 4663 } })).toEqual({ authenticated: false })
    expect(parseViewerResponse({ ...viewer(), tokenHash: 'abc', wallet: { ...viewer().wallet, privateNote: 'x' } })).toEqual(viewer())
  })

  it('rejects anything that would invent or half-describe an identity', () => {
    const bad: unknown[] = [null, undefined, 'anonymous', [], {}, { authenticated: 'true' }, { authenticated: 1 }]
    for (const patch of [{ userId: 'demo-player' }, { userId: '' }, { userId: null }, { wallet: null }, { wallet: { address: '0x1234', chainId: 4663 } }, { wallet: { address: ADDRESS, chainId: '4663' } }, { wallet: { address: ADDRESS, chainId: 0 } }, { session: null }, { session: { expiresAt: 'soon' } }, { session: {} }])
      bad.push({ ...viewer(), ...patch })
    for (const value of bad) expect(parseViewerResponse(value), JSON.stringify(value)).toBeNull()
  })
})

describe('parseChallengeResponse', () => {
  it('needs a nonce, a message and an expiry', () => {
    const ok = { nonce: 'a'.repeat(32), message: 'sign me', expiresAt: '2026-10-02T12:05:00.000Z' }
    expect(parseChallengeResponse({ ...ok, extra: 1 })).toEqual(ok)
    for (const value of [null, {}, { ...ok, nonce: '' }, { ...ok, message: 7 }, { ...ok, message: '' }, { ...ok, expiresAt: undefined }]) expect(parseChallengeResponse(value)).toBeNull()
  })
})

describe('parseFriendsResponse', () => {
  it('accepts owned Friends with string token ids and a known family', () => {
    expect(parseFriendsResponse(JSON.parse(JSON.stringify(friends())))).toEqual(friends())
    expect(parseFriendsResponse({ ...friends(), friends: [] })?.friends).toEqual([])
    expect(parseFriendsResponse({ ...friends(), source: 'fixture', asOfBlock: '0' })?.source).toBe('fixture')
    const huge = (2n ** 200n).toString()
    expect(parseFriendsResponse({ ...friends(), friends: [{ tokenId: huge, family: { id: 8, name: 'Hollow' } }] })?.friends[0].tokenId).toBe(huge)
  })

  it('rejects a family that is not one of the nine, or whose name and id disagree', () => {
    for (const family of [{ id: 9, name: 'Ghost' }, { id: 2, name: 'Mask' }, { id: '2', name: 'Family' }, { id: -1, name: 'Skeleton' }, { name: 'Family' }, null, undefined])
      expect(parseFriendsResponse({ ...friends(), friends: [{ tokenId: '1', family }] }), JSON.stringify(family)).toBeNull()
  })

  it('rejects anything else that is not the contract', () => {
    const bad: unknown[] = [null, [], {}, { ...friends(), source: 'opensea' }, { ...friends(), wallet: { address: 'me', chainId: 4663 } }, { ...friends(), asOfBlock: 77993355 }, { ...friends(), asOfBlock: '-1' }, { ...friends(), friends: null }, { ...friends(), friends: [null] }]
    for (const tokenId of [812, '0x32c', '-1', '01', '1.5', '', '1e3', ' 1']) bad.push({ ...friends(), friends: [{ tokenId, family: { id: 2, name: 'Family' } }] })
    for (const value of bad) expect(parseFriendsResponse(value), JSON.stringify(value)).toBeNull()
  })
})
