import { describe, expect, it } from 'vitest'
import { silentLogger } from '../src/log'
import { PlayApiError, type PlayGameReader, type PlayInstallation } from '../src/play/client'
import { classifyPlayError, createInstallationChecker } from '../src/play/installationCheck'
import type { WorldScope } from '../src/world/store'
import { GUILD_A, GUILD_B, INSTALLATION_A, INSTALLATION_B } from './fakePlay'

const SCOPE_A: WorldScope = { worldId: '01a14800-0000-7000-8000-0000000000a1', environment: 'dev', gameKey: 'rare-city', installationId: INSTALLATION_A, discordGuildId: GUILD_A }
const SCOPE_B: WorldScope = { worldId: '01a14800-0000-7000-8000-0000000000b1', environment: 'dev', gameKey: 'rare-city', installationId: INSTALLATION_B, discordGuildId: GUILD_B }

const installation = (scope: WorldScope, patch: Partial<PlayInstallation> = {}): PlayInstallation => ({ id: scope.installationId, gameKey: 'rare-city', discordGuildId: scope.discordGuildId, status: 'active', activeConfigVersion: 1, activeConfigHash: 'a'.repeat(64), ...patch })

/**
 * A Play whose installation answers the test decides, one request at a time. Each request waits until the test
 * settles it, and records whether it was aborted.
 */
function controlledPlay() {
  const requests: { id: string; signal?: AbortSignal; settle: (outcome: PlayInstallation | Error) => void; aborted: () => boolean }[] = []
  const play: PlayGameReader = {
    redeemRun: () => Promise.reject(new Error('not used')),
    getConfigVersion: () => Promise.reject(new Error('not used')),
    getInstallation(id, options) {
      return new Promise((resolve, reject) => {
        const signal = options?.signal
        // Like the real client: an aborted request fails at once.
        signal?.addEventListener('abort', () => reject(new PlayApiError(503, 'transport_error', 'aborted')))
        requests.push({ id, signal, settle: (o) => (o instanceof Error ? reject(o) : resolve(o)), aborted: () => signal?.aborted ?? false })
      })
    },
  }
  return { play, requests, pending: () => requests.filter((r) => !r.aborted()) }
}

function setup(o: { checkMs?: number; cacheMs?: number; graceMs?: number } = {}) {
  let t = 1_000
  const p = controlledPlay()
  const checker = createInstallationChecker({ play: p.play, environment: 'dev', gameKey: 'rare-city', log: silentLogger, checkMs: o.checkMs ?? 3_000, cacheMs: o.cacheMs ?? 15_000, graceMs: o.graceMs ?? 60_000, clock: () => t })
  /** Ask, then settle the newest request with `outcome`. */
  const answer = async (scope: WorldScope, outcome: PlayInstallation | Error, options?: { fresh?: boolean }) => {
    const before = p.requests.length
    const verdict = checker.check(scope, options)
    await Promise.resolve()
    if (p.requests.length > before) p.requests[p.requests.length - 1].settle(outcome)
    return verdict
  }
  return { p, checker, answer, advance: (ms: number) => (t += ms), now: () => t }
}

describe('reading Play\'s answer about an installation', () => {
  it('tells a definite refusal, a removed or suspended installation, an outage and a malformed answer apart', () => {
    expect(classifyPlayError(new PlayApiError(401, 'unauthorized', ''))).toBe('refused')
    expect(classifyPlayError(new PlayApiError(403, 'play_not_entitled', ''))).toBe('refused')
    expect(classifyPlayError(new PlayApiError(403, 'some_new_refusal', ''))).toBe('refused')
    expect(classifyPlayError(new PlayApiError(403, 'installation_not_active', ''))).toBe('inactive')
    expect(classifyPlayError(new PlayApiError(404, 'installation_not_found', ''))).toBe('inactive')
    expect(classifyPlayError(new PlayApiError(503, 'transport_error', ''))).toBe('unreachable')
    expect(classifyPlayError(new PlayApiError(500, 'internal_error', ''))).toBe('unreachable')
    expect(classifyPlayError(new PlayApiError(503, 'dependency_unavailable', ''))).toBe('unreachable')
    // Outside the contract: not a no, and never a yes.
    expect(classifyPlayError(new PlayApiError(502, 'invalid_response', ''))).toBe('unexpected')
    expect(classifyPlayError(new PlayApiError(404, 'not_found', ''))).toBe('unexpected')
    expect(classifyPlayError(new PlayApiError(409, 'idempotency_conflict', ''))).toBe('unexpected')
    expect(classifyPlayError(new Error('a bug'))).toBe('unexpected')
  })

  it('answers active only for the scope\'s own installation, game and server, active', async () => {
    const { answer } = setup({ cacheMs: 0 })
    expect((await answer(SCOPE_A, installation(SCOPE_A))).kind).toBe('active')
    for (const patch of [{ status: 'suspended' as const }, { status: 'uninstalled' as const }, { discordGuildId: GUILD_B }, { gameKey: 'other-game' }, { id: INSTALLATION_B }]) {
      expect((await answer(SCOPE_A, installation(SCOPE_A, patch))).kind, JSON.stringify(patch)).toBe('inactive')
    }
  })

  it('never turns a definite refusal into unknown, and a refusal of Rare City voids every installation\'s readings', async () => {
    const { checker, answer, p } = setup()
    await answer(SCOPE_A, installation(SCOPE_A))
    await answer(SCOPE_B, installation(SCOPE_B))
    // Both cached: no request.
    expect((await checker.check(SCOPE_B)).kind).toBe('active')
    expect(p.requests).toHaveLength(2)
    expect(await answer(SCOPE_A, new PlayApiError(401, 'unauthorized', ''), { fresh: true })).toEqual({ kind: 'refused', code: 'unauthorized' })
    // B's cached "active" is gone with it: B is asked again, and an outage now has no grace to fall back on.
    const b = await answer(SCOPE_B, new PlayApiError(503, 'transport_error', ''))
    expect(p.requests).toHaveLength(4)
    expect(b).toMatchObject({ kind: 'unknown', reason: 'unreachable', lastVerifiedAt: null, graceRemainingMs: 0 })
  })

  it('serves unknown within the grace period after the last active, and not past it', async () => {
    const { answer, advance } = setup({ cacheMs: 0, graceMs: 60_000 })
    await answer(SCOPE_A, installation(SCOPE_A))
    advance(59_000)
    expect(await answer(SCOPE_A, new PlayApiError(503, 'transport_error', ''))).toMatchObject({ kind: 'unknown', reason: 'unreachable', graceRemainingMs: 1_000 })
    advance(1_000)
    expect(await answer(SCOPE_A, new PlayApiError(502, 'invalid_response', ''))).toMatchObject({ kind: 'unknown', reason: 'unexpected', graceRemainingMs: 0 })
    // Play answers again: grace starts over from that answer.
    expect((await answer(SCOPE_A, installation(SCOPE_A))).kind).toBe('active')
    expect(await answer(SCOPE_A, new PlayApiError(503, 'transport_error', ''))).toMatchObject({ graceRemainingMs: 60_000 })
  })

  it('starts grace from a launch\'s own check, unless a definite no came after it', async () => {
    const { checker, answer, advance, now } = setup({ cacheMs: 15_000 })
    const askedAt = now()
    advance(2_000)
    checker.verified(SCOPE_A, askedAt)
    // Timed from when the launch ASKED: 2s of the cache and of the grace period are already used.
    advance(13_500)
    expect(await answer(SCOPE_A, new PlayApiError(503, 'transport_error', ''))).toMatchObject({ kind: 'unknown', graceRemainingMs: 60_000 - 15_500 })
    // A no, then a launch that had asked before it: the launch's reading does not stand.
    expect((await answer(SCOPE_A, installation(SCOPE_A, { status: 'suspended' }))).kind).toBe('inactive')
    checker.verified(SCOPE_A, askedAt + 1)
    expect(await answer(SCOPE_A, new PlayApiError(503, 'transport_error', ''))).toMatchObject({ graceRemainingMs: 0 })
  })

  it('does not let an "active" asked before a refusal hide it', async () => {
    const { checker, p } = setup({ cacheMs: 0 })
    const slowB = checker.check(SCOPE_B)
    await Promise.resolve()
    const refusal = checker.check(SCOPE_A)
    await Promise.resolve()
    p.requests[1].settle(new PlayApiError(401, 'unauthorized', ''))
    expect((await refusal).kind).toBe('refused')
    // B's request was asked before Rare City was refused; its "active" arrives after.
    p.requests[0].settle(installation(SCOPE_B))
    expect(await slowB).toMatchObject({ kind: 'unknown', reason: 'unexpected', graceRemainingMs: 0 })
  })

  it('asks Play once for many simultaneous reads of one installation, separately per installation and scope', async () => {
    const { checker, p } = setup({ cacheMs: 0 })
    const reads = [...Array.from({ length: 25 }, () => checker.check(SCOPE_A)), ...Array.from({ length: 5 }, () => checker.check(SCOPE_B)), checker.check({ ...SCOPE_A, discordGuildId: GUILD_B })]
    await Promise.resolve()
    expect(p.requests.map((r) => r.id)).toEqual([INSTALLATION_A, INSTALLATION_B, INSTALLATION_A])
    p.requests[0].settle(installation(SCOPE_A))
    p.requests[1].settle(installation(SCOPE_B))
    // Scope A on another server: Play's answer is A's, on A's server, so for that scope it is not this installation.
    p.requests[2].settle(installation(SCOPE_A))
    const verdicts = await Promise.all(reads)
    expect(verdicts.slice(0, 30).every((v) => v.kind === 'active')).toBe(true)
    expect(verdicts[30].kind).toBe('inactive')
    // Once answered, the next question is a new request.
    void checker.check(SCOPE_A)
    await Promise.resolve()
    expect(p.requests).toHaveLength(4)
  })

  it('cancels a request at the deadline: the request is aborted, every waiter gets timeout, nothing is left running', async () => {
    const { checker, p } = setup({ checkMs: 50, cacheMs: 0 })
    const started = performance.now()
    const verdicts = await Promise.all(Array.from({ length: 20 }, () => checker.check(SCOPE_A)))
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(p.requests).toHaveLength(1)
    expect(p.requests[0].aborted()).toBe(true)
    expect(p.pending()).toHaveLength(0)
    expect(verdicts.every((v) => v.kind === 'unknown' && v.reason === 'timeout')).toBe(true)
    // A late answer to the aborted request is no answer: nothing was cached from it, and the next read asks again.
    p.requests[0].settle(installation(SCOPE_A))
    void checker.check(SCOPE_A)
    await Promise.resolve()
    expect(p.requests).toHaveLength(2)
  })

  it('a fresh question never uses the cache', async () => {
    const { checker, answer, p } = setup({ cacheMs: 15_000 })
    await answer(SCOPE_A, installation(SCOPE_A))
    expect(await checker.check(SCOPE_A)).toMatchObject({ kind: 'active', cached: true })
    expect(p.requests).toHaveLength(1)
    expect(await answer(SCOPE_A, installation(SCOPE_A, { status: 'suspended' }), { fresh: true })).toEqual({ kind: 'inactive' })
    expect(p.requests).toHaveLength(2)
    // And the "no" ends the cached "yes".
    expect(await answer(SCOPE_A, new PlayApiError(503, 'transport_error', ''))).toMatchObject({ graceRemainingMs: 0 })
  })
})
