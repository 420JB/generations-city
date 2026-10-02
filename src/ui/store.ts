import { useCallback, useSyncExternalStore } from 'react'
import { getTransport, type CitySnapshot, type ClientCommand } from '../transport'

export type GameAction = ClientCommand
export type StoreState = CitySnapshot

/** The city as the UI sees it. Every read and every mutation goes through the transport. */
export function useGameStore() {
  const transport = getTransport()
  const store = useSyncExternalStore(transport.subscribe, transport.getSnapshot)
  const act = useCallback((a: GameAction) => transport.send(a), [transport])
  return { store, act }
}
