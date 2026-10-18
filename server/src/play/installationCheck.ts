import type { PlayEnvironment } from '../engine'
import type { Logger } from '../log'
import type { WorldScope } from '../world/store'
import { PlayApiError, type PlayGameReader, type PlayInstallation } from './client'

/**
 * WHETHER PLAY STILL HAS A PLAY SESSION'S INSTALLATION ACTIVE, as a play session read asks it
 * (`session.ts`). Play is the authority; this module only asks, classifies the answer, and keeps
 * the two readings a later question may lean on.
 *
 * Every outcome is one of:
 *   - `active`    Play answered that the installation is Rare City's, on the session's Discord
 *                 server, and active.
 *   - `inactive`  Play answered that it is not: suspended or uninstalled, no longer shown to Rare
 *                 City (`installation_not_found`), refused as `installation_not_active`, or shown
 *                 as another game's or on another server. The session is over.
 *   - `refused`   Play refused Rare City itself: `401` (its credential revoked or expired, or the
 *                 game retired) or any other `403`. Nothing Rare City holds is authorized by Play
 *                 any more, so every reading of every installation is dropped with it.
 *   - `unknown`   No authoritative answer: Play could not be reached (`unreachable`), did not
 *                 answer within the deadline (`timeout`), or answered outside its contract
 *                 (`unexpected`: a malformed body, an unknown code, a 2xx that does not parse).
 *
 * Only `active` is ever a yes. A definite no (`inactive`, `refused`) is never softened into
 * `unknown`, and it voids every earlier `active` it covers: a reading taken before it is not used
 * again, by the cache or by the grace period, even if a request that started earlier answers
 * "active" after it.
 *
 * Readings, all in this process and on one monotonic clock:
 *   - the CACHE: an `active` younger than `cacheMs` answers a read without asking Play again;
 *   - the GRACE PERIOD: an `unknown` is served read-only while the last `active` is younger than
 *     `graceMs` (`session.ts` decides what that permits). A launch's own check of the
 *     installation (`launch.ts`) counts as an `active`, timed when it was asked.
 * A process that has seen no `active` for an installation has no grace for it.
 *
 * Questions are shared: while one is in flight for a scope, callers wait for it instead of asking
 * again. Each is cancelled at `checkMs` (the request is aborted, not left running).
 */

export type InstallationVerdict =
  | { kind: 'active'; verifiedAt: Date; cached: boolean }
  | { kind: 'inactive' }
  | { kind: 'refused'; code: string }
  | { kind: 'unknown'; reason: 'unreachable' | 'timeout' | 'unexpected'; lastVerifiedAt: Date | null; graceRemainingMs: number }

export interface InstallationChecker {
  /**
   * Play's answer for `scope`'s installation. `fresh` never uses the cache (a question still in flight
   * may be shared: it was asked after the caller arrived or less than `checkMs` before). Never throws.
   */
  check(scope: WorldScope, options?: { fresh?: boolean }): Promise<InstallationVerdict>
  /** Record an `active` Play gave elsewhere (a launch), asked at `askedAt` on this checker's clock. */
  verified(scope: WorldScope, askedAt: number): void
}

export interface InstallationCheckerOptions {
  play: PlayGameReader
  environment: PlayEnvironment
  gameKey: string
  log: Logger
  checkMs: number
  cacheMs: number
  graceMs: number
  /** Monotonic milliseconds. Tests may replace it; it must be the launch service's clock too. */
  clock?: () => number
  /** Wall time, for what a viewer is told. */
  now?: () => Date
}

const MAX_TRACKED = 10_000

type Raw = { kind: 'answer'; installation: PlayInstallation } | { kind: 'error'; error: unknown } | { kind: 'timeout' }

/** A reading: when it was asked, on the monotonic clock and on the wall. */
interface Reading {
  at: number
  wall: Date
}

/** How a Play error is read. A definite refusal is never `unknown`. */
export function classifyPlayError(err: unknown): 'inactive' | 'refused' | 'unreachable' | 'unexpected' {
  if (!(err instanceof PlayApiError)) return 'unexpected'
  // Outside the contract, whatever status it came with (the client also gives a non-envelope 5xx this code).
  if (err.code === 'invalid_response') return 'unexpected'
  if (err.code === 'installation_not_found' || err.code === 'installation_not_active') return 'inactive'
  if (err.status === 401 || err.status === 403) return 'refused'
  if (err.code === 'transport_error' || err.status >= 500) return 'unreachable'
  return 'unexpected'
}

export function createInstallationChecker(options: InstallationCheckerOptions): InstallationChecker {
  const { play, environment, gameKey, log, checkMs, cacheMs, graceMs } = options
  const clock = options.clock ?? (() => performance.now())
  const now = options.now ?? (() => new Date())

  /** scope key -> the latest `active`. */
  const active = new Map<string, Reading>()
  /** scope key -> the latest definite no for that installation. */
  const deniedAt = new Map<string, number>()
  /** The latest refusal of Rare City itself: it voids every reading taken before it. */
  let refusedAt = Number.NEGATIVE_INFINITY
  const inFlight = new Map<string, Promise<{ raw: Raw; askedAt: number; wall: Date }>>()

  // The environment and game are this deployment's, so they are part of every key: a reading is
  // never shared across them, nor across a scope that differs in any part.
  const keyOf = (s: WorldScope) => `${environment}|${gameKey}|${s.environment}|${s.gameKey}|${s.installationId}|${s.discordGuildId}`
  /** A reading still stands only if no definite no came at or after it. */
  const stands = (key: string, r: Reading | undefined): r is Reading => r !== undefined && r.at > Math.max(deniedAt.get(key) ?? Number.NEGATIVE_INFINITY, refusedAt)

  function remember(key: string, r: Reading) {
    const prior = active.get(key)
    if (prior && prior.at >= r.at) return
    if (active.size >= MAX_TRACKED) active.clear()
    active.set(key, r)
  }

  function deny(key: string, at: number) {
    if (deniedAt.size >= MAX_TRACKED) {
      // Forgetting denials could revive an older reading; forget the readings with them.
      deniedAt.clear()
      active.clear()
    }
    deniedAt.set(key, at)
    active.delete(key)
  }

  function ask(key: string, scope: WorldScope) {
    const pending = inFlight.get(key)
    if (pending) return pending
    const askedAt = clock()
    const wall = now()
    const cancel = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<Raw>((resolve) => {
      timer = setTimeout(() => {
        cancel.abort()
        resolve({ kind: 'timeout' })
      }, checkMs)
    })
    const answer = play.getInstallation(scope.installationId, { signal: cancel.signal }).then(
      (installation): Raw => ({ kind: 'answer', installation }),
      (error: unknown): Raw => (cancel.signal.aborted ? { kind: 'timeout' } : { kind: 'error', error }),
    )
    const flight = Promise.race([answer, deadline]).then((raw) => {
      clearTimeout(timer)
      inFlight.delete(key)
      // Said once per question to Play, however many reads were waiting on it.
      const kind = raw.kind === 'timeout' ? 'timeout' : raw.kind === 'error' ? classifyPlayError(raw.error) : null
      const code = raw.kind === 'error' && raw.error instanceof PlayApiError ? raw.error.code : undefined
      if (kind === 'refused') log.error('proofy play refused rare city', { code, installation: scope.installationId })
      else if (kind && kind !== 'inactive') log.warn('proofy play installation check unanswered', { reason: kind, code, installation: scope.installationId })
      return { raw, askedAt, wall }
    })
    inFlight.set(key, flight)
    return flight
  }

  return {
    verified(scope, askedAt) {
      const key = keyOf(scope)
      const r = { at: askedAt, wall: new Date(now().getTime() - Math.max(0, clock() - askedAt)) }
      if (stands(key, r)) remember(key, r)
    },

    async check(scope, { fresh = false } = {}) {
      const key = keyOf(scope)
      const cached = active.get(key)
      if (!fresh && stands(key, cached) && clock() - cached.at < cacheMs) return { kind: 'active', verifiedAt: cached.wall, cached: true }

      const { raw, askedAt, wall } = await ask(key, scope)
      const answeredAt = clock()
      let kind: ReturnType<typeof classifyPlayError> | 'active' | 'timeout'
      let code = ''
      if (raw.kind === 'answer') {
        const i = raw.installation
        kind = i.id === scope.installationId && i.gameKey === scope.gameKey && i.discordGuildId === scope.discordGuildId && i.status === 'active' ? 'active' : 'inactive'
      } else if (raw.kind === 'timeout') {
        kind = 'timeout'
      } else {
        kind = classifyPlayError(raw.error)
        code = raw.error instanceof PlayApiError ? raw.error.code : 'error'
      }

      switch (kind) {
        case 'active': {
          const reading = { at: askedAt, wall }
          // An "active" asked before a definite no that has since arrived is not an answer any more.
          if (stands(key, reading)) {
            remember(key, reading)
            return { kind: 'active', verifiedAt: wall, cached: false }
          }
          kind = 'unexpected'
          break
        }
        case 'inactive':
          deny(key, answeredAt)
          return { kind: 'inactive' }
        case 'refused':
          // Rare City itself is refused: no reading of any installation stands.
          refusedAt = answeredAt
          active.clear()
          return { kind: 'refused', code }
      }

      const last = active.get(key)
      const standing = stands(key, last) ? last : null
      const graceRemainingMs = standing ? Math.max(0, graceMs - (answeredAt - standing.at)) : 0
      return { kind: 'unknown', reason: kind, lastVerifiedAt: standing?.wall ?? null, graceRemainingMs }
    },
  }
}
