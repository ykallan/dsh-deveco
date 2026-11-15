import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DevecoUsageTracker } from '../src/usage.ts'
import { quotaWindowKey } from '../src/quota.ts'

const dirs: string[] = []

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-deveco-usage-'))
  dirs.push(dir)
  return join(dir, 'usage.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('DevecoUsageTracker', () => {
  it('starts empty and tells the caller the numbers are local only', () => {
    const tracker = new DevecoUsageTracker({ path: tempPath() })
    const snapshot = tracker.snapshot()
    expect(snapshot.scope).toBe('local')
    expect(snapshot.today).toEqual({ requests: 0, failures: 0, inputTokens: 0, outputTokens: 0 })
    expect(snapshot.totals.requests).toBe(0)
  })

  it('buckets a request into totals, today, account and model', () => {
    const tracker = new DevecoUsageTracker({ path: tempPath() })
    tracker.record({ account: 'a', model: 'GLM-5.1', ok: true, ms: 120, inputTokens: 10, outputTokens: 3 })
    const snapshot = tracker.snapshot()
    expect(snapshot.totals).toEqual({ requests: 1, failures: 0, inputTokens: 10, outputTokens: 3 })
    expect(snapshot.today.requests).toBe(1)
    expect(snapshot.byAccount.a?.inputTokens).toBe(10)
    expect(snapshot.byModel['GLM-5.1']?.outputTokens).toBe(3)
    expect(snapshot.recent).toHaveLength(1)
  })

  it('counts failures separately', () => {
    const tracker = new DevecoUsageTracker({ path: tempPath() })
    tracker.record({ account: 'a', model: 'm', ok: false, ms: 10 })
    expect(tracker.snapshot().totals.failures).toBe(1)
  })

  it('orders recent events newest first and caps them', () => {
    const tracker = new DevecoUsageTracker({ path: tempPath() })
    for (let index = 0; index < 120; index += 1) {
      tracker.record({ account: 'a', model: 'm', ok: true, ms: index })
    }
    const snapshot = tracker.snapshot()
    expect(snapshot.recent.length).toBe(100)
    expect(snapshot.recent[0]?.ms).toBe(119)
    expect(snapshot.totals.requests).toBe(120)
  })

  it('persists and reloads the ledger', async () => {
    const path = tempPath()
    const tracker = new DevecoUsageTracker({ path })
    tracker.record({ account: 'a', model: 'm', ok: true, ms: 5, inputTokens: 7, outputTokens: 2 })
    await tracker.flush()
    const reopened = new DevecoUsageTracker({ path })
    await reopened.load()
    const snapshot = reopened.snapshot()
    expect(snapshot.totals.requests).toBe(1)
    expect(snapshot.totals.inputTokens).toBe(7)
    expect(snapshot.byAccount.a?.outputTokens).toBe(2)
  })

  it('survives a corrupt ledger file', async () => {
    const path = tempPath()
    const tracker = new DevecoUsageTracker({ path })
    tracker.record({ account: 'a', model: 'm', ok: true, ms: 1 })
    await tracker.flush()
    const fs = await import('node:fs')
    fs.writeFileSync(path, '{not json')
    const reopened = new DevecoUsageTracker({ path })
    await expect(reopened.load()).resolves.toBeUndefined()
    expect(reopened.snapshot().totals.requests).toBe(0)
  })

  it('labels the current bucket with the quota window, not the calendar day', () => {
    const tracker = new DevecoUsageTracker({ path: tempPath() })
    expect(tracker.snapshot().day).toBe(quotaWindowKey())
  })

  it('drops a stale bucket that belongs to an old window', async () => {
    const path = tempPath()
    const fs = await import('node:fs')
    fs.writeFileSync(path, JSON.stringify({
      version: 1,
      scope: 'local',
      day: '2000-01-01',
      totals: { requests: 5, failures: 0, inputTokens: 50, outputTokens: 5 },
      today: { requests: 5, failures: 0, inputTokens: 50, outputTokens: 5 },
      byAccount: {},
      byModel: {},
      recent: [],
      updatedAt: Date.now(),
    }))
    const tracker = new DevecoUsageTracker({ path })
    await tracker.load()
    const snapshot = tracker.snapshot()
    // 全量保留，窗口内的计数归零。
    expect(snapshot.totals.requests).toBe(5)
    expect(snapshot.today.requests).toBe(0)
    expect(snapshot.day).toBe(quotaWindowKey())
  })
})
