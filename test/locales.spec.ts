import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

/**
 * 文案守卫：卡片里每个 `t('…')` 都必须在两份字典里存在。
 *
 * 漏一个键不会报错 —— 界面会直接把键名印出来（`tabAccounts`），这类缺陷在真实页面上
 * 很容易漏看，所以用测试兜住。
 */
const CLIENT_DIR = join(import.meta.dirname, '..', 'src', 'client')

function clientSources(): { name: string; text: string }[] {
  return readdirSync(CLIENT_DIR)
    .filter(name => name.endsWith('.tsx') || (name.endsWith('.ts') && name !== 'locales.ts'))
    .map(name => ({ name, text: readFileSync(join(CLIENT_DIR, name), 'utf8') }))
}

describe('locales', () => {
  it('keeps the two languages on exactly the same keys', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('has no empty strings', () => {
    for (const [key, value] of Object.entries(zh)) expect(value.trim(), key).not.toBe('')
    for (const [key, value] of Object.entries(en)) expect(value.trim(), key).not.toBe('')
  })

  it('covers every t() key used by the client', () => {
    const known = new Set(Object.keys(zh))
    const missing: string[] = []
    for (const source of clientSources()) {
      for (const match of source.text.matchAll(/\bt\(\s*'([A-Za-z][A-Za-z0-9]*)'/g)) {
        const key = match[1] as string
        if (!known.has(key)) missing.push(`${source.name}: ${key}`)
      }
    }
    expect(missing).toEqual([])
  })
})
