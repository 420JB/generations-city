import { resolveClientMode } from '../transport/mode'
import { createIdentityStore, type IdentityStore } from './store'
import { discoverWallets } from './wallet'

export { hasAccountMismatch, type IdentitySnapshot, type IdentityStore } from './store'
export { shortAddress } from './wallet'

let store: IdentityStore | null | undefined

/**
 * The app's identity store, created on first use. null in the local demo: the demo has its
 * own simulated player, connects to no wallet and calls no server.
 */
export function getIdentityStore(): IdentityStore | null {
  if (store !== undefined) return store
  if (resolveClientMode(import.meta.env.VITE_APP_MODE) !== 'server') return (store = null)
  const created = createIdentityStore({ fetch: (input, init) => window.fetch(input, init), wallets: discoverWallets(window), host: window.location.host })
  // Another tab may have signed in or out; ask again whenever this one is looked at.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void created.refresh()
  })
  return (store = created)
}
