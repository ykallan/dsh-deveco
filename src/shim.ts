/**
 * 本机回环 shim：把 pi-ai 的 OpenAI 请求翻译成 DevEco 的请求。
 *
 * 为什么要有这一层，而不是让适配器直连上游：
 *
 * - 上游需要一批 pi-ai 不会发的头（`Session-Id` / `Chat-Id` / `x-deveco-task` / `x-deveco-client`）；
 * - 非流式走另一条路径；
 * - 每轮结束要 `POST exitSessionQueue` 放槽位；
 * - 多账号轮转、失败换号、并发闸门、用量记账都发生在这一层；
 * - 请求体要按上游的六条硬规则重写（`normalize.ts`）。
 *
 * 适配器那边只需把 `baseUrl` 指向这里、apiKey 用这里发的随机 secret，其余照旧。
 *
 * @module dsh-deveco/shim
 */

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  DEFAULT_MAX_QUEUE,
  DEFAULT_QUEUE_COOLDOWN_MS,
  DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS,
  DEFAULT_VISION_MODEL,
  envNumber,
  exposedModelId,
  upstreamModelId,
} from './config.ts'
import type { DevecoAccountStore } from './auth.ts'
import type { DevecoAccountPool } from './account-pool.ts'
import { filterEnabledModels, type DevecoCatalog, type DevecoModelInfo } from './catalog.ts'
import { normalizeChatBody, type NormalizeContext } from './normalize.ts'
import { DevecoQueueGate, QUEUE_FULL_MESSAGE } from './queue.ts'
import { looksLikeQuotaExhausted, type DevecoQuotaTracker } from './quota.ts'
import type { DevecoUsageTracker } from './usage.ts'
import {
  buildChatHeaders,
  chatUrl,
  classifyUpstreamError,
  exitSessionQueue,
  firstFrameError,
  identityFromHeaders,
  readErrorText,
  usageFromJson,
  streamAuthError,
  usageFromSseLine,
  type ChatUsage,
  type UpstreamError,
} from './upstream.ts'
import { hostIsLoopback } from './loopback.ts'

/** 等一个本地槽位最多等多久。 */
const SLOT_WAIT_MS = 5_000

/** 最多换几个账号重试（每个账号只试一次）。 */
const MAX_ACCOUNT_ATTEMPTS = 3

/**
 * 上游返回 401 后的重试策略：等 5 秒 → 刷新令牌 → 重试，最多 5 次。
 *
 * 等这 5 秒不是礼节：令牌服务有短暂的传播延迟，401 之后立刻刷新经常还是旧状态；
 * 5 秒能让新令牌真正生效。5 次仍然 401 就认为这个号确实失效，停止本次请求。
 */
const AUTH_RETRY_DELAY_MS = 5_000
const AUTH_RETRY_MAX = 5

/** 实际等待时长（测试可以设成 0 或几毫秒）。 */
function authRetryDelayMs(): number {
  return envNumber('DEVECO_AUTH_RETRY_DELAY_MS', AUTH_RETRY_DELAY_MS)
}

/** 请求体上限。 */
const MAX_BODY_BYTES = 32 * 1024 * 1024

/** 探首帧时最多缓冲多少字节。 */
const PEEK_LIMIT = 8 * 1024

export interface DevecoShimOptions {
  store: DevecoAccountStore
  pool: DevecoAccountPool
  catalog: DevecoCatalog
  usage: DevecoUsageTracker
  /** 额度窗口状态：成功即「没被额度挡住」，被上游判额度用尽时留档。 */
  quota: DevecoQuotaTracker
  /** 用户勾选的模型（空 = 全给）。 */
  enabledModels?: () => readonly string[] | undefined
  logger?: { debug: (message: string) => void; warn: (message: string, ...rest: unknown[]) => void }
}

/** shim 对外句柄。 */
export interface DevecoShim {
  baseUrl(): string
  token(): string
  ready: Promise<void>
  close(): Promise<void>
  stats(): ShimStats
}

/** 诊断快照。 */
export interface ShimStats {
  port: number
  lastAccount?: string
  lastModel?: string
  lastError?: string
  lastStatus?: number
  lastLatencyMs?: number
  /**
   * 最近一次聊天请求**实际发出去**的 max_tokens（输出上限）。
   *
   * 排查「回答被截断」时这是第一现场：它和上下文窗口无关，是这个值太小才会在推理
   * 中途撞线。为 undefined 表示请求没带 max_tokens（上游按自己的默认走）。
   */
  lastMaxTokens?: number
  /** 最近一次聊天请求里 `stream` 的取值。 */
  lastStream?: boolean
  /**
   * 最近一次**流式响应中途**出现的鉴权错误原文。
   *
   * 这是排查「推理到一半提示密钥无效」的关键：它说明上游开了流之后才否认令牌，
   * 通常是令牌在长回合里过期，或被同账号的其它客户端/后台续期轮换掉了。
   */
  lastStreamAuthError?: string
  /** 最近一次请求里，因 401 触发的重试次数（0–5）。 */
  lastAuthRetry?: number
}

/** 可被 abort 打断的等待。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** OpenAI 风格的错误体（pi-ai 认识这个形状）。 */
function openAiError(res: ServerResponse, status: number, message: string, type = 'upstream_error'): void {
  json(res, status, { error: { message, type, code: status } })
}

function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', error => reject(error))
  })
}

/** 归一化上下文：从目录里拿这条模型的声明。 */
export function contextForModel(
  catalog: DevecoCatalog,
  requestedModel: string,
): { info?: DevecoModelInfo; ctx: NormalizeContext } {
  const info = catalog.find(requestedModel)
  const wireId = info?.wireId ?? upstreamModelId(requestedModel)
  const ctx: NormalizeContext = {
    model: wireId,
    ...info?.thinking === undefined ? {} : { levels: info.thinking.levels },
    ...info?.reasoning === true ? { reasoning: true } : {},
    textOnly: info !== undefined && info.supportsImages !== true,
    visionModel: process.env.DEVECO_VISION_MODEL?.trim() || DEFAULT_VISION_MODEL,
  }
  return info === undefined ? { ctx } : { info, ctx }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export function createDevecoShim(options: DevecoShimOptions): DevecoShim {
  const { store, pool, catalog, usage, quota, logger } = options
  const secret = randomUUID().replace(/-/g, '')
  const queue = new DevecoQueueGate({
    maxConcurrent: envNumber('DEVECO_MAX_CONCURRENCY', 1),
    maxQueue: envNumber('DEVECO_MAX_QUEUE', DEFAULT_MAX_QUEUE),
    cooldownMs: envNumber('DEVECO_QUEUE_COOLDOWN_MS', DEFAULT_QUEUE_COOLDOWN_MS),
  })
  const idleTimeoutMs = envNumber('UPSTREAM_IDLE_TIMEOUT_MS', DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS)
  let server: Server | undefined
  let port = 0
  const stats: ShimStats = { port: 0 }

  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const value = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim()
    return value === secret
  }

  const handleModels = (req: IncomingMessage, res: ServerResponse): void => {
    if (!hostIsLoopback(req.headers.host)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    const models = filterEnabledModels(catalog.current(), options.enabledModels?.())
    json(res, 200, {
      object: 'list',
      data: models.map(model => ({
        id: exposedModelId(model.wireId),
        object: 'model',
        owned_by: 'deveco',
        ...model.contextWindowKnown === true ? { context_length: model.contextWindow } : {},
        ...model.maxTokens > 0 ? { max_output_tokens: model.maxTokens } : {},
      })),
    })
  }

  /**
   * 把上游响应写回 pi-ai，并在结束时释放服务端排队槽位。
   *
   * `exitSessionQueue` 必须在**这一层的 finally** 里调：上游按 (Session-Id, Chat-Id) 记
   * 轮次账，漏一次就少一个可用名额，而且是静默的。
   */
  const pipeUpstream = async (
    res: ServerResponse,
    params: {
      response: Response
      stream: boolean
      accountId: string
      wireModel: string
      identity: ReturnType<typeof identityFromHeaders>
      accessToken: string
      started: number
    },
  ): Promise<void> => {
    const { response, stream, accountId, wireModel, identity, accessToken, started } = params
    let usageRecord: ChatUsage = {}
    try {
      if (!stream) {
        const text = await response.text()
        try {
          usageRecord = usageFromJson(JSON.parse(text) as unknown)
        } catch {
          // 不是 JSON 也照原样透传：pi-ai 会给出可读的解析错误。
        }
        usage.record({
          account: accountId,
          model: wireModel,
          ok: true,
          ms: Date.now() - started,
          ...usageRecord.inputTokens === undefined ? {} : { inputTokens: usageRecord.inputTokens },
          ...usageRecord.outputTokens === undefined ? {} : { outputTokens: usageRecord.outputTokens },
        })
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
        res.end(text)
        return
      }

      const body = response.body
      if (body === null) {
        openAiError(res, 502, 'dsh-deveco: upstream returned an empty stream')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      const reader = body.getReader()
      const decoder = new TextDecoder()
      let carry = ''
      let peeked = ''
      let decided = false
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const armIdle = (): void => {
        if (idleTimer !== undefined) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          logger?.warn('dsh-deveco: upstream stream idle timeout; aborting this turn')
          void reader.cancel().catch(() => {})
        }, idleTimeoutMs)
        idleTimer.unref?.()
      }
      try {
        armIdle()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          armIdle()
          if (value === undefined) continue
          let text = decoder.decode(value, { stream: true })
          if (!decided) {
            peeked += text
            // 上游有时以 200 + SSE 报错：第一帧是 {"error":…}。先探一帧再决定怎么回。
            if (peeked.length < PEEK_LIMIT && !peeked.includes('\n')) continue
            decided = true
            const early = firstFrameError(peeked)
            if (early !== undefined) {
              await reader.cancel().catch(() => {})
              const classified = classifyUpstreamError(400, early)
              stats.lastError = `early: ${early}`
              openAiError(res, 502, classified.message, classified.kind)
              return
            }
            text = peeked
            peeked = ''
          }
          carry += text
          const newline = carry.lastIndexOf('\n')
          if (newline !== -1) {
            const complete = carry.slice(0, newline)
            carry = carry.slice(newline + 1)
            for (const line of complete.split('\n')) {
              const usageLine = usageFromSseLine(line)
              if (usageLine !== undefined) usageRecord = usageLine
              // 上游可能已经开流之后才否认令牌：这类帧必须记下来，否则用户只看到
              // 「推理到一半提示密钥无效」而没有任何可查的线索。
              const authError = streamAuthError(line)
              if (authError !== undefined) {
                stats.lastStreamAuthError = authError
                stats.lastError = `stream-auth: ${authError}`
                logger?.warn(`dsh-deveco: upstream denied the token mid-stream: ${authError}`)
              }
            }
          }
          res.write(value)
        }
        if (carry !== '') {
          const usageLine = usageFromSseLine(carry)
          if (usageLine !== undefined) usageRecord = usageLine
        }
      } catch (error: unknown) {
        logger?.debug(`dsh-deveco: upstream stream ended early (${error instanceof Error ? error.message : String(error)})`)
      } finally {
        if (idleTimer !== undefined) clearTimeout(idleTimer)
        res.end()
        usage.record({
          account: accountId,
          model: wireModel,
          ok: true,
          ms: Date.now() - started,
          ...usageRecord.inputTokens === undefined ? {} : { inputTokens: usageRecord.inputTokens },
          ...usageRecord.outputTokens === undefined ? {} : { outputTokens: usageRecord.outputTokens },
        })
      }
    } finally {
      await exitSessionQueue(accessToken, identity, wireModel).catch(() => {})
    }
  }

  const handleChat = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!hostIsLoopback(req.headers.host)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (!authorized(req)) {
      openAiError(res, 401, 'dsh-deveco: missing or wrong shim token', 'auth_error')
      return
    }
    let body: Record<string, unknown>
    try {
      const parsed = JSON.parse(await readBody(req)) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
      body = parsed as Record<string, unknown>
    } catch {
      openAiError(res, 400, 'dsh-deveco: request body is not a JSON object', 'invalid_request_error')
      return
    }

    // 只有显式 `stream: true` 才走 SSE：默认非流式，与上游默认一致。
    const stream = body.stream === true
    const requestedModel = typeof body.model === 'string' ? body.model : ''
    const { ctx } = contextForModel(catalog, requestedModel)
    const normalized = normalizeChatBody(body, ctx)
    const prepared = normalized.body
    if (normalized.notes.length > 0) logger?.debug(`dsh-deveco: normalized request (${normalized.notes.join(', ')})`)
    // 记录实际发出去的输出上限：回答被截断时这里能直接看出是不是这个值太小。
    stats.lastMaxTokens = typeof prepared.max_tokens === 'number' ? prepared.max_tokens : undefined
    stats.lastStream = stream

    // 并发闸门：上游同时只放一个生成，排不下就直接 429。
    const granted = await queue.acquire()
    if (!granted) {
      openAiError(res, 429, QUEUE_FULL_MESSAGE, 'rate_limit_error')
      return
    }

    const controller = new AbortController()
    const onClose = (): void => controller.abort()
    res.on('close', onClose)
    const exclude = new Set<string>()
    let lastError: UpstreamError | undefined

    try {
      for (let index = 0; index < MAX_ACCOUNT_ATTEMPTS; index += 1) {
        const ready = await pool.waitForFreeSlot(SLOT_WAIT_MS, controller.signal)
        if (!ready) {
          lastError = {
            kind: 'rate-limit',
            status: 429,
            message: 'every DevEco account is busy right now; please retry shortly',
            retryable: false,
            needsLogin: false,
          }
          break
        }
        const accountId = pool.pick(exclude)
        if (accountId === undefined) {
          lastError = {
            kind: 'auth',
            status: 401,
            message: 'no usable DevEco account; sign in from the DevEco plugin card',
            retryable: false,
            needsLogin: true,
          }
          break
        }
        if (!pool.acquire(accountId)) {
          exclude.add(accountId)
          continue
        }
        try {
          const wireModel = typeof prepared.model === 'string' ? upstreamModelId(prepared.model) : ''
          const identity = identityFromHeaders(req.headers as Record<string, string | string[] | undefined>, prepared)
          const project = headerValue(req.headers as Record<string, string | string[] | undefined>, 'x-deveco-project')
          const parent = headerValue(req.headers as Record<string, string | string[] | undefined>, 'x-deveco-parent-session')

          let resolved = await store.resolve(accountId)
          if (resolved === undefined) {
            pool.disable(accountId, 'credential needs sign-in')
            lastError = {
              kind: 'auth',
              status: 401,
              message: 'DevEco account needs to sign in again',
              retryable: true,
              needsLogin: true,
            }
            exclude.add(accountId)
            continue
          }

          let response: Response | undefined
          let started = Date.now()
          let authAttempts = 0
          /**
           * 401 的处理：**等 5 秒 → 刷新令牌 → 重试**，最多 5 次。
           *
           * 为什么要等：上游判 401 之后立刻刷新，经常还会拿到旧状态（令牌服务有短暂
           * 传播延迟），5 秒能让新令牌真正生效。为什么要「重试」而不是直接判死：
           * accessToken 只有 30 分钟，长回合里中途过期很常见，续期后就能接着推理。
           */
          for (;;) {
            const requestHeaders = buildChatHeaders(resolved.accessToken, identity, {
              ...project === undefined ? {} : { project },
              ...parent === undefined ? {} : { parentSession: parent },
            })
            started = Date.now()
            try {
              response = await fetch(chatUrl(stream), {
                method: 'POST',
                headers: requestHeaders,
                body: JSON.stringify({ ...prepared, model: wireModel, stream }),
                signal: controller.signal,
              })
            } catch (error: unknown) {
              usage.record({ account: accountId, model: wireModel, ok: false, ms: Date.now() - started })
              pool.noteError(accountId, 3, 30_000, 'network error')
              lastError = {
                kind: 'network',
                status: 0,
                message: error instanceof Error ? error.message : String(error),
                retryable: true,
                needsLogin: false,
              }
              exclude.add(accountId)
              response = undefined
              break
            }

            if (response.status !== 401) break

            // 401：重试预算用尽 → 停在这里，交给下面统一判断。
            if (authAttempts >= AUTH_RETRY_MAX) break
            authAttempts += 1
            const denied = await readErrorText(response)
            stats.lastAuthRetry = authAttempts
            stats.lastError = `upstream 401: ${denied}`
            logger?.warn(
              `dsh-deveco: upstream 401 (${denied}); retry ${authAttempts}/${AUTH_RETRY_MAX} `
              + `after ${authRetryDelayMs()}ms`,
            )
            await sleep(authRetryDelayMs(), controller.signal)
            if (controller.signal.aborted) {
              lastError = { kind: 'network', status: 0, message: 'request aborted', retryable: false, needsLogin: false }
              exclude.add(accountId)
              response = undefined
              break
            }
            const refreshed = await store.forceRefresh(accountId).catch(() => false)
            if (!refreshed) {
              logger?.warn('dsh-deveco: refreshing the token after a 401 failed; giving up on this account')
              break
            }
            const again = await store.resolve(accountId)
            if (again === undefined) break
            resolved = again
          }

          // 网络失败 / 取消：lastError 已经设好，换下一个号。
          if (response === undefined) continue

          if (response.ok) {
            pool.noteSuccess(accountId)
            // 一次成功就说明这个号本窗口没被额度卡住。
            quota.noteOk(accountId)
            stats.lastAccount = accountId
            stats.lastModel = wireModel
            stats.lastStatus = response.status
            stats.lastLatencyMs = Date.now() - started
            stats.lastError = undefined
            await pipeUpstream(res, {
              response,
              stream,
              accountId,
              wireModel,
              identity,
              accessToken: resolved.accessToken,
              started,
            })
            return
          }
          const message = await readErrorText(response)
          const classified = classifyUpstreamError(response.status, message)
          usage.record({ account: accountId, model: wireModel, ok: false, ms: Date.now() - started })
          stats.lastStatus = response.status
          stats.lastError = `${classified.kind}: ${message}`
          // 额度用尽与「服务过载」不是一回事：只有前者才记进额度状态。
          if (looksLikeQuotaExhausted(response.status, message)) {
            quota.noteExhausted(accountId, message)
          }
          if (classified.needsLogin) {
            if (authAttempts >= AUTH_RETRY_MAX) {
              // 已经按「5 秒 + 刷新」重试满 5 次仍是 401：这个号确实得重新登录。
              await store.markRejected(accountId, `upstream 401 after ${authAttempts} retries: ${message}`)
              pool.disable(accountId, `upstream 401 after ${authAttempts} retries`)
              lastError = {
                kind: 'auth',
                status: 401,
                message: `DevEco rejected the token ${authAttempts} times in a row (${message}); `
                  + 'sign in again from the DevEco plugin card',
                retryable: true,
                needsLogin: true,
              }
            } else {
              // 刷新本身失败了，但令牌未必真的坏：只冷却，不判死账号。
              pool.noteError(accountId, 3, 20_000, `auth: ${message}`)
              lastError = classified
            }
          } else if (classified.kind === 'rate-limit' || classified.kind === 'overloaded' || classified.kind === 'server') {
            pool.noteError(accountId, 3, 20_000, `${classified.kind}: ${message}`)
            lastError = classified
          } else {
            lastError = classified
          }
          exclude.add(accountId)
          // 连续 5 次 401 之后不再换号尝试：按用户要求「停止这次推理」，把明确的错误交回去，
          // 而不是让外层循环因为「没有可用账号」再抛一个误导性的 429。
          if (classified.needsLogin && authAttempts >= AUTH_RETRY_MAX) break
          if (classified.retryable !== true && classified.needsLogin !== true) break
        } finally {
          pool.release(accountId)
        }
      }
      const error = lastError ?? {
        kind: 'server' as const,
        status: 500,
        message: 'dsh-deveco: no account could serve this request',
        retryable: false,
        needsLogin: false,
      }
      if (!res.headersSent) openAiError(res, error.status === 0 ? 502 : error.status, error.message, error.kind)
      else res.end()
    } finally {
      res.off('close', onClose)
      queue.release()
    }
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const path = url.pathname.replace(/\/$/, '')
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      handleModels(req, res)
      return
    }
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
      void handleChat(req, res).catch((error: unknown) => {
        logger?.warn('dsh-deveco: shim request failed', error)
        if (!res.headersSent) openAiError(res, 500, error instanceof Error ? error.message : String(error))
        else res.end()
      })
      return
    }
    if (req.method === 'GET' && path === '/health') {
      json(res, 200, { ok: true, accounts: pool.list().length, queue: queue.snapshot(), stats })
      return
    }
    json(res, 404, { error: 'not found' })
  }

  const ready = new Promise<void>((resolve, reject) => {
    const instance = createServer(handler)
    instance.once('error', reject)
    instance.listen(0, '127.0.0.1', () => {
      server = instance
      const address = instance.address() as AddressInfo | null
      port = address?.port ?? 0
      stats.port = port
      resolve()
    })
  })

  return {
    baseUrl: () => `http://127.0.0.1:${port}`,
    token: () => secret,
    ready,
    close: async () => {
      queue.dispose()
      const instance = server
      server = undefined
      if (instance === undefined) return
      await new Promise<void>(resolve => {
        instance.close(() => resolve())
        const timer = setTimeout(resolve, 500)
        timer.unref?.()
      })
    },
    stats: () => ({ ...stats }),
  }
}
