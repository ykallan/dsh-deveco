/**
 * 每日签到。
 *
 * **先说清楚上游事实**：DevEco（CodeGenie MaaS）没有任何积分/福利/领取接口，也**不需要**
 * 「领」—— 免费额度按自然日自动重置（每日 08:00 左右，实测）。opencode-deveco 与
 * deveco-code 两个仓库里都不存在签到/领取/积分/quota 端点（见 `docs/PROTOCOL.md` 第 6 节）。
 *
 * 所以这个插件里的「签到」是一件事**真能做到**的事，而不是伪造一次领取：
 *
 * 1. 对每个账号发一次轻量但**需要鉴权**的请求（`modelConfig`）——它同时证明
 *    「凭证今天还有效」和「模型目录今天能拿到」；
 * 2. 把结果按自然日留档，算出连续签到天数；
 * 3. 签到失败（凭证被拒）会立刻把账号标成 stale，让卡片直接给出「重新登录」。
 *
 * 换言之：这是一次**每天一次的账号体检**，不是一个虚假的奖励按钮。卡片上也是这么写的。
 *
 * @module dsh-deveco/checkin
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fetchModelConfig } from './discovery.ts'
import { localDayKey } from './usage.ts'
import type { DevecoAccountStore } from './auth.ts'

/** 一个账号某一天的签到结果。 */
export interface CheckinRecord {
  at: number
  /** 凭证有效且能拉到模型目录。 */
  ok: boolean
  /** 当天拉到的模型数（ok 时有意义）。 */
  models: number
  /** 失败原因。 */
  message?: string
}

/** 台账快照。 */
export interface CheckinSnapshot {
  /** 今天（本地自然日）。 */
  day: string
  /** 今天各账号的结果。 */
  today: Record<string, CheckinRecord>
  /** 各账号连续签到天数（含今天）。 */
  streaks: Record<string, number>
  /** 最近 30 天里有签到的日期（倒序）。 */
  days: string[]
}

/** 单账号签到结果，给路由/卡片用。 */
export interface CheckinAccountResult extends CheckinRecord {
  id: string
  /** 今天之前是否已经签过（幂等，重复点不再打上游）。 */
  alreadyCheckedToday: boolean
}

/** 一次签到的汇总。 */
export interface CheckinOutcome {
  day: string
  results: CheckinAccountResult[]
  /** 至少一个账号签成功。 */
  ok: boolean
  /** 本次真的打了上游的账号数。 */
  probed: number
  message: string
}

interface CheckinDocument {
  version: 1
  /** day → accountId → record */
  days: Record<string, Record<string, CheckinRecord>>
}

/** 台账保留天数。 */
const KEEP_DAYS = 90

/** 按本地自然日倒推的日期键（`offset` 天前）。 */
function dayKeyOffset(offset: number, now = Date.now()): string {
  return localDayKey(now - offset * 24 * 60 * 60 * 1000)
}

export class DevecoCheckinLedger {
  private readonly path: string
  private document: CheckinDocument = { version: 1, days: {} }
  private loaded = false

  constructor(options: { path: string }) {
    this.path = options.path
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<CheckinDocument>
      const days: Record<string, Record<string, CheckinRecord>> = {}
      for (const [day, value] of Object.entries(parsed.days ?? {})) {
        if (typeof value !== 'object' || value === null) continue
        const records: Record<string, CheckinRecord> = {}
        for (const [id, record] of Object.entries(value)) {
          if (typeof record !== 'object' || record === null) continue
          const raw = record as Partial<CheckinRecord>
          records[id] = {
            at: typeof raw.at === 'number' ? raw.at : 0,
            ok: raw.ok === true,
            models: typeof raw.models === 'number' ? raw.models : 0,
            ...typeof raw.message === 'string' ? { message: raw.message } : {},
          }
        }
        days[day] = records
      }
      this.document = { version: 1, days: this.prune(days) }
    } catch {
      // 台账坏了从空开始，不影响签到本身。
    }
  }

  private prune(days: Record<string, Record<string, CheckinRecord>>): Record<string, Record<string, CheckinRecord>> {
    const keys = Object.keys(days).sort()
    if (keys.length <= KEEP_DAYS) return days
    const keep = new Set(keys.slice(-KEEP_DAYS))
    const out: Record<string, Record<string, CheckinRecord>> = {}
    for (const key of keys) if (keep.has(key)) out[key] = days[key] as Record<string, CheckinRecord>
    return out
  }

  private flush(): void {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const temp = `${this.path}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(this.document, undefined, 2)}\n`, 'utf8')
    renameSync(temp, this.path)
  }

  /** 某账号今天的记录。 */
  todayRecord(accountId: string, now = Date.now()): CheckinRecord | undefined {
    this.ensureLoaded()
    return this.document.days[localDayKey(now)]?.[accountId]
  }

  /** 写入一条记录（同一天同账号覆盖）。 */
  record(accountId: string, record: CheckinRecord, now = Date.now()): void {
    this.ensureLoaded()
    const day = localDayKey(now)
    const bucket = this.document.days[day] ?? {}
    bucket[accountId] = record
    this.document.days[day] = bucket
    this.document.days = this.prune(this.document.days)
    this.flush()
  }

  /**
   * 连续签到天数：从今天往回数，**只要当天有成功记录**就继续。
   *
   * 今天还没签时从昨天开始数（这样「今天还没签」不会把连续天数显示成 0）。
   */
  streak(accountId: string, now = Date.now()): number {
    this.ensureLoaded()
    const today = localDayKey(now)
    const todayOk = this.document.days[today]?.[accountId]?.ok === true
    let offset = todayOk ? 0 : 1
    let streak = 0
    // 最多往回数 KEEP_DAYS 天，避免台账被手工改坏时死循环。
    while (offset < KEEP_DAYS) {
      const key = dayKeyOffset(offset, now)
      const record = this.document.days[key]?.[accountId]
      if (record?.ok !== true) break
      streak += 1
      offset += 1
    }
    return streak
  }

  /** 台账快照。 */
  snapshot(accountIds: readonly string[], now = Date.now()): CheckinSnapshot {
    this.ensureLoaded()
    const day = localDayKey(now)
    const streaks: Record<string, number> = {}
    for (const id of accountIds) streaks[id] = this.streak(id, now)
    const days = Object.keys(this.document.days)
      .filter(key => Object.values(this.document.days[key] ?? {}).some(record => record.ok))
      .sort((a, b) => (a < b ? 1 : -1))
      .slice(0, 30)
    return {
      day,
      today: { ...(this.document.days[day] ?? {}) },
      streaks,
      days,
    }
  }
}

/**
 * 执行一次签到。
 *
 * - `accountId` 省略 = 所有账号；
 * - 今天已经签过（且成功）的账号默认跳过，不重复打上游（`force: true` 可强制重签）；
 * - 凭证被上游拒绝时把账号标成 stale —— 签到本来就是「这个号今天还能不能用」的体检，
 *   发现问题却不在卡片上体现，那这个功能就白做了。
 */
export async function runCheckin(
  store: DevecoAccountStore,
  ledger: DevecoCheckinLedger,
  options: { accountId?: string; force?: boolean; signal?: AbortSignal } = {},
): Promise<CheckinOutcome> {
  const ids = options.accountId === undefined ? await store.ids() : [options.accountId]
  const day = localDayKey()
  const results: CheckinAccountResult[] = []
  let probed = 0
  for (const id of ids) {
    const existing = ledger.todayRecord(id)
    if (existing?.ok === true && options.force !== true) {
      results.push({ id, ...existing, alreadyCheckedToday: true })
      continue
    }
    probed += 1
    try {
      const resolved = await store.resolve(id)
      if (resolved === undefined) {
        const record: CheckinRecord = { at: Date.now(), ok: false, models: 0, message: 'account needs sign-in' }
        ledger.record(id, record)
        results.push({ id, ...record, alreadyCheckedToday: false })
        continue
      }
      const probe = await fetchModelConfig(resolved.accessToken, options.signal).then(
        fetched => ({ ok: true, models: fetched.models.length, message: undefined }),
        (error: unknown) => ({
          ok: false,
          models: 0,
          message: error instanceof Error ? error.message : String(error),
        }),
      )
      const record: CheckinRecord = {
        at: Date.now(),
        ok: probe.ok,
        models: probe.models,
        ...probe.message === undefined ? {} : { message: probe.message },
      }
      ledger.record(id, record)
      if (!probe.ok && probe.message !== undefined && /unauthor|forbidden|401|403/i.test(probe.message)) {
        await store.markRejected(id, `check-in failed: ${probe.message}`)
      }
      results.push({ id, ...record, alreadyCheckedToday: false })
    } catch (error: unknown) {
      const record: CheckinRecord = {
        at: Date.now(),
        ok: false,
        models: 0,
        message: error instanceof Error ? error.message : String(error),
      }
      ledger.record(id, record)
      results.push({ id, ...record, alreadyCheckedToday: false })
    }
  }
  const ok = results.some(result => result.ok)
  const claimed = results.filter(result => result.ok && !result.alreadyCheckedToday).length
  return {
    day,
    results,
    ok,
    probed,
    message: buildMessage(results, ok, claimed),
  }
}

function buildMessage(results: readonly CheckinAccountResult[], ok: boolean, checked: number): string {
  if (results.length === 0) return 'no account to check in'
  if (ok) {
    return checked === 0
      ? 'already checked in today'
      : `checked in ${checked} account${checked === 1 ? '' : 's'}`
  }
  const firstError = results.find(result => !result.ok)?.message
  return firstError === undefined ? 'check-in failed' : `check-in failed: ${firstError}`
}
