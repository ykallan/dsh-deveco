import { describe, expect, it } from 'vitest'
import { piModelFor, thinkingFields } from '../src/adapter.ts'
import { DEVECO_OUTPUT_CEILING } from '../src/config.ts'
import type { DevecoModelInfo } from '../src/catalog.ts'

/**
 * 这里的重点是 `maxTokens` —— 它是**单次输出**上限，pi-ai 在请求没带 max_tokens 时直接
 * 拿它当天花板。以前兜底 8192，导致 1M 上下文的模型也在 8K 处被截断。
 */
function info(overrides: Partial<DevecoModelInfo> = {}): DevecoModelInfo {
  return {
    id: 'deepseek-v4.1-flash-1017',
    wireId: 'deepseek-v4.1-flash-1017',
    name: 'deepseek-v4.1-flash-1017',
    contextWindow: 1_048_576,
    contextWindowKnown: true,
    maxTokens: 0,
    supportsImages: true,
    ...overrides,
  }
}

describe('piModelFor', () => {
  it('advertises the channel output ceiling when upstream gives no output', () => {
    const model = piModelFor(info({ maxTokens: 0 }), 'http://127.0.0.1:1/v1')
    // 关键回归：不能退回到 8192。
    expect(model.maxTokens).toBe(DEVECO_OUTPUT_CEILING)
  })

  it('keeps a declared output cap that is within the ceiling', () => {
    const model = piModelFor(info({ maxTokens: 32_000 }), 'http://127.0.0.1:1/v1')
    expect(model.maxTokens).toBe(32_000)
  })

  it('never advertises more than the channel ceiling', () => {
    const model = piModelFor(info({ maxTokens: 131_072 }), 'http://127.0.0.1:1/v1')
    expect(model.maxTokens).toBe(DEVECO_OUTPUT_CEILING)
  })

  it('keeps the context window independent of the output cap', () => {
    const model = piModelFor(info(), 'http://127.0.0.1:1/v1')
    expect(model.contextWindow).toBe(1_048_576)
    expect(model.maxTokens).toBe(DEVECO_OUTPUT_CEILING)
    expect(model.maxTokens).toBeLessThan(model.contextWindow)
  })

  it('falls back to a sane context when upstream gives none', () => {
    const model = piModelFor(info({ contextWindow: 0, contextWindowKnown: false }), 'http://127.0.0.1:1/v1')
    expect(model.contextWindow).toBe(32_768)
  })

  it('declares image input only when the model supports it', () => {
    expect(piModelFor(info({ supportsImages: true }), 'http://x/v1').input).toEqual(['text', 'image'])
    expect(piModelFor(info({ supportsImages: false }), 'http://x/v1').input).toEqual(['text'])
  })

  it('marks reasoning models and maps undeclared levels to null', () => {
    const model = piModelFor(info({ reasoning: true, thinking: { levels: ['low', 'high', 'max'], default: 'high' } }), 'http://x/v1')
    expect(model.reasoning).toBe(true)
    expect(model.thinkingLevelMap).toMatchObject({ low: 'low', high: 'high', max: 'max', off: null, minimal: null })
  })
})

describe('thinkingFields', () => {
  it('offers no reasoning when no real level is declared', () => {
    expect(thinkingFields(undefined).reasoning).toBe(false)
    expect(thinkingFields([]).reasoning).toBe(false)
  })

  it('pins every undeclared level to null', () => {
    const fields = thinkingFields(['high'])
    expect(fields.reasoning).toBe(true)
    expect(fields.thinkingLevelMap?.off).toBeNull()
    expect(fields.thinkingLevelMap?.high).toBe('high')
  })
})
