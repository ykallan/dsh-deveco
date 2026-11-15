/**
 * OpenAI 请求体 → DevEco 能接受的形状。
 *
 * 上游不是「标准 OpenAI」，有六条会直接 400/403 的硬规则（`docs/PROTOCOL.md` 第 5 节）：
 *
 * 1. `developer` 角色不在枚举里 → 改成 `system`；
 * 2. `max_completion_tokens` 被忽略 → 映射成 `max_tokens`，并按渠道上限（32K）钳住；
 * 3. `tool_choice` 只收 `"auto" | "none" | "required"`，对象形式整个请求 400
 *    → 指定某个工具要用 `"required"` + 收窄 `tools` 模拟；
 * 4. `reasoning_effort` 只能发上游声明过的档位，未知值直接丢；
 * 5. 思考内容要显式索要（`chat_template_kwargs.enable_thinking`），否则会被塞进 `content`
 *    并以一个孤零零的 `</think>` 结尾 —— 前端看起来像模型在胡说；
 * 6. 纯文本模型收到图片是 403，必须改路由（`vision.ts`）。
 *
 * 所有函数都是纯函数：给同样的输入永远是同样的输出，方便单测。
 *
 * @module dsh-deveco/normalize
 */

import { channelLimitsFor, DEFAULT_VISION_MODEL } from './config.ts'

/** pi-ai 的标准档位，按由弱到强排列。 */
export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** 归一化时的上下文（这条请求对应的模型声明）。 */
export interface NormalizeContext {
  /** 上游 wire id。 */
  model: string
  /** 上游声明的思考档位；缺省 = 这条模型没声明档位。 */
  levels?: readonly string[]
  /** 这条模型是思考模型（要显式索要思考内容）。 */
  reasoning?: boolean
  /** 纯文本模型（收到图片要改路由）。 */
  textOnly?: boolean
  /** 视觉模型 id（默认 `DEFAULT_VISION_MODEL`）。 */
  visionModel?: string
}

/** 归一化结果。 */
export interface NormalizedBody {
  body: Record<string, unknown>
  changed: boolean
  /** 做过什么（诊断用，只有形状，不含内容）。 */
  notes: string[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `developer` → `system`。
 *
 * 上游 role 枚举只有 `function|user|assistant|system|tool`；新版 OpenAI 客户端会把系统
 * 提示拆成 `developer`，直接发过去整条请求 400。
 */
export function normalizeDeveloperRole(body: Record<string, unknown>): NormalizedBody {
  const messages = body.messages
  if (!Array.isArray(messages)) return { body, changed: false, notes: [] }
  let changed = false
  const next = messages.map(message => {
    if (!isPlainObject(message) || message.role !== 'developer') return message
    changed = true
    return { ...message, role: 'system' }
  })
  if (!changed) return { body, changed: false, notes: [] }
  return { body: { ...body, messages: next }, changed: true, notes: ['developer-role->system'] }
}

/**
 * `max_completion_tokens` → `max_tokens`，并按渠道声明上限钳住。
 *
 * 为什么必须钳：DSH 会把目录里的 `maxTokens` 原样作为上限发出去，而 GLM 这条渠道
 * 声明的是 32K —— 发更大的值上游直接 400（不是截断，是整条请求失败）。
 */
export function normalizeMaxTokens(body: Record<string, unknown>, model: string): NormalizedBody {
  const next = { ...body }
  let changed = false
  const completion = next.max_completion_tokens
  delete next.max_completion_tokens
  if (completion !== undefined) changed = true
  if (typeof completion === 'number' && next.max_tokens === undefined) next.max_tokens = completion
  const cap = channelLimitsFor(model)?.output
  if (cap !== undefined && typeof next.max_tokens === 'number' && next.max_tokens > cap) {
    next.max_tokens = cap
    changed = true
  }
  return changed
    ? { body: next, changed: true, notes: ['max-tokens-normalized'] }
    : { body, changed: false, notes: [] }
}

/** 把一个工具名从 `{type:'function',function:{name}}` / `{name}` 里取出来。 */
function forcedToolName(choice: Record<string, unknown>): string | undefined {
  const fn = choice.function
  if (isPlainObject(fn) && typeof fn.name === 'string') return fn.name
  if (typeof choice.name === 'string') return choice.name
  return undefined
}

/** 只留下名字匹配的那个工具。 */
function narrowTools(tools: unknown, name: string): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined
  const kept = tools.filter(tool => {
    if (!isPlainObject(tool)) return false
    const fn = tool.function
    if (isPlainObject(fn) && fn.name === name) return true
    return tool.name === name
  })
  return kept.length === 0 ? undefined : kept
}

/**
 * `tool_choice` 只留枚举值。
 *
 * 对象形式（指定某个工具）在上游会 400，所以用 `"required"` + 只留那一个工具来模拟；
 * 实在模拟不了就退回 `"auto"` —— 降级也绝不能让整条请求挂掉。
 */
export function normalizeToolChoice(body: Record<string, unknown>): NormalizedBody {
  const choice = body.tool_choice
  if (choice === undefined) return { body, changed: false, notes: [] }
  if (typeof choice === 'string') {
    const value = choice.trim().toLowerCase()
    if (value === 'auto' || value === 'none' || value === 'required') {
      return value === choice ? { body, changed: false, notes: [] } : { body: { ...body, tool_choice: value }, changed: true, notes: ['tool-choice-lowercased'] }
    }
    const next = { ...body }
    delete next.tool_choice
    return { body: next, changed: true, notes: ['tool-choice-dropped'] }
  }
  if (!isPlainObject(choice)) {
    const next = { ...body }
    delete next.tool_choice
    return { body: next, changed: true, notes: ['tool-choice-dropped'] }
  }
  const type = typeof choice.type === 'string' ? choice.type.toLowerCase() : ''
  if (type === 'auto' || type === 'none' || type === 'required') {
    return { body: { ...body, tool_choice: type }, changed: true, notes: ['tool-choice-unwrapped'] }
  }
  const name = forcedToolName(choice)
  if (name !== undefined) {
    const narrowed = narrowTools(body.tools, name)
    if (narrowed !== undefined) {
      return {
        body: { ...body, tool_choice: 'required', tools: narrowed },
        changed: true,
        notes: ['tool-choice-forced'],
      }
    }
  }
  return { body: { ...body, tool_choice: 'auto' }, changed: true, notes: ['tool-choice-degraded'] }
}

/**
 * 档位吸附。
 *
 * 上游声明了档位的模型（GLM-5.3：`low|high|max`）只认声明值；未声明档位或声明之外的
 * 值一律丢弃 —— 让上游走它自己的默认，比发一个它不认识的枚举安全。
 */
export function snapEffort(value: string, levels: readonly string[]): string | undefined {
  if (levels.includes(value)) return value
  const normalized = value === 'off' ? 'none' : value
  if (levels.includes(normalized)) return normalized
  const target = EFFORT_ORDER.indexOf(normalized as (typeof EFFORT_ORDER)[number])
  if (target === -1) return undefined
  let best: string | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const level of levels) {
    const index = EFFORT_ORDER.indexOf(level as (typeof EFFORT_ORDER)[number])
    if (index === -1) continue
    const distance = Math.abs(index - target)
    // 同样近时取更强的那档：实测不到位的档位会让模型「几乎不在思考」，宁可变慢。
    if (distance < bestDistance || (distance === bestDistance && index > EFFORT_ORDER.indexOf(best as (typeof EFFORT_ORDER)[number]))) {
      best = level
      bestDistance = distance
    }
  }
  return best
}

/** `reasoning_effort` 归一化（含 `none`/`off` → 关闭思考）。 */
export function normalizeReasoningEffort(body: Record<string, unknown>, ctx: NormalizeContext): NormalizedBody {
  const effort = body.reasoning_effort
  if (effort === undefined) return { body, changed: false, notes: [] }
  if (typeof effort !== 'string') {
    const next = { ...body }
    delete next.reasoning_effort
    return { body: next, changed: true, notes: ['effort-dropped-non-string'] }
  }
  const value = effort.trim().toLowerCase()
  if (value === '') {
    const next = { ...body }
    delete next.reasoning_effort
    return { body: next, changed: true, notes: ['effort-dropped-empty'] }
  }
  const levels = ctx.levels ?? []
  if (levels.length > 0) {
    const snapped = snapEffort(value, levels)
    if (snapped === undefined) {
      const next = { ...body }
      delete next.reasoning_effort
      return { body: next, changed: true, notes: ['effort-dropped-undeclared'] }
    }
    if (snapped === value) return { body, changed: false, notes: [] }
    return { body: { ...body, reasoning_effort: snapped }, changed: true, notes: ['effort-snapped'] }
  }
  if (value === 'none' || value === 'off') {
    const next = { ...body }
    delete next.reasoning_effort
    next.thinking = { type: 'disabled' }
    return { body: next, changed: true, notes: ['thinking-disabled'] }
  }
  if ((EFFORT_ORDER as readonly string[]).includes(value)) {
    return value === effort
      ? { body, changed: false, notes: [] }
      : { body: { ...body, reasoning_effort: value }, changed: true, notes: ['effort-lowercased'] }
  }
  const next = { ...body }
  delete next.reasoning_effort
  return { body: next, changed: true, notes: ['effort-dropped-unknown'] }
}

/**
 * 显式索要思考内容。
 *
 * 不索要时 GLM 会把思考写进 `content`，并以一个没有开头标签的 `</think>` 收尾 ——
 * DSH 的渲染和重放都会被这段污染。索要之后上游用独立的 reasoning 字段返回。
 */
export function requestThinking(body: Record<string, unknown>): NormalizedBody {
  const current = body.chat_template_kwargs
  const merged = isPlainObject(current) ? { ...current, enable_thinking: true } : { enable_thinking: true }
  if (isPlainObject(current) && current.enable_thinking === true) return { body, changed: false, notes: [] }
  return { body: { ...body, chat_template_kwargs: merged }, changed: true, notes: ['thinking-requested'] }
}

/**
 * 清掉历史里内联的思考尾巴。
 *
 * 老会话（或别的客户端）留下的 assistant 内容可能带着 `…</think>真正的回答`。重放时
 * 上游会把它当普通文本，越滚越长。只在最后一个 `</think>` 处切一刀，没有就不动。
 */
export function cleanAssistantThink(body: Record<string, unknown>): NormalizedBody {
  const messages = body.messages
  if (!Array.isArray(messages)) return { body, changed: false, notes: [] }
  let changed = false
  const next = messages.map(message => {
    if (!isPlainObject(message) || message.role !== 'assistant') return message
    const content = message.content
    if (typeof content === 'string') {
      const index = content.lastIndexOf('</think>')
      if (index === -1) return message
      changed = true
      const trimmed = content.slice(index + '</think>'.length).trimStart()
      return { ...message, content: trimmed }
    }
    if (!Array.isArray(content)) return message
    let touched = false
    const parts = content.map(part => {
      if (!isPlainObject(part) || part.type !== 'text' || typeof part.text !== 'string') return part
      const index = part.text.lastIndexOf('</think>')
      if (index === -1) return part
      touched = true
      return { ...part, text: part.text.slice(index + '</think>'.length).trimStart() }
    })
    if (!touched) return message
    changed = true
    return { ...message, content: parts }
  })
  return changed
    ? { body: { ...body, messages: next }, changed: true, notes: ['assistant-think-trimmed'] }
    : { body, changed: false, notes: [] }
}

/** 消息里有没有图片块。 */
export function hasImageContent(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false
  for (const message of messages) {
    if (!isPlainObject(message)) continue
    const content = message.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (isPlainObject(part) && (part.type === 'image_url' || part.type === 'image')) return true
    }
  }
  return false
}

/** 从最后一条 assistant 之后的消息里找图片（= 这一轮的新输入）。 */
export function currentTurnHasImage(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false
  let start = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (isPlainObject(message) && message.role === 'assistant') {
      start = index + 1
      break
    }
  }
  return hasImageContent(messages.slice(start))
}

/** 把历史图片换成文字占位（纯文本模型 + 只有历史里有图时）。 */
export function replaceImagesWithPlaceholder(body: Record<string, unknown>): NormalizedBody {
  const messages = body.messages
  if (!Array.isArray(messages)) return { body, changed: false, notes: [] }
  let changed = false
  const next = messages.map(message => {
    if (!isPlainObject(message)) return message
    const content = message.content
    if (!Array.isArray(content)) return message
    let touched = false
    const parts = content.map(part => {
      if (!isPlainObject(part)) return part
      if (part.type !== 'image_url' && part.type !== 'image') return part
      touched = true
      return { type: 'text', text: '[图片]' }
    })
    if (!touched) return message
    changed = true
    return { ...message, content: parts }
  })
  return changed
    ? { body: { ...body, messages: next }, changed: true, notes: ['images-placeholdered'] }
    : { body, changed: false, notes: [] }
}

/**
 * 视觉路由。
 *
 * 纯文本模型（`input_modalities: ['text']`）收到含图请求会 403。这一轮真有图就换视觉
 * 模型，并且**必须**丢掉 `tools`/`tool_choice`：那个模型只会把工具调用当文本吐出来，
 * 结构化调用根本不会发生。只有历史有图则原地换成 `[图片]` 占位，保持当前模型。
 */
export function routeVision(
  body: Record<string, unknown>,
  ctx: NormalizeContext,
  currentModel: string,
): NormalizedBody {
  if (ctx.textOnly !== true) return { body, changed: false, notes: [] }
  if (currentTurnHasImage(body.messages)) {
    const next: Record<string, unknown> = {
      ...body,
      model: ctx.visionModel ?? DEFAULT_VISION_MODEL,
    }
    delete next.tools
    delete next.tool_choice
    return { body: next, changed: true, notes: ['vision-rerouted'] }
  }
  if (!hasImageContent(body.messages)) return { body, changed: false, notes: [] }
  if (currentModel === (ctx.visionModel ?? DEFAULT_VISION_MODEL)) return { body, changed: false, notes: [] }
  return replaceImagesWithPlaceholder(body)
}

/** 归一化管线：顺序有意义（`tool_choice` 必须在 `tools` 收窄之后）。 */
export function normalizeChatBody(
  body: Record<string, unknown>,
  ctx: NormalizeContext,
): NormalizedBody {
  let current = body
  const notes: string[] = []
  const steps: ((input: Record<string, unknown>) => NormalizedBody)[] = [
    input => cleanAssistantThink(input),
    input => normalizeDeveloperRole(input),
    input => normalizeMaxTokens(input, String(input.model ?? ctx.model)),
    input => normalizeReasoningEffort(input, ctx),
    input => ctx.reasoning === true ? requestThinking(input) : { body: input, changed: false, notes: [] },
    input => routeVision(input, ctx, String(input.model ?? ctx.model)),
    input => normalizeToolChoice(input),
  ]
  for (const step of steps) {
    const outcome = step(current)
    if (outcome.changed) {
      current = outcome.body
      notes.push(...outcome.notes)
    }
  }
  return { body: current, changed: notes.length > 0, notes }
}
