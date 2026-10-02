import { describe, expect, it } from 'vitest'
import { createRateLimiter, HOUR_MS, LIMITS, MINUTE_MS, perHour, perMinute, unlimited, type RateDecision, type RateRule } from '../src/rateLimit'

function clocked(options: { maxBuckets?: number } = {}) {
  let at = 1_000_000
  const limiter = createRateLimiter({ now: () => at, ...options })
  return { limiter, advance: (ms: number) => (at += ms) }
}

const takeN = (take: () => RateDecision, n: number) => Array.from({ length: n }, take)
const allowed = (decisions: RateDecision[]) => decisions.filter((d) => d.allowed).length

describe('rate limiter', () => {
  it('allows exactly `limit` requests in a window and refuses the next', () => {
    const { limiter } = clocked()
    const take = () => limiter.take('route:client', 'ip4:203.0.113.7', [perMinute(10)])
    expect(takeN(take, 10).every((d) => d.allowed)).toBe(true)
    expect(take()).toEqual({ allowed: false, retryAfterSeconds: 60 })
    expect(take()).toEqual({ allowed: false, retryAfterSeconds: 60 })
  })

  it('says when to retry: when the oldest counted request leaves the window', () => {
    const { limiter, advance } = clocked()
    const take = () => limiter.take('s', 'k', [perMinute(3)])
    take()
    advance(10_000)
    take()
    advance(10_000)
    take()
    expect(take()).toEqual({ allowed: false, retryAfterSeconds: 40 })
    advance(39_001)
    // Rounded up, and never zero: a client told to wait always waits long enough.
    expect(take()).toEqual({ allowed: false, retryAfterSeconds: 1 })
    advance(999)
    expect(take()).toEqual({ allowed: true })
    // That freed one place only; the next opens when the second request leaves the window.
    expect(take()).toEqual({ allowed: false, retryAfterSeconds: 10 })
  })

  it('never allows more than `limit` in any window, however requests are spread', () => {
    const { limiter, advance } = clocked()
    const times: number[] = []
    let t = 0
    for (let i = 0; i < 600; i++) {
      if (limiter.take('s', 'k', [perMinute(10)]).allowed) times.push(t)
      advance(700)
      t += 700
    }
    for (const start of times) expect(times.filter((x) => x >= start && x < start + MINUTE_MS).length).toBeLessThanOrEqual(10)
    // And it does keep allowing: the limit is a rate, not a lockout.
    expect(times.length).toBeGreaterThan(60)
  })

  it('does not count refused requests, so hammering cannot extend the wait', () => {
    const { limiter, advance } = clocked()
    const take = () => limiter.take('s', 'k', [perMinute(2)])
    takeN(take, 2)
    for (let i = 0; i < 50; i++) {
      advance(1_000)
      expect(take().allowed).toBe(false)
    }
    advance(10_000)
    expect(take()).toEqual({ allowed: true })
  })

  it('keeps separate keys and separate scopes apart', () => {
    const { limiter } = clocked()
    const rules = [perMinute(2)]
    expect(allowed(takeN(() => limiter.take('challenge:client', 'ip4:203.0.113.7', rules), 5))).toBe(2)
    expect(allowed(takeN(() => limiter.take('challenge:client', 'ip4:203.0.113.8', rules), 5))).toBe(2)
    expect(allowed(takeN(() => limiter.take('verify:client', 'ip4:203.0.113.7', rules), 5))).toBe(2)
  })

  it('never lets a scope and key spell another pair\'s bucket', () => {
    const { limiter } = clocked()
    const once = [perMinute(1)]
    // Pairs that would run together under any plain separator.
    const pairs: [string, string][] = [['a', 'b\n1/60000\nc'], ['a\n1/60000\nb', 'c'], ['a', 'b","c'], ['a","b', 'c'], ['a', '["b"]'], ['["a"', 'b"]'], ['a:client', 'b'], ['a', 'client:b'], ['', 'ab'], ['ab', '']]
    for (const [scope, key] of pairs) expect(limiter.take(scope, key, once), JSON.stringify([scope, key])).toEqual({ allowed: true })
    expect(limiter.size).toBe(pairs.length)
    for (const [scope, key] of pairs) expect(limiter.take(scope, key, once).allowed, JSON.stringify([scope, key])).toBe(false)
  })

  it('does not depend on the wall clock', () => {
    const realNow = Date.now
    try {
      const limiter = createRateLimiter()
      const take = () => limiter.take('s', 'k', [perMinute(3)])
      expect(takeN(take, 3).every((d) => d.allowed)).toBe(true)
      // The system clock is corrected backwards by an hour: the wait must still be at most the window.
      Date.now = () => realNow() - HOUR_MS
      expect(take()).toEqual({ allowed: false, retryAfterSeconds: 60 })
      Date.now = () => realNow() + 2 * HOUR_MS
      expect(take()).toEqual({ allowed: false, retryAfterSeconds: 60 })
    } finally {
      Date.now = realNow
    }
  })

  it('keeps a client that is being refused when the map is full, and drops idle ones first', () => {
    const { limiter } = clocked({ maxBuckets: 5 })
    const rules = [perMinute(2)]
    const flooder = () => limiter.take('s', 'flooder', rules)
    takeN(flooder, 2)
    expect(flooder().allowed).toBe(false)
    // Other clients arrive while the flooder keeps asking. Its bucket is in use, so it is not the one dropped.
    for (let i = 0; i < 20; i++) {
      expect(limiter.take('s', `other-${i}`, rules).allowed).toBe(true)
      expect(flooder().allowed, `after other-${i}`).toBe(false)
    }
    expect(limiter.size).toBe(5)
  })

  it('applies several rules together: all must allow, and a refusal consumes none', () => {
    const { limiter, advance } = clocked()
    // The shape a later route needs: a short limit and a long one on the same user.
    const rules: RateRule[] = [perMinute(6), perHour(30)]
    const take = () => limiter.take('intents:user', 'user-1', rules)
    for (let minute = 0; minute < 5; minute++) {
      expect(allowed(takeN(take, 20))).toBe(6)
      advance(MINUTE_MS)
    }
    // 30 used this hour. The minute rule would allow more; the hour rule does not.
    const refused = take()
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 3300 })
    // The refusals above did not eat into the minute bucket: once the hour frees a place, it is usable at once.
    advance(HOUR_MS - 5 * MINUTE_MS)
    expect(allowed(takeN(take, 20))).toBe(6)
    expect(take()).toMatchObject({ allowed: false })
  })

  it('forgets idle keys and stays bounded under a flood of distinct keys', () => {
    const { limiter, advance } = clocked({ maxBuckets: 100 })
    for (let i = 0; i < 1_000; i++) limiter.take('s', `ip4:10.0.${i >> 8}.${i & 255}`, [perMinute(10)])
    expect(limiter.size).toBe(100)
    advance(2 * MINUTE_MS)
    limiter.take('s', 'ip4:203.0.113.7', [perMinute(10)])
    expect(limiter.size).toBe(1)
  })

  it('has a labelled no-op for local automated tests', () => {
    expect(takeN(() => unlimited.take('s', 'k', [perMinute(1)]), 100).every((d) => d.allowed)).toBe(true)
  })

  it('states the limits of the routes that exist', () => {
    expect(LIMITS).toEqual({
      authChallenge: { client: [{ limit: 10, windowMs: 60_000 }] },
      authVerify: { client: [{ limit: 10, windowMs: 60_000 }] },
      friends: { client: [{ limit: 30, windowMs: 60_000 }], user: [{ limit: 6, windowMs: 60_000 }] },
    })
  })
})
