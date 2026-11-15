/**
 * 插件卡片用的同源 HTTP 路由。
 *
 * 浏览器侧只通过这里读状态、加/删账号、切换模型勾选、签到、切显示开关。
 * 三个硬约束：
 *
 * 1. **只服务 loopback**：`Host` 与 `Origin` 都必须是回环（防 DNS rebinding）。本机
 *    任何一个网页都能访问 127.0.0.1，所以绑定地址本身不是信任边界。
 * 2. **任何令牌都不出浏览器**：状态文档里只有账号名、到期时间、勾选状态。
 * 3. **写操作要 `content-type: application/json`**：挡住了表单式的跨站提交。
 *
 * @module dsh-deveco/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { DevecoAccountStore, DevecoAccountSummary } from './auth.ts'
import type { AccountRuntime } from './account-pool.ts'
import type { DevecoModelInfo } from './catalog.ts'
import type { CheckinOutcome, CheckinSnapshot } from './checkin.ts'
import type { QuotaRefreshResult, QuotaSnapshot } from './quota.ts'
import type { UsageSnapshot } from './usage.ts'
import type { ShimStats } from './shim.ts'
import { DEVECO_PROVIDER } from './adapter.ts'
import { credentialFromJwtToken } from './login.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'

export type { CheckinOutcome, CheckinSnapshot } from './checkin.ts'
export type { QuotaRefreshResult, QuotaSnapshot } from './quota.ts'
export type { UsageSnapshot } from './usage.ts'
export type { ShimStats } from './shim.ts'

// ---------------------------------------------------------------------------
// 路由常量
// ---------------------------------------------------------------------------

export const DEVECO_STATUS_PATH = '/api/deveco/status'
export const DEVECO_MODELS_PATH = '/api/deveco/models'
export const DEVECO_SELECTION_PATH = '/api/deveco/enabled-models'
export const DEVECO_LOGIN_PATH = '/api/deveco/login'
export const DEVECO_LOGIN_STATUS_PATH = '/api/deveco/login/status'
export const DEVECO_TOKEN_PATH = '/api/deveco/token'
export const DEVECO_ACCOUNTS_PATH = '/api/deveco/accounts'
export const DEVECO_CHECKIN_PATH = '/api/deveco/checkin'
export const DEVECO_REFRESH_MODELS_PATH = '/api/deveco/refresh-models'
export const DEVECO_DOCK_PATH = '/api/deveco/dock'
export const DEVECO_DOCTOR_PATH = '/api/deveco/doctor'
/**
 * GET = 当前额度窗口与「哪些号被上游判过额度用尽」；POST = 重新探测一遍账号可用性。
 *
 * 注意：这**不是**查询余额。上游没有余额接口，见 `docs/PROTOCOL.md` 第 6 节。
 */
export const DEVECO_QUOTA_PATH = '/api/deveco/quota'

// ---------------------------------------------------------------------------
// 契约类型（客户端只认这一份）
// ---------------------------------------------------------------------------

/** 对话底部的显示开关。 */
export interface DevecoDockFlags {
  /** 对话输入框下方那一行（Provider / 模型 / 今日用量）。 */
  dock: boolean
  /** 侧边栏图标列里的入口。 */
  sidebar: boolean
  /** 设置左侧导航里的入口。 */
  settingsEntry: boolean
  /** 每天自动签到一次。 */
  autoClaim: boolean
}

/** 缺省值：dock 与 settingsEntry 开着，侧边栏与自动签到关着。 */
export const DEFAULT_DOCK_FLAGS: DevecoDockFlags = {
  dock: true,
  sidebar: false,
  settingsEntry: true,
  autoClaim: false,
}

/** 卡片上的一个账号（不含令牌）。 */
export interface DevecoWebAccount extends DevecoAccountSummary {
  /** 池里的运行时状态（槽位/冷却），账号不在池里时缺省。 */
  slot?: Pick<AccountRuntime, 'activeConcurrent' | 'maxConcurrent' | 'coolUntil' | 'disabled' | 'lastError'>
  /** 今天签到了吗。 */
  checkedInToday: boolean
  /** 连续签到天数。 */
  streak: number
}

/** 卡片上的一个模型。 */
export interface DevecoWebModel {
  id: string
  name: string
  wireId: string
  contextWindow?: number
  maxTokens?: number
  supportsImages?: boolean
  reasoning?: boolean
  /** 上游声明的思考档位。 */
  levels?: readonly string[]
  hidden?: boolean
}

/** 完整状态文档。 */
export interface DevecoWebStatus {
  version: string
  provider: string
  node: string
  /** 有没有任何账号。 */
  signedIn: boolean
  accounts: DevecoWebAccount[]
  models: DevecoWebModel[]
  usage: UsageSnapshot
  checkin: CheckinSnapshot
  /** 额度窗口 + 被上游判过额度用尽的账号（不含剩余额度，上游没有这个数）。 */
  quota: QuotaSnapshot
  dock: DevecoDockFlags
  /** 显示开关是否可写（没有 settings 服务时只读）。 */
  writable: boolean
  shim: ShimStats
  /** 签到到底是什么（一句话说明，卡片直接展示）。 */
  checkinNote: string
  /** provider 是否已经挂到宿主 LLM 层（注册失败时为 false，体检会指出）。 */
  providerRegistered: boolean
  /** 目录最后一次成功刷新的时刻（epoch ms；0 = 从没成功过）。 */
  catalogUpdatedAt: number
  /** 最近一次模型发现失败的原因（成功时为 undefined）。 */
  lastDiscoveryError?: string
}

/** 模型勾选面板的数据。 */
export interface DevecoModelSelection {
  choices: (DevecoWebModel & { enabled: boolean })[]
  /** 已选子集是否小于全集。 */
  restricted: boolean
  writable: boolean
}

/** 路由依赖。全部由 `index.ts` 注入，路由本身不持有任何状态。 */
export interface DevecoRouteOptions {
  store: DevecoAccountStore
  models: () => readonly DevecoModelInfo[]
  enabledModels: () => readonly string[] | undefined
  setEnabledModels: (ids: readonly string[]) => Promise<boolean>
  pool: () => AccountRuntime[]
  reviveAccount: (id: string) => void
  usage: () => UsageSnapshot
  checkin: () => CheckinSnapshot
  runCheckin: (options?: { accountId?: string; force?: boolean }) => Promise<CheckinOutcome>
  /** 额度窗口快照（不含剩余额度）。 */
  quota: () => QuotaSnapshot
  /** 重新探测账号可用性（不是查余额）。 */
  refreshQuota: () => Promise<QuotaRefreshResult>
  dock: () => DevecoDockFlags
  setDock: (patch: Partial<DevecoDockFlags>) => Promise<boolean>
  refreshModels: () => Promise<{ models: number; refreshed: boolean }>
  shimStats: () => ShimStats
  /** provider 是否已注册（ctx.llm.registerAdapter 成功之后为 true）。 */
  providerRegistered: () => boolean
  /**
   * 宿主 LLM 层实际看到的 provider 与模型数。
   *
   * 排查「模型列表里有、聊天框选择器里没有」的第一手段：它问的是宿主的
   * `llm.listProviders()` / `llm.listModels()`，不是插件自己的目录。
   */
  llmDiagnostics: () => Promise<{
    providers: { id: string; name: string; models: number; error?: string }[]
    error?: string
  }>
  /** 目录最后一次成功刷新的时刻（0 = 从没成功）。 */
  catalogUpdatedAt: () => number
  /** 最近一次发现失败的原因。 */
  lastDiscoveryError: () => string | undefined
  startLogin: (options: { accountId?: string }) => Promise<{ url: string; port: number; result: Promise<unknown>; cancel: () => void }>
  pollLogin: (url: string) => { state: 'pending' | 'done' | 'error'; kind?: string; message?: string; accountId?: string }
  version: string
  /** 签到说明文案（`docs/PROTOCOL.md` 的事实）。 */
  checkinNote: string
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** 只信任来回路环的请求。 */
function loopbackRequest(req: IncomingMessage): boolean {
  return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin)
}

/** 写操作必须是 JSON。 */
function isJsonRequest(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.toLowerCase().includes('application/json')
}

function readBody(req: IncomingMessage, limit = 1 << 20): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 500 ? `${message.slice(0, 500)}…` : message
}

function toWebModel(model: DevecoModelInfo): DevecoWebModel {
  return {
    id: model.id,
    name: model.name,
    wireId: model.wireId,
    ...model.contextWindowKnown === true && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {},
    ...model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {},
    ...model.supportsImages ? { supportsImages: true } : {},
    ...model.reasoning ? { reasoning: true } : {},
    ...model.thinking === undefined ? {} : { levels: model.thinking.levels },
    ...model.hidden ? { hidden: true } : {},
  }
}

/** 组装状态文档（不含任何令牌）。 */
export async function buildStatus(deps: DevecoRouteOptions): Promise<DevecoWebStatus> {
  const summaries = await deps.store.list()
  const slots = new Map(deps.pool().map(entry => [entry.id, entry]))
  const checkin = deps.checkin()
  const accounts: DevecoWebAccount[] = summaries.map(summary => {
    const slot = slots.get(summary.id)
    const today = checkin.today[summary.id]
    return {
      ...summary,
      ...slot === undefined ? {} : {
        slot: {
          activeConcurrent: slot.activeConcurrent,
          maxConcurrent: slot.maxConcurrent,
          coolUntil: slot.coolUntil,
          disabled: slot.disabled,
          ...slot.lastError === undefined ? {} : { lastError: slot.lastError },
        },
      },
      checkedInToday: today?.ok === true,
      streak: checkin.streaks[summary.id] ?? 0,
    }
  })
  const dock = deps.dock()
  return {
    version: deps.version,
    provider: DEVECO_PROVIDER,
    node: process.version,
    signedIn: accounts.length > 0,
    accounts,
    models: deps.models().map(toWebModel),
    usage: deps.usage(),
    checkin,
    quota: deps.quota(),
    dock,
    writable: true,
    shim: deps.shimStats(),
    checkinNote: deps.checkinNote,
    providerRegistered: deps.providerRegistered(),
    catalogUpdatedAt: deps.catalogUpdatedAt(),
    ...deps.lastDiscoveryError() === undefined ? {} : { lastDiscoveryError: deps.lastDiscoveryError() },
  }
}

/** 勾选面板的数据。 */
export function selectionOf(deps: DevecoRouteOptions): DevecoModelSelection {
  const models = deps.models()
  const enabled = deps.enabledModels()
  const allow = enabled === undefined || enabled.length === 0 ? undefined : new Set(enabled.map(id => id.toLowerCase()))
  const choices = models.map(model => ({
    ...toWebModel(model),
    enabled: allow === undefined || allow.has(model.id.toLowerCase()) || allow.has(model.wireId.toLowerCase()),
  }))
  return {
    choices,
    restricted: choices.some(choice => !choice.enabled),
    writable: true,
  }
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

function statusHandler(deps: DevecoRouteOptions): Handler {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    json(res, 200, { status: await buildStatus(deps) })
  }
}

function modelsHandler(deps: DevecoRouteOptions): Handler {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    json(res, 200, { models: deps.models().map(toWebModel) })
  }
}

function selectionHandler(deps: DevecoRouteOptions): Handler {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method === 'GET') {
      json(res, 200, { selection: selectionOf(deps) })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!isJsonRequest(req)) {
      json(res, 415, { error: 'content-type must be application/json' })
      return
    }
    try {
      const body = JSON.parse(await readBody(req)) as { enabledModels?: unknown }
      if (!Array.isArray(body.enabledModels) || body.enabledModels.some(id => typeof id !== 'string')) {
        json(res, 400, { error: 'enabledModels must be an array of model ids' })
        return
      }
      const ok = await deps.setEnabledModels(body.enabledModels as string[])
      if (!ok) {
        json(res, 403, { error: 'selection-not-writable' })
        return
      }
      json(res, 200, { ok: true, selection: selectionOf(deps) })
    } catch (error: unknown) {
      json(res, 400, { error: safeMessage(error) })
    }
  }
}

function loginStartHandler(deps: DevecoRouteOptions): Handler {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    try {
      const accountId = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('account') ?? undefined
      const started = await deps.startLogin({
        ...accountId === null || accountId === undefined ? {} : { accountId },
      })
      json(res, 200, { url: started.url, port: started.port })
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

function loginPollHandler(deps: DevecoRouteOptions): Handler {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('url') ?? ''
    if (url === '') {
      json(res, 400, { error: 'missing url' })
      return
    }
    json(res, 200, deps.pollLogin(url))
  }
}

function tokenHandler(deps: DevecoRouteOptions): Handler {
  // POST 与 DELETE 共用一个席位：宿主 WebServer 对同一个 (kind, path) 只留一个注册位，
  // 重复注册会抛 duplicate exact route，并把同一次 effect 里后面的注册全跳过。
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method === 'DELETE') {
      for (const summary of await deps.store.list()) await deps.store.remove(summary.id)
      json(res, 200, { ok: true, status: await buildStatus(deps) })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!isJsonRequest(req)) {
      json(res, 415, { error: 'content-type must be application/json' })
      return
    }
    try {
      const body = JSON.parse(await readBody(req)) as { jwtToken?: unknown; label?: unknown }
      const jwtToken = typeof body.jwtToken === 'string' ? body.jwtToken.trim() : ''
      if (jwtToken.split('.').length !== 3) {
        json(res, 400, { error: 'jwtToken must be a three-part JWT' })
        return
      }
      const credential = await credentialFromJwtToken(jwtToken, {
        ...typeof body.label === 'string' && body.label.trim() !== '' ? { label: body.label.trim() } : {},
      })
      const id = await deps.store.upsert(credential)
      deps.reviveAccount(id)
      json(res, 200, { ok: true, id, status: await buildStatus(deps) })
    } catch (error: unknown) {
      json(res, 400, { error: safeMessage(error) })
    }
  }
}

function accountsHandler(deps: DevecoRouteOptions): Handler {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method === 'DELETE') {
      const id = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('id')
      if (id === null || id === '') {
        json(res, 400, { error: 'missing id' })
        return
      }
      await deps.store.remove(id)
      json(res, 200, { ok: true, status: await buildStatus(deps) })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!isJsonRequest(req)) {
      json(res, 415, { error: 'content-type must be application/json' })
      return
    }
    try {
      const body = JSON.parse(await readBody(req)) as {
        id?: unknown
        paused?: unknown
        pinned?: unknown
        label?: unknown
        refresh?: unknown
      }
      const id = typeof body.id === 'string' ? body.id : ''
      if (id === '') {
        json(res, 400, { error: 'missing id' })
        return
      }
      let touched = false
      if (typeof body.paused === 'boolean') touched = await deps.store.setPaused(id, body.paused) || touched
      if (typeof body.pinned === 'boolean') touched = await deps.store.setPinned(id, body.pinned) || touched
      if (typeof body.label === 'string') touched = await deps.store.setLabel(id, body.label) || touched
      if (body.refresh === true) touched = await deps.store.forceRefresh(id) || touched
      if (!touched) {
        json(res, 404, { error: 'unknown account or nothing to change' })
        return
      }
      // 重新登录/刷新成功后把这个号从禁用里捞出来。
      deps.reviveAccount(id)
      json(res, 200, { ok: true, status: await buildStatus(deps) })
    } catch (error: unknown) {
      json(res, 400, { error: safeMessage(error) })
    }
  }
}

function checkinHandler(deps: DevecoRouteOptions): Handler {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!isJsonRequest(req)) {
      json(res, 415, { error: 'content-type must be application/json' })
      return
    }
    try {
      const raw = await readBody(req)
      const body = raw.trim() === '' ? {} : JSON.parse(raw) as { id?: unknown; force?: unknown }
      const accountId = typeof body.id === 'string' && body.id !== '' ? body.id : undefined
      // 被判「需要重新登录」的账号，签到后如果成功了就该复活。
      const outcome = await deps.runCheckin({
        ...accountId === undefined ? {} : { accountId },
        force: body.force === true,
      })
      for (const result of outcome.results) if (result.ok) deps.reviveAccount(result.id)
      json(res, 200, { outcome, status: await buildStatus(deps) })
    } catch (error: unknown) {
      json(res, 400, { error: safeMessage(error) })
    }
  }
}

function quotaHandler(deps: DevecoRouteOptions): Handler {  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method === 'GET') {
      json(res, 200, { quota: deps.quota() })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!isJsonRequest(req)) {
      json(res, 415, { error: 'content-type must be application/json' })
      return
    }
    try {
      const outcome = await deps.refreshQuota()
      json(res, 200, { outcome, status: await buildStatus(deps) })
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

function refreshModelsHandler(deps: DevecoRouteOptions): Handler {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    try {
      const outcome = await deps.refreshModels()
      json(res, 200, { ...outcome, selection: selectionOf(deps), status: await buildStatus(deps) })
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

function dockHandler(deps: DevecoRouteOptions): Handler {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method === 'GET') {
      json(res, 200, { dock: deps.dock(), writable: true })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!isJsonRequest(req)) {
      json(res, 415, { error: 'content-type must be application/json' })
      return
    }
    try {
      const body = JSON.parse(await readBody(req)) as Partial<Record<keyof DevecoDockFlags, unknown>>
      const patch: Partial<DevecoDockFlags> = {}
      for (const key of ['dock', 'sidebar', 'settingsEntry', 'autoClaim'] as const) {
        if (typeof body[key] === 'boolean') patch[key] = body[key]
      }
      const ok = await deps.setDock(patch)
      if (!ok) {
        json(res, 403, { error: 'dock-not-writable' })
        return
      }
      json(res, 200, { ok: true, dock: deps.dock(), writable: true })
    } catch (error: unknown) {
      json(res, 400, { error: safeMessage(error) })
    }
  }
}

/** 目录里模型声明过的最大输出上限（体检展示用）。 */
function maxOutputOf(status: DevecoWebStatus): string {
  const values = status.models.map(model => model.maxTokens ?? 0).filter(value => value > 0)
  return values.length === 0 ? 'unknown' : String(Math.max(...values))
}

/**
 * 把「宿主 LLM 层实际看到了什么」写成一句人话。
 *
 * 排查「模型列表有、聊天框选择器没有」时，这一条是第一现场：
 * 它问的是宿主的 `llm.listProviders()` / `llm.listModels()`，不是插件自己的目录。
 */
async function describeLlmDiagnostics(deps: DevecoRouteOptions): Promise<string> {
  let diagnostics
  try {
    diagnostics = await deps.llmDiagnostics()
  } catch (error: unknown) {
    return `host llm query failed: ${safeMessage(error)}`
  }
  if (diagnostics.error !== undefined) return `host llm query failed: ${diagnostics.error}`
  const deveco = diagnostics.providers.find(provider => provider.id === DEVECO_PROVIDER)
  if (deveco === undefined) {
    return `host does not list provider "${DEVECO_PROVIDER}" `
      + `(it lists: ${diagnostics.providers.map(provider => provider.id).join(', ') || 'none'})`
  }
  return `host lists "${DEVECO_PROVIDER}" with ${deveco.models} model(s)`
}

function doctorHandler(deps: DevecoRouteOptions): Handler {
  return async (req, res) => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    const status = await buildStatus(deps)
    const shim = deps.shimStats()
    const checks: { id: string; ok: boolean; detail: string }[] = [
      { id: 'version', ok: true, detail: `${status.version} on ${status.node}` },
      {
        id: 'accounts',
        ok: status.accounts.length > 0,
        detail: status.accounts.length === 0 ? 'no account signed in' : `${status.accounts.length} account(s)`,
      },
      {
        id: 'usable-accounts',
        ok: status.accounts.some(account => account.usable && !account.paused),
        detail: status.accounts.filter(account => account.usable && !account.paused).length === 0
          ? 'every account needs sign-in or is paused'
          : `${status.accounts.filter(account => account.usable && !account.paused).length} usable`,
      },
      {
        id: 'catalog',
        ok: status.models.length > 0,
        detail: status.models.length === 0 ? 'model catalog is empty' : `${status.models.length} model(s)`,
      },
      { id: 'shim', ok: shim.port > 0, detail: shim.port > 0 ? `loopback shim on port ${shim.port}` : 'shim is not listening' },
      {
        id: 'output-ceiling',
        ok: (shim.lastMaxTokens ?? 0) !== 0 && (shim.lastMaxTokens ?? Number.MAX_SAFE_INTEGER) >= 8_192,
        detail: shim.lastMaxTokens === undefined
          ? `no chat request yet; models advertise up to ${maxOutputOf(status)} output tokens`
          : `last request sent max_tokens=${shim.lastMaxTokens}`
            + ` (context is independent; models advertise up to ${maxOutputOf(status)})`,
      },
      {
        id: 'provider',
        ok: status.providerRegistered,
        detail: status.providerRegistered ? 'provider deveco is registered' : 'provider deveco is NOT registered',
      },
      {
        id: 'providers',
        ok: status.providerRegistered && status.accounts.length > 0 && status.models.length > 0,
        detail: await describeLlmDiagnostics(deps),
      },
      {
        id: 'checkin',
        ok: Object.values(status.checkin.today).some(record => record.ok),
        detail: Object.values(status.checkin.today).some(record => record.ok)
          ? 'checked in today'
          : 'not checked in today',
      },
      {
        id: 'quota',
        ok: status.quota.exhausted.length < Math.max(1, status.accounts.length),
        detail: status.quota.exhausted.length === 0
          ? `no account is marked out of quota; window resets in ${status.quota.resetIn}`
          : `${status.quota.exhausted.length} account(s) out of quota until ${status.quota.window.label}`,
      },
    ]
    json(res, 200, {
      report: {
        ok: checks.every(check => check.ok),
        version: status.version,
        node: status.node,
        checks,
        // 把宿主 LLM 层的原始视图也带上：卡片只显示一句话，导出报告时要用完整数据。
        llm: await deps.llmDiagnostics().catch((error: unknown) => ({ providers: [], error: safeMessage(error) })),
        catalogUpdatedAt: status.catalogUpdatedAt,
        ...status.lastDiscoveryError === undefined ? {} : { lastDiscoveryError: status.lastDiscoveryError },
        hints: status.accounts.length === 0 ? ['sign in with a Huawei account that has DevEco access'] : [],
      },
    })
  }
}

/** 挂载全部路由。 */
export function registerDevecoStatusRoutes(ctx: Context, deps: DevecoRouteOptions): void {
  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: DEVECO_STATUS_PATH, handler: statusHandler(deps) }),
      ctx.webServer.register({ kind: 'exact', path: DEVECO_MODELS_PATH, handler: modelsHandler(deps) }),
      ctx.webServer.register({ kind: 'exact', path: DEVECO_SELECTION_PATH, handler: selectionHandler(deps) }),
      ctx.webServer.register({ kind: 'exact', path: DEVECO_LOGIN_PATH, handler: loginStartHandler(deps) }),
      ctx.webServer.register({ kind: 'exact', path: DEVECO_LOGIN_STATUS_PATH, handler: loginPollHandler(deps) }),
      ctx.webServer.register({ kind: 'exact', path: DEVECO_TOKEN_PATH, handler: tokenHandler(deps) }),
      ctx.webServer.register({ kind: 'exact', path: DEVECO_ACCOUNTS_PATH, handler: accountsHandler(deps) }),
      ctx.webServer.register({ kind: 'exact', path: DEVECO_CHECKIN_PATH, handler: checkinHandler(deps) }),
      ctx.webServer.register({ kind: 'exact', path: DEVECO_REFRESH_MODELS_PATH, handler: refreshModelsHandler(deps) }),
      ctx.webServer.register({ kind: 'exact', path: DEVECO_DOCK_PATH, handler: dockHandler(deps) }),
      ctx.webServer.register({ kind: 'exact', path: DEVECO_DOCTOR_PATH, handler: doctorHandler(deps) }),
      ctx.webServer.register({ kind: 'exact', path: DEVECO_QUOTA_PATH, handler: quotaHandler(deps) }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-deveco: web routes')
}
