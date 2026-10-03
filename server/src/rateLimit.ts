/**
 * Request rate limiting, held in memory.
 *
 * A rule is "at most `limit` requests in any `windowMs`", counted exactly: each key keeps
 * the times of the requests it was allowed, and a request is allowed only while fewer than
 * `limit` of them are inside the window. A refused request is not recorded, so being
 * refused never pushes the next allowed time further away.
 *
 * Memory is per process. That is right for one replica; with several, each would allow
 * its own `limit`, and the counts would have to move to shared storage.
 *
 * WHAT A KEY MAY BE. A key names who is asking: the client network (`clientKey.ts`) or the
 * authenticated user. It must never be something the request merely mentions, such as a
 * wallet address being signed in, a challenge address or a token id. A bucket keyed that
 * way could be emptied by anyone, on purpose, to lock the real owner out.
 */
export interface RateRule {
  limit: number
  windowMs: number
}

export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS

export const perMinute = (limit: number): RateRule => ({ limit, windowMs: MINUTE_MS })
export const perHour = (limit: number): RateRule => ({ limit, windowMs: HOUR_MS })

export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number }

export interface RateLimiter {
  /**
   * Count one request against every rule, or against none. `scope` names what is being
   * limited (a route and the kind of key), so the same key never shares a bucket across
   * scopes. With several rules the request is allowed only if all of them allow it, and
   * a refusal leaves every bucket as it was.
   */
  take(scope: string, key: string, rules: readonly RateRule[]): RateDecision
  /** Buckets currently held. */
  readonly size: number
}

export interface RateLimiterOptions {
  /** Milliseconds from a clock that never goes backwards. Defaults to the process's monotonic clock. */
  now?: () => number
  /** Ceiling on buckets held. Past it, the bucket unused for longest is dropped. */
  maxBuckets?: number
}

const ALLOWED: RateDecision = { allowed: true }
const SWEEP_EVERY_MS = 30_000

interface Bucket {
  /** Times of allowed requests still inside the window, oldest first. */
  hits: number[]
  windowMs: number
}

export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const { maxBuckets = 50_000 } = options
  // Not the wall clock: a time correction that stepped it backwards would leave every full bucket refusing until it caught up.
  const now = options.now ?? (() => performance.now())
  /** Insertion order is least-recently-used order: a bucket moves to the back whenever a request consults it, allowed or not. */
  const buckets = new Map<string, Bucket>()
  let sweptAt = Number.NEGATIVE_INFINITY

  const prune = (bucket: Bucket, at: number) => {
    const from = at - bucket.windowMs
    let stale = 0
    while (stale < bucket.hits.length && bucket.hits[stale] <= from) stale++
    if (stale > 0) bucket.hits.splice(0, stale)
  }

  /** Forget buckets with nothing left in their window. Occasional, so the map cannot grow with idle keys. */
  function sweep(at: number) {
    if (at - sweptAt < SWEEP_EVERY_MS) return
    sweptAt = at
    for (const [id, bucket] of buckets) {
      prune(bucket, at)
      if (bucket.hits.length === 0) buckets.delete(id)
    }
  }

  return {
    take(scope, key, rules) {
      const at = now()
      sweep(at)
      // JSON of a tuple: no scope and key can ever spell another pair's bucket.
      const ids = rules.map((rule) => JSON.stringify([scope, rule.limit, rule.windowMs, key]))

      let retryAfterMs = 0
      rules.forEach((rule, i) => {
        const bucket = buckets.get(ids[i])
        if (!bucket) return
        // A client being refused is still in use: it must not become the first bucket dropped when the map is full.
        buckets.delete(ids[i])
        buckets.set(ids[i], bucket)
        prune(bucket, at)
        // Full: a place frees up when the oldest of the last `limit` requests leaves the window.
        if (bucket.hits.length >= rule.limit) retryAfterMs = Math.max(retryAfterMs, bucket.hits[bucket.hits.length - rule.limit] + rule.windowMs - at)
      })
      if (retryAfterMs > 0) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) }

      rules.forEach((rule, i) => {
        const bucket = buckets.get(ids[i]) ?? { hits: [], windowMs: rule.windowMs }
        bucket.hits.push(at)
        buckets.delete(ids[i])
        buckets.set(ids[i], bucket)
      })
      while (buckets.size > maxBuckets) buckets.delete(buckets.keys().next().value!)
      return ALLOWED
    },
    get size() {
      return buckets.size
    },
  }
}

/** A limiter that allows everything: local automated tests only (see `RATE_LIMITS` in config). */
export const unlimited: RateLimiter = { take: () => ALLOWED, size: 0 }

/**
 * The limits on the routes that exist today. Client rules are keyed by the client
 * network; user rules by the authenticated user id.
 */
export const LIMITS = {
  authChallenge: { client: [perMinute(10)] },
  authVerify: { client: [perMinute(10)] },
  friends: { client: [perMinute(30)], user: [perMinute(6)] },
  // Each allowed request of either kind costs one pinned chain read. A person activates a Friend a few times, ever.
  activationIntent: { client: [perMinute(10)], user: [perMinute(6)] },
  activationCommit: { client: [perMinute(10)], user: [perMinute(6)] },
} as const satisfies Record<string, { client: readonly RateRule[]; user?: readonly RateRule[] }>
