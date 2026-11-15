import { describe, expect, it } from 'vitest'
import { DevecoAccountPool, DEFAULT_MAX_CONCURRENT } from '../src/account-pool.ts'
import { DevecoQueueGate, QUEUE_FULL_MESSAGE } from '../src/queue.ts'

describe('DevecoAccountPool', () => {
  it('starts with the given accounts and one slot each', () => {
    const pool = new DevecoAccountPool(['a', 'b'])
    expect(pool.list()).toHaveLength(2)
    expect(pool.list()[0]?.maxConcurrent).toBe(DEFAULT_MAX_CONCURRENT)
  })

  it('picks the least recently used account', () => {
    let now = 1_000
    const pool = new DevecoAccountPool(['a', 'b'], { now: () => now })
    expect(pool.pick()).toBe('a')
    pool.acquire('a')
    now = 2_000
    pool.release('a')
    // b 从没被用过（lastUsed = 0），所以轮到它。
    expect(pool.pick()).toBe('b')
  })

  it('prefers pinned accounts', () => {
    const pool = new DevecoAccountPool(['a', 'b'])
    pool.setPreferred(['b'])
    expect(pool.pick()).toBe('b')
  })

  it('skips paused accounts', () => {
    const pool = new DevecoAccountPool(['a', 'b'])
    pool.setPaused(['a'])
    expect(pool.pick()).toBe('b')
    expect(pool.pausedIds()).toEqual(['a'])
  })

  it('enforces the per-account slot cap', () => {
    const pool = new DevecoAccountPool(['a'])
    expect(pool.acquire('a')).toBe(true)
    expect(pool.acquire('a')).toBe(false)
    pool.release('a')
    expect(pool.acquire('a')).toBe(true)
  })

  it('never lets a release drive the counter negative', () => {
    const pool = new DevecoAccountPool(['a'])
    pool.release('a')
    expect(pool.get('a')?.activeConcurrent).toBe(0)
  })

  it('reports whether something could serve a request', () => {
    const pool = new DevecoAccountPool(['a'])
    expect(pool.hasFreeSlot()).toBe(true)
    pool.acquire('a')
    expect(pool.hasFreeSlot()).toBe(false)
    expect(pool.hasBusyWaitable()).toBe(true)
    pool.disable('a', 'nope')
    expect(pool.hasBusyWaitable()).toBe(false)
    expect(pool.hasUsable()).toBe(false)
  })

  it('honours a cooldown window', () => {
    let now = 1000
    const pool = new DevecoAccountPool(['a'], { now: () => now })
    pool.cooldown('a', 500, 'server error')
    expect(pool.healthy('a')).toBe(false)
    expect(pool.pick()).toBeUndefined()
    now += 600
    expect(pool.healthy('a')).toBe(true)
    expect(pool.pick()).toBe('a')
  })

  it('disables after repeated errors and revives on demand', () => {
    const pool = new DevecoAccountPool(['a'])
    pool.noteError('a', 2, 1000, 'boom')
    pool.noteError('a', 2, 1000, 'boom')
    expect(pool.get('a')?.coolUntil).toBeGreaterThan(0)
    pool.disable('a', 'auth')
    expect(pool.healthy('a')).toBe(false)
    pool.revive('a')
    expect(pool.healthy('a')).toBe(true)
    expect(pool.get('a')?.lastError).toBeUndefined()
  })

  it('clears errors on success', () => {
    const pool = new DevecoAccountPool(['a'])
    pool.noteError('a', 5, 10_000, 'x')
    pool.noteSuccess('a')
    expect(pool.get('a')?.errorCount).toBe(0)
    expect(pool.get('a')?.coolUntil).toBe(0)
  })

  it('syncs membership without losing runtime state', () => {
    const pool = new DevecoAccountPool(['a', 'b'])
    pool.acquire('a')
    pool.sync(['a', 'c'])
    expect(pool.list().map(entry => entry.id).sort()).toEqual(['a', 'c'])
    expect(pool.get('a')?.activeConcurrent).toBe(1)
  })

  it('wakes a waiter when a slot frees up', async () => {
    const pool = new DevecoAccountPool(['a'])
    pool.acquire('a')
    const waiting = pool.waitForFreeSlot(1000)
    setTimeout(() => pool.release('a'), 10)
    await expect(waiting).resolves.toBe(true)
  })

  it('gives up when nothing could ever free up', async () => {
    const pool = new DevecoAccountPool(['a'])
    pool.disable('a', 'auth')
    await expect(pool.waitForFreeSlot(50)).resolves.toBe(false)
  })

  it('gives up when the signal aborts', async () => {
    const pool = new DevecoAccountPool(['a'])
    pool.acquire('a')
    const controller = new AbortController()
    const waiting = pool.waitForFreeSlot(5000, controller.signal)
    setTimeout(() => controller.abort(), 10)
    await expect(waiting).resolves.toBe(false)
  })
})

describe('DevecoQueueGate', () => {
  it('admits up to maxConcurrent immediately', async () => {
    const gate = new DevecoQueueGate({ maxConcurrent: 1, maxQueue: 3, cooldownMs: 0 })
    await expect(gate.acquire()).resolves.toBe(true)
    expect(gate.snapshot().active).toBe(1)
  })

  it('queues the next request and admits it on release', async () => {
    const gate = new DevecoQueueGate({ maxConcurrent: 1, maxQueue: 3, cooldownMs: 0 })
    await gate.acquire()
    const second = gate.acquire()
    expect(gate.snapshot().queued).toBe(1)
    gate.release()
    await expect(second).resolves.toBe(true)
    expect(gate.snapshot().active).toBe(1)
  })

  it('rejects once the queue is full', async () => {
    const gate = new DevecoQueueGate({ maxConcurrent: 1, maxQueue: 1, cooldownMs: 0 })
    await gate.acquire()
    const queued = gate.acquire()
    await expect(gate.acquire()).resolves.toBe(false)
    gate.release()
    await expect(queued).resolves.toBe(true)
    expect(QUEUE_FULL_MESSAGE).toContain('queue is full')
  })

  it('applies the entry cooldown only to queued requests', async () => {
    const gate = new DevecoQueueGate({ maxConcurrent: 1, maxQueue: 2, cooldownMs: 20 })
    const started = Date.now()
    await gate.acquire()
    const queued = gate.acquire()
    gate.release()
    await queued
    expect(Date.now() - started).toBeGreaterThanOrEqual(15)
  })

  it('drops waiters on dispose', async () => {
    const gate = new DevecoQueueGate({ maxConcurrent: 1, maxQueue: 2, cooldownMs: 0 })
    await gate.acquire()
    const queued = gate.acquire()
    gate.dispose()
    await expect(queued).resolves.toBe(false)
  })

  it('respects an aborted signal before queueing', async () => {
    const gate = new DevecoQueueGate({ maxConcurrent: 1, maxQueue: 2, cooldownMs: 0 })
    const controller = new AbortController()
    controller.abort()
    await expect(gate.acquire(controller.signal)).resolves.toBe(false)
  })
})
