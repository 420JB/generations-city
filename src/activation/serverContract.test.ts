import { recoverAddress, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
// The SERVER's own builder and hash: what it writes into an intent, and what it later recovers the signer against.
import { activationDigest, activationTypedData, type IntentFacts } from '../../server/src/activation/typedData'
import type { Eip1193Provider } from '../identity/wallet'
import { parseActivationIntentResponse, type ActivationIntentResponse } from '../protocol/activation'
import { isExpectedIntent } from './flow'
import { createInjectedSigner } from './signer'

/**
 * THE SEAM between the two halves, with no database, no network and no chain.
 *
 * Elsewhere the client is tested against a pretend server and the server against its own
 * tests. Here the real pieces meet: the server's intent, as JSON; the client's parser, its
 * "is this what was reviewed" check and its signer; a wallet that signs what it is handed;
 * and the server's digest, against which the signer must recover.
 */

/** The well-known public development account 0 (`test test ... junk`). Its key is public and holds nothing. */
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const ORIGIN = 'https://staging.rarecity.example'

const FACTS: IntentFacts = {
  intentId: '5e'.repeat(32),
  site: ORIGIN,
  // The session's wallet as the database keeps it: lowercase.
  wallet: account.address.toLowerCase(),
  tokenId: 1204n,
  family: { id: 0, name: 'Skeleton' },
  cityId: 'main',
  cityInstance: 'd8fae2d7-0000-4000-8000-000000000000',
  districtId: 'd8',
  ward: 0,
  plot: 3,
  issuedAt: new Date('2026-10-09T12:00:00.123Z'),
  expiresAt: new Date('2026-10-09T12:10:00.123Z'),
}

/** The intent as it crosses the wire: built the way the service builds its response, then through JSON. */
function overTheWire(facts: IntentFacts = FACTS): { body: unknown; digest: Hex } {
  const typedData = activationTypedData(facts)
  const digest = activationDigest(typedData)
  const response: ActivationIntentResponse = { intentId: facts.intentId, expiresAt: facts.expiresAt.toISOString(), typedData, digest }
  return { body: JSON.parse(JSON.stringify(response)), digest }
}

/** A wallet that signs exactly the JSON it is handed, the way `eth_signTypedData_v4` is specified. */
function signingWallet() {
  const handed: string[] = []
  const provider: Eip1193Provider = {
    async request({ method, params }) {
      if (method === 'eth_accounts') return [account.address.toLowerCase()]
      if (method === 'eth_chainId') return '0x1237'
      if (method !== 'eth_signTypedData_v4') throw new Error(`unexpected ${method}`)
      const [address, json] = params as [string, string]
      if (address !== account.address.toLowerCase()) throw new Error('asked to sign as another account')
      handed.push(json)
      return account.signTypedData(JSON.parse(json))
    },
  }
  return { provider, handed }
}

const expected = { tokenId: '1204', plotId: 'd8-w0-p3', family: { id: 0, name: 'Skeleton' as const }, wallet: account.address, origin: ORIGIN }

describe('the server intent, in the client hands', () => {
  it('is read by the client parser and recognised as the activation that was reviewed', () => {
    const intent = parseActivationIntentResponse(overTheWire().body)
    expect(intent).not.toBeNull()
    expect(isExpectedIntent(intent!, expected)).toBe(true)
    // Whatever casing the session address arrives in.
    expect(isExpectedIntent(intent!, { ...expected, wallet: account.address.toLowerCase() })).toBe(true)
  })

  it('is refused by the client check when it is for anything other than what was reviewed', () => {
    const variants: [string, Partial<IntentFacts>][] = [
      ['another plot', { plot: 4 }],
      ['another ward', { ward: 1 }],
      ['another district', { districtId: 'd4' }],
      ['another Friend', { tokenId: 812n }],
      ['another family', { family: { id: 1, name: 'Mask' } }],
      ['another wallet', { wallet: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' }],
      ['another site', { site: 'https://rarecity.example' }],
    ]
    for (const [name, patch] of variants) {
      const intent = parseActivationIntentResponse(overTheWire({ ...FACTS, ...patch }).body)
      expect(intent, name).not.toBeNull()
      expect(isExpectedIntent(intent!, expected), name).toBe(false)
    }
  })

  it('signed through the client signer, recovers to the wallet against the SERVER digest', async () => {
    const { body, digest } = overTheWire()
    const intent = parseActivationIntentResponse(body)!
    const wallet = signingWallet()
    const signed = await createInjectedSigner(() => wallet.provider).sign(account.address, intent.typedData)

    // The wallet was handed the server's message byte for byte as it came over the wire.
    expect(wallet.handed).toEqual([JSON.stringify((body as ActivationIntentResponse).typedData)])
    if (!signed.ok) throw new Error(`the signer refused: ${signed.reason}`)
    expect(signed.proof.kind).toBe('ecdsa')
    expect(signed.proof.signature).toMatch(/^0x[0-9a-f]{130}$/)
    // What the server does at commit: recover the signer from the hash IT stored.
    expect(await recoverAddress({ hash: digest, signature: signed.proof.signature as Hex })).toBe(account.address)
    expect(intent.digest).toBe(digest)
  })
})
