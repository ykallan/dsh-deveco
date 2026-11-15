/**
 * 上游对话转发：请求头、路径、排队槽位释放、错误归类、用量抽取。
 *
 * 这一层只做「怎么跟 DevEco 说话」，不含账号选择策略（那是 `shim.ts` 的事），
 * 也不碰凭证存储（那是 `auth.ts` 的事）。
 *
 * 三条最容易踩的上游怪癖（`docs/PROTOCOL.md` 第 4 节）：
 *
 * - **非流式是另一条路径**（`/no-stream/chat/completions`），不是 body 里的 `stream:false`；
 * - `Session-Id` 必须 ≤ 32 字符，超了上游直接 400；
 * - 服务端按 (`Session-Id`, `Chat-Id`) 维护轮次状态，每轮结束要 `POST exitSessionQueue`
 *   把槽位放掉，否则会一直漏。
 *
 * @module dsh-deveco/upstream
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  BROWSER_USER_AGENT,
  DEVECO_API_BASE,
  DEVECO_CLIENT_TAG,
  DEVECO_EXIT_QUEUE_URL,
  EXIT_QUEUE_GRACE_MS,
  EXIT_QUEUE_TIMEOUT_MS,
} from './config.ts'

/** 上游 API 的 origin 与前缀。 */
const API_ORIGIN = new URL(DEVECO_API_BASE).origin
const API_PREFIX = new URL(DEVECO_API_BASE).pathname.replace(/\/$/, '')

/** 32 位十六进制（去连字符 UUID）。 */
export function newId32(): string {
  return randomUUID().replace(/-/g, '')
}

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * 把客户端给的会话标识压成「≤32 字符、稳定」的形态。
 *
 * 上游要求 `Session-Id` ≤ 32 字符（超了回 `SSE request header Session-Id is too long`），
 * 而客户端发来的可能是 36 位 UUID（去掉连字符正好 32），也可能是长字符串（稳定哈希）。
 */
export function normalizeAffinityId(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') return ''
  if (UUID_PATTERN.test(trimmed)) return trimmed.replace(/-/g, '').toLowerCase()
  if (trimmed.length <= 32) return trimmed
  return createHash('sha256').update(trimmed).digest('hex').slice(0, 32)
}

/**
 * 推导会话键。
 *
 * 用**首条 user 消息**做键，而不是 `messages[0]`：后者通常是 system prompt，里面有
 * 日期、工作目录这类每次都变的内容 —— 用它做键等于每轮都新开一个上游会话，很快就
 * 会撞到上游的「新会话频率」限制。
 */
export function conversationKey(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const firstUser = messages.find(message => isObject(message) && message.role === 'user')
  const seed = firstUser ?? messages[0] ?? ''
  return createHash('sha256').update(JSON.stringify(seed)).digest('hex').slice(0, 32)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 一次请求要带的三组标识。 */
export interface RequestIdentity {
  /** 会话键（`Session-Id` / `x-deveco-session`）。 */
  sessionId: string
  /** 对话 id（`Chat-Id`），同一会话内稳定。 */
  chatId: string
  /** 本轮任务 id（`x-deveco-task`），推理与 `exitSessionQueue` 必须一致。 */
  taskId: string
}

/** `Chat-Id` 的缓存上限：按会话键缓存，避免无限增长。 */
const CHAT_ID_CACHE_LIMIT = 500
const chatIdCache = new Map<string, string>()

/** 取（或铸造）一个会话的 `Chat-Id`。 */
export function chatIdFor(sessionId: string): string {
  const cached = chatIdCache.get(sessionId)
  if (cached !== undefined) return cached
  if (chatIdCache.size >= CHAT_ID_CACHE_LIMIT) {
    const oldest = chatIdCache.keys().next().value
    if (oldest !== undefined) chatIdCache.delete(oldest)
  }
  const chatId = newId32()
  chatIdCache.set(sessionId, chatId)
  return chatId
}

/** 清空 `Chat-Id` 缓存（测试/登出用）。 */
export function resetChatIdCache(): void {
  chatIdCache.clear()
}

/** 从入站请求头里取客户端指定的会话/任务标识。 */
export function identityFromHeaders(
  headers: Record<string, string | string[] | undefined>,
  body: Record<string, unknown>,
): RequestIdentity {
  const pick = (name: string): string | undefined => {
    const raw = headers[name]
    const value = Array.isArray(raw) ? raw[0] : raw
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  }
  const explicit = pick('x-deveco-session') ?? pick('x-session-affinity') ?? pick('x-session-id')
  const sessionId = explicit !== undefined
    ? normalizeAffinityId(explicit)
    : conversationKey(body)
  const taskHeader = pick('x-deveco-task')
  return {
    sessionId,
    chatId: chatIdFor(sessionId),
    taskId: taskHeader !== undefined ? normalizeAffinityId(taskHeader) : newId32(),
  }
}

/** 聊天请求头。 */
export function buildChatHeaders(
  accessToken: string,
  identity: RequestIdentity,
  extra: { project?: string; parentSession?: string } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    lang: 'en',
    'Chat-Id': identity.chatId,
    'Session-Id': identity.sessionId,
    'x-deveco-session': identity.sessionId,
    'x-deveco-task': identity.taskId,
    'x-deveco-client': DEVECO_CLIENT_TAG,
    'User-Agent': BROWSER_USER_AGENT,
    'accept-language': 'zh-CN',
    'X-DevEco-Improvement-Enabled': process.env.DEVECO_TOOL_IMPROVEMENT === '1' ? 'true' : 'false',
  }
  if (extra.project !== undefined && extra.project !== '') headers['x-deveco-project'] = extra.project
  if (extra.parentSession !== undefined && extra.parentSession !== '') {
    headers['x-deveco-parent-session'] = normalizeAffinityId(extra.parentSession)
  }
  return headers
}

/** 上游聊天地址（流式/非流式是两条路径）。 */
export function chatUrl(stream: boolean): string {
  const path = stream ? `${API_PREFIX}/chat/completions` : `${API_PREFIX}/no-stream/chat/completions`
  return `${API_ORIGIN}${path}`
}

/**
 * 放掉服务端的排队槽位。
 *
 * 必须在 `finally` 里调：上游按 (`Session-Id`, `Chat-Id`) 占槽，漏一次就是漏一个名额。
 * 整体有 `EXIT_QUEUE_GRACE_MS` 上限 —— 释放失败不能把本地队列卡住。
 */
export async function exitSessionQueue(
  accessToken: string,
  identity: RequestIdentity,
  model: string,
): Promise<void> {
  const attempt = async (retriesLeft: number): Promise<void> => {
    const url = `${DEVECO_EXIT_QUEUE_URL}?modelId=${encodeURIComponent(model)}`
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Session-Id': identity.sessionId,
          'Chat-Id': identity.chatId,
          'x-deveco-session': identity.sessionId,
          'x-deveco-task': identity.taskId,
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(EXIT_QUEUE_TIMEOUT_MS),
      })
      if (response.ok) return
      if (retriesLeft <= 0) return
    } catch {
      if (retriesLeft <= 0) return
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 400)
      timer.unref?.()
    })
    await attempt(retriesLeft - 1)
  }
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, EXIT_QUEUE_GRACE_MS)
    timer.unref?.()
    void attempt(1).then(() => {
      clearTimeout(timer)
      resolve()
    }, () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** 上游错误的归类。 */
export type UpstreamErrorKind = 'auth' | 'rate-limit' | 'overloaded' | 'context' | 'model' | 'server' | 'network'

/** 把一次失败的响应翻译成可操作的错误。 */
export interface UpstreamError {
  kind: UpstreamErrorKind
  status: number
  message: string
  /** 换一个账号重试是否有意义。 */
  retryable: boolean
  /** 需要重新登录。 */
  needsLogin: boolean
}

/** 提示：渠道声明的上下文上限（用户看到的必须是渠道事实，不是官方规格）。 */
export const CONTEXT_LIMIT_HINT = 'DevEco serves GLM-5.1-DevEco / GLM-5.3-DevEco with a 170,000-token context and a 32,000-token output cap.'

/** 从响应体里抠出可读的错误文本。 */
export async function readErrorText(response: Response): Promise<string> {
  try {
    const text = await response.text()
    if (text === '') return `HTTP ${response.status}`
    try {
      const parsed = JSON.parse(text) as unknown
      if (isObject(parsed)) {
        const error = parsed.error
        if (typeof error === 'string') return error
        if (isObject(error) && typeof error.message === 'string') return error.message
        if (typeof parsed.message === 'string') return parsed.message
        if (typeof parsed.msg === 'string') return parsed.msg
      }
    } catch {
      // 不是 JSON：直接用原文。
    }
    return text.length > 600 ? `${text.slice(0, 600)}…` : text
  } catch {
    return `HTTP ${response.status}`
  }
}

/** 归类一次上游失败。 */
export function classifyUpstreamError(status: number, message: string): UpstreamError {
  const text = message.toLowerCase()
  if (status === 401) {
    return { kind: 'auth', status, message, retryable: false, needsLogin: true }
  }
  if (status === 403) {
    // 403 有两种：会话频率/账号被拒（换号有用），以及模型服务过载（换号也可能有用）。
    if (text.includes('session') || text.includes('forbidden') || text.includes('permission')) {
      return { kind: 'auth', status, message, retryable: true, needsLogin: false }
    }
    return { kind: 'overloaded', status, message, retryable: true, needsLogin: false }
  }
  if (status === 429) {
    return { kind: 'rate-limit', status, message, retryable: true, needsLogin: false }
  }
  if (status === 413 || (status === 400 && looksLikeLengthError(text))) {
    return { kind: 'context', status, message: `${message}\n${CONTEXT_LIMIT_HINT}`, retryable: false, needsLogin: false }
  }
  if (status === 400 && (text.includes('model') || text.includes('param'))) {
    return { kind: 'model', status, message, retryable: false, needsLogin: false }
  }
  if (status >= 500) {
    return { kind: 'server', status, message, retryable: true, needsLogin: false }
  }
  return { kind: 'server', status, message, retryable: status >= 500, needsLogin: false }
}

function looksLikeLengthError(text: string): boolean {
  return text.includes('too long')
    || text.includes('prompt length')
    || text.includes('maximum input length')
    || text.includes('context length')
    || text.includes('overlimit')
    || text.includes('too many tokens')
}

/** 本轮请求的用量。 */
export interface ChatUsage {
  inputTokens?: number
  outputTokens?: number
}

/** 从一次非流式响应体里取用量。 */
export function usageFromJson(body: unknown): ChatUsage {
  if (!isObject(body)) return {}
  const usage = body.usage
  if (!isObject(usage)) return {}
  const input = numberOrUndefined(usage.prompt_tokens ?? usage.input_tokens)
  const output = numberOrUndefined(usage.completion_tokens ?? usage.output_tokens)
  return {
    ...input === undefined ? {} : { inputTokens: input },
    ...output === undefined ? {} : { outputTokens: output },
  }
}

/**
 * 从一行 SSE `data:` 里取用量。
 *
 * 流式响应通常在最后一个块带 `usage`，也可能压根不带 —— 拿不到就不记，绝不猜。
 */
export function usageFromSseLine(line: string): ChatUsage | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return undefined
  const payload = trimmed.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return undefined
  if (!payload.includes('usage')) return undefined
  try {
    const parsed = JSON.parse(payload) as unknown
    const usage = usageFromJson(parsed)
    return usage.inputTokens === undefined && usage.outputTokens === undefined ? undefined : usage
  } catch {
    return undefined
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value)
  return undefined
}

/**
 * 流式响应里第一帧的错误。
 *
 * 上游有时以 **200 + SSE** 的形式报错：第一帧是 `data: {"error":{...}}`。如果原样透传给
 * pi-ai，它会把这段当正文渲染出来，用户看到一堆 JSON 而不是错误提示。
 */
export function firstFrameError(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload) as unknown
      if (!isObject(parsed)) continue
      const error = parsed.error
      if (isObject(error) && typeof error.message === 'string') return error.message
      if (typeof error === 'string' && error !== '') return error
    } catch {
      // 不是 JSON 的帧不是错误帧。
    }
  }
  return undefined
}
