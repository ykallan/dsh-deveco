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
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
    try {
      const store = tempStore()
      await store.upsert(credential({ accessTokenExpiresAt: Date.now() - 1000 }))
      expect(await store.forceRefresh('u-1')).toBe(false)
      expect((await store.list())[0]?.usable).toBe(false)
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
