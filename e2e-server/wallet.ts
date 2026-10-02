import type { BrowserContext, Page } from '@playwright/test'
import { hexToString, type Hex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'

/**
 * A MOCK injected wallet for the browser tests.
 *
 * The page sees an ordinary EIP-6963 / EIP-1193 provider. Signing happens in the test
 * process with the public development accounts (the well-known `test … junk` mnemonic),
 * which is also what the server's fixture ownership provider knows about. No real wallet,
 * key or chain is involved.
 */
const DEV_MNEMONIC = 'test test test test test test test test test test test junk'
export const ACCOUNTS = [0, 1, 2].map((addressIndex) => mnemonicToAccount(DEV_MNEMONIC, { addressIndex }))
export const ROBINHOOD_CHAIN_ID = 4663

export interface WalletControls {
  /** Everything the page asked the wallet to sign, as text. */
  signed: string[]
  /** The user picks another account in the wallet. */
  selectAccount(page: Page, index: number): Promise<void>
  selectChain(page: Page, chainId: number): Promise<void>
  /** Make the wallet decline the next request for `method`. */
  declineNext(page: Page, method: string): Promise<void>
  calls(page: Page): Promise<string[]>
}

export async function installWallet(context: BrowserContext, options: { chainId?: number; account?: number } = {}): Promise<WalletControls> {
  const signed: string[] = []
  await context.exposeFunction('__rcSign', async (index: number, hex: Hex, address: string) => {
    const account = ACCOUNTS[index]
    if (address.toLowerCase() !== account.address.toLowerCase()) throw new Error('asked to sign with an account that is not selected')
    signed.push(hexToString(hex))
    return account.signMessage({ message: { raw: hex } })
  })
  await context.addInitScript(
    ({ accounts, chainId, selected }) => {
      const state = { accounts, selected, chainId, connected: false, decline: new Set<string>() }
      const calls: string[] = []
      const listeners = new Map<string, Set<(payload: unknown) => void>>()
      const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((fn) => fn(payload))
      const provider = {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          calls.push(method)
          if (state.decline.delete(method)) throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
          switch (method) {
            case 'eth_accounts':
              return state.connected ? [state.accounts[state.selected]] : []
            case 'eth_requestAccounts':
              state.connected = true
              return [state.accounts[state.selected]]
            case 'eth_chainId':
              return `0x${state.chainId.toString(16)}`
            case 'wallet_switchEthereumChain':
              state.chainId = Number((params as [{ chainId: string }])[0].chainId)
              emit('chainChanged', `0x${state.chainId.toString(16)}`)
              return null
            case 'personal_sign':
              return (window as unknown as { __rcSign: (i: number, hex: unknown, address: unknown) => Promise<string> }).__rcSign(state.selected, params![0], params![1])
          }
          throw Object.assign(new Error(`unsupported method ${method}`), { code: 4200 })
        },
        on(event: string, fn: (payload: unknown) => void) {
          if (!listeners.has(event)) listeners.set(event, new Set())
          listeners.get(event)!.add(fn)
        },
        removeListener(event: string, fn: (payload: unknown) => void) {
          listeners.get(event)?.delete(fn)
        },
      }
      Object.assign(window, {
        __wallet: {
          calls,
          selectAccount(index: number) {
            state.selected = index
            if (state.connected) emit('accountsChanged', [state.accounts[index]])
          },
          selectChain(id: number) {
            state.chainId = id
            emit('chainChanged', `0x${id.toString(16)}`)
          },
          declineNext: (method: string) => state.decline.add(method),
        },
      })
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'rc-test-wallet', name: 'Test Wallet', icon: 'data:,', rdns: 'world.rarecity.test' }, provider }) }))
      window.addEventListener('eip6963:requestProvider', announce)
      announce()
    },
    { accounts: ACCOUNTS.map((a) => a.address.toLowerCase()), chainId: options.chainId ?? ROBINHOOD_CHAIN_ID, selected: options.account ?? 0 },
  )
  type Injected = { __wallet: { calls: string[]; selectAccount(i: number): void; selectChain(id: number): void; declineNext(method: string): void } }
  return {
    signed,
    selectAccount: (page, index) => page.evaluate((i) => (window as unknown as Injected).__wallet.selectAccount(i), index),
    selectChain: (page, chainId) => page.evaluate((id) => (window as unknown as Injected).__wallet.selectChain(id), chainId),
    declineNext: (page, method) => page.evaluate((m) => (window as unknown as Injected).__wallet.declineNext(m), method),
    calls: (page) => page.evaluate(() => [...(window as unknown as Injected).__wallet.calls]),
  }
}

export const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`
