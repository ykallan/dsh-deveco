/**
 * DevEco 模型目录。
 *
 * **目录只放上游给的东西。** 唯一来源是动态发现（`discovery.ts` → `codeGenie/modelConfig`）：
 * 启动时、每小时、以及卡片上「刷新模型」各拉一次，取所有成功账号的并集。
 * 上游没返回的模型就是没有，未登录时目录为空 —— 不拿一份历史名单冒充「可用模型」。
 *
 * `FALLBACK_PARAMS` 因此**不往目录里塞模型**，只是一张按上游 id 的参数表，给发现到的
 * 模型补 `contextWindow` / `maxTokens` / 视觉能力。上游有时不给这些字段，而写错的
 * `maxTokens` 会让每个请求直接失败。
 *
 * @module dsh-deveco/catalog
 */

import {
  channelLimitsFor,
  DEFAULT_CONTEXT_WINDOW,
  DEVECO_OUTPUT_CEILING,
  DEFAULT_MAX_TOKENS,
  DEFAULT_VISION_MODEL,
  exposedModelId,
  HIDDEN_MODEL_IDS,
  upstreamModelId,
} from './config.ts'

/** 上游声明的思考强度。 */
export interface DevecoModelThinking {
  /** 可选档位（上游 `reasoning_effort.level` 的原值，如 `['low','high','max']`）。 */
  levels: readonly string[]
  /** 上游默认档位。目前只用于展示/诊断，DSH 的默认档位不由它决定。 */
  default?: string
}

/**
 * 「可配置思考」模型的档位表。
 *
 * 上游内层模型（`deepseek-v4.1-flash-1017`、`glm-5.2`）只给 `thinking_mode: "configurable"`，
 * 不给 `reasoning_effort`，所以档位要靠这里补。这组值是**实测**上游接受的集合：
 * 两个模型都接受 `minimal|low|medium|high|xhigh|max`，超出集合的值会被上游 400
 * （例如 `glm-5.2` 明确回 `reasoning_effort must be [none, minimal, low, medium, high, xhigh, max]`）。
 *
 * **为什么不放 `none`**：pi-ai 在「用户没选档位」时也走「不带 reasoningEffort」那条路，
 * 而 `thinkingLevelMap.off` 是个字符串时它会把 `reasoning_effort: none` 发出去 —— 等于让
 * 所有没选档位的请求都默认关闭思考。所以 `off` 必须钉成 `null`（选择器里不出现），
 * 让「没选」保持「不发送档位、走上游默认」。
 */
export const CONFIGURABLE_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** 一个暴露给 DSH 的模型。 */
export interface DevecoModelInfo {
  /** 对外 id（`GLM-5.1-DevEco`；没有改名的模型与 `wireId` 相同）。 */
  id: string
  /** 上游 wire id（`GLM-5.1`）—— 请求里必须发这个。 */
  wireId: string
  /** 展示名。 */
  name: string
  contextWindow: number
  /** `contextWindow` 是上游真的给的，还是兜底值。卡片只在真值时印规格。 */
  contextWindowKnown?: boolean
  maxTokens: number
  supportsImages: boolean
  /** 是不是思考模型（上游 `thinking_mode` 为 `on` 或 `configurable`）。 */
  reasoning?: boolean
  /** 支持工具调用（上游 `tool_call_mode === 'tool_calls'`）。 */
  toolCall?: boolean
  /** 上游声明的思考档位。空/缺省 = 不显示推理档位选择器。 */
  thinking?: DevecoModelThinking
  /** 不在上游目录里、但确实能调的隐藏模型。 */
  hidden?: boolean
}

/**
 * 参数表（**不是**模型名单）。
 *
 * 只给**发现到的**模型补参数，绝不会因为这里有条目就把模型塞进目录。
 */
export const FALLBACK_PARAMS: readonly DevecoModelInfo[] = [
  {
    id: 'GLM-5.1-DevEco',
    wireId: 'GLM-5.1',
    name: 'GLM-5.1-DevEco',
    contextWindow: 170_000,
    contextWindowKnown: true,
    maxTokens: 32_000,
    supportsImages: false,
    reasoning: true,
    toolCall: true,
  },
  {
    id: 'GLM-5.3-DevEco',
    wireId: 'GLM-5.3',
    name: 'GLM-5.3-DevEco',
    contextWindow: 170_000,
    contextWindowKnown: true,
    maxTokens: 32_000,
    supportsImages: false,
    reasoning: true,
    toolCall: true,
    thinking: { levels: ['low', 'high', 'max'], default: 'high' },
  },
  {
    id: DEFAULT_VISION_MODEL,
    wireId: DEFAULT_VISION_MODEL,
    name: 'Qwen3.5 397B (视觉)',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    supportsImages: true,
  },
  // 上游对这两个模型有时不给 `output`：不补的话输出上限会退到很小的兜底值，
  // 长回答/推理会在中途被截断（而上下文窗口明明是 1M）。
  {
    id: 'glm-5.2',
    wireId: 'glm-5.2',
    name: 'glm-5.2',
    contextWindow: 202_752,
    contextWindowKnown: true,
    maxTokens: DEVECO_OUTPUT_CEILING,
    supportsImages: false,
    // 上游只给 `thinking_mode: "configurable"`，不给档位；实测接受下面六档（默认 max）。
    reasoning: true,
    thinking: { levels: [...CONFIGURABLE_THINKING_LEVELS], default: 'max' },
  },
  {
    id: 'deepseek-v4.1-flash-1017',
    wireId: 'deepseek-v4.1-flash-1017',
    name: 'deepseek-v4.1-flash-1017',
    contextWindow: 1_048_576,
    contextWindowKnown: true,
    maxTokens: DEVECO_OUTPUT_CEILING,
    supportsImages: true,
    // 同上：`thinking_mode: "configurable"`，实测接受六档（默认 high）。
    reasoning: true,
    thinking: { levels: [...CONFIGURABLE_THINKING_LEVELS], default: 'high' },
  },
]

/** 隐藏模型：上游目录里没有，但确实能调。 */
export const HIDDEN_MODELS: readonly DevecoModelInfo[] = HIDDEN_MODEL_IDS.map(id => ({
  id,
  wireId: id,
  name: `${id}（隐藏）`,
  contextWindow: 1_044_480,
  contextWindowKnown: true,
  maxTokens: 32_000,
  supportsImages: false,
  reasoning: true,
  thinking: { levels: [...CONFIGURABLE_THINKING_LEVELS], default: 'high' },
  hidden: true,
}))

/** 可变目录，由 shim 的 `/v1/models` 与适配器共享。 */
export class DevecoCatalog {
  /** 空目录起步：没发现过就是没有模型。 */
  private models: readonly DevecoModelInfo[] = []

  current(): readonly DevecoModelInfo[] {
    return this.models
  }

  set(models: readonly DevecoModelInfo[]): void {
    this.models = [...models]
  }

  /** 按对外 id 或上游 id 找一条（大小写不敏感）。 */
  find(id: string): DevecoModelInfo | undefined {
    const key = id.trim().toLowerCase()
    const wire = upstreamModelId(id).toLowerCase()
    return this.models.find(model => model.id.toLowerCase() === key || model.wireId.toLowerCase() === wire)
  }
}

/** 把目录收窄到用户勾选的子集（空/缺省 = 全给）。 */
export function filterEnabledModels(
  models: readonly DevecoModelInfo[],
  enabled: readonly string[] | undefined,
): readonly DevecoModelInfo[] {
  if (enabled === undefined || enabled.length === 0) return models
  const allow = new Set(enabled.map(id => id.trim().toLowerCase()))
  const kept = models.filter(model =>
    allow.has(model.id.toLowerCase()) || allow.has(model.wireId.toLowerCase()))
  // 勾选项全都对不上（比如目录刚刷新过）时不要变成空列表：那会让模型选择器直接消失。
  return kept.length === 0 ? models : kept
}

/**
 * 合并多路来源（多账号）的模型清单。
 *
 * 规则：
 *  - 按上游 id 去重（上游注册名大小写敏感，但同一模型书写可能不一致）；
 *  - 参数更全的一条优先（有真窗口 > 兜底窗口，支持图片 > 不支持）；
 *  - 输出按对外 id 排序，保证刷新前后顺序稳定。
 */
export function mergeModelLists(sets: readonly (readonly DevecoModelInfo[])[]): readonly DevecoModelInfo[] {
  const merged = new Map<string, DevecoModelInfo>()
  for (const set of sets) {
    for (const model of set) {
      const wireId = model.wireId.trim()
      if (wireId === '') continue
      const key = wireId.toLowerCase()
      const normalized: DevecoModelInfo = { ...model, wireId, id: model.id.trim() || exposedModelId(wireId) }
      const current = merged.get(key)
      merged.set(key, current === undefined ? normalized : richerModel(current, normalized))
    }
  }
  return [...merged.values()].sort((a, b) => (a.id.toLowerCase() < b.id.toLowerCase() ? -1 : 1))
}

function richerModel(current: DevecoModelInfo, next: DevecoModelInfo): DevecoModelInfo {
  const keep = richerThan(next, current) ? next : current
  const drop = keep === next ? current : next
  const merged: DevecoModelInfo = {
    ...keep,
    contextWindow: keep.contextWindowKnown === true || drop.contextWindowKnown !== true
      ? keep.contextWindow
      : drop.contextWindow,
    maxTokens: keep.maxTokens > 0 ? keep.maxTokens : drop.maxTokens,
    supportsImages: keep.supportsImages || drop.supportsImages,
    ...drop.reasoning === true || keep.reasoning === true ? { reasoning: true } : {},
    ...drop.toolCall === true || keep.toolCall === true ? { toolCall: true } : {},
    ...keep.thinking === undefined && drop.thinking === undefined ? {} : { thinking: keep.thinking ?? drop.thinking },
  }
  if (keep.contextWindowKnown !== true) delete merged.contextWindowKnown
  return merged
}

function richerThan(a: DevecoModelInfo, b: DevecoModelInfo): boolean {
  const aKnown = a.contextWindowKnown === true
  const bKnown = b.contextWindowKnown === true
  if (aKnown !== bKnown) return aKnown
  if ((a.contextWindow > 0) !== (b.contextWindow > 0)) return a.contextWindow > 0
  if ((a.maxTokens > 0) !== (b.maxTokens > 0)) return a.maxTokens > 0
  return a.supportsImages && !b.supportsImages
}

/**
 * 用参数表给**发现结果**补 0 值字段。
 *
 * 顺序必须是「先合并发现结果 → 再补参数」：反过来会让参数表里的占位值压过上游真值。
 */
export function backfillParams(
  discovered: readonly DevecoModelInfo[],
  params: readonly DevecoModelInfo[] = FALLBACK_PARAMS,
): readonly DevecoModelInfo[] {
  return discovered.map(model => {
    const fallback = params.find(entry => entry.wireId.toLowerCase() === model.wireId.toLowerCase())
    if (fallback === undefined) return model
    const channel = channelLimitsFor(model.wireId)
    const next: DevecoModelInfo = {
      ...model,
      name: model.name === '' || model.name === model.wireId ? fallback.name : model.name,
      contextWindow: model.contextWindowKnown === true && model.contextWindow > 0
        ? model.contextWindow
        : channel?.context ?? fallback.contextWindow,
      contextWindowKnown: model.contextWindowKnown === true || channel !== undefined || fallback.contextWindowKnown === true,
      maxTokens: model.maxTokens > 0 ? model.maxTokens : channel?.output ?? fallback.maxTokens,
      supportsImages: model.supportsImages || fallback.supportsImages,
      ...model.reasoning === undefined && fallback.reasoning === true ? { reasoning: true } : {},
      ...model.toolCall === undefined && fallback.toolCall === true ? { toolCall: true } : {},
      ...model.thinking === undefined && fallback.thinking !== undefined ? { thinking: fallback.thinking } : {},
    }
    return next
  })
}
