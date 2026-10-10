import { describe, expect, it } from 'vitest'
import type { ActivationTypedData } from '../protocol/activation'
import { classifySignature, createInjectedSigner } from './signer'
import { ALICE, BOB, fakeWallet, SIGNATURE } from './testWorld'

const a = ALICE.toLowerCase()
/** Stands in for the server's typed data: the signer passes it on and never looks inside. */
const TYPED = { domain: { name: 'Rare City', version: '1', chainId: 4663 }, primaryType: 'PropertyActivation', types: {}, message: { z: 'last', a: 'first', tokenId: '1204' } } as unknown as ActivationTypedData

describe('classifySignature', () => {
  it('takes exactly 65 bytes of hex, in either case, and nothing else', () => {
    expect(classifySignature(SIGNATURE)).toEqual({ ok: true, proof: { kind: 'ecdsa', signature: SIGNATURE } })
    expect(classifySignature(`0x${'AB'.repeat(65)}`)).toMatchObject({ ok: true })
    expect(classifySignature(`0x${'ab'.repeat(64)}`)).toEqual({ ok: false, byteLength: 64 })
    expect(classifySignature(`0x${'ab'.repeat(66)}`)).toEqual({ ok: false, byteLength: 66 })
    expect(classifySignature(`0x${'ab'.repeat(1000)}`)).toEqual({ ok: false, byteLength: 1000 })
    expect(classifySignature('0x')).toEqual({ ok: false, byteLength: 0 })
  })

  it('reports no length for what is not whole bytes of hex, and never hands the value back', () => {
    for (const value of [`${'ab'.repeat(65)}`, `0x${'ab'.repeat(64)}a`, `0x${'zz'.repeat(65)}`, ` ${SIGNATURE}`, `${SIGNATURE}\n`, '', null, undefined, 65, {}, [SIGNATURE]]) {
      const sorted = classifySignature(value)
      expect(sorted).toEqual({ ok: false, byteLength: null })
      expect(Object.keys(sorted)).toEqual(['ok', 'byteLength'])
    }
  })
})

describe('the injected signer', () => {
  it('signs with eth_signTypedData_v4, passing the typed data exactly as it was given', async () => {
    const wallet = fakeWallet()
    const signer = createInjectedSigner(() => wallet.provider)
    expect(await signer.sign(ALICE, TYPED)).toEqual({ ok: true, proof: { kind: 'ecdsa', signature: SIGNATURE } })
    expect(wallet.methods()).toEqual(['eth_accounts', 'eth_chainId', 'eth_signTypedData_v4'])
    // Same keys in the same order, nothing added: the string is the object as sent.
    expect(wallet.signRequests()[0].params).toEqual([a, '{"domain":{"name":"Rare City","version":"1","chainId":4663},"primaryType":"PropertyActivation","types":{},"message":{"z":"last","a":"first","tokenId":"1204"}}'])
  })

  it('checks the account and the network without prompting', async () => {
    const wallet = fakeWallet()
    const signer = createInjectedSigner(() => wallet.provider)
    expect(await signer.check(ALICE)).toEqual({ ok: true, account: a })
    wallet.selectAccount(BOB)
    expect(await signer.check(ALICE)).toEqual({ ok: false, reason: 'account-changed' })
    wallet.selectAccount(null)
    expect(await signer.check(ALICE)).toEqual({ ok: false, reason: 'no-wallet' })
    wallet.selectAccount(ALICE)
    wallet.selectChain(1)
    expect(await signer.check(ALICE)).toEqual({ ok: false, reason: 'wrong-chain', chainId: 1 })
    expect(new Set(wallet.methods())).toEqual(new Set(['eth_accounts', 'eth_chainId']))
  })

  it('refuses to sign as another account or on another network, before the wallet is asked to sign', async () => {
    const other = fakeWallet({ accounts: [BOB.toLowerCase()] })
    expect(await createInjectedSigner(() => other.provider).sign(ALICE, TYPED)).toEqual({ ok: false, reason: 'account-changed' })
    const elsewhere = fakeWallet({ chainId: 8453 })
    expect(await createInjectedSigner(() => elsewhere.provider).sign(ALICE, TYPED)).toEqual({ ok: false, reason: 'wrong-chain', chainId: 8453 })
    expect([other.signRequests(), elsewhere.signRequests()]).toEqual([[], []])
    expect(await createInjectedSigner(() => null).sign(ALICE, TYPED)).toEqual({ ok: false, reason: 'no-wallet' })
  })

  it('tells a declined request, a busy wallet and a broken one apart', async () => {
    const wallet = fakeWallet()
    const signer = createInjectedSigner(() => wallet.provider)
    wallet.fail.set('eth_signTypedData_v4', Object.assign(new Error('User rejected the request.'), { code: 4001 }))
    expect(await signer.sign(ALICE, TYPED)).toEqual({ ok: false, reason: 'declined' })
    wallet.fail.set('eth_signTypedData_v4', Object.assign(new Error('pending'), { code: -32002 }))
    expect(await signer.sign(ALICE, TYPED)).toEqual({ ok: false, reason: 'busy' })
    wallet.fail.set('eth_signTypedData_v4', new Error('boom'))
    expect(await signer.sign(ALICE, TYPED)).toEqual({ ok: false, reason: 'wallet-error' })
    wallet.fail.clear()
    wallet.fail.set('eth_chainId', new Error('locked'))
    expect(await signer.sign(ALICE, TYPED)).toEqual({ ok: false, reason: 'wallet-error' })
  })

  it('turns any other answer into a length and nothing more', async () => {
    const blob = `0x${'ab'.repeat(416)}`
    const wallet = fakeWallet({ signature: blob })
    const result = await createInjectedSigner(() => wallet.provider).sign(ALICE, TYPED)
    expect(result).toEqual({ ok: false, reason: 'unsupported-signature', byteLength: 416 })
    expect(JSON.stringify(result)).not.toContain('abab')
  })

  it('never asks a wallet to send, approve, or switch anything', async () => {
    const wallet = fakeWallet()
    const signer = createInjectedSigner(() => wallet.provider)
    await signer.check(ALICE)
    await signer.sign(ALICE, TYPED)
    expect(wallet.methods().filter((m) => !['eth_accounts', 'eth_chainId', 'eth_signTypedData_v4'].includes(m))).toEqual([])
  })
})
