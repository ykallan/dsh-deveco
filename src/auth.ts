/**
 * DevEco 凭证体系：多账号文档 + 单账号续期。
 *
 * 三层的生命周期各不相同（见 `docs/PROTOCOL.md`）：
 *
 * | 凭证 | 谁签发 | 寿命 | 存哪 |
 * |---|---|---|---|
 * | `jwtToken` | `authrouter/temptoken/check` | 天/周级（JWT `exp`） | 磁盘（本文件） |
 * | `accessToken` | `authrouter/jwToken/check?refresh` | 30 分钟（上游不给 TTL，实测） | 磁盘 + 内存，过期即续 |
 * | 浏览器授权 `code` | DevEco 登录页 | 一次 | 只在登录过程中存在 |
 *
 * **多账号**：文档 `.deveco-accounts.json` 管凭证，池（`account-pool.ts`）管「谁现在能接活」。
 * 每个账号一份 `AccountSlot`，续期是单飞的 —— 同一个账号并发刷新会让后到的那次拿着
 * 已轮换的 refreshToken 失败，把好端端的账号写成 stale。
 *
 * @module dsh-deveco/auth
 */

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { estimateTtlMs, MIN_REFRESH_SKEW_MS, pushTtlSample, refreshSkewForTtl, shouldRefresh } from './ttl.ts'
import {
  refreshSkewOverrideMs,
  CONTROL_TIMEOUT_MS,
  DEVECO_JWT_TOKEN_URL,
  REFRESH_COOLDOWN_MS,
  AUTH_WAIT_FOR_REFRESH_MS,
} from './config.ts'

/** 手工粘贴 jwtToken 时用的账号 id（没有身份信息可推）。 */
export const MANUAL_ACCOUNT_ID = 'manual'

/** 一条 DevEco 账号凭证。 */
export interface DevecoCredential {
  /** 长寿命 JWT，所有其它凭证都由它换来。 */
  jwtToken: string
  /** JWT 里的 `userId`，账号自然键的首选。 */
  userId?: string
  /** JWT 里的 `userName`，展示用。 */
  userName?: string
  /** `CN` = 中国大陆账号（上游只服务这个区域）。 */
  nationalCode?: string
  /** 是否实名（未实名不能调上游）。 */
  isRealName?: boolean
  /** 短寿命访问令牌。 */
  accessToken?: string
  /** 访问令牌到期时刻（epoch ms，按学到的 TTL 推算）。 */
  accessTokenExpiresAt?: number
  /** 当前 accessToken 的签发时刻（epoch ms）—— 学习 TTL 的基准。 */
  accessTokenIssuedAt?: number
  /** 学到的「签发后多久被上游拒绝」样本（毫秒，最多保留 5 个）。 */
  ttlSamplesMs?: number[]
  /** 观测到的「签发后仍然可用」的最大时长（TTL 下界）。 */
  workingAgeMs?: number
  /** 上游给的刷新令牌（有就带着，目前只用于诊断）。 */
  refreshToken?: string
  /** 用户可改的备注名。 */
  label?: string
  /** 首次落库时间。 */
  storedAt?: number
  /** 最近一次成功登录时间。 */
  lastLoginAt?: number
  /** 续期被上游拒绝，需要重新登录。 */
  stale?: boolean
  /** 用户手动暂停（不参与轮转）。 */
  paused?: boolean
  /** 用户置顶（轮转优先）。 */
  pinned?: boolean
}

/** 卡片上一条账号摘要（**不含任何令牌**）。 */
export interface DevecoAccountSummary {
  id: string
  label?: string
  userName?: string
  userId?: string
  nationalCode?: string
  isRealName: boolean
  /** 凭证还能不能用（没被标记 stale）。 */
  usable: boolean
  /** 访问令牌何时过期（epoch ms），没有则是 undefined。 */
  accessTokenExpiresAt?: number
  storedAt?: number
  lastLoginAt?: number
  /** JWT 自身何时过期（epoch ms）。 */
  jwtExpiresAt?: number
  /** 当前生效的 accessToken 寿命（毫秒，学到的或默认）。 */
  ttlMs: number
  /** TTL 结论来自哪里：learned（上界样本）/ extended（下界抬高）/ default。 */
  ttlSource: 'learned' | 'extended' | 'default'
  /** 参与计算的「被拒」样本数。 */
  ttlSamples: number
  /** 当前 accessToken 已经用了多久（毫秒）。 */
  tokenAgeMs?: number
  paused: boolean
  pinned: boolean
}

/** 账号文档（`.deveco-accounts.json`）。 */
export interface DevecoAccountDocument {
  version: 1
  /** 展示顺序。 */
  order: string[]
  accounts: Record<string, DevecoCredential>
}

/** 解析出来的 JWT 载荷子集。 */
export interface DevecoJwtPayload {
  userId?: string
  userName?: string
  exp?: number
  iat?: number
  nationalCode?: string
  isRealName?: boolean
}

/** `jwToken/check` 的响应。 */
export interface DevecoTokenCheckResponse {
  status: boolean
  userInfo?: {
    accessToken?: string
    refreshToken?: string
    nationalCode?: string
    realName?: string | boolean
  }
}

/** 续期成功的结果。 */
export interface DevecoRefreshResult {
  accessToken: string
  refreshToken?: string
  isRealName?: boolean
}

/**
 * 一次续期的结果。
 *
 * 必须区分「上游明确拒绝」和「网络/超时这类暂时失败」：前者说明账号真的需要重新登录，
 * 后者只是一次抖动 —— 以前两者都返回 undefined，调用方就把**网络超时也当成密钥无效**，
 * 直接把账号写死并让 DSH 报「API 密钥无效」。这是用户遇到「请求中途突然密钥无效」的根因。
 */
export type DevecoRefreshOutcome =
  | { ok: true; value: DevecoRefreshResult }
  | { ok: false; kind: 'rejected' | 'transient'; message: string }

/** 一次凭证解析的结果：够发一次聊天请求。 */
export interface ResolvedDevecoCredential {
  id: string
  credential: DevecoCredential
  accessToken: string
  /** 认过证的账号身份（JWT 解析结果）。 */
  userName?: string
  userId?: string
}

/** 数据目录：默认 `~/.dsh`（与宿主一致），可用 `DSH_HOME` 覆盖。 */
export function devecoHome(home?: string): string {
  return home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 多账号文档路径。 */
export function devecoAccountsPath(home?: string): string {
  return join(devecoHome(home), '.deveco-accounts.json')
}

/** 签到台账路径。 */
export function devecoCheckinPath(home?: string): string {
  return join(devecoHome(home), '.deveco-checkin.json')
}

/** 用量台账路径。 */
export function devecoUsagePath(home?: string): string {
  return join(devecoHome(home), '.deveco-usage.json')
}

/** 续期失败日志路径（宿主对插件 debug 日志没有出口，失败原因只能自己留档）。 */
export function devecoRefreshLogPath(home?: string): string {
  return join(devecoHome(home), '.deveco-refresh.log')
}

/** 解析 JWT 载荷。**不验签**：上游的签名密钥我们拿不到，也没必要验。 */
export function parseJwtPayload(token: string): DevecoJwtPayload {
  const parts = token.trim().split('.')
  if (parts.length !== 3) throw new Error('not a jwtToken (expected 3 dot-separated parts)')
  const base64Url = (parts[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), '=')
  const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>
  const payload: DevecoJwtPayload = {}
  if (typeof parsed.userId === 'string' && parsed.userId !== '') payload.userId = parsed.userId
  if (typeof parsed.userName === 'string' && parsed.userName !== '') payload.userName = parsed.userName
  if (typeof parsed.exp === 'number') payload.exp = parsed.exp
  if (typeof parsed.iat === 'number') payload.iat = parsed.iat
  if (typeof parsed.nationalCode === 'string' && parsed.nationalCode !== '') payload.nationalCode = parsed.nationalCode
  if (typeof parsed.isRealName === 'boolean') payload.isRealName = parsed.isRealName
  return payload
}

/** 账号自然键：`userId` → `userName` → jwtToken 哈希。 */
export function accountIdOf(credential: DevecoCredential): string {
  if (typeof credential.userId === 'string' && credential.userId !== '') return credential.userId
  if (typeof credential.userName === 'string' && credential.userName !== '') return credential.userName
  return `t${createHash('sha256').update(credential.jwtToken).digest('hex').slice(0, 15)}`
}

/** 用 JWT 载荷补全凭证里的身份字段。 */
export function withJwtIdentity(credential: DevecoCredential): DevecoCredential {
  let payload: DevecoJwtPayload
  try {
    payload = parseJwtPayload(credential.jwtToken)
  } catch {
    return credential
  }
  return {
    ...credential,
    ...payload.userId === undefined ? {} : { userId: payload.userId },
    ...payload.userName === undefined ? {} : { userName: payload.userName },
    ...payload.nationalCode === undefined ? {} : { nationalCode: payload.nationalCode },
    ...payload.isRealName === undefined ? {} : { isRealName: payload.isRealName },
  }
}

/** 账号摘要。 */
export function summarizeAccount(id: string, credential: DevecoCredential): DevecoAccountSummary {
  let jwtExpiresAt: number | undefined
  try {
    const exp = parseJwtPayload(credential.jwtToken).exp
    if (exp !== undefined) jwtExpiresAt = exp * 1000
  } catch {
    jwtExpiresAt = undefined
  }
  const ttl = estimateTtlMs({
    expiredAgesMs: credential.ttlSamplesMs,
    workingAgeMs: credential.workingAgeMs,
  })
  const tokenAgeMs = credential.accessTokenIssuedAt === undefined
    ? undefined
    : Math.max(0, Date.now() - credential.accessTokenIssuedAt)
  return {
    id,
    ...credential.label === undefined ? {} : { label: credential.label },
    ...credential.userName === undefined ? {} : { userName: credential.userName },
    ...credential.userId === undefined ? {} : { userId: credential.userId },
    ...credential.nationalCode === undefined ? {} : { nationalCode: credential.nationalCode },
    isRealName: credential.isRealName === true,
    usable: credential.stale !== true,
    ttlMs: ttl.ttlMs,
    ttlSource: ttl.source,
    ttlSamples: ttl.samples,
    ...tokenAgeMs === undefined ? {} : { tokenAgeMs },
    ...credential.accessTokenExpiresAt === undefined ? {} : { accessTokenExpiresAt: credential.accessTokenExpiresAt },
    ...credential.storedAt === undefined ? {} : { storedAt: credential.storedAt },
    ...credential.lastLoginAt === undefined ? {} : { lastLoginAt: credential.lastLoginAt },
    ...jwtExpiresAt === undefined ? {} : { jwtExpiresAt },
    paused: credential.paused === true,
    pinned: credential.pinned === true,
  }
}

/** `realName` 上游有时给布尔、有时给字符串，统一成布尔。 */
export function parseRealName(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
  return undefined
}

/** 原子写文件（临时文件 + rename），并尽力收紧权限。 */
function writeJsonAtomic(path: string, value: unknown): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows 上 chmod 只影响只读位，失败无所谓。
  }
}

function readJsonFile<T>(path: string): T | undefined {
  try {
    if (!existsSync(path)) return undefined
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

/**
 * 校验 + 续期一个账号的访问令牌（单飞）。
 *
 * 为什么必须单飞：`refreshToken` 是一次性的，上游刷新时会轮换它。两个并发刷新里
 * 后发的那次拿着已作废的值，会把整个账号写成 stale —— 症状正是「隔天就要重新登录」。
 */
class AccountSlot {
  private cred: DevecoCredential
  private inflight: Promise<DevecoRefreshResult | undefined> | undefined
  private generation = 0
  private blockedUntil = 0
  /** 上次真正打上游刷新的时刻（最小刷新间隔用）。 */
  private lastRefreshAt = 0
  private readonly persist: (credential: DevecoCredential) => void
  private readonly log?: (message: string) => void

  constructor(credential: DevecoCredential, persist: (credential: DevecoCredential) => void, log?: (message: string) => void) {
    this.cred = credential
    this.persist = persist
    this.log = log
  }

  current(): DevecoCredential {
    return this.cred
  }

  replace(credential: DevecoCredential): void {
    this.cred = credential
    this.generation += 1
  }

  /**
   * 当前凭证是否已被判定失效。
   *
   * 用方法而不是直接比较属性：`refresh()` 会改写 `this.cred`，而 TS 对属性的窄化会把
   * 刷新之后的 `=== true` 比较当成「没有交集」而报错。
   */
  private isStale(): boolean {
    return this.cred.stale === true
  }

  /** 访问令牌还能用多久（毫秒）；没有或已过期 ≤ 0。 */
  private remainingMs(): number {
    const expiresAt = this.cred.accessTokenExpiresAt
    if (typeof this.cred.accessToken !== 'string' || this.cred.accessToken === '') return 0
    if (expiresAt === undefined) return 0
    return expiresAt - Date.now()
  }

  /** 当前生效的 accessToken 寿命（学到的或默认）。 */
  private ttlMs(): number {
    return estimateTtlMs({
      expiredAgesMs: this.cred.ttlSamplesMs,
      workingAgeMs: this.cred.workingAgeMs,
    }).ttlMs
  }

  /**
   * 续期提前量。
   *
   * 默认跟着**学到的 TTL** 走（TTL/3，夹在 2–10 分钟），所以 TTL 学得越准、刷新越少。
   * 显式设置 `DEVECO_REFRESH_SKEW_MINUTES` 时以它为准（运维逃生口），但仍不允许超过 TTL/2，
   * 否则就变成「刚拿到就作废」的刷新风暴。
   */
  private skewMs(): number {
    const ttl = this.ttlMs()
    const override = refreshSkewOverrideMs()
    if (override === undefined) return refreshSkewForTtl(ttl)
    return Math.min(override, Math.max(MIN_REFRESH_SKEW_MS, Math.floor(ttl / 2)))
  }

  /**
   * 用号前检查：拿一个当前可用的访问令牌。
   *
   * 规则（这是「动态控制有效期」的落点，每次从池里取号发请求前都会走一遍）：
   *  - 剩余寿命 > 提前量 → 直接用。提前量由**学到的 TTL** 推出来（TTL/3，夹在 2–10 分钟），
   *    所以 TTL 学得越准，刷新越少；
   *  - 剩余 ≤ 提前量（含没有过期时间、令牌为空、已经过期）→ 先刷新再返回，但受
   *    `MIN_REFRESH_INTERVAL_MS` 约束，同一张令牌不会被反复重刷；
   *  - 刷新被上游明确拒绝（JWT 过期 / 401）→ 标 stale，返回 undefined，让上层换号；
   *  - 刷新因为网络抖动失败 → 只进冷却，**不判死账号**；只要旧令牌还没真过期就先用它。
   *
   * @returns 令牌；确实是「必须重新登录」时返回 undefined。
   */
  async accessToken(): Promise<string | undefined> {
    if (this.isStale()) return undefined
    const remaining = this.remainingMs()
    const skew = this.skewMs()
    if (remaining > skew) {
      this.noteWorkingAge()
      return this.cred.accessToken
    }
    const now = Date.now()
    const sinceLastRefresh = this.lastRefreshAt === 0
      ? Number.POSITIVE_INFINITY
      : now - this.lastRefreshAt
    // 主动刷新的闸门：每账号 5 分钟最多 1 次；紧急/短 TTL 会自动放行（见 shouldRefresh）。
    const gate = shouldRefresh({ sinceLastRefreshMs: sinceLastRefresh, ttlMs: this.ttlMs(), remainingMs: remaining })
    if (now >= this.blockedUntil && gate.allowed) {
      this.inflight ??= this.refresh().finally(() => {
        this.inflight = undefined
      })
      const outcome = await this.inflight
      if (outcome !== undefined) return outcome.accessToken
    }
    if (this.isStale()) return undefined
    // 刷新失败/冷却/被闸门挡住：旧令牌还没真过期就继续用（让上游去判），真过期了才算不可用。
    //
    // 「有旧令牌就不等」是刻意设计：刷新的触发点是「剩余 < 提前量」，此时旧令牌通常还有几分钟
    // 寿命，让它继续跑比让请求排队等待更快，也不会失败。
    if (remaining > 0 && typeof this.cred.accessToken === 'string' && this.cred.accessToken !== '') {
      this.noteWorkingAge()
      return this.cred.accessToken
    }
    // 真过期了才短等一次正在进行的刷新（有上限，避免把请求拖死）。
    if (this.inflight !== undefined) {
      const settled = await this.waitForInflight(AUTH_WAIT_FOR_REFRESH_MS)
      if (settled !== undefined) return settled
    }
    return undefined
  }

  /** 等一个正在进行的刷新，最多 `maxMs`；超时返回 undefined。 */
  private async waitForInflight(maxMs: number): Promise<string | undefined> {
    const inflight = this.inflight
    if (inflight === undefined) return undefined
    const result = await Promise.race([
      inflight,
      new Promise<undefined>(resolve => {
        const timer = setTimeout(() => resolve(undefined), maxMs)
        timer.unref?.()
      }),
    ])
    return result?.accessToken
  }

  /**
   * 记录「这张令牌已经活了这么久且仍可用」—— TTL 的下界。
   *
   * 只在明显超过当前假设时才落盘，避免每条请求都写文件。
   */
  private noteWorkingAge(): void {
    const issuedAt = this.cred.accessTokenIssuedAt
    if (issuedAt === undefined) return
    const age = Date.now() - issuedAt
    const known = this.cred.workingAgeMs ?? 0
    if (age <= known || age <= this.ttlMs()) return
    this.cred = { ...this.cred, workingAgeMs: age }
    this.persist(this.cred)
  }

  /**
   * 上游**接受**了这张令牌 —— TTL 的下界样本。
   *
   * 判据是「实际年龄超过当前估值却还能用」，说明我们估小了。由 shim 在请求成功后调用，
   * 传进来的 `issuedAt` 是**这次请求实际使用的那张令牌**的签发时刻（不是当前 slot 里的，
   * 因为期间可能已经刷新过）。
   */
  noteTokenWorked(issuedAt?: number): void {
    const issued = issuedAt ?? this.cred.accessTokenIssuedAt
    if (issued === undefined) return
    const age = Date.now() - issued
    if (age <= 0 || age <= (this.cred.workingAgeMs ?? 0) || age <= this.ttlMs()) return
    this.cred = { ...this.cred, workingAgeMs: age }
    this.persist(this.cred)
    this.log?.('token outlived the TTL estimate; raising it to '
      + `${Math.round(this.ttlMs() / 60_000)}min`)
  }

  /**
   * 上游拿这张令牌回了 401 —— 这是 TTL 的**上界样本**。
   *
   * 只在「令牌是本地签发的、且没有被别的路径替换过」时采信：如果签发时刻缺失或为负，
   * 说明这是从磁盘读来的旧令牌，年龄不可信，宁可不要这个样本。
   */
  recordExpiredToken(): void {
    const issuedAt = this.cred.accessTokenIssuedAt
    if (issuedAt === undefined) return
    const age = Date.now() - issuedAt
    if (age <= 0) return
    const samples = pushTtlSample(this.cred.ttlSamplesMs, age)
    if (samples.length === (this.cred.ttlSamplesMs ?? []).length) return
    this.cred = { ...this.cred, ttlSamplesMs: samples }
    this.persist(this.cred)
    const ttl = this.ttlMs()
    this.log?.(`learned a token lifetime sample: ${Math.round(age / 60_000)}min `
      + `(ttl now ~${Math.round(ttl / 60_000)}min from ${samples.length} sample(s))`)
  }

  /** 强制续期一次（用户点「刷新凭证」/聊天 401 后重试）。 */
  async forceRefresh(): Promise<DevecoRefreshResult | undefined> {
    this.inflight ??= this.refresh(true).finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  private async refresh(force = false): Promise<DevecoRefreshResult | undefined> {
    const seen = this.cred.jwtToken
    const generation = this.generation
    // JWT 本身过期了，refresh 一定失败 —— 直接判死，别浪费一次上游请求。
    let jwtExpired = false
    try {
      const exp = parseJwtPayload(seen).exp
      if (exp !== undefined && Date.now() >= exp * 1000) jwtExpired = true
    } catch {
      jwtExpired = true
    }
    if (jwtExpired) {
      this.markStale('jwtToken expired; sign in again')
      return undefined
    }
    this.lastRefreshAt = Date.now()
    const outcome = await requestTokenRefresh(seen)
    if (!outcome.ok) {
      // 代际变了说明期间有人重新登录过，这次失败不该盖掉新凭证。
      if (generation === this.generation) {
        this.blockedUntil = Date.now() + REFRESH_COOLDOWN_MS
        this.log?.(`refresh ${outcome.kind}: ${outcome.message}`)
        // **只有上游明确拒绝**才是真的需要重新登录；网络/超时只是抖动，绝不能写死账号。
        if (outcome.kind === 'rejected' && force && generation === this.generation) {
          this.markStale(`refresh rejected by upstream: ${outcome.message}`)
        }
      }
      return undefined
    }
    const value = outcome.value
    const issuedAt = Date.now()
    const next: DevecoCredential = withJwtIdentity({
      ...this.cred,
      accessToken: value.accessToken,
      // 用**学到的 TTL** 算过期时刻，不再写死 30 分钟；同时记下签发时刻供后续学习。
      accessTokenIssuedAt: issuedAt,
      accessTokenExpiresAt: issuedAt + this.ttlMs(),
      ...value.refreshToken === undefined ? {} : { refreshToken: value.refreshToken },
      ...value.isRealName === undefined ? {} : { isRealName: value.isRealName },
      stale: false,
    })
    this.cred = next
    this.generation += 1
    this.blockedUntil = 0
    this.persist(next)
    return value
  }

  private markStale(reason: string): void {
    if (this.cred.stale === true) return
    this.cred = { ...this.cred, stale: true }
    this.generation += 1
    this.persist(this.cred)
    this.log?.(`account marked stale: ${reason}`)
  }

  /** 记一次上游明确否定了这条凭证（401 / 403 ModelServiceError）。 */
  noteRejected(reason: string): void {
    this.markStale(reason)
  }
}

/**
 * 向 `jwToken/check` 要一个新访问令牌。
 *
 * 上游用**同一个 GET** 同时承担「校验 JWT」和「换 accessToken」，区别只有 `refresh` 头。
 * 请求没有 body，JWT 放在 `jwtToken` 头里（注意是小写开头的驼峰，不是 `Authorization`）。
 *
 * @returns 明确的成功/拒绝/暂时失败三态。**网络失败与上游拒绝必须分开**，否则一次超时
 *          就会被上层当作「密钥无效」，把还能用的账号写死。
 */
export async function requestTokenRefresh(
  jwtToken: string,
  signal?: AbortSignal,
): Promise<DevecoRefreshOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CONTROL_TIMEOUT_MS)
  timer.unref?.()
  signal?.addEventListener('abort', () => controller.abort(), { once: true })
  try {
    const response = await fetch(DEVECO_JWT_TOKEN_URL, {
      method: 'GET',
      headers: { refresh: 'true', jwtToken, 'accept-language': 'zh-CN' },
      signal: controller.signal,
    })
    if (response.status === 401 || response.status === 403) {
      return { ok: false, kind: 'rejected', message: `HTTP ${response.status}` }
    }
    if (!response.ok) {
      // 5xx / 429 是上游暂时不可用，不是凭证问题。
      return { ok: false, kind: 'transient', message: `HTTP ${response.status}` }
    }
    const body = await response.json() as DevecoTokenCheckResponse & { errorCode?: unknown; errorMsg?: unknown }
    const accessToken = body.userInfo?.accessToken
    if (body.status !== true || typeof accessToken !== 'string' || accessToken === '') {
      const errorCode = typeof body.errorCode === 'number' ? body.errorCode : undefined
      const errorMsg = typeof body.errorMsg === 'string' && body.errorMsg !== '' ? body.errorMsg : undefined
      // 4016 / 明确的 invalid token 才是真拒绝；其它未知形态按暂时失败处理，宁可重试也不写死账号。
      const text = [errorMsg, errorCode === undefined ? undefined : `errorCode ${errorCode}`]
        .filter((part): part is string => part !== undefined).join(' ') || 'refresh returned status=false'
      const rejected = errorCode === 4016 || /invalid|expired|unauthor|forbidden/i.test(text)
      return { ok: false, kind: rejected ? 'rejected' : 'transient', message: text }
    }
    const value: DevecoRefreshResult = { accessToken }
    if (typeof body.userInfo?.refreshToken === 'string' && body.userInfo.refreshToken !== '') {
      value.refreshToken = body.userInfo.refreshToken
    }
    const realName = parseRealName(body.userInfo?.realName)
    if (realName !== undefined) value.isRealName = realName
    return { ok: true, value }
  } catch (error: unknown) {
    // 超时 / DNS / 连接重置：一律算暂时失败。
    return {
      ok: false,
      kind: 'transient',
      message: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 只校验一次 JWT（不换令牌），签到用它判断「这个号今天还活着吗」。
 *
 * @returns `true` 有效；`false` 被上游否定；`undefined` 网络/超时等不确定情况。
 */
export async function verifyJwtToken(jwtToken: string, signal?: AbortSignal): Promise<boolean | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CONTROL_TIMEOUT_MS)
  timer.unref?.()
  signal?.addEventListener('abort', () => controller.abort(), { once: true })
  try {
    const response = await fetch(DEVECO_JWT_TOKEN_URL, {
      method: 'GET',
      headers: { refresh: 'false', jwtToken, 'accept-language': 'zh-CN' },
      signal: controller.signal,
    })
    if (response.status === 401 || response.status === 403) return false
    if (!response.ok) return undefined
    const body = await response.json() as DevecoTokenCheckResponse
    return body.status === true
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 多账号凭证文档。
 *
 * 文档本身只管「存了什么」；能不能用由池和 slot 决定。
 */
export class DevecoAccountStore {
  private readonly path: string
  private readonly log?: (message: string) => void
  private document: DevecoAccountDocument | undefined
  private loading: Promise<void> | undefined
  private readonly slots = new Map<string, AccountSlot>()

  constructor(path: string, options: { log?: (message: string) => void } = {}) {
    this.path = path
    this.log = options.log
  }

  /** 当前磁盘路径（部署/诊断用）。 */
  get documentPath(): string {
    return this.path
  }

  private async ensureLoaded(): Promise<void> {
    if (this.document !== undefined) return
    this.loading ??= this.load()
    await this.loading
  }

  private async load(): Promise<void> {
    const raw = readJsonFile<Partial<DevecoAccountDocument>>(this.path)
    const accounts: Record<string, DevecoCredential> = {}
    for (const [id, value] of Object.entries(raw?.accounts ?? {})) {
      if (value === null || typeof value !== 'object') continue
      const credential = value as DevecoCredential
      if (typeof credential.jwtToken !== 'string' || credential.jwtToken === '') continue
      // 解析不出来的 jwtToken（被手工改坏/写错文件）不该进账号列表：它永远无法续期，
      // 只会在卡片上留下一条点不动的死行。
      try {
        parseJwtPayload(credential.jwtToken)
      } catch {
        continue
      }
      accounts[id] = withJwtIdentity(credential)
    }
    const order = Array.isArray(raw?.order)
      ? raw.order.filter((id): id is string => typeof id === 'string' && accounts[id] !== undefined)
      : []
    for (const id of Object.keys(accounts)) if (!order.includes(id)) order.push(id)
    this.document = { version: 1, order, accounts }
  }

  private get doc(): DevecoAccountDocument {
    if (this.document === undefined) {
      this.document = { version: 1, order: [], accounts: {} }
    }
    return this.document
  }

  private flush(): void {
    writeJsonAtomic(this.path, this.doc)
  }

  private slot(id: string, credential: DevecoCredential): AccountSlot {
    const existing = this.slots.get(id)
    if (existing !== undefined) return existing
    const slot = new AccountSlot(credential, next => {
      this.doc.accounts[id] = next
      this.flush()
    }, this.log)
    this.slots.set(id, slot)
    return slot
  }

  /** 账号摘要列表（按文档顺序）。 */
  async list(): Promise<DevecoAccountSummary[]> {
    await this.ensureLoaded()
    const doc = this.doc
    return doc.order
      .map(id => {
        const credential = doc.accounts[id]
        return credential === undefined ? undefined : summarizeAccount(id, credential)
      })
      .filter((entry): entry is DevecoAccountSummary => entry !== undefined)
  }

  /** 账号 id 列表（文档顺序）。 */
  async ids(): Promise<string[]> {
    await this.ensureLoaded()
    return [...this.doc.order]
  }

  /** 账号 id 列表，但按当前凭证可用性过滤（stale 的不参与轮转）。 */
  async dispatchIds(): Promise<string[]> {
    await this.ensureLoaded()
    const doc = this.doc
    return doc.order.filter(id => {
      const credential = doc.accounts[id]
      return credential !== undefined && credential.stale !== true && credential.paused !== true
    })
  }

  /** 某个账号的凭证副本。 */
  async credential(id: string): Promise<DevecoCredential | undefined> {
    await this.ensureLoaded()
    const credential = this.doc.accounts[id]
    return credential === undefined ? undefined : { ...credential }
  }

  /** 第一个可用账号的凭证。 */
  async current(): Promise<{ id: string; credential: DevecoCredential } | undefined> {
    const ids = await this.dispatchIds()
    const id = ids[0]
    if (id === undefined) return undefined
    const credential = await this.credential(id)
    return credential === undefined ? undefined : { id, credential }
  }

  /** 有没有任何账号。 */
  async hasCredential(): Promise<boolean> {
    const ids = await this.ids()
    return ids.length > 0
  }

  /** 写入/更新一个账号，返回账号 id。 */
  async upsert(credential: DevecoCredential, id?: string): Promise<string> {
    await this.ensureLoaded()
    const doc = this.doc
    const normalized = withJwtIdentity({ ...credential, storedAt: credential.storedAt ?? Date.now() })
    const key = id ?? accountIdOf(normalized)
    const previous = doc.accounts[key]
    doc.accounts[key] = {
      ...normalized,
      // 保留用户自己的偏好，重新登录不该把暂停/置顶清掉。
      ...previous?.label === undefined ? {} : { label: normalized.label ?? previous.label },
      ...previous?.paused === undefined ? {} : { paused: previous.paused },
      ...previous?.pinned === undefined ? {} : { pinned: previous.pinned },
      stale: false,
    }
    if (!doc.order.includes(key)) doc.order.push(key)
    this.slots.get(key)?.replace(doc.accounts[key] as DevecoCredential)
    this.flush()
    return key
  }

  /** 删除一个账号。 */
  async remove(id: string): Promise<void> {
    await this.ensureLoaded()
    const doc = this.doc
    if (doc.accounts[id] === undefined) return
    delete doc.accounts[id]
    doc.order = doc.order.filter(entry => entry !== id)
    this.slots.delete(id)
    this.flush()
  }

  /** 清空所有账号。 */
  async clear(): Promise<void> {
    await this.ensureLoaded()
    this.document = { version: 1, order: [], accounts: {} }
    this.slots.clear()
    this.flush()
  }

  /** 暂停/恢复一个账号。 */
  async setPaused(id: string, paused: boolean): Promise<boolean> {
    await this.ensureLoaded()
    const credential = this.doc.accounts[id]
    if (credential === undefined) return false
    this.doc.accounts[id] = { ...credential, paused }
    this.slots.get(id)?.replace(this.doc.accounts[id] as DevecoCredential)
    this.flush()
    return true
  }

  /** 置顶/取消置顶一个账号。 */
  async setPinned(id: string, pinned: boolean): Promise<boolean> {
    await this.ensureLoaded()
    const credential = this.doc.accounts[id]
    if (credential === undefined) return false
    this.doc.accounts[id] = { ...credential, pinned }
    this.slots.get(id)?.replace(this.doc.accounts[id] as DevecoCredential)
    this.flush()
    return true
  }

  /** 改备注名。 */
  async setLabel(id: string, label: string): Promise<boolean> {
    await this.ensureLoaded()
    const credential = this.doc.accounts[id]
    if (credential === undefined) return false
    const trimmed = label.trim()
    this.doc.accounts[id] = trimmed === ''
      ? (() => {
          const { label: _dropped, ...rest } = credential
          return rest
        })()
      : { ...credential, label: trimmed }
    this.slots.get(id)?.replace(this.doc.accounts[id] as DevecoCredential)
    this.flush()
    return true
  }

  /**
   * 解析一个账号，拿到可直接用的访问令牌（必要时静默续期）。
   *
   * @returns 解析结果；账号不存在、被暂停或确实需要重新登录时 undefined。
   */
  async resolve(id: string): Promise<ResolvedDevecoCredential | undefined> {
    await this.ensureLoaded()
    const credential = this.doc.accounts[id]
    if (credential === undefined) return undefined
    const slot = this.slot(id, credential)
    const accessToken = await slot.accessToken()
    if (accessToken === undefined) return undefined
    const fresh = slot.current()
    return {
      id,
      credential: fresh,
      accessToken,
      ...fresh.userName === undefined ? {} : { userName: fresh.userName },
      ...fresh.userId === undefined ? {} : { userId: fresh.userId },
    }
  }

  /** 强制续期一个账号（卡片上的「刷新凭证」按钮）。 */
  async forceRefresh(id: string): Promise<boolean> {
    await this.ensureLoaded()
    const credential = this.doc.accounts[id]
    if (credential === undefined) return false
    const outcome = await this.slot(id, credential).forceRefresh()
    return outcome !== undefined
  }

  /** 上游明确拒了这条凭证：标成 stale，等用户重新登录。 */
  async markRejected(id: string, reason: string): Promise<void> {
    await this.ensureLoaded()
    const credential = this.doc.accounts[id]
    if (credential === undefined) return
    this.slot(id, credential).noteRejected(reason)
  }

  /**
   * 上游拿这张 accessToken 回了 401 —— 交给 slot 记一个 TTL 上界样本。
   *
   * 只采样、不改账号状态：是否判死由调用方根据「刷新能否成功」决定。
   */
  async noteTokenWorked(id: string, issuedAt?: number): Promise<void> {
    await this.ensureLoaded()
    const credential = this.doc.accounts[id]
    if (credential === undefined) return
    this.slot(id, credential).noteTokenWorked(issuedAt)
  }

  async noteTokenExpired(id: string): Promise<void> {
    await this.ensureLoaded()
    const credential = this.doc.accounts[id]
    if (credential === undefined) return
    this.slot(id, credential).recordExpiredToken()
  }

  /** 从磁盘重读（另一个进程/用户手工改了文档时）。 */
  async reloadFromDisk(): Promise<boolean> {
    const before = JSON.stringify(this.doc)
    this.document = undefined
    this.loading = undefined
    this.slots.clear()
    await this.ensureLoaded()
    return JSON.stringify(this.doc) !== before
  }

  /**
   * 保活：把所有「访问令牌快过期」的账号提前续掉。
   *
   * 这一轮**只续 accessToken**，不动 jwtToken 的寿命 —— jwtToken 什么时候过期由上游
   * 决定，过期只能重新登录。它的价值是：DSH 开机放一整天不聊天时，第一个请求不必
   * 先等一次续期，同时把「哪个号已经废了」提前暴露在卡片上。
   */
  /**
   * @param options.skip 返回 true 的账号本轮不碰。
   *
   * 后台续期最忌讳「账号正有请求在飞时给它换令牌」：很多网关签发新 accessToken 就会让
   * 旧的那张失效，正在流式输出的请求会当场被上游判「密钥无效」而中断 —— 这正是
   * 「推理到一半突然密钥无效」的典型来源。所以有在飞请求的账号一律跳过，等它空下来。
   */
  async keepAlive(options: { skip?: (id: string) => boolean } = {}): Promise<{ checked: number; refreshed: number; needsLogin: string[] }> {
    await this.ensureLoaded()
    const ids = this.doc.order.filter(id => this.doc.accounts[id]?.stale !== true && options.skip?.(id) !== true)
    let refreshed = 0
    const needsLogin: string[] = []
    for (const id of ids) {
      const credential = this.doc.accounts[id]
      if (credential === undefined) continue
      const slot = this.slot(id, credential)
      const before = slot.current().accessToken
      const token = await slot.accessToken()
      if (token === undefined) {
        needsLogin.push(id)
        continue
      }
      if (token !== before) refreshed += 1
    }
    return { checked: ids.length, refreshed, needsLogin }
  }
}
