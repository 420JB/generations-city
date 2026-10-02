import { useCallback, useSyncExternalStore } from 'react'
import { getTransport, type CitySnapshot, type ClientCommand } from '../transport'

export type GameAction = ClientCommand
export type StoreState = CitySnapshot

/** The city as the UI sees it. Every read and every mutation goes through the transport. */
export function useGameStore() {
  const transport = getTransport()
  const store = useSyncExternalStore(transport.subscribe, transport.getSnapshot)
  /**
   * Send a command and return the snapshot as it stands right after. A transport that
   * settles synchronously already reflects the outcome there; one that settles later does not.
   */
  const act = useCallback(
    (a: GameAction): StoreState => {
      transport.send(a)
      return transport.getSnapshot()
    },
    [transport],
  )
  return { store, act }
}
