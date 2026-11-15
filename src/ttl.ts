/**
 * accessToken 的**有效期自适应学习**。
 *
 * 上游从不告诉我们 accessToken 能活多久（token 是不透明字符串，响应里也没有 `expiresIn`），
 * 之前用的 30 分钟是从参考实现沿用的一个假设。这里改成从**实际行为**里学：
 *
 *  1. **上界样本**：某个令牌在「签发后 A 分钟」被上游 401 拒绝 → 真实 TTL ≈ A。多来几次取中位数。
 *  2. **下界样本**：某个令牌在「签发后 A 分钟」还能正常用 → TTL ≥ A。这能纠正「假设偏短」的情况。
 *  3. 样本足够（≥2 个上界样本）才覆盖默认值；否则用下界把默认值往上抬；都没有就用默认 30 分钟。
 *
 * 「不要频繁刷新」由两处保证：一是提前量按 TTL 的比例取（并封顶 10 分钟），二是每个账号有
 * 最小刷新间隔（`MIN_REFRESH_INTERVAL_MS`），同一张令牌不会被反复重刷。
 *
 * @module dsh-deveco/ttl
 */

/** 没有样本时的默认假设（参考实现实测值）。 */
export const TTL_FALLBACK_MS = 30 * 60 * 1000
/** 学到的 TTL 允许范围：太小是脏样本，太大说明判据错了。 */
export const TTL_MIN_MS = 3 * 60 * 1000
export const TTL_MAX_MS = 24 * 60 * 60 * 1000
/** 保留多少个上界样本（取中位数，抗单点抖动）。 */
export const TTL_SAMPLE_KEEP = 5
/** 至少几个上界样本才敢覆盖默认值。 */
export const TTL_MIN_SAMPLES = 2
/** 同一账号两次刷新之间的最小间隔，避免「刷新风暴」。 */
export const MIN_REFRESH_INTERVAL_MS = 60 * 1000
/**
 * 每账号「主动刷新」的最小间隔（用户要求：5 分钟内最多 1 次）。
 *
 * 只约束**主动/后台**刷新。401 恢复、以及下面两种紧急情况会绕过它。
 */
export const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000
/** 剩余寿命低于这个值属于「紧急」，闸门必须放行。 */
export const URGENT_REMAINING_MS = 60 * 1000

/**
 * 闸门会不会挡住一次「到点了」的刷新。
 *
 * 关键算式：刷新发生在「令牌年龄 = TTL − 提前量 = 2/3·TTL」时。若 `2/3·TTL` 小于闸门间隔，
 * 闸门就会把该刷的请求挡到过期之后 —— 这就是必须按 TTL 退化的原因。
 *
 * @param sinceLastRefreshMs 距上次刷新的毫秒数
 * @param ttlMs 学到的（或默认的）令牌寿命
 * @param remainingMs 当前令牌剩余寿命
 * @param autoIntervalMs 主动刷新闸门（默认 5 分钟）
 * @param urgentRemainingMs 紧急阈值（默认 60 秒）
 * @returns true = 允许刷新
 */
export function shouldRefresh(input: {
  sinceLastRefreshMs: number
  ttlMs: number
  remainingMs: number
  autoIntervalMs?: number
  urgentRemainingMs?: number
}): { allowed: boolean; reason: 'interval-ok' | 'urgent' | 'short-ttl' | 'throttled' } {
  const auto = input.autoIntervalMs ?? AUTO_REFRESH_INTERVAL_MS
  const urgent = input.urgentRemainingMs ?? URGENT_REMAINING_MS
  if (input.sinceLastRefreshMs >= auto) return { allowed: true, reason: 'interval-ok' }
  // 紧急：快没命了就别管节流。
  if (input.remainingMs <= urgent) return { allowed: true, reason: 'urgent' }
  // 令牌寿命本来就比闸门短：闸门会把它挡到过期之后，必须退化。
  if (Math.round((input.ttlMs * 2) / 3) < auto) return { allowed: true, reason: 'short-ttl' }
  return { allowed: false, reason: 'throttled' }
}
/** 提前量上限（沿用原来的 10 分钟）。 */
export const MAX_REFRESH_SKEW_MS = 10 * 60 * 1000
/** 提前量下限：太小的提前量等于没有。 */
export const MIN_REFRESH_SKEW_MS = 2 * 60 * 1000

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/** 中位数（偶数个取中间两数的均值）。 */
export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[mid] as number
    : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2)
}

/** 估算输入。 */
export interface TtlEstimateInput {
  /** 「签发后多久被拒」的样本（即真实 TTL 的近似值）。 */
  expiredAgesMs?: readonly number[]
  /** 「签发后多久仍然可用」的最大观测值（TTL 的下界）。 */
  workingAgeMs?: number
  /** 当前生效的默认值。 */
  fallbackMs?: number
}

/** 估算结果。 */
export interface TtlEstimate {
  ttlMs: number
  /** `learned` = 由上界样本得出；`extended` = 由下界抬高；`default` = 用默认值。 */
  source: 'learned' | 'extended' | 'default'
  /** 参与计算的上界样本数。 */
  samples: number
}

/**
 * 估算 accessToken 的 TTL。
 *
 * 优先用上界样本（最接近真相）；样本不足时用下界抬高默认值；都没有就用默认。
 */
export function estimateTtlMs(input: TtlEstimateInput): TtlEstimate {
  const fallback = clamp(input.fallbackMs ?? TTL_FALLBACK_MS, TTL_MIN_MS, TTL_MAX_MS)
  const expired = (input.expiredAgesMs ?? [])
    .filter(age => Number.isFinite(age) && age >= TTL_MIN_MS && age <= TTL_MAX_MS)
  if (expired.length >= TTL_MIN_SAMPLES) {
    const ttl = median(expired)
    if (ttl !== undefined) {
      return { ttlMs: clamp(ttl, TTL_MIN_MS, TTL_MAX_MS), source: 'learned', samples: expired.length }
    }
  }
  const working = input.workingAgeMs ?? 0
  if (Number.isFinite(working) && working > fallback && working <= TTL_MAX_MS) {
    // 令牌活过了我们以为的期限 → 至少这么长。留一点余量，但不超过上限。
    return { ttlMs: clamp(Math.round(working * 1.1), TTL_MIN_MS, TTL_MAX_MS), source: 'extended', samples: expired.length }
  }
  return { ttlMs: fallback, source: 'default', samples: expired.length }
}

/**
 * 由 TTL 推导提前量：按比例取（1/3），并夹在 [2 分钟, 10 分钟]。
 *
 * 这样「学到的 TTL 很短」时会自动更早续期，而 TTL 很长时也不会无脑提前 10 分钟以上，
 * 减少不必要的刷新。
 */
export function refreshSkewForTtl(ttlMs: number, configuredSkewMs: number = MAX_REFRESH_SKEW_MS): number {
  const proportional = Math.round(ttlMs / 3)
  const upper = clamp(configuredSkewMs, MIN_REFRESH_SKEW_MS, MAX_REFRESH_SKEW_MS)
  return clamp(proportional, MIN_REFRESH_SKEW_MS, upper)
}

/** 追加一个上界样本（保留最近 `TTL_SAMPLE_KEEP` 个）。 */
export function pushTtlSample(samples: readonly number[] | undefined, sampleMs: number): number[] {
  const next = [...(samples ?? []), Math.round(sampleMs)].filter(age => age >= TTL_MIN_MS && age <= TTL_MAX_MS)
  return next.slice(-TTL_SAMPLE_KEEP)
}
