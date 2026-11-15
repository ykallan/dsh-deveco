import { describe, expect, it } from 'vitest'
import {
  cleanAssistantThink,
  currentTurnHasImage,
  EFFORT_ORDER,
  normalizeChatBody,
  normalizeDeveloperRole,
  normalizeMaxTokens,
  normalizeReasoningEffort,
  normalizeToolChoice,
  requestThinking,
  routeVision,
  snapEffort,
} from '../src/normalize.ts'
import { DEFAULT_VISION_MODEL, DEVECO_GLM_OUTPUT_LIMIT } from '../src/config.ts'

describe('normalizeDeveloperRole', () => {
  it('rewrites developer messages to system', () => {
    const result = normalizeDeveloperRole({
      messages: [
        { role: 'developer', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
    })
    expect(result.changed).toBe(true)
    expect(result.body.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('leaves other roles untouched', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] }
    expect(normalizeDeveloperRole(body).changed).toBe(false)
    expect(normalizeDeveloperRole(body).body).toBe(body)
  })
})

describe('normalizeMaxTokens', () => {
  it('maps max_completion_tokens onto max_tokens', () => {
    const result = normalizeMaxTokens({ model: 'GLM-5.1-DevEco', max_completion_tokens: 1234 }, 'GLM-5.1')
    expect(result.body.max_tokens).toBe(1234)
    expect('max_completion_tokens' in result.body).toBe(false)
  })

  it('clamps to the channel output cap', () => {
    const result = normalizeMaxTokens({ max_tokens: 131_072 }, 'GLM-5.3')
    expect(result.body.max_tokens).toBe(DEVECO_GLM_OUTPUT_LIMIT)
    expect(result.changed).toBe(true)
  })

  it('leaves an in-range value alone', () => {
    const body = { max_tokens: 4096 }
    expect(normalizeMaxTokens(body, 'GLM-5.1').changed).toBe(false)
  })
})

describe('normalizeToolChoice', () => {
  it('passes through the three legal enum values', () => {
    expect(normalizeToolChoice({ tool_choice: 'auto' }).changed).toBe(false)
    expect(normalizeToolChoice({ tool_choice: 'required' }).body.tool_choice).toBe('required')
  })

  it('emulates a forced tool with required + narrowed tools', () => {
    const result = normalizeToolChoice({
      tool_choice: { type: 'function', function: { name: 'read' } },
      tools: [
        { type: 'function', function: { name: 'read' } },
        { type: 'function', function: { name: 'write' } },
      ],
    })
    expect(result.body.tool_choice).toBe('required')
    expect(result.body.tools).toEqual([{ type: 'function', function: { name: 'read' } }])
  })

  it('degrades instead of 400 when the forced tool is not declared', () => {
    const result = normalizeToolChoice({ tool_choice: { type: 'function', function: { name: 'nope' } }, tools: [] })
    expect(result.body.tool_choice).toBe('auto')
  })

  it('drops an unknown string choice', () => {
    const result = normalizeToolChoice({ tool_choice: 'any' })
    expect('tool_choice' in result.body).toBe(false)
  })
})

describe('snapEffort', () => {
  it('keeps declared levels', () => {
    expect(snapEffort('high', ['low', 'high', 'max'])).toBe('high')
  })

  it('snaps an undeclared level to the nearest declared one', () => {
    expect(snapEffort('medium', ['low', 'high', 'max'])).toBe('high')
    expect(snapEffort('minimal', ['low', 'high', 'max'])).toBe('low')
    expect(snapEffort('xhigh', ['low', 'high', 'max'])).toBe('max')
  })

  it('maps off onto none before snapping', () => {
    expect(snapEffort('off', ['none', 'high'])).toBe('none')
  })

  it('returns undefined when nothing is comparable', () => {
    expect(snapEffort('bogus', ['low', 'high'])).toBeUndefined()
  })
})

describe('normalizeReasoningEffort', () => {
  it('drops an effort the model does not declare', () => {
    const result = normalizeReasoningEffort({ reasoning_effort: 'nonsense' }, { model: 'GLM-5.3', levels: ['low', 'high'] })
    expect('reasoning_effort' in result.body).toBe(false)
  })

  it('turns none into thinking disabled when the model declares no levels', () => {
    const result = normalizeReasoningEffort({ reasoning_effort: 'none' }, { model: 'GLM-5.1' })
    expect(result.body.thinking).toEqual({ type: 'disabled' })
    expect('reasoning_effort' in result.body).toBe(false)
  })

  it('keeps a standard level for a model that declares none', () => {
    const result = normalizeReasoningEffort({ reasoning_effort: 'low' }, { model: 'GLM-5.1' })
    expect(result.body.reasoning_effort).toBe('low')
    expect(result.changed).toBe(false)
  })

  it('drops non-string efforts', () => {
    const result = normalizeReasoningEffort({ reasoning_effort: 3 }, { model: 'GLM-5.1' })
    expect('reasoning_effort' in result.body).toBe(false)
  })

  it('covers every pi-ai level in the ordering table', () => {
    expect(EFFORT_ORDER[0]).toBe('none')
    expect(EFFORT_ORDER.at(-1)).toBe('max')
  })
})

describe('requestThinking', () => {
  it('adds chat_template_kwargs.enable_thinking', () => {
    expect(requestThinking({}).body.chat_template_kwargs).toEqual({ enable_thinking: true })
  })

  it('preserves other template kwargs', () => {
    expect(requestThinking({ chat_template_kwargs: { foo: 1 } }).body.chat_template_kwargs)
      .toEqual({ foo: 1, enable_thinking: true })
  })

  it('is a no-op when thinking is already requested', () => {
    const body = { chat_template_kwargs: { enable_thinking: true } }
    expect(requestThinking(body).changed).toBe(false)
  })
})

describe('cleanAssistantThink', () => {
  it('trims inline reasoning from assistant history', () => {
    const result = cleanAssistantThink({
      messages: [{ role: 'assistant', content: 'thinking…</think>the answer' }],
    })
    expect(result.body.messages).toEqual([{ role: 'assistant', content: 'the answer' }])
  })

  it('handles text parts', () => {
    const result = cleanAssistantThink({
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'a</think>b' }] }],
    })
    expect((result.body.messages as { content: { text: string }[] }[])[0]!.content[0]!.text).toBe('b')
  })

  it('leaves messages without a closing tag alone', () => {
    const body = { messages: [{ role: 'assistant', content: 'plain' }] }
    expect(cleanAssistantThink(body).changed).toBe(false)
  })
})

describe('vision routing', () => {
  const image = { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'x' } }] }

  it('detects images in the current turn only', () => {
    expect(currentTurnHasImage([{ role: 'assistant', content: 'ok' }, image])).toBe(true)
    expect(currentTurnHasImage([image, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }])).toBe(false)
  })

  it('reroutes a text-only model and drops tools', () => {
    const result = routeVision(
      { model: 'GLM-5.1', messages: [image], tools: [{ type: 'function', function: { name: 'a' } }], tool_choice: 'auto' },
      { model: 'GLM-5.1', textOnly: true },
      'GLM-5.1',
    )
    expect(result.body.model).toBe(DEFAULT_VISION_MODEL)
    expect('tools' in result.body).toBe(false)
    expect('tool_choice' in result.body).toBe(false)
  })

  it('replaces historical images with a placeholder when the current turn has none', () => {
    const result = routeVision(
      { model: 'GLM-5.1', messages: [image, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'go on' }] },
      { model: 'GLM-5.1', textOnly: true },
      'GLM-5.1',
    )
    expect(result.notes).toContain('images-placeholdered')
    expect(JSON.stringify(result.body.messages)).toContain('[图片]')
  })

  it('never touches a vision-capable model', () => {
    const body = { model: 'Qwen', messages: [image] }
    expect(routeVision(body, { model: 'Qwen', textOnly: false }, 'Qwen').changed).toBe(false)
  })
})

describe('normalizeChatBody', () => {
  it('applies the whole pipeline and reports what it did', () => {
    const result = normalizeChatBody({
      model: 'GLM-5.3-DevEco',
      messages: [{ role: 'developer', content: 'sys' }],
      max_tokens: 999_999,
      reasoning_effort: 'medium',
      tool_choice: { type: 'function', function: { name: 'read' } },
      tools: [{ type: 'function', function: { name: 'read' } }],
    }, { model: 'GLM-5.3', levels: ['low', 'high', 'max'], reasoning: true })
    expect(result.body.messages).toEqual([{ role: 'system', content: 'sys' }])
    expect(result.body.max_tokens).toBe(DEVECO_GLM_OUTPUT_LIMIT)
    expect(result.body.reasoning_effort).toBe('high')
    expect(result.body.tool_choice).toBe('required')
    expect(result.body.chat_template_kwargs).toEqual({ enable_thinking: true })
    expect(result.notes).toContain('developer-role->system')
  })

  it('does not request thinking for a non-reasoning model', () => {
    const result = normalizeChatBody({ model: 'Qwen' }, { model: 'Qwen', reasoning: false })
    expect('chat_template_kwargs' in result.body).toBe(false)
  })
})
