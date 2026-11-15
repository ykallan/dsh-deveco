import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  accountIdOf,
  DevecoAccountStore,
  parseJwtPayload,
  parseRealName,
  summarizeAccount,
  verifyJwtToken,
  withJwtIdentity,
  type DevecoCredential,
} from '../src/auth.ts'

/** 造一个形状正确的 JWT（签名是假的，本插件从不验签）。 */
function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(payload)}.signature`
}

const OTHER_TOKEN = makeJwt({
  userId: 'u-2',
  userName: 'other',
  exp: Math.floor(Date.now() / 1000) + 86_400,
})

const TOKEN = makeJwt({
  userId: 'u-1',
  userName: 'tester',
  exp: Math.floor(Date.now() / 1000) + 86_400,
  nationalCode: 'CN',
  isRealName: true,
})

const dirs: string[] = []

function tempStore(): DevecoAccountStore {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-deveco-test-'))
  dirs.push(dir)
  return new DevecoAccountStore(join(dir, 'accounts.json'))
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function credential(overrides: Partial<DevecoCredential> = {}): DevecoCredential {
  return {
    jwtToken: TOKEN,
    accessToken: 'access',
    accessTokenExpiresAt: Date.now() + 20 * 60 * 1000,
    ...overrides,
  }
}

describe('parseJwtPayload', () => {
  it('reads the identity claims', () => {
    expect(parseJwtPayload(TOKEN)).toEqual({
      userId: 'u-1',
      userName: 'tester',
      exp: expect.any(Number),
      nationalCode: 'CN',
      isRealName: true,
    })
  })

  it('rejects a non-JWT', () => {
    expect(() => parseJwtPayload('nope')).toThrow(/jwtToken/)
  })
})

describe('parseRealName', () => {
  it('normalises booleans and strings', () => {
    expect(parseRealName(true)).toBe(true)
    expect(parseRealName('true')).toBe(true)
    expect(parseRealName('false')).toBe(false)
    expect(parseRealName(undefined)).toBeUndefined()
  })
})

describe('account identity', () => {
  it('prefers userId, then userName, then a token hash', () => {
    expect(accountIdOf({ jwtToken: TOKEN, userId: 'u-1', userName: 'n' })).toBe('u-1')
    expect(accountIdOf({ jwtToken: TOKEN, userName: 'n' })).toBe('n')
    expect(accountIdOf({ jwtToken: TOKEN })).toMatch(/^t[0-9a-f]{15}$/)
  })

  it('fills identity from the JWT', () => {
    const filled = withJwtIdentity({ jwtToken: TOKEN })
    expect(filled.userId).toBe('u-1')
    expect(filled.nationalCode).toBe('CN')
  })

  it('summarises without leaking any token', () => {
    const summary = summarizeAccount('u-1', withJwtIdentity(credential({ userId: 'u-1' })))
    expect(summary.id).toBe('u-1')
    expect(summary.usable).toBe(true)
    expect(summary.isRealName).toBe(true)
    expect(summary).not.toHaveProperty('accessToken')
    expect(summary).not.toHaveProperty('jwtToken')
    expect(JSON.stringify(summary)).not.toContain(TOKEN)
  })
})

describe('DevecoAccountStore', () => {
  it('starts empty', async () => {
    const store = tempStore()
    expect(await store.ids()).toEqual([])
    expect(await store.hasCredential()).toBe(false)
  })

  it('round-trips an account through disk', async () => {
    const store = tempStore()
    const id = await store.upsert(credential())
    expect(id).toBe('u-1')
    const reopened = new DevecoAccountStore(store.documentPath)
    const list = await reopened.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.userName).toBe('tester')
    expect((await reopened.credential('u-1'))?.accessToken).toBe('access')
  })

  it('remembers pause / pin / label preferences', async () => {
    const store = tempStore()
    await store.upsert(credential())
    expect(await store.setPaused('u-1', true)).toBe(true)
    expect(await store.setPinned('u-1', true)).toBe(true)
    expect(await store.setLabel('u-1', 'work')).toBe(true)
    const reopened = new DevecoAccountStore(store.documentPath)
    const summary = (await reopened.list())[0]
    expect(summary?.paused).toBe(true)
    expect(summary?.pinned).toBe(true)
    expect(summary?.label).toBe('work')
  })

  it('keeps preferences across a re-login of the same account', async () => {
    const store = tempStore()
    await store.upsert(credential())
    await store.setPaused('u-1', true)
    await store.upsert(credential({ accessToken: 'new' }))
    expect((await store.list())[0]?.paused).toBe(true)
  })

  it('excludes paused accounts from dispatch but keeps them listed', async () => {
    const store = tempStore()
    await store.upsert(credential())
    await store.setPaused('u-1', true)
    expect(await store.ids()).toEqual(['u-1'])
    expect(await store.dispatchIds()).toEqual([])
  })

  it('removes accounts', async () => {
    const store = tempStore()
    await store.upsert(credential())
    await store.remove('u-1')
    expect(await store.ids()).toEqual([])
  })

  it('drops accounts whose JWT cannot be parsed', async () => {
    const store = tempStore()
    await store.upsert(credential())
    const path = store.documentPath
    const fs = await import('node:fs')
    const raw = JSON.parse(fs.readFileSync(path, 'utf8')) as { accounts: Record<string, unknown> }
    raw.accounts['broken'] = { jwtToken: 'nope' }
    fs.writeFileSync(path, JSON.stringify(raw))
    const reopened = new DevecoAccountStore(path)
    expect(await reopened.ids()).toEqual(['u-1'])
  })

  it('reuses a fresh access token without calling the network', async () => {
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      throw new Error('should not be called')
    }) as typeof fetch
    try {
      const store = tempStore()
      await store.upsert(credential())
      const resolved = await store.resolve('u-1')
      expect(resolved?.accessToken).toBe('access')
      expect(calls).toBe(0)
    } finally {
      globalThis.fetch = original
    }
  })

  it('refreshes an expired access token', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: true,
      userInfo: { accessToken: 'fresh', refreshToken: 'r2', nationalCode: 'CN', realName: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    try {
      const store = tempStore()
      await store.upsert(credential({ accessTokenExpiresAt: Date.now() - 1000 }))
      const resolved = await store.resolve('u-1')
      expect(resolved?.accessToken).toBe('fresh')
      const reopened = new DevecoAccountStore(store.documentPath)
      expect((await reopened.credential('u-1'))?.accessToken).toBe('fresh')
    } finally {
      globalThis.fetch = original
    }
  })

  it('marks an account stale when the refresh is rejected', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: false,
      errorCode: 4016,
      errorMsg: 'invalid accessToken.',
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    try {
      const store = tempStore()
      await store.upsert(credential({ accessTokenExpiresAt: Date.now() - 1000 }))
      expect(await store.forceRefresh('u-1')).toBe(false)
      expect((await store.list())[0]?.usable).toBe(false)
    } finally {
      globalThis.fetch = original
    }
  })

  it('does not mark an account stale when the refresh fails on the network', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('ECONNRESET')
    }) as typeof fetch
    try {
      const store = tempStore()
      await store.upsert(credential({ accessTokenExpiresAt: Date.now() - 1000 }))
      expect(await store.forceRefresh('u-1')).toBe(false)
      // 网络失败 ≠ 密钥无效：账号必须仍然是「可用」的，否则一次抖动就会让用户被迫重登。
      expect((await store.list())[0]?.usable).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  })

  it('does not even try to refresh a JWT that is already expired', async () => {
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      throw new Error('should not be called')
    }) as typeof fetch
    try {
      const expired = makeJwt({ userId: 'u-2', exp: Math.floor(Date.now() / 1000) - 60 })
      const store = tempStore()
      await store.upsert({ jwtToken: expired, accessTokenExpiresAt: Date.now() - 1000 })
      expect(await store.resolve('u-2')).toBeUndefined()
      expect(calls).toBe(0)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('pre-use refresh policy (freshness gate)', () => {
  const original = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = original
  })

  function stubRefresh(accessToken = 'fresh'): () => number {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({
        status: true,
        userInfo: { accessToken, refreshToken: 'r2', nationalCode: 'CN', realName: true },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return () => calls
  }

  it('refreshes when less than 10 minutes remain', async () => {
    const calls = stubRefresh('fresh-9')
    const store = tempStore()
    await store.upsert(credential({ accessToken: 'old', accessTokenExpiresAt: Date.now() + 9 * 60_000 }))
    const resolved = await store.resolve('u-1')
    expect(calls()).toBe(1)
    expect(resolved?.accessToken).toBe('fresh-9')
  })

  it('does not refresh when more than 10 minutes remain', async () => {
    const calls = stubRefresh()
    const store = tempStore()
    await store.upsert(credential({ accessToken: 'old', accessTokenExpiresAt: Date.now() + 11 * 60_000 }))
    const resolved = await store.resolve('u-1')
    expect(calls()).toBe(0)
    expect(resolved?.accessToken).toBe('old')
  })

  it('refreshes when the expiry is unknown', async () => {
    const calls = stubRefresh('fresh-unknown')
    const store = tempStore()
    const { accessTokenExpiresAt: _dropped, ...rest } = credential({ accessToken: 'old' })
    await store.upsert(rest)
    const resolved = await store.resolve('u-1')
    expect(calls()).toBe(1)
    expect(resolved?.accessToken).toBe('fresh-unknown')
  })

  it('keeps a still-valid token when the refresh fails transiently, without marking the account stale', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as typeof fetch
    const store = tempStore()
    await store.upsert(credential({ accessToken: 'still-good', accessTokenExpiresAt: Date.now() + 5 * 60_000 }))
    const resolved = await store.resolve('u-1')
    // 还剩 5 分钟：刷新失败也先用旧令牌，让上游去判定。
    expect(resolved?.accessToken).toBe('still-good')
    expect((await store.list())[0]?.usable).toBe(true)
  })

  it('gives up only when the token has really expired and the refresh failed', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as typeof fetch
    const store = tempStore()
    await store.upsert(credential({ accessToken: 'dead', accessTokenExpiresAt: Date.now() - 60_000 }))
    expect(await store.resolve('u-1')).toBeUndefined()
    // 网络失败不等于凭证失效：不能把账号标成「需重新登录」。
    expect((await store.list())[0]?.usable).toBe(true)
  })

  it('honours DEVECO_REFRESH_SKEW_MINUTES', async () => {
    process.env.DEVECO_REFRESH_SKEW_MINUTES = '20'
    try {
      const calls = stubRefresh('fresh-15')
      const store = tempStore()
      // 剩 15 分钟：默认 10 分钟不刷新，但提前量改成 20 分钟后应当刷新。
      await store.upsert(credential({ accessToken: 'old', accessTokenExpiresAt: Date.now() + 15 * 60_000 }))
      const resolved = await store.resolve('u-1')
      expect(calls()).toBe(1)
      expect(resolved?.accessToken).toBe('fresh-15')
    } finally {
      delete process.env.DEVECO_REFRESH_SKEW_MINUTES
    }
  })
  it('skips accounts with an in-flight request when sweeping, so a background refresh cannot rotate the token under a live stream', async () => {
    const original = globalThis.fetch
    const refreshedFor: string[] = []
    globalThis.fetch = (async (_input: unknown, init?: { headers?: Record<string, string> }) => {
      // 用 jwtToken 头区分是哪个账号在续期。
      const jwt = init?.headers?.jwtToken ?? ''
      refreshedFor.push(jwt === OTHER_TOKEN ? 'b' : 'a')
      return new Response(JSON.stringify({
        status: true,
        userInfo: { accessToken: 'fresh', refreshToken: 'r', nationalCode: 'CN', realName: true },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const store = tempStore()
      await store.upsert(credential({ accessTokenExpiresAt: Date.now() - 1000 }))
      await store.upsert({ jwtToken: OTHER_TOKEN, accessToken: 'old-b', accessTokenExpiresAt: Date.now() - 1000 })
      const outcome = await store.keepAlive({ skip: id => id === 'u-1' })
      // 只检查/续期了没被跳过的那一个。
      expect(outcome.checked).toBe(1)
      expect(refreshedFor).toEqual(['b'])
      expect((await store.credential('u-1'))?.accessToken).toBe('access')
      expect((await store.credential('u-2'))?.accessToken).toBe('fresh')
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('adaptive TTL learning', () => {
  const original = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = original
  })

  function stubRefresh(accessToken = 'fresh'): () => number {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({
        status: true,
        userInfo: { accessToken, refreshToken: 'r', nationalCode: 'CN', realName: true },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return () => calls
  }

  it('records a lifetime sample from a 401 and starts learning', async () => {
    const store = tempStore()
    // 令牌签发于 20 分钟前，现在被上游拒绝 → 样本 20 分钟。
    await store.upsert(credential({
      accessToken: 'old',
      accessTokenIssuedAt: Date.now() - 20 * 60_000,
      accessTokenExpiresAt: Date.now() + 10 * 60_000,
    }))
    await store.noteTokenExpired('u-1')
    const summary = (await store.list())[0]
    expect(summary?.ttlSamples).toBe(1)
    // 一个样本还不够，先沿用默认值。
    expect(summary?.ttlSource).toBe('default')

    await store.noteTokenExpired('u-1')
    await store.noteTokenExpired('u-1')
    const learned = (await store.list())[0]
    expect(learned?.ttlSource).toBe('learned')
    expect(learned?.ttlMs).toBeGreaterThanOrEqual(20 * 60_000 - 1000)
    expect(learned?.ttlMs).toBeLessThanOrEqual(20 * 60_000 + 1000)
  })

  it('persists learned samples across reload', async () => {
    const store = tempStore()
    await store.upsert(credential({
      accessTokenIssuedAt: Date.now() - 18 * 60_000,
      accessTokenExpiresAt: Date.now() + 12 * 60_000,
    }))
    await store.noteTokenExpired('u-1')
    await store.noteTokenExpired('u-1')
    const reopened = new DevecoAccountStore(store.documentPath)
    const summary = (await reopened.list())[0]
    expect(summary?.ttlSamples).toBe(2)
    expect(summary?.ttlSource).toBe('learned')
  })

  it('ignores a 401 for a token with no issue time (unknown age)', async () => {
    const store = tempStore()
    const { accessTokenIssuedAt: _dropped, ...rest } = credential()
    await store.upsert(rest)
    await store.noteTokenExpired('u-1')
    expect((await store.list())[0]?.ttlSamples).toBe(0)
  })

  it('does not refresh more often than the minimum interval', async () => {
    const calls = stubRefresh('fresh')
    const store = tempStore()
    await store.upsert(credential({ accessTokenExpiresAt: Date.now() - 1000 }))
    const first = await store.resolve('u-1')
    expect(first?.accessToken).toBe('fresh')
    expect(calls()).toBe(1)

    // 立刻把令牌再标成「已过期」，第二次取号不应再次打上游（最小刷新间隔 60s）。
    await store.upsert(credential({ accessToken: 'fresh', accessTokenExpiresAt: Date.now() - 1000 }))
    await store.resolve('u-1')
    expect(calls()).toBe(1)
  })

  it('learns a longer lifetime when the upstream accepts an old token', async () => {
    const store = tempStore()
    // 签发于 45 分钟前、上游照样接受 → 下界样本，TTL 应抬到默认 30 分钟之上。
    await store.upsert(credential({
      accessToken: 'still-good',
      accessTokenIssuedAt: Date.now() - 45 * 60_000,
      accessTokenExpiresAt: Date.now() - 60_000,
    }))
    await store.noteTokenWorked('u-1')
    const summary = (await store.list())[0]
    expect(summary?.ttlSource).toBe('extended')
    expect(summary?.ttlMs).toBeGreaterThan(30 * 60_000)
  })
})

describe('verifyJwtToken', () => {
  it('reports false on 401 and true on status:true', async () => {
    const original = globalThis.fetch
    try {
      globalThis.fetch = (async () => new Response('', { status: 401 })) as typeof fetch
      expect(await verifyJwtToken(TOKEN)).toBe(false)
      globalThis.fetch = (async () => new Response(JSON.stringify({ status: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
      expect(await verifyJwtToken(TOKEN)).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  })

  it('reports undefined when the network fails', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('offline')
    }) as typeof fetch
    try {
      expect(await verifyJwtToken(TOKEN)).toBeUndefined()
    } finally {
      globalThis.fetch = original
    }
  })
})
