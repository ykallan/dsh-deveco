/**
 * 本机用量台账。
 *
 * 只记**本机经这个插件发出去的**请求：上游不提供用量接口（见 `docs/PROTOCOL.md` 第 6 节），
 * 所以「今天用了多少」只能自己攒。它是估算的、不完整的（其它设备/IDE 的用量不在里面），
 * 卡片上必须这么标，不能写成「账号总额度」。
 *
 * 口径：
 *  - `requests` 发出去的生成请求数（含失败）；
 *  - `inputTokens` / `outputTokens` 来自上游响应体里的 `usage`（流式取最后一个带的块）；
 *  - `today` 按**额度窗口**归零（上游每天在固定整点重置免费额度，不是自然日零点，
 *    见 `quota.ts`），同时保留 `totals` 全量。
 *
 * @module dsh-deveco/usage
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { quotaWindowKey } from './quota.ts'

/** 累计计数。 */
export interface UsageTotals {
  requests: number
  failures: number
  inputTokens: number
  outputTokens: number
}

/** 一条最近请求记录（不含任何内容）。 */
export interface UsageEvent {
  at: number
  account: string
  model: string
  ok: boolean
  ms: number
  inputTokens?: number
  outputTokens?: number
}

/** 台账快照，给卡片/路由用。 */
export interface UsageSnapshot {
  /** 统计口径说明（卡片直接展示，避免误读成账号总额度）。 */
  scope: 'local'
  day: string
  totals: UsageTotals
  today: UsageTotals
  byAccount: Record<string, UsageTotals>
  byModel: Record<string, UsageTotals>
  recent: readonly UsageEvent[]
}

interface UsageDocument extends UsageSnapshot {
  version: 1
  updatedAt: number
}

const EMPTY_TOTALS: UsageTotals = { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0 }

/**
 * 本地**自然日**键 `YYYY-MM-DD`。
 *
 * 只给签到台账用（签到是人的习惯，按自然日数连续天数）。用量分桶走
 * `quotaWindowKey()`，因为上游的免费额度是按固定整点重置的。
 */
export function localDayKey(at: number = Date.now()): string {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function addTotals(target: UsageTotals, event: { ok: boolean; inputTokens?: number; outputTokens?: number }): UsageTotals {
  return {
    requests: target.requests + 1,
    failures: target.failures + (event.ok ? 0 : 1),
    inputTokens: target.inputTokens + (event.inputTokens ?? 0),
    outputTokens: target.outputTokens + (event.outputTokens ?? 0),
  }
}

/** 保留多少条最近记录。 */
const RECENT_LIMIT = 100

export class DevecoUsageTracker {
  private readonly path: string
  private document: UsageDocument = {
    version: 1,
    scope: 'local',
    day: quotaWindowKey(),
    totals: { ...EMPTY_TOTALS },
    today: { ...EMPTY_TOTALS },
    byAccount: {},
    byModel: {},
    recent: [],
    updatedAt: Date.now(),
  }

  private loaded = false
  private flushTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: { path: string }) {
    this.path = options.path
  }

  /** 读盘。失败/文件缺失都不影响插件启动。 */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<UsageDocument>
      if (typeof parsed !== 'object' || parsed === null) return
      this.document = {
        version: 1,
        scope: 'local',
        day: typeof parsed.day === 'string' ? parsed.day : quotaWindowKey(),
        totals: normalizeTotals(parsed.totals),
        today: normalizeTotals(parsed.today),
        byAccount: normalizeBuckets(parsed.byAccount),
        byModel: normalizeBuckets(parsed.byModel),
        recent: Array.isArray(parsed.recent) ? parsed.recent.slice(-RECENT_LIMIT) : [],
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      }
      this.rollDay()
    } catch {
      // 台账坏了不该拦住使用：从空账本继续。
    }
  }

  /** 记一次请求。 */
  record(event: Omit<UsageEvent, 'at'> & { at?: number }): void {
    const at = event.at ?? Date.now()
    this.rollDay()
    const full: UsageEvent = {
      at,
      account: event.account,
      model: event.model,
      ok: event.ok,
      ms: event.ms,
      ...event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens },
      ...event.outputTokens === undefined ? {} : { outputTokens: event.outputTokens },
    }
    this.document.totals = addTotals(this.document.totals, full)
    this.document.today = addTotals(this.document.today, full)
    this.document.byAccount[full.account] = addTotals(
      this.document.byAccount[full.account] ?? { ...EMPTY_TOTALS },
      full,
    )
    this.document.byModel[full.model] = addTotals(
      this.document.byModel[full.model] ?? { ...EMPTY_TOTALS },
      full,
    )
    this.document.recent = [...this.document.recent.slice(-(RECENT_LIMIT - 1)), full]
    this.document.updatedAt = at
    this.scheduleFlush()
  }

  /** 立刻落盘（插件停用时调）。 */
  async flush(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const temp = `${this.path}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(this.document, undefined, 2)}\n`, 'utf8')
    renameSync(temp, this.path)
  }

  /** 当前快照。 */
  snapshot(): UsageSnapshot {
    this.rollDay()
    return {
      scope: 'local',
      day: this.document.day,
      totals: { ...this.document.totals },
      today: { ...this.document.today },
      byAccount: { ...this.document.byAccount },
      byModel: { ...this.document.byModel },
      recent: [...this.document.recent].reverse(),
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flush().catch(() => {})
    }, 2_000)
    this.flushTimer.unref?.()
  }

  /** 跨天把 `today` 归零（`totals` 保留）。 */
  private rollDay(): void {
    const day = quotaWindowKey()
    if (day === this.document.day) return
    this.document.day = day
    this.document.today = { ...EMPTY_TOTALS }
  }
}

function normalizeTotals(value: unknown): UsageTotals {
  if (typeof value !== 'object' || value === null) return { ...EMPTY_TOTALS }
  const raw = value as Partial<UsageTotals>
  return {
    requests: numberOr0(raw.requests),
    failures: numberOr0(raw.failures),
    inputTokens: numberOr0(raw.inputTokens),
    outputTokens: numberOr0(raw.outputTokens),
  }
}

function normalizeBuckets(value: unknown): Record<string, UsageTotals> {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, UsageTotals> = {}
  for (const [key, entry] of Object.entries(value)) out[key] = normalizeTotals(entry)
  return out
}

function numberOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}
