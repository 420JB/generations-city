import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSeedState } from '../game/seed'
import { STATE_VERSION } from '../game/stateSchema'
import type { GameState } from '../game/types'
import type { CityResponse } from '../protocol/city'
import { createServerTransport, READ_ONLY_MESSAGE } from './server'

const INSTANCE = 'inst-1'

function body(sequence: number, state: GameState = createSeedState(), patch: Partial<CityResponse['city']> = {}): CityResponse {
  return {
    city: { id: 'main', instance: INSTANCE, sequence, stateVersion: STATE_VERSION, canonical: false, origin: 'demo-fixture', updatedAt: '2026-10-02T00:00:00.000Z', ...patch },
    viewer: { userId: null, source: 'anonymous' },
    server: { mode: 'staging' },
    state,
  }
}

type Reply = { status: number; json?: unknown; text?: string; etag?: string } | 'network-error'

/** A fake server: replies are taken from a queue; every request is recorded. */
function fakeServer(replies: Reply[]) {
  const requests: { url: string; headers: Record<string, string>; init: RequestInit }[] = []
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    requests.push({ url: String(input), headers: (init.headers ?? {}) as Record<string, string>, init })
    const reply = replies.shift()
    if (!reply) throw new Error('unexpected request')
    if (reply === 'network-error') throw new TypeError('Failed to fetch')
    const payload = reply.text ?? (reply.json === undefined ? '' : JSON.stringify(reply.json))
    // 204/304 responses carry no body.
    return new Response(reply.status === 304 ? null : payload, { status: reply.status, headers: reply.etag ? { etag: reply.etag } : {} })
  }) as typeof globalThis.fetch
  return { fetch, requests, replies }
}

const ok = (sequence: number, state?: GameState, patch?: Partial<CityResponse['city']>): Reply => ({ status: 200, json: body(sequence, state, patch), etag: `"${patch?.instance ?? INSTANCE}.${sequence}"` })
const manual = (server: ReturnType<typeof fakeServer>) => createServerTransport({ fetch: server.fetch, autoStart: false })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('server transport: reading the authoritative city', () => {
  it('starts with no city and an anonymous viewer, then shows exactly what the server sent', async () => {
    const server = fakeServer([ok(4)])
    const transport = manual(server)
    expect(transport.getSnapshot()).toMatchObject({ game: null, viewer: { userId: null, source: 'anonymous' }, connection: { status: 'connecting', sequence: null } })

    await transport.refresh()

    const snap = transport.getSnapshot()
    expect(snap.game).toEqual(createSeedState())
    expect(snap.viewer).toEqual({ userId: null, source: 'anonymous' })
    expect(snap.connection).toEqual({ status: 'live', sequence: 4, canonical: false, message: null })
    expect(server.requests[0].url).toBe('/v1/city')
    expect(server.requests[0].init).toMatchObject({ cache: 'no-store', credentials: 'same-origin' })
  })

  it('takes its viewer from the server, never from the browser', async () => {
    const withSession = { ...body(1), viewer: { userId: 'u-42', source: 'session' } }
    const transport = manual(fakeServer([{ status: 200, json: withSession, etag: '"a"' }]))
    await transport.refresh()
    expect(transport.getSnapshot().viewer).toEqual({ userId: 'u-42', source: 'session' })
  })

  it('never reads or writes localStorage, even when a local demo city is saved there', async () => {
    const calls: string[] = []
    const saved = JSON.stringify({ ...createSeedState(), clock: 999 })
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (calls.push(`get ${k}`), saved),
      setItem: (k: string) => void calls.push(`set ${k}`),
      removeItem: (k: string) => void calls.push(`remove ${k}`),
    })
    const transport = manual(fakeServer([ok(1), ok(2, { ...createSeedState(), clock: 5 })]))
    await transport.refresh()
    await transport.refresh()
    transport.send({ type: 'reset' })
    transport.send({ type: 'contribute', buildingId: 'b-812', amount: 38 })
    expect(calls).toEqual([])
    expect(transport.getSnapshot().game!.clock).toBe(5)
  })

  it('revalidates with the ETag and treats 304 as "unchanged" without republishing', async () => {
    const server = fakeServer([ok(1), { status: 304 }, { status: 304 }])
    const transport = manual(server)
    await transport.refresh()
    const first = transport.getSnapshot()
    let notified = 0
    transport.subscribe(() => notified++)
    await transport.refresh()
    await transport.refresh()
    expect(server.requests[0].headers['if-none-match']).toBeUndefined()
    expect(server.requests[1].headers['if-none-match']).toBe(`"${INSTANCE}.1"`)
    expect(transport.getSnapshot()).toBe(first)
    expect(notified).toBe(0)
  })

  it('publishes a new snapshot when the sequence moves, and only then', async () => {
    const changed = { ...createSeedState(), clock: 12 }
    const transport = manual(fakeServer([ok(1), ok(1), ok(2, changed)]))
    await transport.refresh()
    const first = transport.getSnapshot()
    await transport.refresh()
    expect(transport.getSnapshot()).toBe(first)
    await transport.refresh()
    expect(transport.getSnapshot().game).toEqual(changed)
    expect(transport.getSnapshot().connection.sequence).toBe(2)
  })

  it('never moves backwards within one city, but follows a reinstalled city', async () => {
    const newer = { ...createSeedState(), clock: 9 }
    const transport = manual(fakeServer([ok(5, newer), ok(3), ok(1, createSeedState(), { instance: 'inst-2' })]))
    await transport.refresh()
    await transport.refresh()
    expect(transport.getSnapshot().game).toEqual(newer)
    expect(transport.getSnapshot().connection).toMatchObject({ status: 'stale', sequence: 5 })
    await transport.refresh()
    expect(transport.getSnapshot().game).toEqual(createSeedState())
    expect(transport.getSnapshot().connection).toMatchObject({ status: 'live', sequence: 1 })
  })
})

describe('server transport: failures never invent a city', () => {
  it('reports unavailable when the first read fails, and loads once the server is back', async () => {
    const transport = manual(fakeServer(['network-error', { status: 502, text: '<html>Bad Gateway</html>' }, ok(1)]))
    await transport.refresh()
    expect(transport.getSnapshot()).toMatchObject({ game: null, connection: { status: 'unavailable', message: 'Cannot reach Rare City. Retrying…' } })
    await transport.refresh()
    expect(transport.getSnapshot()).toMatchObject({ game: null, connection: { status: 'unavailable' } })
    await transport.refresh()
    expect(transport.getSnapshot().connection.status).toBe('live')
    expect(transport.getSnapshot().game).toEqual(createSeedState())
  })

  it('keeps the last good city, marked stale, through every kind of failure, then recovers', async () => {
    const failures: Reply[] = [
      'network-error',
      { status: 500, json: { error: 'internal_error' } },
      { status: 503, json: { error: 'city_unavailable' } },
      { status: 503, json: { error: 'city_not_initialized' } },
      { status: 200, text: '{not json' },
      { status: 200, json: { city: 'nope' } },
      { status: 200, json: { ...body(2), state: { version: STATE_VERSION } } },
      { status: 200, json: { ...body(2), viewer: { userId: 'demo-player', source: 'demo' } } },
      { status: 200, json: body(2, createSeedState(), { stateVersion: STATE_VERSION + 1 }) },
      { status: 404, json: { error: 'not_found' } },
    ]
    const transport = manual(fakeServer([ok(1), ...failures, ok(2, { ...createSeedState(), clock: 3 })]))
    await transport.refresh()
    const good = transport.getSnapshot().game
    for (const failure of failures) {
      await transport.refresh()
      const snap = transport.getSnapshot()
      expect(snap.game, JSON.stringify(failure)).toBe(good)
      expect(snap.viewer).toEqual({ userId: null, source: 'anonymous' })
      expect(snap.connection.status).toBe('stale')
      expect(snap.connection.sequence).toBe(1)
      expect(snap.connection.message).toBeTruthy()
    }
    await transport.refresh()
    expect(transport.getSnapshot().connection).toEqual({ status: 'live', sequence: 2, canonical: false, message: null })
    expect(transport.getSnapshot().game!.clock).toBe(3)
  })

  it('says why: not founded yet, out of date, or unreadable', async () => {
    const message = async (reply: Reply) => {
      const transport = manual(fakeServer([reply]))
      await transport.refresh()
      return transport.getSnapshot().connection.message
    }
    expect(await message({ status: 503, json: { error: 'city_not_initialized' } })).toBe('This city has not been founded yet.')
    expect(await message({ status: 200, json: body(1, createSeedState(), { stateVersion: STATE_VERSION + 1 }) })).toBe('This page is out of date. Reload to update.')
    expect(await message({ status: 200, json: { hello: 'world' } })).toMatch(/could not read/)
  })

  it('gives up on a read that never answers', async () => {
    const hang = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as typeof globalThis.fetch
    const transport = createServerTransport({ fetch: hang, autoStart: false, timeoutMs: 20 })
    await transport.refresh()
    expect(transport.getSnapshot().connection.status).toBe('unavailable')
  })
})

describe('server transport: commands cannot change the city', () => {
  it('refuses every command without touching the state, the sequence or the network', async () => {
    const server = fakeServer([ok(7)])
    const transport = manual(server)
    await transport.refresh()
    const before = transport.getSnapshot()
    const frozen = JSON.stringify(before.game)
    const commands = [
      { type: 'contribute', buildingId: 'b-812', amount: 38 },
      { type: 'faucet' },
      { type: 'rival' },
      { type: 'grow', districtId: 'd4' },
      { type: 'join-at', districtId: 'd5', ward: 0, plot: 19 },
      { type: 'reset' },
    ] as const
    commands.forEach((command, i) => {
      transport.send(command)
      const snap = transport.getSnapshot()
      expect(snap.game).toBe(before.game)
      expect(snap.last).toBeNull()
      expect(snap.error).toEqual({ seq: i + 1, message: READ_ONLY_MESSAGE })
      expect(snap.connection).toBe(before.connection)
    })
    expect(JSON.stringify(transport.getSnapshot().game)).toBe(frozen)
    expect(server.requests).toHaveLength(1)
  })

  it('refuses commands before any city has loaded, too', () => {
    const transport = manual(fakeServer([]))
    transport.send({ type: 'contribute', buildingId: 'b-812', amount: 38 })
    expect(transport.getSnapshot()).toMatchObject({ game: null, error: { message: READ_ONLY_MESSAGE } })
  })
})

describe('server transport: polling', () => {
  function clock() {
    const timers: { fn: () => void; ms: number }[] = []
    return { timers, schedule: (fn: () => void, ms: number) => timers.push({ fn, ms }), cancel: vi.fn() }
  }
  const settle = () => new Promise((done) => setTimeout(done, 0))

  it('polls at a steady interval while healthy and backs off, bounded, while failing', async () => {
    const c = clock()
    const server = fakeServer([ok(1), { status: 304 }, 'network-error', 'network-error', 'network-error', ok(2)])
    const transport = createServerTransport({ fetch: server.fetch, pollMs: 5_000, maxBackoffMs: 6_000, schedule: c.schedule, cancel: c.cancel })
    const delays: number[] = []
    for (let i = 0; i < 6; i++) {
      await settle()
      const next = c.timers.shift()!
      delays.push(next.ms)
      if (i < 5) next.fn()
    }
    expect(delays).toEqual([5_000, 5_000, 2_000, 4_000, 6_000, 5_000])
    expect(transport.getSnapshot().connection).toMatchObject({ status: 'live', sequence: 2 })
    transport.stop()
  })

  it('never overlaps reads, and stops when told', async () => {
    const c = clock()
    const server = fakeServer([ok(1)])
    const transport = createServerTransport({ fetch: server.fetch, schedule: c.schedule, cancel: c.cancel })
    await Promise.all([transport.refresh(), transport.refresh(), transport.refresh()])
    expect(server.requests).toHaveLength(1)
    await settle()
    transport.stop()
    expect(c.cancel).toHaveBeenCalledTimes(1)
  })

  it('notifies subscribers and honours unsubscribe', async () => {
    const transport = manual(fakeServer([ok(1), ok(2)]))
    let notified = 0
    const unsubscribe = transport.subscribe(() => notified++)
    await transport.refresh()
    expect(notified).toBe(1)
    unsubscribe()
    await transport.refresh()
    expect(notified).toBe(1)
  })
})
