/**
 * 动态模型发现：`GET /codeGenie/modelConfig`。
 *
 * 上游按**账号**下发模型目录，所以多账号要逐号拉一次再取并集 —— 一个号失败不影响
 * 其它号。结果是「真实可用模型」的唯一来源：目录空就是空，不拿静态名单糊上去。
 *
 * 响应结构（实测，见 `docs/PROTOCOL.md`）：
 *
 * ```jsonc
 * { "code": 200,
 *   "body": { "inner_models": [ { "group_name": "GLM",
 *     "task_default_model_map": { "small_model": "GLM-5.1", "blacklist": "Qwen3_5_..." },
 *     "model_configs": [ { "model_id": "GLM-5.3", "thinking_mode": "on",
 *       "input_modalities": ["text"], "context_window": 170000, "output": "32000",
 *       "tool_call_mode": "tool_calls",
 *       "reasoning_effort": "{\"level\":[\"low\",\"high\",\"max\"],\"default\":\"high\"}" } ] } ] } }
 * ```
 *
 * @module dsh-deveco/discovery
 */

import {
  CONTROL_TIMEOUT_MS,
  DEVECO_CLIENT_TAG,
  DEVECO_MODEL_CONFIG_URL,
  exposedModelId,
  HIDDEN_MODEL_IDS,
} from './config.ts'
import {
  backfillParams,
  HIDDEN_MODELS,
  mergeModelLists,
  type DevecoModelInfo,
  type DevecoModelThinking,
  type DevecoCatalog,
} from './catalog.ts'
import type { DevecoAccountStore } from './auth.ts'

/** 一个 `model_configs[]` 条目。 */
export interface ModelConfigEntry {
  model_id?: unknown
  thinking_mode?: unknown
  input_modalities?: unknown
  context_window?: unknown
  output?: unknown
  tool_call_mode?: unknown
  reasoning_effort?: unknown
}

/** 一个 `inner_models[]` 分组。 */
export interface ModelConfigGroup {
  protocol?: unknown
  group_name?: unknown
  task_default_model_map?: unknown
  model_configs?: unknown
}

/** `modelConfig` 响应体。 */
export interface ModelConfigResponse {
  code?: unknown
  body?: { inner_models?: unknown }
}

/** 一次目录抓取的结果。 */
export interface ModelConfigFetch {
  models: readonly DevecoModelInfo[]
  /** 上游推荐的默认模型（`task_default_model_map.small_model`）。 */
  smallModel?: string
  /** 上游要求从目录里剔除的模型 id。 */
  blacklist: readonly string[]
}

const ALLOWED_MODALITIES = new Set(['text', 'audio', 'image', 'video', 'pdf'])

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim())
}

/** `output` 上游有时给字符串、有时给数字。 */
function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return undefined
}

/**
 * 解析上游的 `reasoning_effort`：可能是 `{"level":[...],"default":"..."}` 的 JSON 文本，
 * 也可能是更老的纯数组。解析不出来就当「没声明档位」。
 */
export function parseReasoningEfforts(raw: unknown): DevecoModelThinking | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (Array.isArray(parsed)) {
    const levels = stringList(parsed)
    return levels.length === 0 ? undefined : { levels }
  }
  if (typedObject(parsed) === undefined) return undefined
  const value = typedObject(parsed) as { level?: unknown; default?: unknown }
  const levels = stringList(value.level)
  if (levels.length === 0) return undefined
  const fallback = typeof value.default === 'string' && levels.includes(value.default) ? value.default : undefined
  return fallback === undefined ? { levels } : { levels, default: fallback }
}

function typedObject(value: unknown): object | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/** 一条 `model_configs` 条目 → 目录项；无法识别时 undefined。 */
export function toModelInfo(entry: ModelConfigEntry): DevecoModelInfo | undefined {
  const wireId = typeof entry.model_id === 'string' ? entry.model_id.trim() : ''
  if (wireId === '') return undefined
  const windows = parsePositiveInt(entry.context_window)
  const maxTokens = parsePositiveInt(entry.output)
  const modalities = stringList(entry.input_modalities).filter(item => ALLOWED_MODALITIES.has(item))
  const info: DevecoModelInfo = {
    id: exposedModelId(wireId),
    wireId,
    name: exposedModelId(wireId),
    contextWindow: windows ?? 0,
    maxTokens: maxTokens ?? 0,
    supportsImages: modalities.includes('image'),
  }
  if (windows !== undefined) info.contextWindowKnown = true
  if (entry.thinking_mode === 'on') info.reasoning = true
  if (entry.tool_call_mode === 'tool_calls') info.toolCall = true
  const thinking = parseReasoningEfforts(entry.reasoning_effort)
  if (thinking !== undefined) info.thinking = thinking
  return info
}

/** 解析整个 `modelConfig` 响应。 */
export function parseModelConfig(raw: unknown): ModelConfigFetch {
  const response = typedObject(raw) as ModelConfigResponse | undefined
  const inner = (typedObject(response?.body) as { inner_models?: unknown } | undefined)?.inner_models
  const groups = Array.isArray(inner) ? inner : []
  const models: DevecoModelInfo[] = []
  const blacklist: string[] = []
  let smallModel: string | undefined
  for (const rawGroup of groups) {
    const group = typedObject(rawGroup) as ModelConfigGroup | undefined
    if (group === undefined) continue
    const taskMap = typedObject(group.task_default_model_map) as { small_model?: unknown; blacklist?: unknown } | undefined
    if (smallModel === undefined && typeof taskMap?.small_model === 'string' && taskMap.small_model !== '') {
      smallModel = taskMap.small_model
    }
    if (typeof taskMap?.blacklist === 'string') {
      for (const id of taskMap.blacklist.split(',').map(item => item.trim()).filter(item => item !== '')) {
        blacklist.push(id)
      }
    }
    const entries = group.model_configs
    if (!Array.isArray(entries)) continue
    for (const rawEntry of entries) {
      const entry = typedObject(rawEntry) as ModelConfigEntry | undefined
      if (entry === undefined) continue
      const info = toModelInfo(entry)
      if (info !== undefined) models.push(info)
    }
  }
  const blocked = new Set(blacklist.map(id => id.toLowerCase()))
  const allowed = models.filter(model => !blocked.has(model.wireId.toLowerCase()))
  return {
    models: allowed,
    ...smallModel === undefined ? {} : { smallModel },
    blacklist,
  }
}

/** 拉一个账号的模型目录。 */
export async function fetchModelConfig(
  accessToken: string,
  signal?: AbortSignal,
): Promise<ModelConfigFetch> {
  const url = `${DEVECO_MODEL_CONFIG_URL}?localVersion=0&pluginVersion=${encodeURIComponent(DEVECO_CLIENT_TAG)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)
  timer.unref?.()
  signal?.addEventListener('abort', () => controller.abort(), { once: true })
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`modelConfig returned HTTP ${response.status}`)
    }
    const body = await response.json() as unknown
    const code = (typedObject(body) as { code?: unknown } | undefined)?.code
    if (code !== undefined && code !== 200) {
      throw new Error(`modelConfig returned code ${String(code)}`)
    }
    const parsed = parseModelConfig(body)
    if (parsed.models.length === 0) throw new Error('modelConfig listed no usable model')
    return parsed
  } finally {
    clearTimeout(timer)
  }
}

/** 一次跨账号发现的完整结果。 */
export interface DiscoveryOutcome {
  models: readonly DevecoModelInfo[]
  /** 至少一个账号能给出目录。 */
  anySucceeded: boolean
  accounts: { id: string; models: number; errors: string[] }[]
}

/**
 * 逐号发现并合并。
 *
 * 隐藏模型（`deepseek-v4-flash`）不在上游目录里，单独补在最后 —— 它的窗口和普通模型
 * 完全不同（1M），也不该被合并规则跟别的模型混在一起。
 */
export async function discoverModels(
  store: DevecoAccountStore,
  signal?: AbortSignal,
): Promise<DiscoveryOutcome> {
  const ids = await store.dispatchIds()
  const perAccount: { id: string; models: number; errors: string[] }[] = []
  const sets: DevecoModelInfo[][] = []
  for (const id of ids) {
    try {
      const resolved = await store.resolve(id)
      if (resolved === undefined) {
        perAccount.push({ id, models: 0, errors: ['no usable credential'] })
        continue
      }
      const fetched = await fetchModelConfig(resolved.accessToken, signal)
      const models = backfillParams(fetched.models)
      sets.push([...models])
      perAccount.push({ id, models: models.length, errors: [] })
    } catch (error: unknown) {
      perAccount.push({ id, models: 0, errors: [error instanceof Error ? error.message : String(error)] })
    }
  }
  const merged = mergeModelLists(sets)
  const withHidden = [...merged, ...HIDDEN_MODELS.filter(model =>
    !merged.some(entry => entry.wireId.toLowerCase() === model.wireId.toLowerCase()))]
  return {
    models: withHidden,
    anySucceeded: sets.some(set => set.length > 0),
    accounts: perAccount,
  }
}

/** 拉一次目录并写进 `catalog`；失败时保留旧目录（上游抖动不该清空模型选择器）。 */
export async function refreshCatalog(
  store: DevecoAccountStore,
  catalog: DevecoCatalog,
  signal?: AbortSignal,
): Promise<DiscoveryOutcome> {
  const outcome = await discoverModels(store, signal)
  if (outcome.anySucceeded && outcome.models.length > 0) catalog.set(outcome.models)
  return outcome
}

/** 供诊断用：这次目录里哪些是隐藏模型。 */
export function hiddenModelIds(): readonly string[] {
  return HIDDEN_MODEL_IDS
}

/** 单号快速探活：能不能列出模型（签到用它证明「这个号今天真的能用」）。 */
export async function probeAccount(
  accessToken: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; models: number; message?: string }> {
  try {
    const fetched = await fetchModelConfig(accessToken, signal)
    return { ok: true, models: fetched.models.length }
  } catch (error: unknown) {
    return { ok: false, models: 0, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 控制面超时（导出给签到用，避免每处各写一个数字）。 */
export const DISCOVERY_CONTROL_TIMEOUT_MS = CONTROL_TIMEOUT_MS
