import { RARE_FRIENDS_CHAIN } from '../config/rareFriends'
import { firstAccount, parseChainId, providerErrorCode, type Eip1193Provider } from '../identity/wallet'
import type { ActivationTypedData } from '../protocol/activation'

/**
 * THE WALLET SIGNING BOUNDARY for Friend activation.
 *
 * Everything the activation flow knows about wallets is in this file: how to ask one what
 * it has selected, how to ask it to sign, and what counts as a signature Rare City can
 * verify today. The flow sees only `ActivationSigner` and `ActivationProof`, so another way
 * of proving a signature (a contract wallet, for instance) is another proof kind and
 * another signer here, not a change to the flow or its screens.
 *
 * The only wallet methods used are `eth_accounts`, `eth_chainId` and `eth_signTypedData_v4`.
 * Nothing here sends a transaction, asks for an approval, or moves anything.
 */

/** What a wallet produced, in a form the server can verify. One kind exists today. */
export type ActivationProof = {
  /** A plain 65-byte ECDSA signature: `0x` and 130 hex characters. */
  kind: 'ecdsa'
  signature: string
}

export type SignerRefusal =
  /** No wallet is in use, or it has no account connected to this page. */
  | { reason: 'no-wallet' }
  /** The wallet has a different account selected than the one that is signed in. */
  | { reason: 'account-changed' }
  /** The wallet is on another network. */
  | { reason: 'wrong-chain'; chainId: number | null }
  /** The person said no in the wallet. */
  | { reason: 'declined' }
  /** The wallet already has a request open. */
  | { reason: 'busy' }
  /** The wallet failed in some other way. */
  | { reason: 'wallet-error' }
  /** The wallet answered with something that is not a 65-byte signature. Only its length is kept. */
  | { reason: 'unsupported-signature'; byteLength: number | null }

export type SignerCheck = { ok: true; account: string } | ({ ok: false } & SignerRefusal)
export type SignerResult = { ok: true; proof: ActivationProof } | ({ ok: false } & SignerRefusal)

export interface ActivationSigner {
  /** Is the wallet, right now, on `address` and on Robinhood Chain? Never prompts. */
  check(address: string): Promise<SignerCheck>
  /**
   * Ask the wallet to sign `typedData` exactly as given, as `address`. Checks the account
   * and the network again first, and refuses rather than sign as anyone else or anywhere else.
   */
  sign(address: string, typedData: ActivationTypedData): Promise<SignerResult>
}

const ECDSA_SIGNATURE = /^0x[0-9a-fA-F]{130}$/
const HEX = /^0x([0-9a-fA-F]{2})*$/

/**
 * Sort what a wallet returned into a proof Rare City can verify, or not one.
 *
 * Exactly 65 bytes is a proof. Anything else is refused whatever the wallet calls itself,
 * and only its length in bytes (when it has one) leaves this function: the value itself is
 * not kept, returned or written anywhere.
 */
export function classifySignature(value: unknown): { ok: true; proof: ActivationProof } | { ok: false; byteLength: number | null } {
  if (typeof value === 'string' && ECDSA_SIGNATURE.test(value)) return { ok: true, proof: { kind: 'ecdsa', signature: value } }
  return { ok: false, byteLength: typeof value === 'string' && HEX.test(value) ? (value.length - 2) / 2 : null }
}

/** A signer over the injected wallet currently in use. `provider` is asked each time: the wallet in use can change. */
export function createInjectedSigner(provider: () => Eip1193Provider | null): ActivationSigner {
  async function check(wallet: Eip1193Provider, address: string): Promise<SignerCheck> {
    let account: string | null
    let chainId: number | null
    try {
      // Asked of the wallet now, not remembered: it may have moved since the page last heard from it.
      account = firstAccount(await wallet.request({ method: 'eth_accounts' }))
      chainId = parseChainId(await wallet.request({ method: 'eth_chainId' }))
    } catch {
      return { ok: false, reason: 'wallet-error' }
    }
    if (!account) return { ok: false, reason: 'no-wallet' }
    if (account !== address.toLowerCase()) return { ok: false, reason: 'account-changed' }
    if (chainId !== RARE_FRIENDS_CHAIN.chainId) return { ok: false, reason: 'wrong-chain', chainId }
    return { ok: true, account }
  }

  return {
    async check(address) {
      const wallet = provider()
      return wallet ? check(wallet, address) : { ok: false, reason: 'no-wallet' }
    },
    async sign(address, typedData) {
      const wallet = provider()
      if (!wallet) return { ok: false, reason: 'no-wallet' }
      const ready = await check(wallet, address)
      if (!ready.ok) return ready
      let answer: unknown
      try {
        // The typed data goes to the wallet as the server wrote it. Nothing is added, dropped or reordered.
        answer = await wallet.request({ method: 'eth_signTypedData_v4', params: [ready.account, JSON.stringify(typedData)] })
      } catch (err) {
        const code = providerErrorCode(err)
        return { ok: false, reason: code === 4001 ? 'declined' : code === -32002 ? 'busy' : 'wallet-error' }
      }
      const sorted = classifySignature(answer)
      return sorted.ok ? sorted : { ok: false, reason: 'unsupported-signature', byteLength: sorted.byteLength }
    },
  }
}
