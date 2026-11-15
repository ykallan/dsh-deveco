/**
 * DevEco 插件卡片（设置页 / 侧边栏整页 / bundle 详情页共用同一个组件）。
 *
 * 卡片自己读状态：`GET /api/deveco/status` 一次拿到账号、模型、用量、签到与显示开关，
 * 之后每 30 秒刷一次。所有写操作都返回新的状态文档，直接替换本地快照 —— 不靠「祈祷
 * 下一次轮询能反映出来」。
 *
 * @module dsh-deveco/client/DevecoPluginCard
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Button, Checkbox, Input, SegmentedTabs, StateDot, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SegmentedTab, StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  DevecoDockFlags,
  DevecoModelSelection,
  DevecoWebAccount,
  DevecoWebModel,
  DevecoWebStatus,
  CheckinOutcome,
  QuotaRefreshResult,
} from '../web-status.ts'
import { DEFAULT_DOCK_FLAGS, dockSnapshot, publishDock, subscribeDock } from './dock-store.ts'
import { setSettingsEntryWanted, setSidebarPanelWanted } from './panel-switch.ts'
import { accountDisplayName, formatCount, formatTokens, formatWhen } from './format.ts'
import styles from './DevecoPluginCard.module.css'

/** 卡片注入的东西：只有翻译函数。 */
export interface DevecoPluginCardInjected {
  t: (key: string, params?: Record<string, string | number>) => string
}

type Tab = 'accounts' | 'models' | 'checkin' | 'display'

/** 状态轮询间隔。 */
const POLL_MS = 30_000

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...init?.body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...init?.headers ?? {},
    },
  })
  const text = await response.text()
  const parsed = text === '' ? {} : JSON.parse(text) as unknown
  if (!response.ok) {
    const message = typeof parsed === 'object' && parsed !== null && 'error' in parsed
      ? String((parsed as { error: unknown }).error)
      : `HTTP ${response.status}`
    throw new Error(message)
  }
  return parsed as T
}

function statusOfDot(account: DevecoWebAccount): StateDotState {
  if (account.usable !== true) return 'error'
  if (account.paused) return 'idle'
  if (account.slot?.coolUntil !== undefined && account.slot.coolUntil > Date.now()) return 'warning'
  return 'done'
}

/** 一个账号行。 */
function AccountRow({
  account,
  t,
  pending,
  onAction,
}: {
  account: DevecoWebAccount
  t: DevecoPluginCardInjected['t']
  pending: boolean
  onAction: (action: 'pause' | 'resume' | 'pin' | 'unpin' | 'remove' | 'refresh' | 'rename', label?: string) => void
}): ReactElement {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(account.label ?? '')
  const name = accountDisplayName(account, t('accountNoLabel'))
  return (
    <div className={styles.accountRow}>
      <div className={styles.accountMain}>
        <div className={styles.accountTitle}>
          <StateDot state={statusOfDot(account)} />
          <span className={styles.accountName}>{name}</span>
          {account.pinned ? <Tag tone="info">{t('accountPinned')}</Tag> : null}
          {account.usable !== true ? <Tag tone="danger">{t('accountNeedsLogin')}</Tag> : null}
          {account.paused ? <Tag tone="neutral">{t('accountPaused')}</Tag> : null}
          {account.isRealName !== true ? <Tag tone="warning">{t('accountNotRealName')}</Tag> : null}
          {account.streak > 0 ? <Tag tone="success">{t('streakDays', { days: account.streak })}</Tag> : null}
        </div>
        <div className={styles.accountMeta}>
          <span>{account.userId ?? account.id}</span>
          {account.nationalCode === undefined ? null : <span>{account.nationalCode}</span>}
          {account.accessTokenExpiresAt === undefined ? null : (
            <span>{t('accountAccessExpires', { time: formatWhen(account.accessTokenExpiresAt) })}</span>
          )}
          {account.slot === undefined ? null : (
            <span>{account.slot.activeConcurrent}/{account.slot.maxConcurrent}</span>
          )}
          {account.slot?.lastError === undefined ? null : (
            <span className={styles.warnText} title={account.slot.lastError}>!</span>
          )}
        </div>
        {renaming ? (
          <div className={styles.inlineForm}>
            <Input
              value={draft}
              placeholder={t('accountRenamePlaceholder')}
              onChange={event => setDraft(event.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => {
                onAction('rename', draft)
                setRenaming(false)
              }}
            >
              OK
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>×</Button>
          </div>
        ) : null}
      </div>
      <div className={styles.accountActions}>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setRenaming(value => !value)}>
          {t('accountRename')}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => onAction('refresh')}>
          {t('refreshCredential')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => onAction(account.pinned ? 'unpin' : 'pin')}
        >
          {account.pinned ? t('accountUnpin') : t('accountPin')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => onAction(account.paused ? 'resume' : 'pause')}
        >
          {account.paused ? t('accountResume') : t('accountPause')}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => onAction('remove')}>
          {t('accountDelete')}
        </Button>
      </div>
    </div>
  )
}

/** 一个模型行。 */
function ModelRow({
  model,
  enabled,
  t,
  onToggle,
}: {
  model: DevecoWebModel
  enabled: boolean
  t: DevecoPluginCardInjected['t']
  onToggle: (next: boolean) => void
}): ReactElement {
  return (
    <label className={styles.modelRow}>
      <Checkbox checked={enabled} onChange={onToggle} label="" />
      <div className={styles.modelMain}>
        <div className={styles.modelTitle}>
          <span className={styles.modelName}>{model.name}</span>
          {model.wireId !== model.id ? <span className={styles.muted}>{model.wireId}</span> : null}
          {model.supportsImages ? <Tag tone="info">{t('modelVision')}</Tag> : null}
          {model.reasoning ? <Tag tone="outline">{t('modelReasoning')}</Tag> : null}
          {model.hidden ? <Tag tone="neutral">{t('modelHidden')}</Tag> : null}
        </div>
        <div className={styles.modelMeta}>
          {model.contextWindow === undefined ? null : (
            <span>{t('modelContext', { tokens: formatTokens(model.contextWindow) })}</span>
          )}
          {model.maxTokens === undefined ? null : (
            <span>{t('modelOutput', { tokens: formatTokens(model.maxTokens) })}</span>
          )}
          {model.levels === undefined ? null : <span>{t('modelLevels', { levels: model.levels.join('/') })}</span>}
        </div>
      </div>
    </label>
  )
}

export function DevecoPluginCard({ t }: DevecoPluginCardInjected): ReactElement {
  const [status, setStatus] = useState<DevecoWebStatus | undefined>(undefined)
  const [selection, setSelection] = useState<DevecoModelSelection | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [tab, setTab] = useState<Tab>('accounts')
  const [token, setToken] = useState('')
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [dock, setDock] = useState<DevecoDockFlags>(dockSnapshot().dock ?? DEFAULT_DOCK_FLAGS)
  const mounted = useRef(true)
  const loginUrl = useRef<string | undefined>(undefined)

  const refresh = async (): Promise<void> => {
    try {
      const [next, nextSelection] = await Promise.all([
        requestJson<{ status: DevecoWebStatus }>('/api/deveco/status'),
        requestJson<{ selection: DevecoModelSelection }>('/api/deveco/enabled-models'),
      ])
      if (!mounted.current) return
      setStatus(next.status)
      setSelection(nextSelection.selection)
      setDock(next.status.dock)
      publishDock({ dock: next.status.dock, writable: next.status.writable })
      setSettingsEntryWanted(next.status.dock.settingsEntry)
      setSidebarPanelWanted(next.status.dock.sidebar)
      setError(undefined)
    } catch (caught: unknown) {
      if (!mounted.current) return
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    const unsubscribe = subscribeDock(() => setDock(dockSnapshot().dock))
    return () => {
      mounted.current = false
      clearInterval(timer)
      unsubscribe()
    }
    // `refresh` 每次渲染都是新函数，但它的行为不变；只在挂载时排一次轮询。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const tabs = useMemo<readonly [SegmentedTab<Tab>, ...SegmentedTab<Tab>[]]>(() => [
    { value: 'accounts', label: t('tabAccounts'), id: 'deveco-tab-accounts', panelId: 'deveco-panel-accounts' },
    { value: 'models', label: t('tabModels'), id: 'deveco-tab-models', panelId: 'deveco-panel-models' },
    { value: 'checkin', label: t('tabCheckin'), id: 'deveco-tab-checkin', panelId: 'deveco-panel-checkin' },
    { value: 'display', label: t('tabDisplay'), id: 'deveco-tab-display', panelId: 'deveco-panel-display' },
  ], [t])

  const accountAction = async (
    id: string,
    action: 'pause' | 'resume' | 'pin' | 'unpin' | 'remove' | 'refresh' | 'rename',
    label?: string,
  ): Promise<void> => {
    setBusy(`${action}:${id}`)
    try {
      if (action === 'remove') {
        const next = await requestJson<{ status: DevecoWebStatus }>(
          `/api/deveco/accounts?id=${encodeURIComponent(id)}`,
          { method: 'DELETE' },
        )
        setStatus(next.status)
      } else {
        const body: Record<string, unknown> = { id }
        if (action === 'pause') body.paused = true
        if (action === 'resume') body.paused = false
        if (action === 'pin') body.pinned = true
        if (action === 'unpin') body.pinned = false
        if (action === 'refresh') body.refresh = true
        if (action === 'rename') body.label = label ?? ''
        const next = await requestJson<{ status: DevecoWebStatus }>('/api/deveco/accounts', {
          method: 'POST',
          body: JSON.stringify(body),
        })
        setStatus(next.status)
      }
      setError(undefined)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(undefined)
    }
  }

  const signIn = async (): Promise<void> => {
    setBusy('login')
    setNotice(t('signInOpening'))
    try {
      const started = await requestJson<{ url: string; port: number }>('/api/deveco/login', { method: 'POST' })
      loginUrl.current = started.url
      setNotice(t('signInWaiting'))
      void pollLogin(started.url)
    } catch (caught: unknown) {
      setNotice(undefined)
      setError(caught instanceof Error ? caught.message : String(caught))
      setBusy(undefined)
    }
  }

  const pollLogin = async (url: string): Promise<void> => {
    try {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await new Promise<void>(resolve => setTimeout(resolve, 1500))
        if (!mounted.current) return
        let outcome: { state: 'pending' | 'done' | 'error'; kind?: string; message?: string }
        try {
          outcome = await requestJson<{ state: 'pending' | 'done' | 'error'; kind?: string; message?: string }>(
            `/api/deveco/login/status?url=${encodeURIComponent(url)}`,
          )
        } catch {
          // 轮询失败就继续等：登录本身还在后台跑。
          continue
        }
        if (outcome.state === 'pending') continue
        if (outcome.state === 'done') {
          setNotice(t('signInDone'))
          await refresh()
        } else {
          setNotice(t('signInFailed', { message: outcome.message ?? outcome.kind ?? 'unknown' }))
        }
        return
      }
    } finally {
      if (mounted.current) setBusy(undefined)
    }
  }

  const saveToken = async (): Promise<void> => {
    const trimmed = token.trim()
    if (trimmed.split('.').length !== 3) {
      setError(t('pasteTokenInvalid'))
      return
    }
    setBusy('token')
    try {
      const next = await requestJson<{ status: DevecoWebStatus }>('/api/deveco/token', {
        method: 'POST',
        body: JSON.stringify({ jwtToken: trimmed }),
      })
      setStatus(next.status)
      setToken('')
      setError(undefined)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(undefined)
    }
  }

  const toggleModel = async (model: DevecoWebModel, next: boolean): Promise<void> => {
    if (status === undefined || selection === undefined) return
    const enabledIds = selection.choices.filter(choice => choice.enabled).map(choice => choice.id)
    const set = new Set(enabledIds)
    if (next) set.add(model.id)
    else set.delete(model.id)
    const all = selection.choices.map(choice => choice.id)
    // 全选 = 空数组（语义是「全部都可用」，不是「一个都不给」）。
    const payload = set.size === all.length ? [] : [...set]
    setBusy('models')
    try {
      const result = await requestJson<{ selection: DevecoModelSelection }>('/api/deveco/enabled-models', {
        method: 'POST',
        body: JSON.stringify({ enabledModels: payload }),
      })
      setSelection(result.selection)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(undefined)
    }
  }

  const refreshModels = async (): Promise<void> => {
    setBusy('refresh-models')
    try {
      const result = await requestJson<{ models: number; refreshed: boolean; selection: DevecoModelSelection; status: DevecoWebStatus }>(
        '/api/deveco/refresh-models',
        { method: 'POST' },
      )
      setSelection(result.selection)
      setStatus(result.status)
      setError(undefined)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(undefined)
    }
  }

  /**
   * 「刷新额度」：重新探测账号可用性。
   *
   * 它不可能查到「还剩多少」—— 上游没有这个接口 —— 所以按钮旁边必须写清楚它做了什么，
   * 否则用户点完会以为额度被刷新了。
   */
  const refreshQuota = async (): Promise<void> => {
    setBusy('quota')
    try {
      const result = await requestJson<{ outcome: QuotaRefreshResult; status: DevecoWebStatus }>(
        '/api/deveco/quota',
        { method: 'POST', body: '{}' },
      )
      setStatus(result.status)
      setNotice(`${t('quotaProbeDone', { count: result.outcome.probed })}：${result.outcome.message}`)
      setError(result.outcome.ok ? undefined : result.outcome.message)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(undefined)
    }
  }

  const checkin = async (force: boolean): Promise<void> => {
    setBusy('checkin')
    try {
      const result = await requestJson<{ outcome: CheckinOutcome; status: DevecoWebStatus }>('/api/deveco/checkin', {
        method: 'POST',
        body: JSON.stringify({ force }),
      })
      setStatus(result.status)
      const outcome = result.outcome
      setNotice(outcome.ok
        ? `${t('checkinOk')}：${outcome.message}`
        : t('checkinFailed', { message: outcome.results.find(entry => !entry.ok)?.message ?? outcome.message }))
      setError(undefined)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(undefined)
    }
  }

  /** 体检：读一次 /doctor，把结果写进 notice/error。 */
  const diagnose = async (): Promise<void> => {
    setBusy('doctor')
    try {
      const result = await requestJson<{ report: { ok: boolean; checks: { id: string; ok: boolean; detail: string }[] } }>(
        '/api/deveco/doctor',
      )
      const failed = result.report.checks.find(check => !check.ok)
      if (result.report.ok) {
        setNotice(t('doctorOk'))
        setError(undefined)
      } else {
        setNotice(undefined)
        setError(t('doctorFail', {
          detail: failed === undefined ? 'unknown' : `${failed.id}: ${failed.detail}`,
        }))
      }
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(undefined)
    }
  }

  const setDockFlag = async (patch: Partial<DevecoDockFlags>): Promise<void> => {
    setDock(current => ({ ...current, ...patch }))
    publishDock({ dock: patch })
    if (patch.sidebar !== undefined) setSidebarPanelWanted(patch.sidebar)
    if (patch.settingsEntry !== undefined) setSettingsEntryWanted(patch.settingsEntry)
    try {
      await requestJson('/api/deveco/dock', { method: 'POST', body: JSON.stringify(patch) })
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const accounts = status?.accounts ?? []
  const usage = status?.usage
  /**
   * 客户端可能比宿主先更新（客户端产物会热重载，宿主模块不会），所以 `quota` 当成可选：
   * 旧宿主不返回它时就整块不渲染，而不是让整张卡片崩掉。
   */
  const quota = status?.quota

  return (
    <div className={styles.card}>
      <header className={styles.header}>
        <div className={styles.headerMain}>
          <h2 className={styles.title}>{t('cardTitle')}</h2>
          <p className={styles.subtitle}>{t('cardSubtitle')}</p>
        </div>
        <div className={styles.headerMeta}>
          {status === undefined ? (
            <span className={styles.muted}>{t('statusLoading')}</span>
          ) : (
            <Tag tone={accounts.length > 0 ? 'success' : 'warning'}>
              {accounts.length === 0 ? t('signedOut') : t('signedInCount', { count: accounts.length })}
            </Tag>
          )}
          {status === undefined ? null : <span className={styles.muted}>{t('versionLabel', { version: status.version })}</span>}
        </div>
      </header>

      {error === undefined ? null : <div className={styles.error}>{t('loadFailed', { message: error })}</div>}
      {notice === undefined ? null : <div className={styles.notice}>{notice}</div>}

      <SegmentedTabs items={tabs} value={tab} onChange={setTab} label={t('cardTitle')} className={styles.tabs} size="sm" />

      {tab === 'accounts' ? (
        <section id="deveco-panel-accounts" role="tabpanel" aria-labelledby="deveco-tab-accounts" className={styles.section}>
          <div className={styles.signInBox}>
            <Button variant="primary" disabled={busy === 'login'} onClick={() => void signIn()}>
              {t('signIn')}
            </Button>
            <span className={styles.muted}>{t('signInHint')}</span>
          </div>
          <div className={styles.signInBox}>
            <Input
              value={token}
              placeholder={t('pasteTokenPlaceholder')}
              onChange={event => setToken(event.target.value)}
              className={styles.tokenInput}
            />
            <Button
              variant="outline"
              disabled={busy === 'token' || token.trim() === ''}
              onClick={() => void saveToken()}
            >
              {t('pasteTokenSubmit')}
            </Button>
          </div>
          {accounts.length === 0 ? (
            <p className={styles.muted}>{t('signedOut')}</p>
          ) : (
            <div className={styles.list}>
              {accounts.map(account => (
                <AccountRow
                  key={account.id}
                  account={account}
                  t={t}
                  pending={busy !== undefined && busy.endsWith(`:${account.id}`)}
                  onAction={(action, label) => void accountAction(account.id, action, label)}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}

      {tab === 'models' ? (
        <section id="deveco-panel-models" role="tabpanel" aria-labelledby="deveco-tab-models" className={styles.section}>
          {status?.lastDiscoveryError === undefined ? null : (
            <div className={styles.error}>{t('catalogStale', { message: status.lastDiscoveryError })}</div>
          )}
          <div className={styles.toolbar}>
            <Button variant="outline" size="sm" disabled={busy === 'refresh-models'} onClick={() => void refreshModels()}>
              {busy === 'refresh-models' ? t('refreshing') : t('refreshModels')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={selection === undefined || busy === 'models'}
              onClick={() => {
                if (selection === undefined) return
                setBusy('models')
                void requestJson<{ selection: DevecoModelSelection }>('/api/deveco/enabled-models', {
                  method: 'POST',
                  body: JSON.stringify({ enabledModels: [] }),
                }).then(result => setSelection(result.selection)).catch(() => {}).finally(() => setBusy(undefined))
              }}
            >
              {t('selectAll')}
            </Button>
            <span className={styles.muted}>
              {selection === undefined || !selection.restricted ? t('selectionAll') : t('selectionRestricted')}
            </span>
          </div>
          {(selection?.choices ?? []).length === 0 ? (            <>
              <p className={styles.muted}>{t('modelsEmpty')}</p>
              <p className={styles.muted}>{t('modelsEmptyHint')}</p>
            </>
          ) : (
            <div className={styles.list}>
              {(selection?.choices ?? []).map(choice => (
                <ModelRow
                  key={choice.id}
                  model={choice}
                  enabled={choice.enabled}
                  t={t}
                  onToggle={next => void toggleModel(choice, next)}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}

      {tab === 'checkin' ? (
        <section id="deveco-panel-checkin" role="tabpanel" aria-labelledby="deveco-tab-checkin" className={styles.section}>
          {quota === undefined ? null : (
            <div className={styles.quotaBox}>
              <div className={styles.toolbar}>
                <span className={styles.quotaTitle}>{t('quotaTitle')}</span>
                <Tag tone={quota.exhausted.length > 0 ? 'danger' : 'outline'}>
                  {t('quotaWindow', { window: quota.window.label })}
                </Tag>
                <span className={styles.muted}>{t('quotaResetIn', { time: quota.resetIn })}</span>
                <span className={styles.muted}>
                  {t('quotaUsage', {
                    tokens: formatCount((usage?.today.inputTokens ?? 0) + (usage?.today.outputTokens ?? 0)),
                  })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === 'quota'}
                  onClick={() => void refreshQuota()}
                >
                  {busy === 'quota' ? t('quotaRefreshing') : t('quotaRefresh')}
                </Button>
              </div>
              {quota.exhausted.length === 0 ? null : (
                <div className={styles.quotaExhausted}>
                  <Tag tone="danger">{t('quotaExhaustedTag')}</Tag>
                  <span>{t('quotaExhaustedNotice', { count: quota.exhausted.length })}</span>
                  <span className={styles.muted}>
                    {quota.exhausted
                      .map(id => accountDisplayName(
                        accounts.find(account => account.id === id) ?? { id },
                        t('accountNoLabel'),
                      ))
                      .join(', ')}
                  </span>
                </div>
              )}
              <p className={styles.note}>{t('quotaNote')}</p>
            </div>
          )}
          <div className={styles.toolbar}>
            <Button variant="primary" size="sm" disabled={busy === 'checkin'} onClick={() => void checkin(false)}>
              {busy === 'checkin' ? t('checking') : t('checkinNow')}
            </Button>
            <span className={styles.muted}>{status?.checkin.day ?? ''}</span>
          </div>
          <p className={styles.note}>{t('checkinNote')}</p>
          {accounts.length === 0 ? <p className={styles.muted}>{t('signedOut')}</p> : (
            <div className={styles.list}>
              {accounts.map(account => {
                const record = status?.checkin.today[account.id]
                return (
                  <div key={account.id} className={styles.checkinRow}>
                    <StateDot state={record === undefined ? 'idle' : record.ok ? 'done' : 'error'} />
                    <span className={styles.accountName}>{accountDisplayName(account, t('accountNoLabel'))}</span>
                    <span className={styles.muted}>
                      {record === undefined
                        ? t('checkinNever')
                        : record.ok ? `${t('checkinAlready')} · ${formatWhen(record.at)}` : (record.message ?? '')}
                    </span>
                    <span className={styles.muted}>{t('checkinStreak', { days: account.streak })}</span>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      ) : null}

      {tab === 'display' ? (
        <section id="deveco-panel-display" role="tabpanel" aria-labelledby="deveco-tab-display" className={styles.section}>
          {status !== undefined && status.writable !== true ? <p className={styles.muted}>{t('displayReadonly')}</p> : null}
          <div className={styles.switchRow}>
            <Switch checked={dock.dock} onChange={next => void setDockFlag({ dock: next })} label={t('showDock')} />
            <span>{t('showDock')}</span>
          </div>
          <div className={styles.switchRow}>
            <Switch checked={dock.sidebar} onChange={next => void setDockFlag({ sidebar: next })} label={t('showSidebar')} />
            <span>{t('showSidebar')}</span>
          </div>
          <div className={styles.switchRow}>
            <Switch
              checked={dock.settingsEntry}
              onChange={next => void setDockFlag({ settingsEntry: next })}
              label={t('showSettings')}
            />
            <span>{t('showSettings')}</span>
          </div>
          <div className={styles.switchRow}>
            <Switch checked={dock.autoClaim} onChange={next => void setDockFlag({ autoClaim: next })} label={t('autoCheckin')} />
            <span>{t('autoCheckin')}</span>
            <span className={styles.muted}>{t('autoCheckinHint')}</span>
          </div>
        </section>
      ) : null}

      <footer className={styles.footer}>
        <span className={styles.footerTitle}>{t('usageTitle')}</span>
        <span>{t('usageTodayRequests', { count: formatCount(usage?.today.requests ?? 0) })}</span>
        <span>{t('usageTodayInput', { tokens: formatCount(usage?.today.inputTokens ?? 0) })}</span>
        <span>{t('usageTodayOutput', { tokens: formatCount(usage?.today.outputTokens ?? 0) })}</span>
        <span className={styles.muted} title={t('usageScope')}>{t('usageScope')}</span>
        <Button size='sm' variant='ghost' disabled={busy === 'doctor'} onClick={() => void diagnose()}>
          {t('doctor')}
        </Button>
      </footer>
    </div>
  )
}
