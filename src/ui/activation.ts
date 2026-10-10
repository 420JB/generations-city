import { useSyncExternalStore } from 'react'
import { getActivationFlow, type ActivationFlow, type ActivationSnapshot } from '../activation'

const subscribeToNothing = () => () => {}
const noSnapshot = () => null

export interface Activation {
  snapshot: ActivationSnapshot
  flow: ActivationFlow
}

/** Friend activation state for the UI. null in the local demo, which has no real Friends to activate. */
export function useActivation(): Activation | null {
  const flow = getActivationFlow()
  const snapshot = useSyncExternalStore<ActivationSnapshot | null>(flow ? flow.subscribe : subscribeToNothing, flow ? flow.getSnapshot : noSnapshot)
  return flow && snapshot ? { snapshot, flow } : null
}
