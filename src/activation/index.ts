import { getIdentityStore } from '../identity'
import { getTransport } from '../transport'
import { createActivationFlow, type ActivationFlow } from './flow'
import { createInjectedSigner } from './signer'

export { plotDisplay, plotLabel, type PlotDisplay } from './display'
export { cityAcceptsActivation } from './eligibility'
export type { ActivationFlow, ActivationNotice, ActivationPhase, ActivationResult, ActivationSnapshot, ActivationStep } from './flow'

let flow: ActivationFlow | null | undefined

/**
 * The app's activation flow, created on first use. null in the local demo: the demo has no
 * wallet, no session and no server, and adds its simulated Friends its own way.
 */
export function getActivationFlow(): ActivationFlow | null {
  if (flow !== undefined) return flow
  const identity = getIdentityStore()
  if (!identity) return (flow = null)
  const transport = getTransport()
  return (flow = createActivationFlow({
    fetch: (input, init) => window.fetch(input, init),
    signer: createInjectedSigner(() => identity.provider()),
    identity,
    city: { game: () => transport.getSnapshot().game, subscribe: transport.subscribe, refresh: transport.refresh },
    origin: window.location.origin,
  }))
}
