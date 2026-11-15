import { describe, expect, it } from 'vitest'
import {
  buildChatHeaders,
  chatUrl,
  classifyUpstreamError,
  conversationKey,
  exitSessionQueue,
  firstFrameError,
  identityFromHeaders,
  normalizeAffinityId,
  readErrorText,
  resetChatIdCache,
  usageFromJson,
  usageFromSseLine,
} from '../src/upstream.ts'

describe('normalizeAffinityId', () => {
  it('strips hyphens from a UUID', () => {
    const id = normalizeAffinityId('123e4567-e89b-12d3-a456-426614174000')
    expect(id).toBe('123e4567e89b12d3a456426614174000')
    expect(id).toHaveLength(32)
  })

  it('keeps a short id untouched', () => {
    expect(normalizeAffinityId('abc')).toBe('abc')
  })

  it('hashes an over-long id into 32 hex chars', () => {
    const id = normalizeAffinityId('x'.repeat(80))
    expect(id).toHaveLength(32)
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    // 稳定：同样的输入永远同样的输出（否则每轮都会新开上游会话）。
    expect(normalizeAffinityId('x'.repeat(80))).toBe(id)
  })

  it('returns an empty string for blank input', () => {
    expect(normalizeAffinityId('   ')).toBe('')
  })
})

describe('conversationKey', () => {
  it('keys on the first user message, not messages[0]', () => {
    const a = conversationKey({
      messages: [
        { role: 'system', content: 'today is Monday' },
        { role: 'user', content: 'hello' },
      ],
    })
    const b = conversationKey({
      messages: [
        { role: 'system', content: 'today is Tuesday' },
        { role: 'user', content: 'hello' },
      ],
    })
    expect(a).toBe(b)
    expect(a).toHaveLength(32)
  })

  it('changes when the first user message changes', () => {
    expect(conversationKey({ messages: [{ role: 'user', content: 'a' }] }))
      .not.toBe(conversationKey({ messages: [{ role: 'user', content: 'b' }] }))
  })

  it('survives a body without messages', () => {
    expect(conversationKey({})).toHaveLength(32)
  })
})

describe('identityFromHeaders', () => {
  it('honours an explicit session header', () => {
    resetChatIdCache()
    const identity = identityFromHeaders({ 'x-deveco-session': 'sess-1' }, { messages: [] })
    expect(identity.sessionId).toBe('sess-1')
    expect(identity.chatId).toHaveLength(32)
    expect(identity.taskId).toHaveLength(32)
  })

  it('keeps the chat id stable per session and refreshes the task id per call', () => {
    resetChatIdCache()
    const first = identityFromHeaders({ 'x-session-id': 'same' }, { messages: [] })
    const second = identityFromHeaders({ 'x-session-id': 'same' }, { messages: [] })
    expect(second.chatId).toBe(first.chatId)
    expect(second.taskId).not.toBe(first.taskId)
  })

  it('prefers x-deveco-session over x-session-id', () => {
    resetChatIdCache()
    const identity = identityFromHeaders({ 'x-deveco-session': 'a', 'x-session-id': 'b' }, { messages: [] })
    expect(identity.sessionId).toBe('a')
  })
})

describe('buildChatHeaders', () => {
  const identity = { sessionId: 's', chatId: 'c', taskId: 't' }

  it('sends every header the upstream requires', () => {
    const headers = buildChatHeaders('token', identity)
    expect(headers.Authorization).toBe('Bearer token')
    expect(headers.lang).toBe('en')
    expect(headers['Session-Id']).toBe('s')
    expect(headers['Chat-Id']).toBe('c')
    expect(headers['x-deveco-session']).toBe('s')
    expect(headers['x-deveco-task']).toBe('t')
    expect(headers['x-deveco-client']).toMatch(/^deveco-code@/)
    expect(headers['X-DevEco-Improvement-Enabled']).toBe('false')
    expect(headers['accept-language']).toBe('zh-CN')
  })

  it('passes through optional affinity headers', () => {
    const headers = buildChatHeaders('token', identity, {
      project: 'proj',
      parentSession: '123e4567-e89b-12d3-a456-426614174000',
    })
    expect(headers['x-deveco-project']).toBe('proj')
    expect(headers['x-deveco-parent-session']).toBe('123e4567e89b12d3a456426614174000')
  })
})

describe('chatUrl', () => {
  it('uses a different path for non-streaming', () => {
    expect(chatUrl(true)).toContain('/sse/codeGenie/maas/v2/chat/completions')
    expect(chatUrl(false)).toContain('/sse/codeGenie/maas/v2/no-stream/chat/completions')
  })
})

describe('classifyUpstreamError', () => {
  it('treats 401 as "sign in again"', () => {
    const error = classifyUpstreamError(401, 'unauthorized')
    expect(error.needsLogin).toBe(true)
    expect(error.retryable).toBe(false)
  })

  it('retries 429 and 5xx on another account', () => {
    expect(classifyUpstreamError(429, 'slow down').retryable).toBe(true)
    expect(classifyUpstreamError(503, 'busy').retryable).toBe(true)
  })

  it('adds the channel limit hint to a length error', () => {
    const error = classifyUpstreamError(400, 'the prompt length 1044994 must less than the maximum input length 1044480')
    expect(error.kind).toBe('context')
    expect(error.message).toContain('170,000')
    expect(error.retryable).toBe(false)
  })

  it('treats a 403 session complaint as retryable without forcing a re-login', () => {
    const error = classifyUpstreamError(403, 'New session request rate exceeded')
    expect(error.needsLogin).toBe(false)
    expect(error.retryable).toBe(true)
  })
})

describe('readErrorText', () => {
  it('unwraps an OpenAI error envelope', async () => {
    const response = new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 400 })
    expect(await readErrorText(response)).toBe('boom')
  })

  it('falls back to the raw text', async () => {
    const response = new Response('plain failure', { status: 500 })
    expect(await readErrorText(response)).toBe('plain failure')
  })
})

describe('usage extraction', () => {
  it('reads usage from a JSON body', () => {
    expect(usageFromJson({ usage: { prompt_tokens: 10, completion_tokens: 4 } }))
      .toEqual({ inputTokens: 10, outputTokens: 4 })
  })

  it('reads usage from an SSE line', () => {
    const line = 'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}'
    expect(usageFromSseLine(line)).toEqual({ inputTokens: 12, outputTokens: 3 })
  })

  it('ignores lines without usage', () => {
    expect(usageFromSseLine('data: {"choices":[{"delta":{"content":"hi"}}]}')).toBeUndefined()
    expect(usageFromSseLine('data: [DONE]')).toBeUndefined()
  })
})

describe('firstFrameError', () => {
  it('finds an error frame', () => {
    expect(firstFrameError('data: {"error":{"message":"model overloaded"}}')).toBe('model overloaded')
  })

  it('returns undefined for normal frames', () => {
    expect(firstFrameError('data: {"choices":[{"delta":{"content":"hi"}}]}')).toBeUndefined()
  })
})

describe('exitSessionQueue', () => {
  it('posts once and never throws when the upstream fails', async () => {
    const calls: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input))
      throw new Error('offline')
    }) as typeof fetch
    try {
      await expect(exitSessionQueue('token', { sessionId: 's', chatId: 'c', taskId: 't' }, 'GLM-5.1'))
        .resolves.toBeUndefined()
      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0]).toContain('exitSessionQueue?modelId=GLM-5.1')
    } finally {
      globalThis.fetch = original
    }
  })
})
