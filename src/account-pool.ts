/**
 * 账号池：把多个 DevEco 账号编成一个可轮转的池。
 *
 * 为什么要多账号：上游对**每个账号**只同时允许一个生成任务（多出来的排队）。单个号
 * 在长回答里被占住时，多一个号就能直接换过去，而不是陪着一起等。
 *
 * 池只记「谁现在能接活」：槽位计数、健康/冷却、暂停与置顶。凭证本身在
 * `auth.ts` 的账号文档里 —— 池不读磁盘，也不碰令牌。
 *
 * @module dsh-deveco/account-pool
 */

/** 单账号默认并发上限。上游给 1 个生成位，多留会直接把请求推到排队。 */
export const DEFAULT_MAX_CONCURRENT = 1

/** 连续出错多少次后短时冷却。 */
export const ERROR_THRESHOLD = 3

/** 一次失败的默认冷却时长。 */
export const DEFAULT_COOLDOWN_MS = 30_000

/** 池里一个账号的运行时状态。 */
export interface AccountRuntime {
  id: string
  /** 我们这边正在飞的请求数。 */
  activeConcurrent: number
  maxConcurrent: number
  /** 冷却截止时间（epoch ms）；0 = 没在冷却。 */
  coolUntil: number
  /** 凭据失效等硬错误：停用，等用户重新登录。 */
  disabled: boolean
  lastError?: string
  /** 上次被选中的时间，用于「最久未用优先」。 */
  lastUsed: number
  errorCount: number
}

export interface PoolOptions {
  maxConcurrent?: number
  /** 可注入的时钟，便于测试。 */
  now?: () => number
}

export class DevecoAccountPool {
  private readonly accounts = new Map<string, AccountRuntime>()
  /** 用户手动暂停的账号：运行时状态留着（卡片还看得见槽位），但不参与轮转。 */
  private readonly paused = new Set<string>()
  /** 用户置顶的账号：选号时排在最前面。 */
  private readonly preferred = new Set<string>()
  private readonly maxConcurrent: number
  private readonly now: () => number
  /** 等槽位的唤醒器：槽位释放 / 池里新增账号 / 账号复活时逐个唤醒。 */
  private readonly waiters = new Set<() => void>()

  constructor(ids: readonly string[], options: PoolOptions = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)
    this.now = options.now ?? (() => Date.now())
    this.sync(ids)
  }

  /** 让池与账号文档对齐：新增的进来，删掉的出去。已有账号的运行时状态保留。 */
  sync(ids: readonly string[]): void {
    const wanted = new Set(ids)
    const before = this.accounts.size
    for (const id of [...this.accounts.keys()]) {
      if (!wanted.has(id)) this.accounts.delete(id)
    }
    for (const id of ids) {
      if (this.accounts.has(id)) continue
      this.accounts.set(id, {
        id,
        activeConcurrent: 0,
        maxConcurrent: this.maxConcurrent,
        coolUntil: 0,
        disabled: false,
        lastUsed: 0,
        errorCount: 0,
      })
    }
    if (this.accounts.size !== before) this.notifyWaiters()
  }

  list(): AccountRuntime[] {
    return [...this.accounts.values()]
  }

  get(id: string): AccountRuntime | undefined {
    return this.accounts.get(id)
  }

  /** 账号本身可用（没被禁用、不在冷却中）。 */
  healthy(id: string): boolean {
    const account = this.accounts.get(id)
    if (account === undefined) return false
    return !account.disabled && this.now() >= account.coolUntil
  }

  /** 现在就能接活的账号：置顶优先，其余按「最久未用」。 */
  private available(exclude: ReadonlySet<string>): AccountRuntime[] {
    const now = this.now()
    return this.list()
      .filter(account =>
        !account.disabled
        && !this.paused.has(account.id)
        && now >= account.coolUntil
        && !exclude.has(account.id)
        && account.activeConcurrent < account.maxConcurrent)
      .sort((a, b) => {
        const pinned = Number(this.preferred.has(b.id)) - Number(this.preferred.has(a.id))
        return pinned !== 0 ? pinned : a.lastUsed - b.lastUsed
      })
  }

  /** 设置暂停集合（账号 id）。 */
  setPaused(ids: readonly string[]): void {
    this.paused.clear()
    for (const id of ids) this.paused.add(id)
    this.notifyWaiters()
  }

  pausedIds(): string[] {
    return [...this.paused]
  }

  /** 设置置顶集合（账号 id）。置顶只在「同时可用」时改变先后，不绕过冷却/上限。 */
  setPreferred(ids: readonly string[]): void {
    this.preferred.clear()
    for (const id of ids) this.preferred.add(id)
  }

  preferredIds(): string[] {
    return [...this.preferred]
  }

  /** 选一个账号（跳过 `exclude` 里的）。 */
  pick(exclude: ReadonlySet<string> = new Set()): string | undefined {
    return this.available(exclude)[0]?.id
  }

  /** 占一个本地槽位。占用失败（已满/不存在）返回 false。 */
  acquire(id: string): boolean {
    const account = this.accounts.get(id)
    if (account === undefined) return false
    if (account.activeConcurrent >= account.maxConcurrent) return false
    account.activeConcurrent += 1
    account.lastUsed = this.now()
    return true
  }

  /** 释放槽位；重复释放不会把计数压到负数。 */
  release(id: string): void {
    const account = this.accounts.get(id)
    if (account === undefined) return
    if (account.activeConcurrent > 0) account.activeConcurrent -= 1
    this.notifyWaiters()
  }

  private notifyWaiters(): void {
    for (const waiter of [...this.waiters]) {
      try {
        waiter()
      } catch {
        // 等待器自己负责兜底；这里只保证通知链不断。
      }
    }
  }

  /** 现在是否有一个真正能接活的空槽位。 */
  hasFreeSlot(): boolean {
    const now = this.now()
    return this.list().some(account =>
      !account.disabled
      && !this.paused.has(account.id)
      && now >= account.coolUntil
      && account.activeConcurrent < account.maxConcurrent)
  }

  /** 有没有「健康、但本地槽位被占满」的号 —— 只有这种值得等一会儿。 */
  hasBusyWaitable(): boolean {
    const now = this.now()
    return this.list().some(account =>
      !account.disabled
      && !this.paused.has(account.id)
      && now >= account.coolUntil
      && account.activeConcurrent >= account.maxConcurrent)
  }

  /** 等一个本地槽位空出来，最多 `maxWaitMs`。 */
  waitForFreeSlot(maxWaitMs: number, signal?: AbortSignal): Promise<boolean> {
    if (this.hasFreeSlot()) return Promise.resolve(true)
    if (!this.hasBusyWaitable() || maxWaitMs <= 0) return Promise.resolve(false)
    if (signal?.aborted === true) return Promise.resolve(false)
    return new Promise<boolean>(resolve => {
      let settled = false
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        this.waiters.delete(check)
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const check = (): void => {
        if (this.hasFreeSlot()) finish(true)
      }
      const onAbort = (): void => finish(false)
      const timer = setTimeout(() => finish(false), maxWaitMs)
      timer.unref?.()
      this.waiters.add(check)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** 凭据失效等硬错误：直接停用，等用户重新登录。 */
  disable(id: string, reason: string): void {
    const account = this.accounts.get(id)
    if (account === undefined) return
    account.disabled = true
    account.lastError = reason
  }

  /** 用户重新登录后调用：把账号从禁用/冷却里捞出来。 */
  revive(id: string): void {
    const account = this.accounts.get(id)
    if (account === undefined) return
    account.disabled = false
    account.coolUntil = 0
    account.errorCount = 0
    account.lastError = undefined
    this.notifyWaiters()
  }

  /** 上游 5xx / 软限流：短时冷却。 */
  cooldown(id: string, ms: number, reason: string): void {
    const account = this.accounts.get(id)
    if (account === undefined) return
    account.coolUntil = this.now() + ms
    account.lastError = reason
  }

  /** 累计错误；达到阈值就冷却。 */
  noteError(id: string, threshold: number, cooldownMs: number, reason: string): void {
    const account = this.accounts.get(id)
    if (account === undefined) return
    account.errorCount += 1
    account.lastError = reason
    if (threshold > 0 && account.errorCount >= threshold) {
      account.coolUntil = this.now() + cooldownMs
    }
  }

  /** 一次成功：清掉错误计数与冷却。 */
  noteSuccess(id: string): void {
    const account = this.accounts.get(id)
    if (account === undefined) return
    account.errorCount = 0
    account.coolUntil = 0
    account.lastError = undefined
  }

  /** 有没有任何账号可用（含被暂停之外的）。 */
  hasUsable(): boolean {
    const now = this.now()
    return this.list().some(account => !account.disabled && now >= account.coolUntil)
  }
}
