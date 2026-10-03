import { describe, expect, it } from 'vitest'
import { parseFriendsResponse } from './identity'
import { ACTIVATION_DOMAIN_NAME, ACTIVATION_DOMAIN_VERSION, ACTIVATION_INTENTS_ENDPOINT, ACTIVATION_PRIMARY_TYPE, ACTIVATION_STATEMENT, ACTIVATION_TYPES, ACTIVATIONS_ENDPOINT, MAX_ACTIVATION_TOKEN_ID, parseCanonicalTokenId, parsePlotId } from './activation'

describe('canonical token id', () => {
  it('accepts zero and decimals with no leading zero, up to 2^53 - 1', () => {
    expect(parseCanonicalTokenId('0')).toBe(0n)
    expect(parseCanonicalTokenId('1')).toBe(1n)
    expect(parseCanonicalTokenId('812')).toBe(812n)
    expect(parseCanonicalTokenId('1000')).toBe(1000n)
    expect(parseCanonicalTokenId('9007199254740991')).toBe(9007199254740991n)
    expect(MAX_ACTIVATION_TOKEN_ID).toBe(9007199254740991)
  })

  it('refuses every other spelling of a number, and never repairs one', () => {
    const refused = [
      // signs
      '+1', '-1', '-0', '+0',
      // leading zeros
      '01', '0812', '00', '000',
      // fractions and exponents
      '1.0', '812.0', '1.5', '.5', '1.', '1e3', '1E3', '8e2',
      // other bases and separators
      '0x10', '0x32c', '0X10', '0b11', '0o7', '1_000', '1,000',
      // whitespace anywhere
      ' 1', '1 ', ' 812 ', '8 12', '\t812', '812\n', '',
      // not numbers
      'NaN', 'Infinity', '-Infinity', 'null', 'undefined', 'abc', '१२', '１２',
      // out of range
      '9007199254740992', '9007199254740993', '10000000000000000', '18446744073709551616', '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    ]
    for (const text of refused) expect(parseCanonicalTokenId(text), JSON.stringify(text)).toBeNull()
  })

  it('refuses anything that is not a string, so a JSON number is never a token id', () => {
    for (const value of [812, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 812n, true, null, undefined, ['812'], { tokenId: '812' }, new String('812')]) expect(parseCanonicalTokenId(value), String(value)).toBeNull()
  })
})

describe('plot id', () => {
  it('parses the one canonical spelling of a plot', () => {
    expect(parsePlotId('d4-w0-p7')).toEqual({ districtId: 'd4', ward: 0, plot: 7, plotId: 'd4-w0-p7' })
    expect(parsePlotId('d9-w12-p430')).toEqual({ districtId: 'd9', ward: 12, plot: 430, plotId: 'd9-w12-p430' })
    for (let d = 1; d <= 9; d++) expect(parsePlotId(`d${d}-w0-p0`)?.districtId).toBe(`d${d}`)
  })

  it('refuses anything else', () => {
    for (const text of ['', 'd4', 'd4-w0', 'd0-w0-p0', 'd10-w0-p0', 'D4-w0-p0', 'd4-W0-p0', 'd4-w00-p0', 'd4-w0-p07', 'd4-w-1-p0', 'd4-w0-p-1', 'd4-w1.0-p0', 'd4-w0-p1e3', 'd4-w0x1-p0', ' d4-w0-p0', 'd4-w0-p0 ', 'd4-w0-p0\n', 'd4_w0_p0', 'd4-w0-p1000000', 'd4-w1000000-p0', 'd4-w0-p0-x', 'x-d4-w0-p0'])
      expect(parsePlotId(text), JSON.stringify(text)).toBeNull()
    for (const value of [null, undefined, 4, { districtId: 'd4', ward: 0, plot: 0 }, ['d4-w0-p0']]) expect(parsePlotId(value)).toBeNull()
  })
})

describe('the frozen V1 PropertyActivation format', () => {
  it('is spelled exactly like this, for good', () => {
    expect(ACTIVATION_INTENTS_ENDPOINT).toBe('/v1/activation/intents')
    expect(ACTIVATIONS_ENDPOINT).toBe('/v1/activations')
    expect(ACTIVATION_DOMAIN_NAME).toBe('Rare City')
    expect(ACTIVATION_DOMAIN_VERSION).toBe('1')
    expect(ACTIVATION_PRIMARY_TYPE).toBe('PropertyActivation')
    expect(ACTIVATION_STATEMENT).toBe('Activate this Rare Friend as a permanent Rare City property.')
  })

  it('has a name, version and chain in its domain and no verifying contract', () => {
    expect(ACTIVATION_TYPES.EIP712Domain).toEqual([
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
    ])
  })

  it('binds these sixteen fields, in this order, and not the city sequence', () => {
    expect(ACTIVATION_TYPES.PropertyActivation.map((f) => `${f.type} ${f.name}`)).toEqual([
      'bytes32 intentId',
      'string site',
      'string statement',
      'address wallet',
      'address collection',
      'uint256 tokenId',
      'uint8 familyId',
      'string familyName',
      'string cityId',
      'string cityInstance',
      'string districtId',
      'uint32 ward',
      'uint32 plot',
      'string plotId',
      'uint64 issuedAt',
      'uint64 expiresAt',
    ])
    expect(Object.keys(ACTIVATION_TYPES)).toEqual(['EIP712Domain', 'PropertyActivation'])
    expect(JSON.stringify(ACTIVATION_TYPES)).not.toMatch(/sequence|verifyingContract|salt/i)
  })
})

describe('My Friends with the optional property annotation', () => {
  const wallet = { address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', chainId: 4663 }
  const property = { id: '29d2ac0a-1754-8500-acdd-802ba2c51575', buildingId: 'b-812', districtId: 'd4', ward: 0, plot: 7, plotId: 'd4-w0-p7', activatedAt: '2026-10-03T12:00:00.000Z' }

  it('is still read by the client that does not know the annotation yet', () => {
    const body = { wallet, source: 'robinhood-chain', asOfBlock: '79000000', friends: [{ tokenId: '812', family: { id: 2, name: 'Family' }, property }, { tokenId: '1204', family: { id: 0, name: 'Skeleton' }, property: null }] }
    // Exactly what it returned before the annotation existed: the extra key changes nothing.
    expect(parseFriendsResponse(body)).toEqual({ wallet, source: 'robinhood-chain', asOfBlock: '79000000', friends: [{ tokenId: '812', family: { id: 2, name: 'Family' } }, { tokenId: '1204', family: { id: 0, name: 'Skeleton' } }] })
  })
})
