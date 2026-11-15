import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, DEVECO_PROVIDER, DEVECO_SETTINGS_NS, inject, name } from '../src/index.ts'

/**
 * 宿主侧集成测试：用一个假的 cordis Context 把 `apply()` 跑起来。
 *
 * 它验证的是「装配」而不是上游行为：路由有没有全部挂上、provider 有没有真的注册、
 * 状态接口在没有任何账号时是否给出可用的空状态、以及 loopback 门禁是否生效。
 */

interface RegisteredRoute {
  kind: string
  path: string
  handler: (req: FakeRequest, res: FakeResponse) => Promise<void>
}

interface FakeRequest {
  method: string
  url: string
  headers: Record<string, string | undefined>
}

interface FakeResponse {
  status?: number
  body?: string
  writeHead: (status: number, headers?: Record<string, unknown>) => void
  end: (payload?: string) => void
  on: () => void
  off: () => void
}

function fakeRes(): FakeResponse {
  return {
    writeHead(status) {
      this.status = status
    },
    end(payload) {
      this.body = payload
    },
    on() {},
    off() {},
  }
}

function fakeReq(overrides: Partial<FakeRequest> = {}): FakeRequest {
  return {
    method: 'GET',
    url: '/api/deveco/status',
    headers: { host: '127.0.0.1:58852' },
    ...overrides,
  }
}

function fakeContext(): {
  ctx: Record<string, unknown>
  routes: RegisteredRoute[]
  adapters: string[][]
  directory: unknown[]
  dispose: () => void
} {
  const routes: RegisteredRoute[] = []
  const adapters: string[][] = []
  const directory: unknown[] = []
  const disposers: (() => void)[] = []
  const noop = (): void => {}
  const logger = { debug: noop, info: noop, warn: noop, error: noop }
  const handle = (): void => {}
  const ctx = {
    logger,
    get: () => undefined,
    // 真实的 cordis 子上下文与父上下文共享全部服务；这里也把同一个对象传下去。
    inject: (names: readonly string[], callback: (sub: unknown) => void) => {
      if (!names.includes('webServer')) return
      callback(ctx)
    },
    webServer: {
      register: (spec: RegisteredRoute) => {
        routes.push(spec)
        return () => {}
      },
    },
    effect: (factory: () => (() => void) | void) => {
      const result = factory()
      if (typeof result === 'function') disposers.push(result)
    },
    llm: {
      registerAdapter: (providers: string[]) => {
        adapters.push(providers)
        return Object.assign(handle, { replace: handle })
      },
      registerConfigurableProviders: (entries: unknown[]) => {
        directory.push(...entries)
        return Object.assign(handle, { replace: handle })
      },
    },
  }
  return {
    ctx,
    routes,
    adapters,
    directory,
    dispose: () => {
      for (const disposer of disposers) {
        try {
          disposer()
        } catch {
          // 拆解失败不影响断言。
        }
      }
    },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

const dirs: string[] = []

afterEach(() => {
  delete process.env.DSH_HOME
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-deveco-apply-'))
  dirs.push(dir)
  process.env.DSH_HOME = dir
  return dir
}

describe('plugin identity', () => {
  it('declares a stable name and a single hard dependency', () => {
    expect(name).toBe('llm-deveco')
    expect(inject).toEqual(['llm'])
    expect(DEVECO_PROVIDER).toBe('deveco')
    expect(String(DEVECO_SETTINGS_NS)).toBe('deveco')
  })
})

describe('apply()', () => {
  it('mounts every route under /api/deveco/', async () => {
    tempHome()
    const { ctx, routes, dispose } = fakeContext()
    apply(ctx as never, {})
    try {
      await waitFor(() => routes.length > 0)
      const paths = routes.map(route => route.path).sort()
      expect(paths).toEqual([
        '/api/deveco/accounts',
        '/api/deveco/checkin',
        '/api/deveco/dock',
        '/api/deveco/doctor',
        '/api/deveco/enabled-models',
        '/api/deveco/login',
        '/api/deveco/login/status',
        '/api/deveco/models',
        '/api/deveco/quota',
        '/api/deveco/refresh-models',
        '/api/deveco/status',
        '/api/deveco/token',
      ])
      // 每个席位只注册一次：宿主对同一个 (kind, path) 只留一个注册位。
      expect(new Set(paths).size).toBe(paths.length)
      expect(routes.every(route => route.kind === 'exact')).toBe(true)
    } finally {
      dispose()
    }
  })

  it('registers the deveco provider and its directory entry', async () => {
    tempHome()
    const { ctx, adapters, directory, dispose } = fakeContext()
    apply(ctx as never, {})
    try {
      // 注册分两步（适配器 + 目录条目），等都完成再断言。
      await waitFor(() => adapters.length > 0 && directory.length > 0)
      expect(adapters).toEqual([['deveco']])
      expect(directory).toHaveLength(1)
      expect(directory[0]).toMatchObject({ provider: 'deveco', displayName: 'DevEco' })
    } finally {
      dispose()
    }
  })

  it('serves a usable empty status document', async () => {
    tempHome()
    const { ctx, routes, directory, dispose } = fakeContext()
    apply(ctx as never, {})
    try {
      // 路由在 apply() 里同步挂上，provider 注册在 shim 就绪之后 —— 等后者完成。
      await waitFor(() => routes.some(entry => entry.path === '/api/deveco/status') && directory.length > 0)
      const route = routes.find(entry => entry.path === '/api/deveco/status')
      const res = fakeRes()
      await route?.handler(fakeReq(), res)
      expect(res.status).toBe(200)
      const parsed = JSON.parse(res.body ?? '{}') as { status: Record<string, unknown> }
      expect(parsed.status.provider).toBe('deveco')
      expect(parsed.status.signedIn).toBe(false)
      expect(parsed.status.accounts).toEqual([])
      expect(parsed.status.models).toEqual([])
      expect(parsed.status.dock).toMatchObject({ dock: true, sidebar: false, settingsEntry: true, autoClaim: false })
      const shim = parsed.status.shim as { port: number }
      expect(shim.port).toBeGreaterThan(0)
      expect(parsed.status.providerRegistered).toBe(true)
    } finally {
      dispose()
    }
  })

  it('rejects a non-loopback Host header', async () => {
    tempHome()
    const { ctx, routes, dispose } = fakeContext()
    apply(ctx as never, {})
    try {
      await waitFor(() => routes.some(route => route.path === '/api/deveco/status'))
      const route = routes.find(entry => entry.path === '/api/deveco/status')
      const res = fakeRes()
      await route?.handler(fakeReq({ headers: { host: 'evil.example.com' } }), res)
      expect(res.status).toBe(403)
    } finally {
      dispose()
    }
  })

  it('rejects a cross-site Origin header', async () => {
    tempHome()
    const { ctx, routes, dispose } = fakeContext()
    apply(ctx as never, {})
    try {
      await waitFor(() => routes.some(route => route.path === '/api/deveco/dock'))
      const route = routes.find(entry => entry.path === '/api/deveco/dock')
      const res = fakeRes()
      await route?.handler(fakeReq({
        method: 'GET',
        url: '/api/deveco/dock',
        headers: { host: '127.0.0.1:58852', origin: 'https://evil.example.com' },
      }), res)
      expect(res.status).toBe(403)
    } finally {
      dispose()
    }
  })

  it('requires JSON for a mutating request', async () => {
    tempHome()
    const { ctx, routes, dispose } = fakeContext()
    apply(ctx as never, {})
    try {
      await waitFor(() => routes.some(route => route.path === '/api/deveco/dock'))
      const route = routes.find(entry => entry.path === '/api/deveco/dock')
      const res = fakeRes()
      await route?.handler(fakeReq({
        method: 'POST',
        url: '/api/deveco/dock',
        headers: { host: '127.0.0.1:58852', 'content-type': 'text/plain' },
      }), res)
      expect(res.status).toBe(415)
    } finally {
      dispose()
    }
  })

  it('never returns token material in the status document', async () => {
    tempHome()
    const { ctx, routes, dispose } = fakeContext()
    apply(ctx as never, {})
    try {
      await waitFor(() => routes.some(route => route.path === '/api/deveco/status'))
      const route = routes.find(entry => entry.path === '/api/deveco/status')
      const res = fakeRes()
      await route?.handler(fakeReq(), res)
      const body = res.body ?? ''
      expect(body).not.toContain('jwtToken')
      expect(body).not.toContain('accessToken"')
      expect(body).not.toContain('refreshToken')
    } finally {
      dispose()
    }
  })
})
