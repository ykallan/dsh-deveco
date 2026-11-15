/**
 * `deveco` 这个 pi-ai provider。
 *
 * 一个适配器，把 DSH 的 LLM seam 接到本机回环 shim 上（`shim.ts` 做真正的上游翻译）。
 * 这里只描述模型、把 `baseUrl` 指向 shim、并把 apiKey 换成 shim 的进程内 secret。
 *
 * @module dsh-deveco/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, Model, Provider, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { filterEnabledModels, type DevecoCatalog, type DevecoModelInfo } from './catalog.ts'
import type { DevecoShim } from './shim.ts'

/** 这个 bundle 拥有的 provider 路由。与 `cordis.patch.yml` 保持一致。 */
export const DEVECO_PROVIDER = 'deveco'

/**
 * 等上游开流时的空闲上限。
 *
 * 90s：DevEco 的免费后端实测会「吐几个 token 然后长时间静默」。给到 90s 既能容忍首
 * token 冷启动和推理间隙，又能让 DSH 自己的重试策略更快接管（它把 TIMEOUT 当可重试）。
 */
export const DEVECO_STREAM_IDLE_TIMEOUT_MS = 90_000

/** 订阅额度没有可算的单价，一律报 0。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
} as const

/** 惰性的 pi-ai 凭证面：deveco 路由只靠 shim 的 secret 鉴权。 */
const INERT_AUTH = {
  credentials: {
    async read() {
      return undefined
    },
    async list() {
      return []
    },
    async modify() {
      throw new Error('dsh-deveco: the deveco route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() {
      return undefined
    },
    async fileExists() {
      return false
    },
  },
}

export interface DevecoAdapterOptions {
  shim: DevecoShim
  catalog: DevecoCatalog
  enabledModels?: () => readonly string[] | undefined
  resolveAttachments?: () => AttachmentStore | undefined
}

export interface DevecoAdapter {
  adapter: PiAiAdapter
  invalidate: () => void
}

/** pi-ai 认的档位，按由弱到强排列。 */
const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * 上游声明的思考档位 → pi-ai 的推理元数据。
 *
 * 上游没声明的档位一律钉成 `null`：pi-ai 把「没写」当成「支持」，漏掉的话界面会给一个
 * 只会 high/max 的模型显示 Off/Minimal/Low/Medium。`off` 同样钉死 —— 上游默认已经在思考，
 * 声称支持 Off 只会发出一个不带档位的请求，然后照样思考。
 */
export function thinkingFields(strengths: readonly string[] | undefined): {
  reasoning: boolean
  thinkingLevelMap?: ThinkingLevelMap
} {
  const offered = new Set(strengths ?? [])
  if (!REASONING_LEVELS.some(level => level !== 'off' && offered.has(level))) return { reasoning: false }
  const map = {} as Record<(typeof REASONING_LEVELS)[number], string | null>
  for (const level of REASONING_LEVELS) map[level] = offered.has(level) ? level : null
  return { reasoning: true, thinkingLevelMap: map }
}

/** 一条目录项 → pi-ai 模型描述（指向 shim）。 */
function toPiModel(info: DevecoModelInfo, baseUrl: string): Model<Api> {
  const thinking = thinkingFields(info.thinking?.levels)
  const reasoning = info.reasoning === true || thinking.reasoning
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: DEVECO_PROVIDER,
    baseUrl,
    input: info.supportsImages ? (['text', 'image'] as const) : (['text'] as const),
    reasoning,
    ...thinking.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: thinking.thinkingLevelMap },
    cost: NO_COST,
    contextWindow: info.contextWindow > 0 ? info.contextWindow : 32_768,
    maxTokens: info.maxTokens > 0 ? info.maxTokens : 8_192,
  } as unknown as Model<Api>
}

export function createDevecoAdapter(options: DevecoAdapterOptions): DevecoAdapter {
  const { shim, catalog, enabledModels, resolveAttachments } = options

  const buildModels = (): Model<Api>[] => {
    const baseUrl = `${shim.baseUrl()}/v1`
    return catalog.current().map(info => toPiModel(info, baseUrl))
  }

  const base = createProvider({
    id: DEVECO_PROVIDER,
    name: 'DevEco',
    auth: {
      apiKey: {
        name: 'DevEco shim key',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'DevEco' }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })

  const provider: Provider = { ...base, getModels: () => buildModels() }

  const profileFields = {
    provider: DEVECO_PROVIDER,
    displayName: 'DevEco',
    streamIdleTimeoutMs: DEVECO_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-deveco retryPolicy'),
    configuredMaxTokens: new Map<string, number>(),
    modelErrors: new Map<string, string>(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }
  const profile = profileFields as unknown as ResolvedPiAiProviderProfile

  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[DEVECO_PROVIDER, profile]])

  const adapter = new DevecoPiAiAdapter(catalog, enabledModels, {
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => shim.token(),
    ...resolveAttachments === undefined ? {} : { resolveAttachments },
  })

  return {
    adapter,
    invalidate: () => {
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[DEVECO_PROVIDER, profile]])
    },
  }
}

/** 把**对外**模型面收窄到用户勾选的子集（分发不受影响）。 */
class DevecoPiAiAdapter extends PiAiAdapter {
  private readonly catalog: DevecoCatalog
  private readonly enabledModels: (() => readonly string[] | undefined) | undefined

  constructor(
    catalog: DevecoCatalog,
    enabledModels: (() => readonly string[] | undefined) | undefined,
    options: ConstructorParameters<typeof PiAiAdapter>[0],
  ) {
    super(options)
    this.catalog = catalog
    this.enabledModels = enabledModels
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await super.listModels(provider)
    const allowed = filterEnabledModels(this.catalog.current(), this.enabledModels?.())
    const catalogIds = new Set(this.catalog.current().map(entry => entry.id))
    const allowedIds = new Set(allowed.map(entry => entry.id))
    return models.filter(model => !catalogIds.has(model.id) || allowedIds.has(model.id))
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return super.resolveModel(provider, model, signal)
  }
}
