import { ANONYMOUS_VIEWER, CITY_ENDPOINT, parseCityResponse } from '../protocol/city'
import type { CitySnapshot, CityTransport, Connection } from './types'

export interface ServerTransportOptions {
  fetch: typeof globalThis.fetch
  /** Origin of the Rare City service. Empty = same origin as the page. */
  baseUrl?: string
  /** Delay between reads while healthy. */
  pollMs?: number
  /** Ceiling for the delay between reads while failing. */
  maxBackoffMs?: number
  /** A read that takes longer than this counts as a failure. */
  timeoutMs?: number
  /** Start reading immediately and keep polling. Tests turn this off and call `refresh` themselves. */
  autoStart?: boolean
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
}

export interface ServerTransport extends CityTransport {
  /** Read the city now. Resolves when the snapshot reflects the outcome. */
  refresh(): Promise<void>
  stop(): void
}

export const READ_ONLY_MESSAGE = 'This city is read-only. Building is not available here yet.'

const MESSAGES = {
  unreachable: 'Cannot reach Rare City. Retrying…',
  notInitialized: 'This city has not been founded yet.',
  outdated: 'This page is out of date. Reload to update.',
  malformed: 'Rare City sent something this page could not read. Retrying…',
  unavailable: 'Rare City is unavailable right now. Retrying…',
} as const

/**
 * SERVER authority: the city lives in the Rare City service and this browser only reads it.
 *
 * It polls `GET /v1/city`, never runs the engine, and never touches localStorage. A failed
 * read keeps the last city the server sent (marked stale) rather than inventing one.
 * Commands are refused: this slice has no authoritative mutations.
 *
 * The city's viewer here is always anonymous. Signing in with a wallet (`src/identity`)
 * establishes who the visitor is; it does not make them an actor in the city, because
 * nothing in the shared city can be acted on yet.
 */
export function createServerTransport(options: ServerTransportOptions): ServerTransport {
  const { fetch: doFetch, baseUrl = '', pollMs = 5_000, maxBackoffMs = 30_000, timeoutMs = 10_000, autoStart = true } = options
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  const listeners = new Set<() => void>()
  let snapshot: CitySnapshot = {
    game: null,
    viewer: ANONYMOUS_VIEWER,
    connection: { status: 'connecting', sequence: null, canonical: null, message: null },
    last: null,
    error: null,
    seq: 0,
    restored: false,
    saveFailed: false,
  }
  /** Identity of the city on screen, so a read can never move it backwards. */
  let current: { instance: string; sequence: number; etag: string | null } | null = null
  let failures = 0
  let inFlight: Promise<void> | null = null
  let timer: unknown = null
  let stopped = false

  const publish = (next: CitySnapshot) => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  const setConnection = (patch: Partial<Connection>) => {
    const connection = { ...snapshot.connection, ...patch }
    const same = (Object.keys(connection) as (keyof Connection)[]).every((k) => connection[k] === snapshot.connection[k])
    if (!same) publish({ ...snapshot, connection })
  }

  const failed = (message: string) => {
    failures += 1
    // Keep whatever the server last sent; only say that it may be out of date.
    setConnection({ status: snapshot.game ? 'stale' : 'unavailable', message })
  }

  async function read(): Promise<void> {
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort(), timeoutMs)
    let res: Response
    try {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (current?.etag) headers['if-none-match'] = current.etag
      res = await doFetch(`${baseUrl}${CITY_ENDPOINT}`, { headers, cache: 'no-store', credentials: 'same-origin', signal: abort.signal })
    } catch {
      return failed(MESSAGES.unreachable)
    } finally {
      clearTimeout(deadline)
    }

    if (res.status === 304 && current) {
      failures = 0
      return setConnection({ status: 'live', message: null })
    }
    if (res.status !== 200) {
      let code: unknown
      try {
        code = ((await res.json()) as { error?: unknown }).error
      } catch {
        // Not JSON (a proxy error page, for example): treated like any other failure.
      }
      return failed(code === 'city_not_initialized' ? MESSAGES.notInitialized : MESSAGES.unavailable)
    }

    let body: unknown
    try {
      body = await res.json()
    } catch {
      return failed(MESSAGES.malformed)
    }
    const parsed = parseCityResponse(body)
    if (!parsed.ok) return failed(parsed.reason === 'unsupported-version' ? MESSAGES.outdated : MESSAGES.malformed)

    const { city, state } = parsed.response
    // Within one installation of the city, the sequence only moves forward.
    if (current && current.instance === city.instance && city.sequence < current.sequence) return failed(MESSAGES.unavailable)

    failures = 0
    const unchanged = current !== null && current.instance === city.instance && current.sequence === city.sequence
    current = { instance: city.instance, sequence: city.sequence, etag: res.headers.get('etag') }
    if (unchanged) return setConnection({ status: 'live', canonical: city.canonical, message: null })
    // The viewer stays as it is: the city says nothing about who is looking, and a shared city has no actors yet.
    publish({ ...snapshot, game: state, connection: { status: 'live', sequence: city.sequence, canonical: city.canonical, message: null } })
  }

  const refresh = () => {
    inFlight ??= read().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  const loop = () => {
    void refresh().then(() => {
      if (stopped) return
      const delay = failures === 0 ? pollMs : Math.min(maxBackoffMs, 1_000 * 2 ** Math.min(failures, 10))
      timer = schedule(loop, delay)
    })
  }
  if (autoStart) loop()

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    send() {
      // No engine, no local mutation: the command is refused and the city is untouched.
      const seq = snapshot.seq + 1
      publish({ ...snapshot, seq, error: { seq, message: READ_ONLY_MESSAGE } })
    },
    refresh,
    stop() {
      stopped = true
      if (timer !== null) cancel(timer)
    },
  }
}
