import { describe, expect, it } from 'vitest'
import {
  AUTO_REFRESH_INTERVAL_MS,
  estimateTtlMs,
  MAX_REFRESH_SKEW_MS,
  median,
  MIN_REFRESH_SKEW_MS,
  pushTtlSample,
  refreshSkewForTtl,
  shouldRefresh,
  TTL_FALLBACK_MS,
  TTL_MAX_MS,
  TTL_MIN_MS,
  TTL_SAMPLE_KEEP,
  URGENT_REMAINING_MS,
} from '../src/ttl.ts'

const MIN = 60 * 1000

describe('median', () => {
  it('returns the middle value for an odd count', () => {
    expect(median([3, 1, 2])).toBe(2)
  })

  it('averages the two middles for an even count', () => {
    expect(median([10, 20, 30, 40])).toBe(25)
  })

  it('is undefined for an empty list', () => {
    expect(median([])).toBeUndefined()
  })
})

describe('estimateTtlMs', () => {
  it('falls back to the default until it has enough samples', () => {
    const result = estimateTtlMs({ expiredAgesMs: [20 * MIN] })
    expect(result.source).toBe('default')
    expect(result.ttlMs).toBe(TTL_FALLBACK_MS)
  })

  it('learns from at least two expiry samples, taking the median', () => {
    const result = estimateTtlMs({ expiredAgesMs: [20 * MIN, 22 * MIN, 60 * MIN] })
    expect(result.source).toBe('learned')
    expect(result.ttlMs).toBe(22 * MIN)
    expect(result.samples).toBe(3)
  })

  it('ignores samples outside the sane range', () => {
    const result = estimateTtlMs({ expiredAgesMs: [1 * MIN, 30 * 24 * 60 * MIN, 18 * MIN, 20 * MIN] })
    expect(result.source).toBe('learned')
    expect(result.ttlMs).toBe(19 * MIN)
  })

  it('extends the default when a token demonstrably lived longer', () => {
    const result = estimateTtlMs({ workingAgeMs: 45 * MIN })
    expect(result.source).toBe('extended')
    expect(result.ttlMs).toBeGreaterThan(45 * MIN)
    expect(result.ttlMs).toBeLessThanOrEqual(TTL_MAX_MS)
  })

  it('never shrinks below the floor or above the ceiling', () => {
    expect(estimateTtlMs({ expiredAgesMs: [TTL_MIN_MS, TTL_MIN_MS], fallbackMs: 1 }).ttlMs).toBe(TTL_MIN_MS)
    expect(estimateTtlMs({ workingAgeMs: 30 * 24 * 60 * MIN }).ttlMs).toBeLessThanOrEqual(TTL_MAX_MS)
  })
})

describe('refreshSkewForTtl', () => {
  it('takes a third of the TTL for short lifetimes', () => {
    expect(refreshSkewForTtl(9 * MIN)).toBe(3 * MIN)
  })

  it('caps at the configured maximum for a 30-minute token', () => {
    expect(refreshSkewForTtl(30 * MIN)).toBe(MAX_REFRESH_SKEW_MS)
  })

  it('never goes below the floor', () => {
    expect(refreshSkewForTtl(3 * MIN)).toBe(MIN_REFRESH_SKEW_MS)
  })

  it('honours a smaller configured skew', () => {
    expect(refreshSkewForTtl(30 * MIN, 4 * MIN)).toBeLessThanOrEqual(4 * MIN)
  })
})

describe('pushTtlSample', () => {
  it('keeps only the most recent samples', () => {
    let samples: number[] = []
    for (let index = 1; index <= 8; index += 1) samples = pushTtlSample(samples, index * 10 * MIN)
    expect(samples).toHaveLength(TTL_SAMPLE_KEEP)
    expect(samples.at(-1)).toBe(80 * MIN)
  })

  it('drops junk samples', () => {
    expect(pushTtlSample([], 1000)).toEqual([])
    expect(pushTtlSample([], TTL_MAX_MS * 2)).toEqual([])
  })
})

describe('shouldRefresh (5-minute auto gate)', () => {
  const ttl30 = 30 * MIN

  it('allows a refresh once five minutes have passed', () => {
    const result = shouldRefresh({ sinceLastRefreshMs: AUTO_REFRESH_INTERVAL_MS, ttlMs: ttl30, remainingMs: 9 * MIN })
    expect(result).toEqual({ allowed: true, reason: 'interval-ok' })
  })

  it('throttles a second refresh inside five minutes when the token is comfortable', () => {
    const result = shouldRefresh({ sinceLastRefreshMs: 2 * MIN, ttlMs: ttl30, remainingMs: 9 * MIN })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('throttled')
  })

  it('lets an urgent token through even inside the window', () => {
    const result = shouldRefresh({ sinceLastRefreshMs: 1 * MIN, ttlMs: ttl30, remainingMs: URGENT_REMAINING_MS - 1 })
    expect(result).toEqual({ allowed: true, reason: 'urgent' })
  })

  it('degrades the gate when the learned TTL is shorter than it', () => {
    // TTL=6 分钟 → 刷新点在 4 分钟，5 分钟闸门会把它挡到过期之后，必须放行。
    const result = shouldRefresh({ sinceLastRefreshMs: 2 * MIN, ttlMs: 6 * MIN, remainingMs: 2 * MIN })
    expect(result).toEqual({ allowed: true, reason: 'short-ttl' })
  })

  it('keeps throttling at the TTL boundary itself', () => {
    // TTL=7.5 分钟 → 2/3·TTL = 5 分钟，闸门刚好不生效，仍按间隔判断。
    const result = shouldRefresh({ sinceLastRefreshMs: 2 * MIN, ttlMs: 7.5 * MIN, remainingMs: 3 * MIN })
    expect(result.allowed).toBe(false)
    const ok = shouldRefresh({ sinceLastRefreshMs: 5 * MIN, ttlMs: 7.5 * MIN, remainingMs: 3 * MIN })
    expect(ok.allowed).toBe(true)
  })

  it('does not throttle the very first refresh', () => {
    const result = shouldRefresh({ sinceLastRefreshMs: Number.POSITIVE_INFINITY, ttlMs: ttl30, remainingMs: 9 * MIN })
    expect(result.allowed).toBe(true)
  })
})
