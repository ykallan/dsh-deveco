/**
 * DevEco（华为 CodeGenie MaaS）的协议常量。
 *
 * 这一份是「上游事实」的唯一出处：主机名、路径、OAuth 参数、必需请求头、渠道上限。
 * 业务代码只引用这里，不自己拼字符串 —— 上游换路径时只要改这一个文件。
 *
 * 数据来源与实测记录见 `docs/PROTOCOL.md`。
 *
 * @module dsh-deveco/config
 */

import { DEVECO_VERSION } from './version.ts'

/** 上游站点根。仅中国站可用（登录回调的 `siteId` 必须是 `1`）。 */
export const DEVECO_BASE_URL = 'https://cn.devecostudio.huawei.com'

/** OpenAI 兼容的模型 API 前缀（流式）。 */
export const DEVECO_API_BASE = `${DEVECO_BASE_URL}/sse/codeGenie/maas/v2`

/** 动态模型目录。 */
export const DEVECO_MODEL_CONFIG_URL = `${DEVECO_BASE_URL}/codeGenie/modelConfig`

/** 释放服务端排队槽位。 */
export const DEVECO_EXIT_QUEUE_URL = `${DEVECO_BASE_URL}/sse/codeGenie/exitSessionQueue`

/** 登录页（浏览器打开）。 */
export const DEVECO_AUTH_URL = `${DEVECO_BASE_URL}/console/DevEcoIDE/apply`

/** tempToken → jwtToken。 */
export const DEVECO_TEMP_TOKEN_URL = `${DEVECO_BASE_URL}/authrouter/auth/api/temptoken/check`

/** jwtToken 校验 / 续期 / 换 accessToken（同一个接口，靠 `refresh` 头区分）。 */
export const DEVECO_JWT_TOKEN_URL = `${DEVECO_BASE_URL}/authrouter/auth/api/jwToken/check`

/** 登录成功后浏览器回跳的落地页。 */
export const DEVECO_SUCCESS_URL = `${DEVECO_BASE_URL}/console/DevEcoCode/loginSuccess`

/** 登录失败/取消后浏览器回跳的落地页。 */
export const DEVECO_FAILED_URL = `${DEVECO_BASE_URL}/console/DevEcoCode/loginFailed`

/** 登录页要求的 appId（写死在上游前端里）。 */
export const DEVECO_APP_ID = '1008'

/** 登录页要求 `siteId === '1'`（中国站）。 */
export const DEVECO_CHINA_SITE_ID = '1'

/** 回调服务端口候选。DevEco 只在 127.0.0.1 上等这几个口。 */
export const DEVECO_CALLBACK_PORTS = [10101, 34567, 34568, 34569, 34570] as const

/** 回调路径。 */
export const DEVECO_CALLBACK_PATH = '/callback'

/** 等用户点完登录的总预算。 */
export const LOGIN_TIMEOUT_MS = 600_000

/** 登录/token 这类控制面请求的超时。 */
export const CONTROL_TIMEOUT_MS = 20_000

/** accessToken 的固定有效期：上游不给 TTL，实测 30 分钟。 */
export const ACCESS_TOKEN_TTL_MS = 30 * 60 * 1000

/** 提前多久视作「快过期」，触发静默续期。 */
export const REFRESH_SKEW_MS = 5 * 60 * 1000

/** 续期失败后的冷却，避免每个请求都去打上游。 */
export const REFRESH_COOLDOWN_MS = 30_000

/** 控制面请求用的浏览器 UA（上游按 UA 判客户端）。 */
export const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 聊天请求里的客户端标识：`deveco-code@<version>`。 */
export const DEVECO_CLIENT_TAG = `deveco-code@${DEVECO_VERSION}`

/** GLM 渠道声明上限（低于智谱官方规格，以渠道为准）。 */
export const DEVECO_GLM_CONTEXT_LIMIT = 170_000
export const DEVECO_GLM_OUTPUT_LIMIT = 32_000

/** 未声明上限时的兜底（上下文窗口）。 */
export const DEFAULT_CONTEXT_WINDOW = 32_768
/** 兜底的单次输出上限：只给「确实知道上限」的模型用（如视觉模型 8K）。 */
export const DEFAULT_MAX_TOKENS = 8_192

/**
 * 渠道级输出上限。
 *
 * 这是**输出**（max_tokens）的上限，和上下文窗口无关 —— 1M 上下文的模型也照样只能
 * 一次输出这么多。上游对 GLM 明确声明 32K；其余模型没有单独声明时按同一个上限处理。
 *
 * 为什么要有一个统一上限：pi-ai 在请求没带 `max_tokens` 时，直接拿模型描述里的
 * `maxTokens` 当上限（见 `openai-completions.js` 的 `ceiling`）。如果这里给了一个
 * 保守的小值（以前是 8192），长回答会在 8K 处被截断，而推理内容与正文**共享**这个
 * 额度 —— 表现就是「推理到一半提示输出 token 上限」。
 */
export const DEVECO_OUTPUT_CEILING = 32_000

/**
 * 当前生效的输出上限。
 *
 * 可用 `DEVECO_MAX_OUTPUT_TOKENS` 覆盖：上游若是放宽了单次输出，不必改代码。
 * 注意这个值只能**调低/对齐**渠道；设得比渠道实际允许的更大，上游会直接 400。
 */
export function outputCeiling(): number {
  return envNumber('DEVECO_MAX_OUTPUT_TOKENS', DEVECO_OUTPUT_CEILING)
}

/**
 * 隐藏模型：不在模型目录里，但确实能调。用户手工写进 `enabledModels`
 * 或对话模型选择里仍然可用。
 */
export const HIDDEN_MODEL_IDS = ['deepseek-v4-flash'] as const

/**
 * 对外模型 id ↔ 上游 wire id。
 *
 * 上游注册名是 `GLM-5.1` / `GLM-5.3`；对外加 `-DevEco` 后缀是为了和智谱公版区分，
 * 避免用户在模型下拉里选错。裸 id 仍然作为兼容别名接受。
 */
export const DEVECO_EXPOSED_MODEL_IDS: Record<string, string> = {
  'GLM-5.1': 'GLM-5.1-DevEco',
  'GLM-5.3': 'GLM-5.3-DevEco',
}

/** 视觉模型：纯文本模型收到图片会被上游 403，需改路由到这条。 */
export const DEFAULT_VISION_MODEL = 'Qwen3_5_397B_A17B_w8a8_single'

/** 对外暴露的 id（`GLM-5.1` → `GLM-5.1-DevEco`）。幂等。 */
export function exposedModelId(id: string): string {
  return DEVECO_EXPOSED_MODEL_IDS[id] ?? id
}

/** 还原成上游 wire id（`GLM-5.1-DevEco` → `GLM-5.1`）。幂等。 */
export function upstreamModelId(id: string): string {
  const trimmed = id.trim()
  for (const [upstream, exposed] of Object.entries(DEVECO_EXPOSED_MODEL_IDS)) {
    if (exposed.toLowerCase() === trimmed.toLowerCase()) return upstream
  }
  return trimmed
}

/** 该模型在渠道上声明的窗口/输出上限；未声明返回 undefined。 */
export function channelLimitsFor(id: string): { context: number; output: number } | undefined {
  const wire = upstreamModelId(id)
  return DEVECO_MODEL_LIMITS[wire]
}

/**
 * 渠道声明上限表（按上游 wire id）。
 *
 * `output` 是**单次输出**上限，`context` 是上下文窗口。上游对 GLM 系声明
 * 170000/32000；deepseek 系未单独声明输出，按 `DEVECO_OUTPUT_CEILING` 处理。
 */
export const DEVECO_MODEL_LIMITS: Record<string, { context: number; output: number }> = {
  'GLM-5.1': { context: DEVECO_GLM_CONTEXT_LIMIT, output: DEVECO_GLM_OUTPUT_LIMIT },
  'GLM-5.3': { context: DEVECO_GLM_CONTEXT_LIMIT, output: DEVECO_GLM_OUTPUT_LIMIT },
  'GLM-5.2': { context: 202_752, output: DEVECO_OUTPUT_CEILING },
  'deepseek-v4.1-flash-1017': { context: 1_048_576, output: DEVECO_OUTPUT_CEILING },
  'deepseek-v4-flash': { context: 1_044_480, output: DEVECO_OUTPUT_CEILING },
}

/** 队列/并发默认值。上游同时只允许 1 个生成，超出的排队。 */
export const DEFAULT_MAX_CONCURRENCY = 1
export const DEFAULT_MAX_QUEUE = 3
export const DEFAULT_QUEUE_COOLDOWN_MS = 1_000

/** 等上游开流时的空闲超时：沉默这么久才判死。不能用总时长超时。 */
export const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 120_000

/** exitSessionQueue 的等待上限：放槽位失败不该把队列卡住。 */
export const EXIT_QUEUE_GRACE_MS = 3_000
export const EXIT_QUEUE_TIMEOUT_MS = 5_000

/** 环境变量读取（空串视作未设置）。 */
export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/** 环境变量里的列表（逗号分隔，去空）。 */
export function envList(name: string): string[] | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const items = raw.split(',').map(item => item.trim()).filter(item => item !== '')
  return items.length === 0 ? undefined : items
}
