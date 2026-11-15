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
  usageFromSseLine,
  type ChatUsage,
  type UpstreamError,
} from './upstream.ts'
import { hostIsLoopback } from './loopback.ts'

/** 等一个本地槽位最多等多久。 */
const SLOT_WAIT_MS = 5_000

/** 最多换几个账号重试（每个账号只试一次）。 */
const MAX_ACCOUNT_ATTEMPTS = 3

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
          const resolved = await store.resolve(accountId)
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
          const wireModel = typeof prepared.model === 'string' ? upstreamModelId(prepared.model) : ''
          const identity = identityFromHeaders(req.headers as Record<string, string | string[] | undefined>, prepared)
          const project = headerValue(req.headers as Record<string, string | string[] | undefined>, 'x-deveco-project')
          const parent = headerValue(req.headers as Record<string, string | string[] | undefined>, 'x-deveco-parent-session')
          const requestHeaders = buildChatHeaders(resolved.accessToken, identity, {
            ...project === undefined ? {} : { project },
            ...parent === undefined ? {} : { parentSession: parent },
          })
          const started = Date.now()
          let response: Response
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
            continue
          }
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
            await store.markRejected(accountId, `upstream ${response.status}: ${message}`)
            pool.disable(accountId, `upstream ${response.status}`)
          } else if (classified.kind === 'rate-limit' || classified.kind === 'overloaded' || classified.kind === 'server') {
            pool.noteError(accountId, 3, 20_000, `${classified.kind}: ${message}`)
          }
          lastError = classified
          exclude.add(accountId)
          if (!classified.retryable) break
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
