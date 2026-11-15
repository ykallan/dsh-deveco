/**
 * DevEco（华为 CodeGenie MaaS）接入 DeepSeek Harness。
 *
 * 插件注册一个 `deveco` provider，请求经本机回环 shim 转发到 DevEco 的模型 API。
 * 登录是华为账号的浏览器授权（本机回环回调），一次登录换来的 `jwtToken` 由插件自己
 * 续期，`accessToken` 过期即静默刷新。
 *
 * 多账号：`.deveco-accounts.json` 存凭证，账号池负责轮转 —— 上游每个账号只同时放一个
 * 生成，多一个号就多一份并发。模型目录来自上游 `codeGenie/modelConfig`，启动时与每小时
 * 各拉一次，失败保留上一次的结果。
 *
 * 签到：DevEco 没有积分/领取接口（`docs/PROTOCOL.md` 第 6 节），所以这里的签到是
 * **每天一次的真实体检**：逐个账号拉一次模型目录，证明凭证今天还活着，并把结果留档、
 * 算连续天数。发现问题（凭证被拒）会直接把账号标成「需要重新登录」。
 *
 * @module dsh-deveco
 */

import { appendFileSync, statSync, writeFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  DevecoAccountStore,
  devecoAccountsPath,
  devecoCheckinPath,
  devecoRefreshLogPath,
  devecoUsagePath,
} from './auth.ts'
import { DevecoAccountPool } from './account-pool.ts'
import { DevecoCatalog } from './catalog.ts'
import { refreshCatalog } from './discovery.ts'
import { DevecoUsageTracker } from './usage.ts'
import { DevecoCheckinLedger, runCheckin as runCheckinNow, type CheckinOutcome } from './checkin.ts'
import { DevecoQuotaTracker, looksLikeQuotaExhausted, type QuotaRefreshResult } from './quota.ts'
import { fetchModelConfig } from './discovery.ts'
import { createDevecoShim, type ShimStats } from './shim.ts'
import { createDevecoAdapter, DEVECO_PROVIDER } from './adapter.ts'
import { installSettingsSectionCompat, resolveSettingsNamespaceCompat } from './settings-compat.ts'
import { registerDevecoStatusRoutes, type DevecoDockFlags } from './web-status.ts'
import { startLogin } from './login.ts'
import { DEVECO_VERSION } from './version.ts'

export { DEVECO_PROVIDER, createDevecoAdapter, type DevecoAdapter } from './adapter.ts'
export { createDevecoShim, type DevecoShim, type ShimStats } from './shim.ts'
export {
  FALLBACK_PARAMS,
  HIDDEN_MODELS,
  DevecoCatalog,
  filterEnabledModels,
  mergeModelLists,
  type DevecoModelInfo,
} from './catalog.ts'
export {
  DevecoAccountStore,
  devecoAccountsPath,
  devecoCheckinPath,
  devecoUsagePath,
  parseJwtPayload,
  type DevecoAccountSummary,
  type DevecoCredential,
} from './auth.ts'
export { DevecoAccountPool, type AccountRuntime } from './account-pool.ts'
export { DevecoUsageTracker, type UsageSnapshot } from './usage.ts'
export { DevecoCheckinLedger, runCheckin, type CheckinOutcome, type CheckinSnapshot } from './checkin.ts'
export { discoverModels, refreshCatalog, type DiscoveryOutcome } from './discovery.ts'
export { DevecoQueueGate } from './queue.ts'
export { startLogin, type LoginOutcome, type StartedLogin } from './login.ts'
export { DEVECO_VERSION } from './version.ts'

/** 稳定的 Cordis 插件名（与 `cordis.patch.yml` 的 id 对齐）。 */
export const name = 'llm-deveco'

/** provider 注册前必须先有 `llm` 服务。 */
export const inject = ['llm']

/** 拥有配置卡片的 settings 命名空间。 */
export const DEVECO_SETTINGS_NS = 'deveco' as SettingsNamespace

/** 插件配置。 */
export interface Config {
  /** 模型选择器里允许出现的模型 id（空 = 全部）。 */
  enabledModels?: string[]
  /** 对话输入框下方的 `Provider DevEco · 模型 · 今日用量` 那一行。 */
  showDock?: boolean
  /** 侧边栏图标列里的 DevEco 入口。缺省关：图标列是全宿主共用资源。 */
  showSidebarPanel?: boolean
  /** 设置左侧导航里的 DevEco 入口。缺省开。 */
  showSettingsEntry?: boolean
  /** 每天自动签到一次（逐个账号体检并留档）。缺省关。 */
  autoCheckin?: boolean
  /** 同时打到上游的生成数（上游每个账号只放 1 个）。 */
  maxConcurrent?: number
  /** 本地排队上限，超出直接 429。 */
  maxQueue?: number
}

interface VolatileValue<T> {
  get: () => T
}

function unwrapVolatileValue<T>(value: unknown): T {
  if (typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function') {
    return (value as VolatileValue<T>).get()
  }
  return value as T
}

function unwrapConfig(value: unknown): Config {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value)) out[key] = unwrapVolatileValue(field)
  return out as Config
}

export const Config: z<Config> = z.object({
  enabledModels: z.array(z.string())
    .description('Model ids offered in the model pickers (empty means every model)')
    .volatile(),
  showDock: z.boolean().default(true)
    .description('Show the DevEco line (provider, model, today usage) under the chat input box')
    .volatile(),
  showSidebarPanel: z.boolean().default(false)
    .description('Show a DevEco icon in the DSH sidebar icon column')
    .volatile(),
  showSettingsEntry: z.boolean().default(true)
    .description('Show a DevEco entry in the left navigation of DSH Settings')
    .volatile(),
  autoCheckin: z.boolean().default(false)
    .description('Run the daily per-account check-in automatically (probes each account once a day and keeps the streak)')
    .volatile(),
  maxConcurrent: z.natural().default(1)
    .description('Concurrent upstream generations (DevEco serves one per account)')
    .volatile(),
  maxQueue: z.natural().default(3)
    .description('Local queue depth before requests are rejected with 429')
    .volatile(),
}) as unknown as z<Config>

/** 签到说明（卡片直接展示，别让用户以为这是「领积分」）。 */
export const CHECKIN_NOTE = 'DevEco has no points or daily-reward endpoint, so this check-in is a real daily health probe: '
  + 'it fetches the model catalog for each account once a day, proves the credential still works, '
  + 'records the result and keeps a streak. A rejected credential is marked "sign in again".'

function settingsCompatNamespace(ctx: Context): SettingsNamespace {
  return resolveSettingsNamespaceCompat(ctx, ctx.get('settings'), DEVECO_SETTINGS_NS)
}

/** 登录会话（URL → 结果）。卡片的轮询只认这个表。 */
interface LoginSessionView {
  started: { url: string; port: number; result: Promise<unknown>; cancel: () => void }
  outcome?: { state: 'done'; accountId: string } | { state: 'error'; kind: string; message: string }
}

export function apply(ctx: Context, rawConfig: Config): void {
  const config = unwrapConfig(rawConfig)

  /**
   * 续期失败日志。
   *
   * 宿主对插件的 info/debug 没有出口，warn 会变成系统通知 —— 一次网络抖动就弹一次窗口
   * 不行。所以失败原因写插件自己的文件，1MB 截断重来。
   */
  const appendRefreshLog = (message: string): void => {
    try {
      const path = devecoRefreshLogPath()
      try {
        if (statSync(path).size > 1_000_000) writeFileSync(path, '')
      } catch {
        // 文件还不存在：append 会创建它。
      }
      appendFileSync(path, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 })
    } catch {
      // 日志写不进去不能影响续期本身。
    }
  }

  const store = new DevecoAccountStore(devecoAccountsPath(), { log: appendRefreshLog })
  const pool = new DevecoAccountPool([], { maxConcurrent: config.maxConcurrent ?? 1 })
  const catalog = new DevecoCatalog()
  const usage = new DevecoUsageTracker({ path: devecoUsagePath() })
  const checkinLedger = new DevecoCheckinLedger({ path: devecoCheckinPath() })
  // 额度状态只活在内存里：上游没有余额接口，过期的「额度用尽」比「不知道」更误导。
  const quota = new DevecoQuotaTracker()

  let current = (): Config => config
  const dock = (): DevecoDockFlags => ({
    dock: current().showDock !== false,
    sidebar: current().showSidebarPanel === true,
    settingsEntry: current().showSettingsEntry !== false,
    autoClaim: current().autoCheckin === true,
  })

  const setDock = async (patch: Partial<DevecoDockFlags>): Promise<boolean> => {
    const settings = ctx.get('settings')
    if (settings === undefined) return false
    await settings.update(settingsCompatNamespace(ctx), {
      ...patch.dock === undefined ? {} : { showDock: patch.dock },
      ...patch.sidebar === undefined ? {} : { showSidebarPanel: patch.sidebar },
      ...patch.settingsEntry === undefined ? {} : { showSettingsEntry: patch.settingsEntry },
      ...patch.autoClaim === undefined ? {} : { autoCheckin: patch.autoClaim },
    })
    return true
  }

  const setEnabledModels = async (ids: readonly string[]): Promise<boolean> => {
    const settings = ctx.get('settings')
    if (settings === undefined) return false
    await settings.update(settingsCompatNamespace(ctx), { enabledModels: [...ids] })
    return true
  }

  /** 把池与账号文档对齐（新增/删除账号后调）。 */
  const syncPool = async (): Promise<void> => {
    const ids = await store.ids()
    pool.sync(ids)
    const summaries = await store.list()
    pool.setPaused(summaries.filter(entry => entry.paused).map(entry => entry.id))
    pool.setPreferred(summaries.filter(entry => entry.pinned).map(entry => entry.id))
  }

  /** 执行一次签到（卡片按钮与自动签到共用这一条路径）。 */
  const runCheckin = async (options: { accountId?: string; force?: boolean } = {}): Promise<CheckinOutcome> => {
    await syncPool()
    const outcome = await runCheckinNow(store, checkinLedger, {
      ...options.accountId === undefined ? {} : { accountId: options.accountId },
      force: options.force === true,
    })
    for (const result of outcome.results) if (result.ok) pool.revive(result.id)
    appendRefreshLog(`checkin day=${outcome.day} ok=${String(outcome.ok)} probed=${String(outcome.probed)}: ${outcome.message}`)
    return outcome
  }

  // 登录会话表：POST /login 建一条，GET /login/status?url= 读它。
  const loginSessions = new Map<string, LoginSessionView>()

  /**
   * 会话表兜底清理。
   *
   * 正常情况下每条会话被轮询到终态后自己删掉；这里只防「用户开了登录页又关掉」留下的
   * 悬挂条目无限堆积 —— 超过 20 条就丢最旧的。
   */
  const pruneLogins = (): void => {
    if (loginSessions.size <= 20) return
    for (const url of [...loginSessions.keys()].slice(0, loginSessions.size - 20)) {
      const session = loginSessions.get(url)
      session?.started.cancel()
      loginSessions.delete(url)
    }
  }

  const startLoginForCard = async (options: { accountId?: string }): Promise<{
    url: string
    port: number
    result: Promise<unknown>
    cancel: () => void
  }> => {
    const started = await startLogin({ openBrowser: true })
    const session: LoginSessionView = { started }
    loginSessions.set(started.url, session)
    void started.result.then(async outcome => {
      if (outcome.state === 'done') {
        const id = await store.upsert(outcome.credential)
        await syncPool()
        pool.revive(id)
        session.outcome = { state: 'done', accountId: id }
        appendRefreshLog(`login ok: account ${id}`)
        // 登录成功后立刻重拉目录：新账号可能带来新模型。
        void refreshCatalog(store, catalog).catch(() => {})
      } else {
        session.outcome = { state: 'error', kind: outcome.kind, message: outcome.message }
        appendRefreshLog(`login failed (${outcome.kind}): ${outcome.message}`)
      }
      void options
    })
    pruneLogins()
    return started
  }

  const pollLogin = (url: string): {
    state: 'pending' | 'done' | 'error'
    kind?: string
    message?: string
    accountId?: string
  } => {
    const session = loginSessions.get(url)
    if (session === undefined) return { state: 'pending' }
    if (session.outcome === undefined) return { state: 'pending' }
    const outcome = session.outcome
    loginSessions.delete(url)
    return outcome.state === 'done'
      ? { state: 'done', accountId: outcome.accountId }
      : { state: 'error', kind: outcome.kind, message: outcome.message }
  }

  /**
   * 「刷新额度」：重新探测每个账号现在还能不能用。
   *
   * **它不是查余额** —— 上游没有余额接口（`docs/PROTOCOL.md` 第 6 节）。它能做的就是
   * 拿一次轻量但需要鉴权的请求（`modelConfig`）去问上游「这个号现在还行吗」：
   * 成功 → 本窗口没被额度卡住；被拒且错误像是额度/限流 → 记成「额度用尽」。
   * 额度是否真的重置，只能靠时间和下一次请求来证明。
   */
  const refreshQuota = async (): Promise<QuotaRefreshResult> => {
    await syncPool()
    const ids = await store.dispatchIds()
    const accounts: QuotaRefreshResult['accounts'] = []
    for (const id of ids) {
      try {
        const resolved = await store.resolve(id)
        if (resolved === undefined) {
          accounts.push({ id, ok: false, models: 0, message: 'account needs sign-in', exhausted: false })
          continue
        }
        const probe = await fetchModelConfig(resolved.accessToken).then(
          fetched => ({ ok: true, models: fetched.models.length, message: undefined }),
          (error: unknown) => ({
            ok: false,
            models: 0,
            message: error instanceof Error ? error.message : String(error),
          }),
        )
        if (probe.ok) {
          quota.noteOk(id)
        } else if (probe.message !== undefined && looksLikeQuotaExhausted(0, probe.message)) {
          quota.noteExhausted(id, probe.message)
        }
        accounts.push({
          id,
          ok: probe.ok,
          models: probe.models,
          ...probe.message === undefined ? {} : { message: probe.message },
          exhausted: quota.state(id)?.exhausted === true,
        })
      } catch (error: unknown) {
        accounts.push({
          id,
          ok: false,
          models: 0,
          message: error instanceof Error ? error.message : String(error),
          exhausted: false,
        })
      }
    }
    const snapshot = quota.snapshot(ids)
    const ok = accounts.some(entry => entry.ok)
    const exhausted = accounts.filter(entry => entry.exhausted).length
    return {
      ok,
      probed: accounts.length,
      accounts,
      snapshot,
      message: ids.length === 0
        ? 'no account to probe'
        : ok
          ? (exhausted > 0
              ? `probed ${accounts.length} account(s); ${exhausted} still marked as out of quota until ${snapshot.window.label}`
              : `probed ${accounts.length} account(s); all usable, quota resets in ${snapshot.resetIn}`)
          : `probe failed: ${accounts.find(entry => !entry.ok)?.message ?? 'unknown'}`,
    }
  }

  /** 手动/自动刷新目录。 */
  const refreshModels = async (): Promise<{ models: number; refreshed: boolean }> => {
    await syncPool()
    const outcome = await refreshCatalog(store, catalog)
    return { models: catalog.current().length, refreshed: outcome.anySucceeded }
  }

  /** provider 是否真的挂上了 —— 卡片体检要能看到这一条（注册失败时它会是 false）。 */
  let providerRegistered = false

  const shim: ReturnType<typeof createDevecoShim> = createDevecoShim({
    store,
    pool,
    catalog,
    usage,
    quota,
    enabledModels: () => current().enabledModels,
    logger: ctx.logger,
  })

  let stopped = false

  // ---- 路由 ----------------------------------------------------------------
  ctx.inject(['webServer'], webCtx => {
    registerDevecoStatusRoutes(webCtx, {
      store,
      models: () => catalog.current(),
      enabledModels: () => current().enabledModels,
      setEnabledModels,
      pool: () => pool.list(),
      reviveAccount: id => pool.revive(id),
      usage: () => usage.snapshot(),
      checkin: () => checkinLedger.snapshot(storeIdsSnapshot()),
      runCheckin,
      quota: () => quota.snapshot(storeIdsSnapshot()),
      refreshQuota,
      dock,
      setDock,
      refreshModels,
      shimStats: (): ShimStats => shim.stats(),
      providerRegistered: () => providerRegistered,
      // 直接问宿主 LLM 层：这才是「聊天框里能不能选到」的数据来源。
      llmDiagnostics: async () => {
        try {
          const providers = ctx.llm.listProviders()
          const out: { id: string; name: string; models: number; error?: string }[] = []
          for (const provider of providers) {
            let models = 0
            let error: string | undefined
            try {
              models = (await ctx.llm.listModels(provider.id)).length
            } catch (caught: unknown) {
              error = caught instanceof Error ? caught.message : String(caught)
            }
            out.push({ id: provider.id, name: provider.name, models, ...error === undefined ? {} : { error } })
          }
          return { providers: out }
        } catch (caught: unknown) {
          return { providers: [], error: caught instanceof Error ? caught.message : String(caught) }
        }
      },
      catalogUpdatedAt: () => catalogUpdatedAt,
      lastDiscoveryError: () => lastDiscoveryError,
      startLogin: startLoginForCard,
      pollLogin,
      version: DEVECO_VERSION,
      checkinNote: CHECKIN_NOTE,
    })
  })

  /** 同步快照：`checkin()` 是同步调用，而账号 id 列表是异步读的 —— 这里用池作为代理。 */
  function storeIdsSnapshot(): string[] {
    return pool.list().map(entry => entry.id)
  }

  // ---- 设置卡片 ------------------------------------------------------------
  installSettingsSectionCompat(ctx, DEVECO_SETTINGS_NS, Config, config, {
    setSource(source) {
      current = () => unwrapConfig(source())
      armAutoCheckin()
    },
    onChange() {
      armAutoCheckin()
    },
  })

  // ---- 目录发现 ------------------------------------------------------------
  const CATALOG_REFRESH_MS = 60 * 60 * 1000
  /** 目录空时的重试（指数退避，封顶 5 分钟）。 */
  const CATALOG_EMPTY_RETRY_MS = 60 * 1000
  const CATALOG_EMPTY_RETRY_MAX_MS = 5 * 60 * 1000
  let discoveryTimer: ReturnType<typeof setTimeout> | undefined
  let emptyStreak = 0
  const abort = new AbortController()
  /** 目录最后一次成功刷新的时刻（0 = 从没成功过）。卡片/体检用它判断「看到的模型是不是旧的」。 */
  let catalogUpdatedAt = 0
  /** 最近一次发现失败的原因（给体检用，别让用户只能靠猜）。 */
  let lastDiscoveryError: string | undefined

  const discoverLoop = async (): Promise<void> => {
    if (stopped) return
    try {
      await syncPool()
      const outcome = await refreshCatalog(store, catalog, abort.signal)
      catalogUpdatedAt = outcome.anySucceeded ? Date.now() : catalogUpdatedAt
      lastDiscoveryError = outcome.anySucceeded
        ? undefined
        : outcome.accounts.flatMap(account => account.errors).slice(0, 3).join(' | ') || 'no account'
      if (outcome.anySucceeded) {
        ctx.logger.debug(`dsh-deveco: model catalog refreshed (${outcome.models.length} models)`)
      } else if ((await store.ids()).length > 0) {
        ctx.logger.debug('dsh-deveco: model discovery found nothing usable; keeping the current catalog')
      }
    } catch (error: unknown) {
      lastDiscoveryError = error instanceof Error ? error.message : String(error)
      ctx.logger.debug('dsh-deveco: model discovery failed; keeping the current catalog', error)
    }
    if (stopped) return
    let delay: number
    if (catalog.current().length === 0) {
      delay = Math.min(CATALOG_EMPTY_RETRY_MS * 2 ** emptyStreak, CATALOG_EMPTY_RETRY_MAX_MS)
      emptyStreak += 1
    } else {
      emptyStreak = 0
      delay = CATALOG_REFRESH_MS
    }
    discoveryTimer = setTimeout(() => void discoverLoop(), delay)
    discoveryTimer.unref?.()
  }

  // ---- 凭证保活 ------------------------------------------------------------
  /**
   * 每 5 分钟扫一遍账号，把「剩余寿命低于提前量（默认 10 分钟）」的 accessToken 提前续掉。
   *
   * 为什么是 5 分钟：accessToken 只有 30 分钟，提前量 10 分钟，也就是每张令牌有一个
   * 20 分钟的「可续期窗口」。扫描间隔必须明显小于这个窗口，才能保证每个账号在一张令牌
   * 过期前至少被扫到一次 —— 20 分钟的扫描间隔刚好卡在窗口边界上，抖动一下就会滑过去。
   *
   * 这一轮只是「没人聊天时也别让凭证裸奔到过期」；真正的第一道防线是
   * `auth.ts` 的 `accessToken()`：**每次取号发请求前**都会检查剩余寿命，不足 10 分钟就先刷新。
   */
  const KEEP_ALIVE_INTERVAL_MS = 5 * 60 * 1000
  let keepAliveTimer: ReturnType<typeof setTimeout> | undefined
  const keepAliveLoop = async (): Promise<void> => {
    if (stopped) return
    try {
      const outcome = await store.keepAlive()
      if (outcome.refreshed > 0) ctx.logger.debug(`dsh-deveco: refreshed ${outcome.refreshed} access token(s)`)
      if (outcome.needsLogin.length > 0) {
        ctx.logger.debug(`dsh-deveco: ${outcome.needsLogin.length} account(s) need a fresh sign-in`)
      }
    } catch (error: unknown) {
      ctx.logger.debug('dsh-deveco: credential keep-alive failed; will retry', error)
    }
    if (stopped) return
    keepAliveTimer = setTimeout(() => void keepAliveLoop(), KEEP_ALIVE_INTERVAL_MS)
    keepAliveTimer.unref?.()
  }

  // ---- 自动签到 ------------------------------------------------------------
  /** 首次延迟：别和启动瞬间的目录请求抢上游。 */
  const AUTO_CHECKIN_FIRST_DELAY_MS = 30 * 1000
  /** 之后每 6 小时看一次（一天只签一次，重复的是幂等跳过）。 */
  const AUTO_CHECKIN_INTERVAL_MS = 6 * 60 * 60 * 1000
  let autoCheckinTimer: ReturnType<typeof setTimeout> | undefined
  const autoCheckinLoop = async (): Promise<void> => {
    if (stopped) return
    if (!dock().autoClaim) {
      autoCheckinTimer = undefined
      return
    }
    try {
      const outcome = await runCheckin()
      if (outcome.probed > 0) ctx.logger.debug(`dsh-deveco: auto check-in: ${outcome.message}`)
    } catch (error: unknown) {
      ctx.logger.debug('dsh-deveco: auto check-in failed; will retry next round', error)
    }
    if (stopped) return
    autoCheckinTimer = setTimeout(() => void autoCheckinLoop(), AUTO_CHECKIN_INTERVAL_MS)
    autoCheckinTimer.unref?.()
  }

  const armAutoCheckin = (): void => {
    if (stopped) return
    if (!dock().autoClaim) {
      if (autoCheckinTimer !== undefined) clearTimeout(autoCheckinTimer)
      autoCheckinTimer = undefined
      return
    }
    if (autoCheckinTimer !== undefined) return
    autoCheckinTimer = setTimeout(() => void autoCheckinLoop(), AUTO_CHECKIN_FIRST_DELAY_MS)
    autoCheckinTimer.unref?.()
  }

  // ---- 启动 ----------------------------------------------------------------
  void usage.load().catch(() => {})

  ctx.effect(() => () => {
    stopped = true
    abort.abort()
    for (const timer of [discoveryTimer, keepAliveTimer, autoCheckinTimer]) {
      if (timer !== undefined) clearTimeout(timer)
    }
    for (const session of loginSessions.values()) session.started.cancel()
    loginSessions.clear()
    void usage.flush().catch(() => {})
    void shim.close().catch(() => {})
  })

  void shim.ready
    .then(async () => {
      if (stopped) return
      // 先把池和目录对齐。**第一轮发现要在注册 provider 之前完成**：宿主的模型选择器
      // 往往只在打开时取一次 `listModels()`，如果那一刻目录还是空的，用户就会看到
      // 「provider 有了但一个模型都没有」—— 而且之后目录填好了，选择器也不会自己刷新。
      // 这里给第一轮一个上限，失败了照样注册（还能靠卡片上的「刷新模型」补）。
      await syncPool()
      await Promise.race([
        (async () => {
          try {
            const outcome = await refreshCatalog(store, catalog)
            if (outcome.anySucceeded) catalogUpdatedAt = Date.now()
            else lastDiscoveryError = outcome.accounts.flatMap(a => a.errors).slice(0, 3).join(' | ') || 'no account'
          } catch (error: unknown) {
            lastDiscoveryError = error instanceof Error ? error.message : String(error)
          }
        })(),
        new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 25_000)
          timer.unref?.()
        }),
      ])
      if (stopped) return
      ctx.logger.debug(`dsh-deveco: first discovery done (${catalog.current().length} model(s) known)`)
      // 后续的定时刷新交给循环（第一轮已经跑过，这里只是把节奏接上）。
      void discoverLoop()
      void keepAliveLoop()
      armAutoCheckin()

      const deveco = createDevecoAdapter({
        shim,
        catalog,
        enabledModels: () => current().enabledModels,
        resolveAttachments: () => ctx.get('attachments'),
      })

      let releaseAdapter: (() => void) | undefined
      let releaseDirectory: (() => void) | undefined
      try {
        releaseAdapter = ctx.llm.registerAdapter([DEVECO_PROVIDER], deveco.adapter)
        releaseDirectory = ctx.llm.registerConfigurableProviders([{
          provider: DEVECO_PROVIDER,
          displayName: 'DevEco',
          settingsNs: settingsCompatNamespace(ctx),
          settingsPath: [],
          declared: false,
        }])
      } finally {
        if (releaseAdapter === undefined || releaseDirectory === undefined) {
          releaseAdapter?.()
          releaseDirectory?.()
        }
      }
      try {
        ctx.effect(() => () => {
          releaseAdapter?.()
          releaseDirectory?.()
        })
      } catch {
        releaseAdapter?.()
        releaseDirectory?.()
      }

      providerRegistered = true
      ctx.logger.debug(`dsh-deveco: provider "${DEVECO_PROVIDER}" registered (shim on ${shim.baseUrl()})`)
    })
    .catch((error: unknown) => {
      ctx.logger.error('dsh-deveco: loopback shim failed to start; provider not registered', error)
    })
}
