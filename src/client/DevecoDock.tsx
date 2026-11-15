/**
 * 对话输入框下方那一行：`Provider DevEco · 模型 · 今日 tokens · 已签到`。
 *
 * 只在当前模型确实来自 `deveco` 时渲染 —— 别的 provider 的对话不该出现这一行。
 * 状态每 60 秒刷一次（够用，且不给 `/status` 添压力）。
 *
 * @module dsh-deveco/client/DevecoDock
 */

import { useEffect, useState, type ReactElement } from 'react'
import type { DevecoWebStatus } from '../web-status.ts'
import { formatCount } from './format.ts'
import styles from './DevecoPluginCard.module.css'

/** 这个 provider 路由的名字（客户端不能 import 宿主模块，所以这里单独抄一份）。 */
const DEVECO_PROVIDER = 'deveco'

/** 状态刷新间隔。 */
const REFRESH_INTERVAL_MS = 60_000

export interface DevecoDockProps {
  /** 宿主提供的「当前模型/供应商」投影读取器（没有就退化成只显示登录态）。 */
  useProjection?: (key: string) => unknown
  t: (key: string, params?: Record<string, string | number>) => string
  /** `bar` = 输入框下方的积分条区，`dock` = 输入框下沿 —— 目前两者渲染一致。 */
  zone?: 'bar' | 'dock'
  onOpenSettings?: () => boolean
}

interface ModelSelection {
  provider?: string
  model?: string
  name?: string
}

/** 读当前选中的 provider/model。 */
function readSelection(useProjection: DevecoDockProps['useProjection']): ModelSelection | undefined {
  if (useProjection === undefined) return undefined
  try {
    const value = useProjection('modelSelection')
    if (typeof value !== 'object' || value === null) return undefined
    const raw = value as { provider?: unknown; model?: unknown; name?: unknown }
    return {
      ...typeof raw.provider === 'string' ? { provider: raw.provider } : {},
      ...typeof raw.model === 'string' ? { model: raw.model } : {},
      ...typeof raw.name === 'string' ? { name: raw.name } : {},
    }
  } catch {
    return undefined
  }
}

export function DevecoDock({ useProjection, t, onOpenSettings }: DevecoDockProps): ReactElement | null {
  const [status, setStatus] = useState<DevecoWebStatus | undefined>(undefined)
  const selection = readSelection(useProjection)
  const isDeveco = selection?.provider === DEVECO_PROVIDER

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const response = await fetch('/api/deveco/status', { headers: { Accept: 'application/json' } })
        if (!response.ok) return
        const parsed = await response.json() as { status?: DevecoWebStatus }
        if (!cancelled && parsed.status !== undefined) setStatus(parsed.status)
      } catch {
        // 状态读不到就不显示，不影响对话。
      }
    }
    void load()
    const timer = setInterval(() => void load(), REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  // 只有当前模型来自 DevEco 时才占这个位置。
  if (status === undefined || !isDeveco) return null
  const dock = status.dock
  if (dock.dock !== true) return null

  const modelName = selection?.name ?? selection?.model ?? ''
  const todayTokens = status.usage.today.inputTokens + status.usage.today.outputTokens
  const checkedIn = Object.values(status.checkin.today).some(record => record.ok)
  const clickable = typeof onOpenSettings === 'function'

  return (
    <span
      className={styles.dockLine}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onOpenSettings?.() : undefined}
      onKeyDown={clickable
        ? event => {
            if (event.key === 'Enter' || event.key === ' ') onOpenSettings?.()
          }
        : undefined}
      title={status.accounts.length === 0 ? t('dockNone') : undefined}
    >
      <span>{modelName === '' ? t('dockProvider') : `${t('dockProvider')} · ${modelName}`}</span>
      <span className={styles.dockSeparator}>|</span>
      <span>{t('dockUsage', { tokens: formatCount(todayTokens) })}</span>
      <span className={styles.dockSeparator}>|</span>
      <span>{checkedIn ? t('dockCheckin') : t('checkinNever')}</span>
    </span>
  )
}
