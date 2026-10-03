import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { encodeAbiParameters, keccak256, recoverAddress, recoverTypedDataAddress, stringToHex, verifyTypedData, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { ownershipEraId, propertyId, propertyIdPreimage } from '../src/activation/propertyId'
import { activationDigest, activationTypedData, type IntentFacts } from '../src/activation/typedData'

/** The well-known public development account 0 (`test test ... junk`). Its key is public and holds nothing. */
const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const account = privateKeyToAccount(DEV_KEY)

/** Frozen outputs. A change to any of them is a change to what wallets sign or to permanent ids. */
const GOLDEN = {
  zero: 'abc2fd4d-1222-8e93-9c44-fc0e9206f090',
  max: '3135a130-3e5c-8cb5-97a8-899928b23dd0',
  era1: '897792e1-381a-88f7-91fb-9e491372a22a',
  digest: '0xe4e6bb396b664ee99470f42b16a95ced2a62f21ddf05f7cf804ef321562200ee',
  signature: '0x0c00eb0d93c654b492c907b1c01ff6a1ed253f1713acdc73bc92cf314d11799d34639edc68f34bc4395deac8a340c4632992b0cd6e0037bb40d8a9b5b11366f81c',
}

describe('deterministic property id (V1, frozen)', () => {
  it('hashes exactly this preimage', () => {
    expect(propertyIdPreimage('812')).toBe('rare-city:property:v1|world=rare-city|chain=4663|collection=0x14c49e6118f46525de9ab41a51cbaa3c6ebf181d|token=812')
  })

  it('GOLDEN VECTOR: Rare Friend 812 is property 29d2ac0a-1754-8500-acdd-802ba2c51575', () => {
    // SHA-256 of the preimage is 29d2ac0a17544500ecdd802ba2c51575a99e4a95... . Its first 16 bytes, with the
    // version nibble set to 8 (0x45 -> 0x85) and the variant bits to 10 (0xec -> 0xac), are this UUID.
    expect(createHash('sha256').update(propertyIdPreimage('812')).digest('hex')).toBe('29d2ac0a17544500ecdd802ba2c51575a99e4a959d093bee9f41702606e19389')
    expect(propertyId('812')).toBe('29d2ac0a-1754-8500-acdd-802ba2c51575')
  })

  it('GOLDEN VECTORS: the smallest and the largest supported Friend', () => {
    expect(propertyId('0')).toBe(GOLDEN.zero)
    expect(propertyId('9007199254740991')).toBe(GOLDEN.max)
  })

  it('is a version-8, RFC-variant UUID in canonical lowercase text, for every Friend', () => {
    const seen = new Set<string>()
    for (let token = 0; token < 2_000; token++) {
      const id = propertyId(String(token))
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      seen.add(id)
    }
    expect(seen.size).toBe(2_000)
  })

  it('is the same on every derivation, and in another process', () => {
    expect(new Set(Array.from({ length: 50 }, () => propertyId('812'))).size).toBe(1)
    const script = `import('./server/src/activation/propertyId.ts').then((m) => process.stdout.write(m.propertyId('812') + ' ' + m.propertyId('9007199254740991')))`
    const other = execFileSync('node_modules/.bin/tsx', ['-e', script], { encoding: 'utf8' })
    expect(other).toBe(`29d2ac0a-1754-8500-acdd-802ba2c51575 ${GOLDEN.max}`)
  })

  it('does not depend on the city installation: nothing but the Friend goes in', () => {
    expect(propertyId.length).toBe(1)
    expect(propertyIdPreimage('812')).not.toMatch(/instance|city=|sequence/)
  })

  it('refuses a token id that is not canonical decimal rather than derive an id from it', () => {
    for (const bad of ['01', '0812', '812.0', '1e3', '0x32c', ' 812', '812 ', '-1', '+1', '', 'abc']) expect(() => propertyId(bad), bad).toThrow()
  })

  it('derives ownership era ids the same way, from the property and the era number', () => {
    const property = propertyId('812')
    expect(ownershipEraId(property, 1)).toBe(GOLDEN.era1)
    expect(ownershipEraId(property, 1)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(ownershipEraId(property, 2)).not.toBe(ownershipEraId(property, 1))
    expect(ownershipEraId(propertyId('813'), 1)).not.toBe(ownershipEraId(property, 1))
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => ownershipEraId(property, bad)).toThrow()
    expect(() => ownershipEraId('not-a-uuid', 1)).toThrow()
  })
})

const FACTS: IntentFacts = {
  intentId: '11'.repeat(32),
  site: 'https://rarecity.example',
  wallet: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  tokenId: 812n,
  family: { id: 2, name: 'Family' },
  cityId: 'main',
  cityInstance: 'd8fae2d7-7044-4faf-b36c-f4b700c3ba28',
  districtId: 'd4',
  ward: 0,
  plot: 7,
  issuedAt: new Date(1_791_000_000_000),
  expiresAt: new Date(1_791_000_600_000),
}

describe('EIP-712 PropertyActivation (V1, frozen)', () => {
  it('GOLDEN VECTOR: builds exactly this typed data', () => {
    expect(activationTypedData(FACTS)).toEqual({
      domain: { name: 'Rare City', version: '1', chainId: 4663 },
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
        ],
        PropertyActivation: [
          { name: 'intentId', type: 'bytes32' },
          { name: 'site', type: 'string' },
          { name: 'statement', type: 'string' },
          { name: 'wallet', type: 'address' },
          { name: 'collection', type: 'address' },
          { name: 'tokenId', type: 'uint256' },
          { name: 'familyId', type: 'uint8' },
          { name: 'familyName', type: 'string' },
          { name: 'cityId', type: 'string' },
          { name: 'cityInstance', type: 'string' },
          { name: 'districtId', type: 'string' },
          { name: 'ward', type: 'uint32' },
          { name: 'plot', type: 'uint32' },
          { name: 'plotId', type: 'string' },
          { name: 'issuedAt', type: 'uint64' },
          { name: 'expiresAt', type: 'uint64' },
        ],
      },
      primaryType: 'PropertyActivation',
      message: {
        intentId: `0x${'11'.repeat(32)}`,
        site: 'https://rarecity.example',
        statement: 'Activate this Rare Friend as a permanent Rare City property.',
        wallet: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        collection: '0x14C49e6118F46525dE9ab41a51cBAA3c6EBF181D',
        tokenId: '812',
        familyId: 2,
        familyName: 'Family',
        cityId: 'main',
        cityInstance: 'd8fae2d7-7044-4faf-b36c-f4b700c3ba28',
        districtId: 'd4',
        ward: 0,
        plot: 7,
        plotId: 'd4-w0-p7',
        issuedAt: '1791000000000',
        expiresAt: '1791000600000',
      },
    })
  })

  it('GOLDEN VECTOR: hashes to exactly this digest', () => {
    expect(activationDigest(activationTypedData(FACTS))).toBe(GOLDEN.digest)
  })

  it('is the hash EIP-712 defines, computed here by hand from the specification', () => {
    const hashText = (text: string) => keccak256(stringToHex(text))
    const domainType = 'EIP712Domain(string name,string version,uint256 chainId)'
    const domainSeparator = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }], [hashText(domainType), hashText('Rare City'), hashText('1'), 4663n]))
    const messageType =
      'PropertyActivation(bytes32 intentId,string site,string statement,address wallet,address collection,uint256 tokenId,uint8 familyId,string familyName,string cityId,string cityInstance,string districtId,uint32 ward,uint32 plot,string plotId,uint64 issuedAt,uint64 expiresAt)'
    const word = { type: 'bytes32' } as const
    const structHash = keccak256(
      encodeAbiParameters(
        [word, word, word, word, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint8' }, word, word, word, word, { type: 'uint32' }, { type: 'uint32' }, word, { type: 'uint64' }, { type: 'uint64' }],
        [
          hashText(messageType),
          `0x${'11'.repeat(32)}`,
          hashText('https://rarecity.example'),
          hashText('Activate this Rare Friend as a permanent Rare City property.'),
          '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
          '0x14C49e6118F46525dE9ab41a51cBAA3c6EBF181D',
          812n,
          2,
          hashText('Family'),
          hashText('main'),
          hashText('d8fae2d7-7044-4faf-b36c-f4b700c3ba28'),
          hashText('d4'),
          0,
          7,
          hashText('d4-w0-p7'),
          1_791_000_000_000n,
          1_791_000_600_000n,
        ],
      ),
    )
    const digest = keccak256(`0x1901${domainSeparator.slice(2)}${structHash.slice(2)}` as Hex)
    expect(digest).toBe(GOLDEN.digest)
  })

  it('GOLDEN VECTOR: the development account signs it to exactly this signature, and it recovers', async () => {
    const typedData = activationTypedData(FACTS)
    // Signed the way a wallet would be asked to: from the JSON form, with large integers as decimal strings.
    const signature = await account.signTypedData(JSON.parse(JSON.stringify(typedData)))
    expect(signature).toBe(GOLDEN.signature)
    expect(await recoverAddress({ hash: activationDigest(typedData), signature })).toBe(account.address)
    expect(await recoverTypedDataAddress({ ...JSON.parse(JSON.stringify(typedData)), signature })).toBe(account.address)
    expect(await verifyTypedData({ ...JSON.parse(JSON.stringify(typedData)), address: account.address, signature })).toBe(true)
  })

  it('changes its digest when any one signed field changes', () => {
    const base = activationDigest(activationTypedData(FACTS))
    const variants: Partial<IntentFacts>[] = [
      { intentId: '22'.repeat(32) },
      { site: 'https://rarecity.world' },
      { wallet: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' },
      { tokenId: 813n },
      { family: { id: 7, name: 'Sparkling' } },
      { cityId: 'other' },
      { cityInstance: 'c8b6db6c-5075-4fa0-bfe3-cf138c9120dd' },
      { districtId: 'd2' },
      { ward: 1 },
      { plot: 8 },
      { issuedAt: new Date(1_791_000_000_001) },
      { expiresAt: new Date(1_791_000_600_001) },
    ]
    const digests = variants.map((patch) => activationDigest(activationTypedData({ ...FACTS, ...patch })))
    for (const digest of digests) expect(digest).not.toBe(base)
    expect(new Set(digests).size).toBe(variants.length)
  })

  it('writes the wallet and collection checksummed whatever casing it is given, and signs the same thing', () => {
    const upper = activationTypedData({ ...FACTS, wallet: '0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266'.replace('0X', '0x') })
    expect(upper.message.wallet).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
    expect(activationDigest(upper)).toBe(GOLDEN.digest)
  })

  it('carries times as Unix milliseconds, exactly', () => {
    const { message } = activationTypedData({ ...FACTS, issuedAt: new Date('2026-10-03T20:11:32.123Z'), expiresAt: new Date('2026-10-03T20:21:32.123Z') })
    expect(message.issuedAt).toBe(String(Date.parse('2026-10-03T20:11:32.123Z')))
    expect(Number(message.expiresAt) - Number(message.issuedAt)).toBe(600_000)
  })
})
