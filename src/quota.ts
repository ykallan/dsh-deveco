/**
 * 额度窗口与「额度用尽」状态。
 *
 * **上游没有额度查询接口。** `codeGenie/modelConfig`、`tempToken`、`jwToken`、聊天、
 * `exitSessionQueue` —— DevEco 一共只暴露这几个端点，没有任何一个会告诉你「还剩多少」。
 * 额度用尽的唯一信号是聊天请求被拒：`403 UserRateLimit` / 响应体里的
 * `FreeUsageLimitError`，或者被限流时的 429。所以这里只能做两件事：
 *
 * 1. **按上游的重置时刻划分「额度窗口」**。免费额度每天固定时刻清零（实测为本地 08:00），
 *    不是自然日零点；用自然日统计「今天用了多少」会和服务端对不上。
 * 2. **记住哪个账号在本窗口内被上游判过额度用尽**，窗口一换自动作废。
 *
 * 界面上因此**不显示「剩余额度」**这类假数字，只显示：本窗口本机用了多少、窗口什么时候
 * 重置、哪个号被上游挡过。「刷新额度」按钮做的事情是重新探测账号可用性 —— 它不可能
 * 变出更多额度，这一点必须写在按钮旁边，而不是让用户点了才发现。
 *
 * @module dsh-deveco/quota
 */

import { envNumber } from './config.ts'

/**
 * 额度每天在这个整点（本地时间）重置。
 *
 * 不是自然日零点：多个实测记录都指向 08:00。允许用 `DEVECO_QUOTA_RESET_HOUR` 覆盖，
 * 因为这是上游行为，随时可能调整。
 */
export const DEFAULT_QUOTA_RESET_HOUR = 8

/** 当前配置的重置整点（0–23）。 */
export function quotaResetHour(): number {
  const hour = envNumber('DEVECO_QUOTA_RESET_HOUR', DEFAULT_QUOTA_RESET_HOUR)
  return hour >= 0 && hour <= 23 ? Math.floor(hour) : DEFAULT_QUOTA_RESET_HOUR
}

/** 一个额度窗口。 */
export interface QuotaWindow {
  /** 窗口键（窗口开始那天，`YYYY-MM-DD`）。 */
  key: string
  /** 窗口开始时刻（epoch ms）。 */
  start: number
  /** 下一次重置时刻（epoch ms）。 */
  end: number
  /** 展示用：`11-15 08:00 → 11-16 08:00`。 */
  label: string
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 算出 `now` 落在哪个额度窗口里。
 *
 * 边界处理：今天还没到重置时刻（例如 07:59）时，当前窗口是「昨天 08:00 开始」的那个，
 * 而不是「今天 08:00」—— 否则每天开盘前都会把窗口算到未来去。
 */
export function quotaWindow(now: number = Date.now(), resetHour: number = quotaResetHour()): QuotaWindow {
  const date = new Date(now)
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), resetHour, 0, 0, 0)
  if (start.getTime() > now) start.setDate(start.getDate() - 1)
  const end = new Date(start.getTime())
  end.setDate(end.getDate() + 1)
  const key = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`
  const label = `${pad(start.getMonth() + 1)}-${pad(start.getDate())} ${pad(resetHour)}:00 → `
    + `${pad(end.getMonth() + 1)}-${pad(end.getDate())} ${pad(resetHour)}:00`
  return { key, start: start.getTime(), end: end.getTime(), label }
}

/** 当前额度窗口的键（用量台账按它分桶）。 */
export function quotaWindowKey(now: number = Date.now()): string {
  return quotaWindow(now).key
}

/** 距离重置还剩多久，`13小时47分` 这种写法。 */
export function formatQuotaRemaining(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '即将重置'
  const totalMinutes = Math.floor(ms / 60_000)
  const days = Math.floor(totalMinutes / (60 * 24))
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
  if (minutes > 0) return `${minutes} 分`
  return '不到 1 分钟'
}

/** 单个账号在本窗口内的额度状态。 */
export interface QuotaAccountState {
  id: string
  /** 属于哪个窗口；窗口一换旧状态作废。 */
  window: string
  /** 上游在本窗口内明确说过「额度用尽」。 */
  exhausted: boolean
  /** 最近一次判定的时刻。 */
  at: number
  /** 上游给的原文（诊断用，可能为空）。 */
  message?: string
}

/** 给卡片用的额度快照。 */
export interface QuotaSnapshot {
  window: QuotaWindow
  /** 距离重置还剩多少毫秒。 */
  resetInMs: number
  /** 距离重置还剩多久（已格式化）。 */
  resetIn: string
  /** 本窗口内被上游挡过的账号 id。 */
  exhausted: string[]
  /** 各账号的状态（只包含被记录过的）。 */
  accounts: Record<string, QuotaAccountState>
  /**
   * 上游有没有「剩余额度」接口。恒为 false，写进数据里是为了让界面不必猜、也不必
   * 硬编码一句会被改掉的文案。
   */
  hasUpstreamEndpoint: false
}

/**
 * 判断一次上游失败是不是「今日免费额度用尽」。
 *
 * 与「过载」「普通限流」区分开：上游服务过载会回 `403 ModelServiceError`
 * （`Built-in model service is currently overloaded` / `Full inference timed out`），
 * 那是**别人**把机器占满了，不是你的额度没了，不该记成额度用尽。
 */
export function looksLikeQuotaExhausted(status: number, message: string): boolean {
  const text = message.toLowerCase()
  if (/overloaded|full inference timed out|service is currently overloaded/.test(text)) return false
  if (/freeusagelimiterror|free usage|insufficient_quota|usage_not_included|quota exceeded/.test(text)) return true
  if (/额度|配额/.test(message)) return true
  if (status === 403 && /userratelimit|rate limit|too many requests|rate increased too quickly/.test(text)) return true
  if (status === 429) return true
  return false
}

/**
 * 记录「谁的额度用尽了」。
 *
 * 只活在内存里：窗口一换所有状态作废，重启后重新学习。刻意不落盘 —— 一个过期状态被
 * 当成事实显示在卡片上，比「暂时不知道」更糟。
 */
export class DevecoQuotaTracker {
  private readonly states = new Map<string, QuotaAccountState>()
  private readonly now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now())
  }

  /** 上游判了这个账号本窗口的额度用尽。 */
  noteExhausted(id: string, message: string): void {
    const window = quotaWindowKey(this.now())
    this.states.set(id, {
      id,
      window,
      exhausted: true,
      at: this.now(),
      ...message === '' ? {} : { message: message.length > 300 ? `${message.slice(0, 300)}…` : message },
    })
  }

  /** 一次成功 = 这个号本窗口没被卡住（同时把过期的「用尽」清掉）。 */
  noteOk(id: string): void {
    const window = quotaWindowKey(this.now())
    const current = this.states.get(id)
    if (current === undefined) return
    if (current.window !== window || current.exhausted) this.states.delete(id)
  }

  /** 某账号本窗口的状态（跨窗口的旧记录视为没有）。 */
  state(id: string): QuotaAccountState | undefined {
    const window = quotaWindowKey(this.now())
    const current = this.states.get(id)
    if (current === undefined) return undefined
    if (current.window !== window) {
      this.states.delete(id)
      return undefined
    }
    return current
  }

  /** 快照（`ids` 用于计算「有哪些号被挡过」，顺序稳定）。 */
  snapshot(ids: readonly string[], now: number = this.now()): QuotaSnapshot {
    const window = quotaWindow(now)
    const accounts: Record<string, QuotaAccountState> = {}
    const exhausted: string[] = []
    for (const id of ids) {
      const state = this.state(id)
      if (state === undefined) continue
      accounts[id] = state
      if (state.exhausted) exhausted.push(id)
    }
    return {
      window,
      resetInMs: Math.max(0, window.end - now),
      resetIn: formatQuotaRemaining(window.end - now),
      exhausted,
      accounts,
      hasUpstreamEndpoint: false,
    }
  }
}

/** 一次手动「刷新额度」的结果（重新探测可用性，不是查余额）。 */
export interface QuotaRefreshResult {
  /** 至少一个账号探测通过。 */
  ok: boolean
  /** 探测了几个账号。 */
  probed: number
  accounts: { id: string; ok: boolean; models: number; message?: string; exhausted: boolean }[]
  snapshot: QuotaSnapshot
  /** 一句话结论，卡片直接显示。 */
  message: string
}
