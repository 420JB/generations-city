import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalHash, canonicalJson } from '../src/play/canonical'
import { createPlayClient, PlayApiError } from '../src/play/client'

const CREDENTIAL = `ppk_dev_${'a'.repeat(24)}.${'b'.repeat(64)}`
const RUN = { runId: '01a14800-0000-7000-8000-000000000001', installationId: '01a14800-0000-7000-8000-00000000000a', gameKey: 'rare-city', discordGuildId: '900000000000000001', coreServerId: 's1', player: { discordUserId: '111111111111111111', coreUserId: 'u1', displayName: 'Ada' }, configVersion: 1, configHash: 'a'.repeat(64), competitionRef: null, nonce: 'c'.repeat(32), issuedAt: '2026-10-17T00:00:00.000Z', redeemedAt: '2026-10-17T00:00:01.000Z', runExpiresAt: '2026-10-17T02:00:00.000Z' }

type Seen = { url: string; init: RequestInit }
function stub(answer: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init })
    return answer({ url, init })
  }) as unknown as typeof globalThis.fetch
  return { seen, client: createPlayClient({ baseUrl: 'http://play.test/', credential: CREDENTIAL, fetch, timeoutMs: 200 }) }
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function failure(work: Promise<unknown>): Promise<PlayApiError> {
  const err = await work.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(PlayApiError)
  return err as PlayApiError
}

describe('Play canonical JSON (golden vectors from @proofy/play-contract tests)', () => {
  it('matches Play byte for byte', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}')
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(canonicalJson(-0)).toBe('0')
    expect(canonicalJson({ é: '日本' })).toBe('{"é":"日本"}')
    expect(canonicalHash({ b: [1, 2], a: 'x' })).toBe(createHash('sha256').update('{"a":"x","b":[1,2]}').digest('hex'))
    expect(canonicalHash({ title: 'x', difficulty: 3, nested: { one: 1, two: 2 } })).toBe(canonicalHash({ nested: { two: 2, one: 1 }, difficulty: 3, title: 'x' }))
  })
  it('refuses what JSON cannot represent', () => {
    for (const v of [Number.NaN, Infinity, undefined, [undefined], 10n, () => 1, { when: new Date(0) }, new Map()]) expect(() => canonicalJson(v)).toThrow(TypeError)
  })
})

describe('the Play game-service client', () => {
  it('redeems with the service credential and reads the run', async () => {
    const { seen, client } = stub(() => json(200, { ok: true, run: RUN }))
    const run = await client.redeemRun('t.o.k')
    expect(run).toEqual({ runId: RUN.runId, installationId: RUN.installationId, gameKey: 'rare-city', discordGuildId: RUN.discordGuildId, player: { discordUserId: RUN.player.discordUserId, coreUserId: 'u1', displayName: 'Ada' }, configVersion: 1, configHash: RUN.configHash, runExpiresAt: RUN.runExpiresAt })
    expect(seen[0].url).toBe('http://play.test/v1/game/runs/redeem')
    expect(seen[0].init.method).toBe('POST')
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${CREDENTIAL}`)
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ runToken: 't.o.k' })
    expect(seen[0].init.redirect).toBe('error')
  })

  it('reads an installation and a pinned configuration version by their routes', async () => {
    const { seen, client } = stub(({ url }) =>
      url.includes('/config/')
        ? json(200, { ok: true, configVersion: { installationId: RUN.installationId, version: 3, schemaVersion: 1, configHash: 'a'.repeat(64), createdAt: '2026-10-17T00:00:00.000Z', config: { cityName: 'X' } } })
        : json(200, { ok: true, installation: { id: RUN.installationId, gameKey: 'rare-city', discordGuildId: RUN.discordGuildId, coreServerId: 's1', status: 'active', activeConfigVersion: 3, activeConfigHash: 'a'.repeat(64), createdAt: 'x', updatedAt: 'x' } }),
    )
    expect((await client.getInstallation(RUN.installationId)).status).toBe('active')
    expect((await client.getConfigVersion(RUN.installationId, 3)).config).toEqual({ cityName: 'X' })
    expect(seen.map((s) => s.url)).toEqual([`http://play.test/v1/game/installations/${RUN.installationId}`, `http://play.test/v1/game/installations/${RUN.installationId}/config/3`])
  })

  it('passes Play\'s error code through, and never the credential', async () => {
    const { client } = stub(() => json(409, { ok: false, error: { code: 'run_already_redeemed', message: 'x', retryable: false }, requestId: 'r' }))
    const err = await failure(client.redeemRun('t.o.k'))
    expect([err.status, err.code]).toEqual([409, 'run_already_redeemed'])
    expect(err.message).not.toContain(CREDENTIAL)
  })

  it('treats a body outside the contract as invalid, never as data', async () => {
    // A run without the player Play pins to it (contract §4.7) is not one a session can be opened for.
    const players = [
      { discordUserId: RUN.player.discordUserId, displayName: 'Ada' },
      { ...RUN.player, coreUserId: '' },
      { ...RUN.player, coreUserId: 'not/opaque' },
      { ...RUN.player, coreUserId: 'x'.repeat(65) },
      { ...RUN.player, discordUserId: 'ada' },
      { ...RUN.player, displayName: '' },
      { ...RUN.player, displayName: 'x'.repeat(101) },
    ].map((player) => ({ ok: true, run: { ...RUN, player } }))
    for (const body of [{ ok: true }, { ok: true, run: { ...RUN, installationId: 'nope' } }, { ok: true, run: { ...RUN, configHash: 'A'.repeat(64) } }, { ok: true, run: { ...RUN, runExpiresAt: 'soon' } }, ...players, { ok: false }, [1]]) {
      const { client } = stub(() => json(200, body))
      expect((await failure(client.redeemRun('t.o.k'))).code).toBe('invalid_response')
    }
    const { client } = stub(() => new Response('<html>bad gateway</html>', { status: 502 }))
    expect((await failure(client.redeemRun('t.o.k'))).code).toBe('invalid_response')
  })

  it('bounds the whole exchange: a stalled body, a refused connection and an oversized body are transport errors', async () => {
    const stalled = stub(
      ({ init }) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"ok":true,'))
              init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
            },
          }),
          { status: 200 },
        ),
    )
    const started = Date.now()
    expect((await failure(stalled.client.redeemRun('t.o.k'))).code).toBe('transport_error')
    expect(Date.now() - started).toBeLessThan(2_000)

    const refused = stub(() => Promise.reject(new TypeError(`fetch failed for Bearer ${CREDENTIAL}`)))
    const err = await failure(refused.client.redeemRun('t.o.k'))
    expect(err.code).toBe('transport_error')
    expect(err.message).not.toContain(CREDENTIAL)

    const huge = stub(() => new Response('x'.repeat(600 * 1024), { status: 200 }))
    expect((await failure(huge.client.redeemRun('t.o.k'))).code).toBe('transport_error')
  })

  it('refuses to be built with something that is not a Play credential', () => {
    expect(() => createPlayClient({ baseUrl: 'http://play.test', credential: 'secret' })).toThrow(TypeError)
  })
})
