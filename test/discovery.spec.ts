import { describe, expect, it } from 'vitest'
import {
  fetchModelConfig,
  parseModelConfig,
  parseReasoningEfforts,
  toModelInfo,
} from '../src/discovery.ts'
import { backfillParams, filterEnabledModels, HIDDEN_MODELS, mergeModelLists } from '../src/catalog.ts'

const GROUP = {
  protocol: 'openai',
  group_name: 'GLM',
  task_default_model_map: {
    small_model: 'GLM-5.1',
    ui_verification: 'Qwen3_5_397B_A17B_w8a8_single',
    blacklist: 'Qwen3_5_397B_A17B_w8a8_single',
  },
  model_configs: [
    {
      model_id: 'GLM-5.3',
      thinking_mode: 'on',
      input_modalities: ['text'],
      context_window: 170000,
      output: '32000',
      tool_call_mode: 'tool_calls',
      reasoning_effort: '{"level":["low","high","max"],"default":"high"}',
    },
    {
      model_id: 'GLM-5.1',
      thinking_mode: 'on',
      input_modalities: ['text'],
      context_window: 170000,
      output: 32000,
      tool_call_mode: 'tool_calls',
    },
    { model_id: 'Qwen3_5_397B_A17B_w8a8_single', input_modalities: ['text', 'image'] },
  ],
}

describe('parseReasoningEfforts', () => {
  it('reads the level/default JSON form', () => {
    expect(parseReasoningEfforts('{"level":["low","high"],"default":"high"}')).toEqual({
      levels: ['low', 'high'],
      default: 'high',
    })
  })

  it('accepts the legacy plain-array form', () => {
    expect(parseReasoningEfforts('["low","high"]')).toEqual({ levels: ['low', 'high'] })
  })

  it('drops a default that is not in the level list', () => {
    expect(parseReasoningEfforts('{"level":["low"],"default":"max"}')).toEqual({ levels: ['low'] })
  })

  it('returns undefined for junk', () => {
    expect(parseReasoningEfforts('not json')).toBeUndefined()
    expect(parseReasoningEfforts(undefined)).toBeUndefined()
    expect(parseReasoningEfforts('{"level":[]}')).toBeUndefined()
  })
})

describe('toModelInfo', () => {
  it('maps a full entry', () => {
    expect(toModelInfo(GROUP.model_configs[0])).toEqual({
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
    })
  })

  it('accepts a numeric output field', () => {
    expect(toModelInfo(GROUP.model_configs[1])?.maxTokens).toBe(32_000)
  })

  it('detects image input', () => {
    expect(toModelInfo(GROUP.model_configs[2])?.supportsImages).toBe(true)
  })

  it('rejects an entry without a model id', () => {
    expect(toModelInfo({})).toBeUndefined()
  })
})

describe('parseModelConfig', () => {
  it('parses the upstream body and applies the blacklist', () => {
    const parsed = parseModelConfig({ code: 200, body: { inner_models: [GROUP] } })
    expect(parsed.models.map(model => model.wireId)).toEqual(['GLM-5.3', 'GLM-5.1'])
    expect(parsed.smallModel).toBe('GLM-5.1')
    expect(parsed.blacklist).toContain('Qwen3_5_397B_A17B_w8a8_single')
  })

  it('survives a malformed body', () => {
    expect(parseModelConfig({}).models).toEqual([])
    expect(parseModelConfig(null).models).toEqual([])
  })
})

describe('fetchModelConfig', () => {
  it('rejects an empty catalog so callers can keep the previous one', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: 200, body: { inner_models: [] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
    try {
      await expect(fetchModelConfig('token')).rejects.toThrow('no usable model')
    } finally {
      globalThis.fetch = original
    }
  })

  it('surfaces a non-200 code', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: 401 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
    try {
      await expect(fetchModelConfig('token')).rejects.toThrow('code 401')
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('catalog helpers', () => {
  const glm51 = {
    id: 'GLM-5.1-DevEco',
    wireId: 'GLM-5.1',
    name: 'GLM-5.1-DevEco',
    contextWindow: 0,
    maxTokens: 0,
    supportsImages: false,
  }
  const glm53 = {
    id: 'GLM-5.3-DevEco',
    wireId: 'GLM-5.3',
    name: 'GLM-5.3-DevEco',
    contextWindow: 170_000,
    maxTokens: 32_000,
    supportsImages: false,
  }

  it('backfills zeroed params from the table', () => {
    const [filled] = backfillParams([glm51])
    expect(filled?.contextWindow).toBe(170_000)
    expect(filled?.maxTokens).toBe(32_000)
    expect(filled?.reasoning).toBe(true)
  })

  it('never injects a model that discovery did not return', () => {
    expect(backfillParams([])).toEqual([])
  })

  it('merges duplicates keeping the richer record', () => {
    const merged = mergeModelLists([[glm51], [glm53]])
    expect(merged.map(model => model.wireId)).toEqual(['GLM-5.1', 'GLM-5.3'])
  })

  it('treats an empty allowlist as "everything"', () => {
    expect(filterEnabledModels([glm51, glm53], undefined)).toHaveLength(2)
    expect(filterEnabledModels([glm51, glm53], [])).toHaveLength(2)
  })

  it('keeps everything when the allowlist matches nothing', () => {
    expect(filterEnabledModels([glm51, glm53], ['gone'])).toHaveLength(2)
  })

  it('narrows to the selected ids (case-insensitive)', () => {
    expect(filterEnabledModels([glm51, glm53], ['glm-5.3-deveco']).map(model => model.wireId)).toEqual(['GLM-5.3'])
  })

  it('exposes the hidden deepseek model separately', () => {
    expect(HIDDEN_MODELS.map(model => model.wireId)).toContain('deepseek-v4-flash')
  })
})
