/**
 * Browser wallet discovery: injected EIP-1193 providers, found through EIP-6963 where the
 * wallet supports it and through `window.ethereum` where it does not.
 *
 * Nothing here decides who the visitor is. A provider can say which account is selected;
 * only a signed challenge verified by the server makes that an identity.
 */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
  on?(event: string, listener: (...args: never[]) => void): void
  removeListener?(event: string, listener: (...args: never[]) => void): void
}

export interface WalletOption {
  id: string
  name: string
  provider: Eip1193Provider
}

/** The wallets available in this browser, and a way to hear when another announces itself. */
export interface WalletSource {
  list(): WalletOption[]
  subscribe(listener: () => void): () => void
}

interface AnnounceDetail {
  info?: { uuid?: unknown; name?: unknown }
  provider?: unknown
}

const isProvider = (value: unknown): value is Eip1193Provider => !!value && typeof (value as Eip1193Provider).request === 'function'

/** Wallets in `win`. EIP-6963 announcements are preferred; `window.ethereum` covers wallets that predate it. */
export function discoverWallets(win: Window): WalletSource {
  const announced: WalletOption[] = []
  const listeners = new Set<() => void>()

  win.addEventListener('eip6963:announceProvider', (event) => {
    const detail = (event as CustomEvent<AnnounceDetail>).detail
    const id = detail?.info?.uuid
    if (typeof id !== 'string' || !id || !isProvider(detail.provider)) return
    if (announced.some((w) => w.id === id || w.provider === detail.provider)) return
    const name = typeof detail.info?.name === 'string' && detail.info.name ? detail.info.name.slice(0, 40) : 'Wallet'
    announced.push({ id, name, provider: detail.provider })
    for (const listener of [...listeners]) listener()
  })
  win.dispatchEvent(new Event('eip6963:requestProvider'))

  return {
    list() {
      if (announced.length > 0) return [...announced]
      const legacy = (win as unknown as { ethereum?: unknown }).ethereum
      return isProvider(legacy) ? [{ id: 'injected', name: 'Browser wallet', provider: legacy }] : []
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** UTF-8 text as 0x-prefixed hex, the form `personal_sign` takes. */
export function utf8ToHex(text: string): string {
  let hex = '0x'
  for (const byte of new TextEncoder().encode(text)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** A provider's first account as a lowercase address, or null. */
export function firstAccount(accounts: unknown): string | null {
  const first = Array.isArray(accounts) ? accounts[0] : null
  return typeof first === 'string' && /^0x[0-9a-fA-F]{40}$/.test(first) ? first.toLowerCase() : null
}

/** A provider's chain id (hex string or number) as a number, or null. */
export function parseChainId(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null
}

/** EIP-1193 error code, when the thrown value carries one. */
export const providerErrorCode = (err: unknown): number | null => {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'number' ? code : null
}

export const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`
