import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DevecoCheckinLedger, runCheckin } from '../src/checkin.ts'
import { localDayKey } from '../src/usage.ts'
import { DevecoAccountStore, type DevecoCredential } from '../src/auth.ts'

const dirs: string[] = []

function tempPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-deveco-checkin-'))
  dirs.push(dir)
  return join(dir, name)
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256' })}.${encode(payload)}.signature`
}

function credential(userId: string): DevecoCredential {
  return {
    jwtToken: makeJwt({ userId, exp: Math.floor(Date.now() / 1000) + 86_400 }),
    accessToken: 'access',
    accessTokenExpiresAt: Date.now() + 20 * 60 * 1000,
  }
}

describe('DevecoCheckinLedger', () => {
  it('starts empty', () => {
    const ledger = new DevecoCheckinLedger({ path: tempPath('checkin.json') })
    const snapshot = ledger.snapshot(['a'])
    expect(snapshot.today).toEqual({})
    expect(snapshot.streaks.a).toBe(0)
  })

  it('records and reloads today\'s result', () => {
    const path = tempPath('checkin.json')
    const ledger = new DevecoCheckinLedger({ path })
    ledger.record('a', { at: Date.now(), ok: true, models: 3 })
    expect(ledger.todayRecord('a')?.ok).toBe(true)
    const reopened = new DevecoCheckinLedger({ path })
    expect(reopened.todayRecord('a')?.models).toBe(3)
  })

  it('counts a streak across consecutive days', () => {
    const ledger = new DevecoCheckinLedger({ path: tempPath('checkin.json') })
    const day = 24 * 60 * 60 * 1000
    const now = Date.now()
    // 今天、昨天、前天都有成功记录。
    for (const offset of [0, 1, 2]) {
      ledger.record('a', { at: now - offset * day, ok: true, models: 1 }, now - offset * day)
    }
    expect(ledger.streak('a', now)).toBe(3)
  })

  it('stops counting at the first missed day', () => {
    const ledger = new DevecoCheckinLedger({ path: tempPath('checkin.json') })
    const day = 24 * 60 * 60 * 1000
    const now = Date.now()
    ledger.record('a', { at: now, ok: true, models: 1 }, now)
    ledger.record('a', { at: now - 2 * day, ok: true, models: 1 }, now - 2 * day)
    // 昨天断了一天 → 连续天数只有今天这一次。
    expect(ledger.streak('a', now)).toBe(1)
  })

  it('counts yesterday\'s streak when today is still unchecked', () => {
    const ledger = new DevecoCheckinLedger({ path: tempPath('checkin.json') })
    const day = 24 * 60 * 60 * 1000
    const now = Date.now()
    ledger.record('a', { at: now - day, ok: true, models: 1 }, now - day)
    expect(ledger.streak('a', now)).toBe(1)
  })

  it('exposes the local day key and recent days in the snapshot', () => {
    const ledger = new DevecoCheckinLedger({ path: tempPath('checkin.json') })
    ledger.record('a', { at: Date.now(), ok: true, models: 2 })
    const snapshot = ledger.snapshot(['a'])
    expect(snapshot.day).toBe(localDayKey())
    expect(snapshot.days[0]).toBe(localDayKey())
  })
})

describe('runCheckin', () => {
  const original = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = original
  })

  async function storeWithAccount(): Promise<DevecoAccountStore> {
    const store = new DevecoAccountStore(tempPath('accounts.json'))
    await store.upsert(credential('u-1'))
    return store
  }

  it('probes the account and records success', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 200,
      body: { inner_models: [{ model_configs: [{ model_id: 'GLM-5.1' }] }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const store = await storeWithAccount()
    const ledger = new DevecoCheckinLedger({ path: tempPath('checkin.json') })
    const outcome = await runCheckin(store, ledger)
    expect(outcome.ok).toBe(true)
    expect(outcome.probed).toBe(1)
    expect(outcome.results[0]?.models).toBe(1)
    expect(ledger.todayRecord('u-1')?.ok).toBe(true)
  })

  it('skips an account already checked in today', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({
        code: 200,
        body: { inner_models: [{ model_configs: [{ model_id: 'GLM-5.1' }] }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const store = await storeWithAccount()
    const ledger = new DevecoCheckinLedger({ path: tempPath('checkin.json') })
    await runCheckin(store, ledger)
    const second = await runCheckin(store, ledger)
    expect(second.probed).toBe(0)
    expect(second.results[0]?.alreadyCheckedToday).toBe(true)
    expect(calls).toBe(1)
  })

  it('forces a re-probe when asked', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 200,
      body: { inner_models: [{ model_configs: [{ model_id: 'GLM-5.1' }] }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const store = await storeWithAccount()
    const ledger = new DevecoCheckinLedger({ path: tempPath('checkin.json') })
    await runCheckin(store, ledger)
    const forced = await runCheckin(store, ledger, { force: true })
    expect(forced.probed).toBe(1)
  })

  it('records a failure without throwing', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch
    const store = await storeWithAccount()
    const ledger = new DevecoCheckinLedger({ path: tempPath('checkin.json') })
    const outcome = await runCheckin(store, ledger)
    expect(outcome.ok).toBe(false)
    expect(outcome.results[0]?.ok).toBe(false)
    expect(outcome.results[0]?.message).toContain('500')
  })

  it('reports an account that cannot even sign in', async () => {
    const store = new DevecoAccountStore(tempPath('accounts-empty.json'))
    const ledger = new DevecoCheckinLedger({ path: tempPath('checkin.json') })
    const outcome = await runCheckin(store, ledger)
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('no account')
  })
})
