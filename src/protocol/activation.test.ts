import { describe, expect, it } from 'vitest'
import { parseFriendsResponse } from './identity'
import { ACTIVATION_DOMAIN_NAME, ACTIVATION_DOMAIN_VERSION, ACTIVATION_INTENTS_ENDPOINT, ACTIVATION_PRIMARY_TYPE, ACTIVATION_STATEMENT, ACTIVATION_TYPES, ACTIVATIONS_ENDPOINT, MAX_ACTIVATION_TOKEN_ID, parseActivationCommitResponse, parseActivationIntentResponse, parseCanonicalTokenId, parsePlotId } from './activation'

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

describe('My Friends with the property annotation', () => {
  const wallet = { address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', chainId: 4663 }
  const property = { id: '29d2ac0a-1754-8500-acdd-802ba2c51575', buildingId: 'b-812', districtId: 'd4', ward: 0, plot: 7, plotId: 'd4-w0-p7', activatedAt: '2026-10-03T12:00:00.000Z' }
  const body = (friends: unknown[]) => ({ wallet, source: 'robinhood-chain', asOfBlock: '79000000', friends })
  const family = { id: 2, name: 'Family' }

  it('keeps all three answers apart: a property, none, and could-not-tell', () => {
    const parsed = parseFriendsResponse(body([{ tokenId: '812', family, property }, { tokenId: '1204', family: { id: 0, name: 'Skeleton' }, property: null }, { tokenId: '4471', family: { id: 7, name: 'Sparkling' } }]))
    expect(parsed?.friends).toEqual([{ tokenId: '812', family, property }, { tokenId: '1204', family: { id: 0, name: 'Skeleton' }, property: null }, { tokenId: '4471', family: { id: 7, name: 'Sparkling' } }])
    // Absent stays absent: "the server could not tell" is never turned into "has none".
    expect(Object.hasOwn(parsed!.friends[2], 'property')).toBe(false)
  })

  it('keeps only the contract of a property', () => {
    expect(parseFriendsResponse(body([{ tokenId: '812', family, property: { ...property, ownerId: 'u', secret: 1 } }]))?.friends[0].property).toEqual(property)
  })

  it('reads the rehearsed Friend as already activated', () => {
    const rehearsed = { id: '5f29bf55-6d76-8365-9581-0327fbc0fa22', buildingId: 'b-345260', districtId: 'd8', ward: 0, plot: 0, plotId: 'd8-w0-p0', activatedAt: '2026-10-05T12:00:00.000Z' }
    expect(parseFriendsResponse(body([{ tokenId: '345260', family: { id: 0, name: 'Skeleton' }, property: rehearsed }]))?.friends[0].property).toEqual(rehearsed)
  })

  it('refuses a property that does not hang together, rather than showing part of one', () => {
    const bad: unknown[] = ['d4-w0-p7', 7, [], {}, { ...property, id: '' }, { ...property, buildingId: null }, { ...property, activatedAt: 'recently' }]
    // The plot id must be canonical and must say what the separate fields say.
    for (const patch of [{ plotId: 'd4-w0-p8' }, { plotId: 'd4-w00-p7' }, { plotId: 'D4-W0-P7' }, { ward: 1 }, { plot: 6 }, { districtId: 'd5' }, { ward: '0' }]) bad.push({ ...property, ...patch })
    // Family geography is permanent: a Family Friend's property is in Family's district or it is not a property.
    bad.push({ ...property, districtId: 'd8', plotId: 'd8-w0-p7' })
    for (const value of bad) expect(parseFriendsResponse(body([{ tokenId: '812', family, property: value }])), JSON.stringify(value)).toBeNull()
  })
})

describe('reading an intent', () => {
  const typedData = () => ({
    domain: { name: ACTIVATION_DOMAIN_NAME, version: ACTIVATION_DOMAIN_VERSION, chainId: 4663 },
    types: ACTIVATION_TYPES,
    primaryType: ACTIVATION_PRIMARY_TYPE,
    message: { intentId: `0x${'a'.repeat(64)}`, site: 'https://rarecity.example', statement: ACTIVATION_STATEMENT, wallet: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', collection: '0x14C49e6118F46525dE9ab41a51cBAA3c6EBF181D', tokenId: '812', familyId: 2, familyName: 'Family', cityId: 'main', cityInstance: 'inst-1', districtId: 'd4', ward: 0, plot: 7, plotId: 'd4-w0-p7', issuedAt: '1791547200000', expiresAt: '1791547800000' },
  })
  const intent = () => ({ intentId: 'a'.repeat(64), expiresAt: '2026-10-09T12:10:00.000Z', typedData: typedData(), digest: `0x${'b'.repeat(64)}` })

  it('hands back the very typed data object it was given, untouched', () => {
    const body = intent()
    const frozen = JSON.stringify(body.typedData)
    const parsed = parseActivationIntentResponse(body)
    expect(parsed).toEqual(intent())
    // The same object, not a copy: what the wallet signs is what the server sent.
    expect(parsed!.typedData).toBe(body.typedData)
    expect(JSON.stringify(parsed!.typedData)).toBe(frozen)
  })

  it('refuses anything that is not an intent', () => {
    const bad: unknown[] = [null, [], 'intent', {}, { ...intent(), intentId: 'A'.repeat(64) }, { ...intent(), intentId: 'a'.repeat(63) }, { ...intent(), expiresAt: 'soon' }, { ...intent(), digest: 'b'.repeat(64) }, { ...intent(), typedData: null }, { ...intent(), typedData: JSON.stringify(typedData()) }]
    bad.push({ ...intent(), typedData: { ...typedData(), primaryType: 'Permit' } })
    bad.push({ ...intent(), typedData: { ...typedData(), domain: { name: 'Rare City', version: '1', chainId: '4663' } } })
    bad.push({ ...intent(), typedData: { ...typedData(), types: [] } })
    for (const patch of [{ tokenId: 812 }, { ward: '0' }, { plot: -1 }, { familyId: 1.5 }, { plotId: undefined }, { expiresAt: 1791547800000 }, { wallet: null }]) bad.push({ ...intent(), typedData: { ...typedData(), message: { ...typedData().message, ...patch } } })
    for (const value of bad) expect(parseActivationIntentResponse(value), JSON.stringify(value)).toBeNull()
  })
})

describe('reading a commit', () => {
  const committed = () => ({ status: 'committed', property: { id: '5f29bf55-6d76-8365-9581-0327fbc0fa22', tokenId: '345260', buildingId: 'b-345260', districtId: 'd8', ward: 0, plot: 0, plotId: 'd8-w0-p0', activatedAt: '2026-10-05T12:00:00.000Z', sequence: 2 }, city: { id: 'main', instance: 'd8fae2d7' } })

  it('accepts a committed property and keeps only the contract', () => {
    expect(parseActivationCommitResponse(committed())).toEqual(committed())
    expect(parseActivationCommitResponse({ ...committed(), debug: 'x', property: { ...committed().property, ownerId: 'u' } })).toEqual(committed())
  })

  it('refuses anything that is not a committed property', () => {
    const bad: unknown[] = [null, {}, 'committed', { ...committed(), status: 'pending' }, { ...committed(), city: null }, { ...committed(), city: { id: 'main' } }, { ...committed(), property: null }]
    for (const patch of [{ tokenId: 345260 }, { tokenId: '0345260' }, { buildingId: '' }, { plotId: 'd8-w0-p1' }, { districtId: 'd7' }, { ward: 1 }, { sequence: '2' }, { sequence: -1 }, { activatedAt: null }, { id: undefined }]) bad.push({ ...committed(), property: { ...committed().property, ...patch } })
    for (const value of bad) expect(parseActivationCommitResponse(value), JSON.stringify(value)).toBeNull()
  })
})
