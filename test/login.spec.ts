import { afterEach, describe, expect, it } from 'vitest'
import { startLogin, buildLoginUrl, newClientSecret, assertOfficialAuthUrl, browserOpenCommand, exchangeTempToken } from '../src/login.ts'

/** 造一个形状正确的 JWT（本插件从不验签）。 */
function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256' })}.${encode(payload)}.signature`
}

const LIVE_JWT = makeJwt({
  userId: 'u-9',
  userName: 'tester',
  exp: Math.floor(Date.now() / 1000) + 3600,
  nationalCode: 'CN',
})

const originalFetch = globalThis.fetch
/** 真实的 fetch：投递回调必须绕过被替换掉的那个桩。 */
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** 把 token 接口打桩：temptoken → 纯文本 JWT；jwToken/check → access token。 */
function stubTokenEndpoints(): string[] {
  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/temptoken/check')) {
      return new Response(LIVE_JWT, { status: 200, headers: { 'content-type': 'text/plain' } })
    }
    if (url.includes('/jwToken/check')) {
      return new Response(JSON.stringify({
        status: true,
        userInfo: { accessToken: 'access-1', refreshToken: 'refresh-1', nationalCode: 'CN', realName: true },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch
  return calls
}

/** 往回调端口投递一次授权结果。 */
async function deliverCallback(port: number, params: Record<string, string>): Promise<Response> {
  const query = new URLSearchParams(params).toString()
  return await realFetch(`http://127.0.0.1:${port}/callback?${query}`, { redirect: 'manual' })
}

describe('login helpers', () => {
  it('builds the documented sign-in URL', () => {
    const url = buildLoginUrl(10101, 'abc123')
    expect(url).toBe('https://cn.devecostudio.huawei.com/console/DevEcoIDE/apply?port=10101&appid=1008&code=abc123')
  })

  it('generates a 32-hex client secret', () => {
    expect(newClientSecret()).toMatch(/^[0-9a-f]{32}$/)
  })

  it('refuses to open a non-official sign-in URL', () => {
    expect(() => assertOfficialAuthUrl('https://evil.example.com/console/DevEcoIDE/apply')).toThrow(/unexpected/)
    expect(() => assertOfficialAuthUrl('http://cn.devecostudio.huawei.com/x')).toThrow(/unexpected/)
    expect(() => assertOfficialAuthUrl(buildLoginUrl(1, 'a'))).not.toThrow()
  })

  it('quotes the URL on Windows so the & characters survive', () => {
    const command = browserOpenCommand('win32', 'https://x/y?a=1&b=2')
    expect(command.shell).toBe(true)
    expect(command.command).toContain('"https://x/y?a=1&b=2"')
    expect(browserOpenCommand('linux', 'https://x').command).toBe('xdg-open')
  })

  it('strips a glued "&…" tail from the tempToken', async () => {
    stubTokenEndpoints()
    await expect(exchangeTempToken('abc&site=CN')).resolves.toBe(LIVE_JWT)
  })
})

describe('startLogin', () => {
  it('binds a callback port and returns a URL carrying it', async () => {
    const started = await startLogin({ openBrowser: false })
    try {
      expect(started.port).toBeGreaterThan(0)
      expect(started.url).toContain(`port=${started.port}`)
      expect(started.url).toContain('appid=1008')
      expect(started.url).toMatch(/code=[0-9a-f]{32}/)
    } finally {
      started.cancel()
    }
  })

  it('rejects a callback whose code does not match', async () => {
    const started = await startLogin({ openBrowser: false })
    stubTokenEndpoints()
    try {
      const response = await deliverCallback(started.port, { code: 'wrong', tempToken: 't', siteId: '1' })
      expect(response.status).toBe(400)
      // 收到错 code 之后服务仍然在等真正的回调。
      const good = await deliverCallback(started.port, {
        code: /code=([0-9a-f]{32})/.exec(started.url)?.[1] ?? '',
        tempToken: 'temp',
        siteId: '1',
      })
      expect(good.status).toBe(302)
      const outcome = await started.result
      expect(outcome.state).toBe('done')
    } finally {
      started.cancel()
    }
  })

  it('completes the whole flow into a usable credential', async () => {
    const started = await startLogin({ openBrowser: false })
    const calls = stubTokenEndpoints()
    try {
      const code = /code=([0-9a-f]{32})/.exec(started.url)?.[1] ?? ''
      await deliverCallback(started.port, { code, tempToken: 'temp', siteId: '1' })
      const outcome = await started.result
      expect(outcome.state).toBe('done')
      if (outcome.state !== 'done') return
      expect(outcome.credential.jwtToken).toBe(LIVE_JWT)
      expect(outcome.credential.accessToken).toBe('access-1')
      expect(outcome.credential.userId).toBe('u-9')
      expect(outcome.credential.userName).toBe('tester')
      expect(outcome.credential.isRealName).toBe(true)
      expect(outcome.credential.accessTokenExpiresAt).toBeGreaterThan(Date.now())
      expect(calls.some(url => url.includes('site=CN'))).toBe(true)
      expect(calls.some(url => url.includes('/jwToken/check'))).toBe(true)
    } finally {
      started.cancel()
    }
  })

  it('refuses a non-China site id', async () => {
    const started = await startLogin({ openBrowser: false })
    stubTokenEndpoints()
    try {
      const code = /code=([0-9a-f]{32})/.exec(started.url)?.[1] ?? ''
      await deliverCallback(started.port, { code, tempToken: 'temp', siteId: '2' })
      const outcome = await started.result
      expect(outcome.state).toBe('error')
      if (outcome.state === 'error') expect(outcome.kind).toBe('region')
    } finally {
      started.cancel()
    }
  })

  it('treats quit=true as a cancellation', async () => {
    const started = await startLogin({ openBrowser: false })
    try {
      const code = /code=([0-9a-f]{32})/.exec(started.url)?.[1] ?? ''
      await deliverCallback(started.port, { code, quit: 'true' })
      const outcome = await started.result
      expect(outcome.state).toBe('error')
      if (outcome.state === 'error') expect(outcome.kind).toBe('cancelled')
    } finally {
      started.cancel()
    }
  })

  it('reports a cancellation when the caller cancels', async () => {
    const started = await startLogin({ openBrowser: false })
    started.cancel()
    const outcome = await started.result
    expect(outcome.state).toBe('error')
    if (outcome.state === 'error') expect(outcome.kind).toBe('cancelled')
  })
})
