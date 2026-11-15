import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDevecoShim } from '../src/shim.ts'
import { DevecoAccountStore, type DevecoCredential } from '../src/auth.ts'
import { DevecoAccountPool } from '../src/account-pool.ts'
import { DevecoCatalog } from '../src/catalog.ts'
import { DevecoUsageTracker } from '../src/usage.ts'
import { DevecoQuotaTracker } from '../src/quota.ts'

/**
 * shim 的集成测试：真的起一个回环服务，用打桩的 fetch 假装上游。
 *
 * 重点覆盖「推理中途/续请求时上游 401」这条路径：必须**先续期再重试同一个账号**，
 * 而不是直接把账号判死让用户看到「密钥无效」。
 */

const realFetch = globalThis.fetch
const dirs: string[] = []

afterEach(() => {
  globalThis.fetch = realFetch
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256' })}.${encode(payload)}.signature`
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-deveco-shim-'))
  dirs.push(dir)
  return dir
}

interface Harness {
  baseUrl: string
  token: string
  store: DevecoAccountStore
  pool: DevecoAccountPool
  close: () => Promise<void>
}

async function buildShim(credential: DevecoCredential): Promise<Harness> {
  const dir = tempDir()
  const store = new DevecoAccountStore(join(dir, 'accounts.json'))
  await store.upsert(credential)
  const ids = await store.ids()
  const pool = new DevecoAccountPool(ids)
  const catalog = new DevecoCatalog()
  catalog.set([{
    id: 'GLM-5.1-DevEco',
    wireId: 'GLM-5.1',
    name: 'GLM-5.1-DevEco',
    contextWindow: 170_000,
    contextWindowKnown: true,
    maxTokens: 32_000,
    supportsImages: false,
    reasoning: true,
  }])
  const shim = createDevecoShim({
    store,
    pool,
    catalog,
    usage: new DevecoUsageTracker({ path: join(dir, 'usage.json') }),
    quota: new DevecoQuotaTracker(),
  })
  await shim.ready
  return { baseUrl: shim.baseUrl(), token: shim.token(), store, pool, close: () => shim.close() }
}

function credential(overrides: Partial<DevecoCredential> = {}): DevecoCredential {
  return {
    jwtToken: makeJwt({ userId: 'u-1', exp: Math.floor(Date.now() / 1000) + 86_400 }),
    accessToken: 'stale-token',
    accessTokenExpiresAt: Date.now() + 20 * 60 * 1000,
    ...overrides,
  }
}

/** 打到 shim 自己（回环）的请求要放行给真实 fetch，只拦截发往上游的那些。 */
function isLoopback(url: string): boolean {
  return url.startsWith('http://127.0.0.1:')
}

async function chat(harness: Harness, body: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const response = await realFetch(`${harness.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${harness.token}` },
    body: JSON.stringify(body),
  })
  return { status: response.status, text: await response.text() }
}

const SSE_BODY = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n'

describe('shim 401 handling', () => {
  process.env.DEVECO_AUTH_RETRY_DELAY_MS = '5'   // 测试里不必真的等 5 秒

  it('refreshes once and retries the same account instead of killing it', async () => {
    const harness = await buildShim(credential())
    const calls: string[] = []
    let chatAttempts = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (isLoopback(url)) return realFetch(input as never)
      calls.push(url)
      if (url.includes('/jwToken/check')) {
        return new Response(JSON.stringify({
          status: true,
          userInfo: { accessToken: 'fresh-token', refreshToken: 'r2', nationalCode: 'CN', realName: true },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/chat/completions')) {
        chatAttempts += 1
        if (chatAttempts === 1) {
          return new Response(JSON.stringify({ error: { message: 'invalid accessToken' } }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(SSE_BODY, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected upstream call: ${url}`)
    }) as typeof fetch

    try {
      const result = await chat(harness, {
        model: 'GLM-5.1-DevEco',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })
      expect(result.status).toBe(200)
      expect(result.text).toContain('hello')
      expect(chatAttempts).toBe(2)                       // 401 后用新令牌重试了一次
      expect(calls.some(url => url.includes('/jwToken/check'))).toBe(true)
      expect((await harness.store.credential('u-1'))?.accessToken).toBe('fresh-token')
      // 账号没有被判死。
      expect((await harness.store.list())[0]?.usable).toBe(true)
      expect(harness.pool.get('u-1')?.disabled).toBe(false)
    } finally {
      await harness.close()
    }
  })

  it('gives up after five 401 retries and stops the request', async () => {
    const harness = await buildShim(credential())
    let chatAttempts = 0
    let refreshes = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (isLoopback(url)) return realFetch(input as never)
      if (url.includes('/jwToken/check')) {
        refreshes += 1
        // 每次都能刷出新令牌，但上游就是不认 —— 模拟真失效。
        return new Response(JSON.stringify({
          status: true,
          userInfo: { accessToken: `fresh-${refreshes}`, refreshToken: 'r', nationalCode: 'CN', realName: true },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/chat/completions')) {
        chatAttempts += 1
        return new Response(JSON.stringify({ error: { message: 'invalid accessToken' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected upstream call: ${url}`)
    }) as typeof fetch

    try {
      const result = await chat(harness, {
        model: 'GLM-5.1-DevEco',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })
      // 1 次首发 + 5 次重试；每次都先刷新令牌。
      expect(chatAttempts).toBe(6)
      expect(refreshes).toBe(5)
      expect(result.status).toBe(401)
      expect(result.text).toMatch(/rejected the token 5 times|sign in again/i)
      // 5 次都失败 → 这个号确实要重新登录。
      expect((await harness.store.list())[0]?.usable).toBe(false)
    } finally {
      await harness.close()
    }
  })

  it('records a TTL sample when upstream 401s a token it issued 20 minutes ago', async () => {
    // 令牌签发于 20 分钟前 → 这次 401 就是一个「20 分钟寿命」的上界样本。
    const harness = await buildShim(credential({
      accessToken: 'aging-token',
      accessTokenIssuedAt: Date.now() - 20 * 60_000,
      // 本地认为还剩 25 分钟（> 提前量），所以这次请求不会先刷新 —— 401 的样本年龄才是真的 20 分钟。
      accessTokenExpiresAt: Date.now() + 25 * 60_000,
    }))
    let chatAttempts = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (isLoopback(url)) return realFetch(input as never)
      if (url.includes('/jwToken/check')) {
        return new Response(JSON.stringify({
          status: true,
          userInfo: { accessToken: 'fresh-token', refreshToken: 'r', nationalCode: 'CN', realName: true },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/chat/completions')) {
        chatAttempts += 1
        if (chatAttempts === 1) {
          return new Response(JSON.stringify({ error: { message: 'invalid accessToken' } }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(SSE_BODY, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected upstream call: ${url}`)
    }) as typeof fetch

    try {
      const result = await chat(harness, {
        model: 'GLM-5.1-DevEco',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })
      expect(result.status).toBe(200)
      const summary = (await harness.store.list())[0]
      expect(summary?.ttlSamples).toBe(1)
      // 一个样本还不够覆盖默认值，但记录本身必须落地。
      expect(summary?.ttlSource).toBe('default')
    } finally {
      await harness.close()
    }
  })

  it('marks the account only when the refresh is also rejected', async () => {
    const harness = await buildShim(credential())
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (isLoopback(url)) return realFetch(input as never)
      if (url.includes('/jwToken/check')) {
        // 续期也被拒：这才是真的需要重新登录。
        return new Response(JSON.stringify({ status: false, errorCode: 4016, errorMsg: 'invalid accessToken.' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/chat/completions')) {
        return new Response(JSON.stringify({ error: { message: 'invalid accessToken' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected upstream call: ${url}`)
    }) as typeof fetch

    try {
      const result = await chat(harness, {
        model: 'GLM-5.1-DevEco',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })
      expect(result.status).toBeGreaterThanOrEqual(400)
      expect(result.text).toMatch(/sign in|invalid|auth/i)
      expect((await harness.store.list())[0]?.usable).toBe(false)
    } finally {
      await harness.close()
    }
  })
})
