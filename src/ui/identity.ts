import { useSyncExternalStore } from 'react'
import { getIdentityStore, type IdentitySnapshot, type IdentityStore } from '../identity'

const subscribeToNothing = () => () => {}
const noSnapshot = () => null

export interface Identity {
  snapshot: IdentitySnapshot
  store: IdentityStore
}

/** Wallet and session state for the UI. null in the local demo, which has neither. */
export function useIdentity(): Identity | null {
  const store = getIdentityStore()
  const snapshot = useSyncExternalStore<IdentitySnapshot | null>(store ? store.subscribe : subscribeToNothing, store ? store.getSnapshot : noSnapshot)
  return store && snapshot ? { snapshot, store } : null
}
