import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_QUOTA_RESET_HOUR,
  DevecoQuotaTracker,
  formatQuotaRemaining,
  looksLikeQuotaExhausted,
  quotaWindow,
  quotaWindowKey,
} from '../src/quota.ts'

const HOUR = 60 * 60 * 1000

afterEach(() => {
  delete process.env.DEVECO_QUOTA_RESET_HOUR
})

/** 本地时间的时间戳（不受测试机时区影响，构造用本地时间分量）。 */
function local(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

describe('quotaWindow', () => {
  it('starts at the configured hour, not at midnight', () => {
    const now = local(2026, 11, 15, 13, 30)
    const window = quotaWindow(now, 8)
    expect(new Date(window.start).getHours()).toBe(8)
    expect(window.key).toBe('2026-11-15')
    expect(window.end - window.start).toBe(24 * HOUR)
    expect(now).toBeGreaterThanOrEqual(window.start)
    expect(now).toBeLessThan(window.end)
  })

  it('keeps yesterday\'s window before the reset hour', () => {
    const now = local(2026, 11, 15, 7, 59)
    const window = quotaWindow(now, 8)
    expect(window.key).toBe('2026-11-14')
    expect(new Date(window.start).getDate()).toBe(14)
    expect(window.end).toBe(local(2026, 11, 15, 8))
  })

  it('opens the new window exactly at the reset hour', () => {
    const now = local(2026, 11, 15, 8, 0)
    const window = quotaWindow(now, 8)
    expect(window.key).toBe('2026-11-15')
    expect(window.start).toBe(now)
    expect(window.end).toBe(local(2026, 11, 16, 8))
  })

  it('handles a month boundary', () => {
    const now = local(2026, 12, 1, 2, 0)
    const window = quotaWindow(now, 8)
    expect(window.key).toBe('2026-11-30')
    expect(window.end).toBe(local(2026, 12, 1, 8))
  })

  it('renders a human window label', () => {
    expect(quotaWindow(local(2026, 11, 15, 9), 8).label).toBe('11-15 08:00 → 11-16 08:00')
  })

  it('defaults to the documented reset hour and honours the env override', () => {
    const now = local(2026, 11, 15, 3, 0)
    expect(DEFAULT_QUOTA_RESET_HOUR).toBe(8)
    // 默认 8 点：凌晨 3 点还属于昨天那个窗口。
    expect(quotaWindow(now).key).toBe('2026-11-14')
    // 覆盖成 0 点：凌晨 3 点属于今天。
    process.env.DEVECO_QUOTA_RESET_HOUR = '0'
    expect(quotaWindow(now).key).toBe('2026-11-15')
  })

  it('ignores a bogus reset hour', () => {
    process.env.DEVECO_QUOTA_RESET_HOUR = '99'
    expect(quotaWindow(local(2026, 11, 15, 13)).key).toBe('2026-11-15')
  })

  it('exposes a window key helper', () => {
    expect(quotaWindowKey(local(2026, 11, 15, 13))).toBe('2026-11-15')
  })
})

describe('formatQuotaRemaining', () => {
  it('says how long until the reset', () => {
    expect(formatQuotaRemaining(13 * HOUR + 47 * 60_000)).toBe('13 小时 47 分')
    expect(formatQuotaRemaining(2 * HOUR)).toBe('2 小时')
    expect(formatQuotaRemaining(25 * HOUR)).toBe('1 天 1 小时')
    expect(formatQuotaRemaining(30 * 60_000)).toBe('30 分')
    expect(formatQuotaRemaining(0)).toBe('即将重置')
    expect(formatQuotaRemaining(-5)).toBe('即将重置')
  })
})

describe('looksLikeQuotaExhausted', () => {
  it('recognises the upstream quota signals', () => {
    expect(looksLikeQuotaExhausted(429, 'slow down')).toBe(true)
    expect(looksLikeQuotaExhausted(403, '{"error":{"type":"UserRateLimit"}}')).toBe(true)
    expect(looksLikeQuotaExhausted(403, 'FreeUsageLimitError: free usage exceeded')).toBe(true)
    expect(looksLikeQuotaExhausted(400, 'insufficient_quota')).toBe(true)
    expect(looksLikeQuotaExhausted(400, '今日免费额度已用尽')).toBe(true)
  })

  it('never mistakes an overload for an exhausted quota', () => {
    expect(looksLikeQuotaExhausted(403, 'ModelServiceError: Built-in model service is currently overloaded')).toBe(false)
    expect(looksLikeQuotaExhausted(403, 'Full inference timed out')).toBe(false)
  })

  it('ignores unrelated failures', () => {
    expect(looksLikeQuotaExhausted(401, 'unauthorized')).toBe(false)
    expect(looksLikeQuotaExhausted(500, 'internal error')).toBe(false)
    expect(looksLikeQuotaExhausted(400, 'the request param is invalid')).toBe(false)
  })
})

describe('DevecoQuotaTracker', () => {
  it('remembers an exhausted account within the window', () => {
    let now = local(2026, 11, 15, 10)
    const tracker = new DevecoQuotaTracker({ now: () => now })
    tracker.noteExhausted('a', 'FreeUsageLimitError')
    expect(tracker.state('a')?.exhausted).toBe(true)
    const snapshot = tracker.snapshot(['a', 'b'])
    expect(snapshot.exhausted).toEqual(['a'])
    expect(snapshot.accounts.a?.message).toContain('FreeUsageLimitError')
    expect(snapshot.hasUpstreamEndpoint).toBe(false)
  })

  it('clears the mark after a success', () => {
    const now = local(2026, 11, 15, 10)
    const tracker = new DevecoQuotaTracker({ now: () => now })
    tracker.noteExhausted('a', 'quota exceeded')
    tracker.noteOk('a')
    expect(tracker.state('a')).toBeUndefined()
    expect(tracker.snapshot(['a']).exhausted).toEqual([])
  })

  it('forgets everything once the window rolls over', () => {
    let now = local(2026, 11, 15, 23)
    const tracker = new DevecoQuotaTracker({ now: () => now })
    tracker.noteExhausted('a', 'quota exceeded')
    expect(tracker.snapshot(['a']).exhausted).toEqual(['a'])
    // 跨过 08:00 重置点。
    now = local(2026, 11, 16, 8, 1)
    expect(tracker.state('a')).toBeUndefined()
    expect(tracker.snapshot(['a']).exhausted).toEqual([])
  })

  it('reports the remaining time to the reset', () => {
    const now = local(2026, 11, 15, 20)
    const tracker = new DevecoQuotaTracker({ now: () => now })
    const snapshot = tracker.snapshot([])
    expect(snapshot.resetInMs).toBe(12 * HOUR)
    expect(snapshot.resetIn).toBe('12 小时')
    expect(snapshot.window.label).toBe('11-15 08:00 → 11-16 08:00')
  })

  it('truncates a very long upstream message', () => {
    const tracker = new DevecoQuotaTracker({ now: () => local(2026, 11, 15, 10) })
    tracker.noteExhausted('a', 'x'.repeat(1000))
    expect((tracker.state('a')?.message ?? '').length).toBeLessThanOrEqual(301)
  })
})
