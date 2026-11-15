/**
 * 侧边栏图标 + 整页面板。
 *
 * 图标是内联 SVG：插件的图标列只有 16px，用 `currentColor` 才能跟着主题走。
 *
 * @module dsh-deveco/client/DevecoPanel
 */

import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { DevecoPluginCard, type DevecoPluginCardInjected } from './DevecoPluginCard.tsx'
import styles from './DevecoPluginCard.module.css'

/** 侧边栏图标（16×16，正六边形里一个 D 形切口 —— 呼应 DevEco 的六边形视觉）。 */
export function DevecoPanelIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.6 13.2 4.6v6L8 13.6 2.8 10.6v-6L8 1.6Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M6.1 5.4h2.2a2.6 2.6 0 0 1 0 5.2H6.1V5.4Z" fill="currentColor" opacity="0.85" />
    </svg>
  )
}

export interface DevecoPanelPageInjected extends DevecoPluginCardInjected {
  backToConversation?: (() => void) | undefined
}

/** 侧边栏里的整页版本：一个返回按钮 + 同一张卡片。 */
export function DevecoPanelPage({ t, backToConversation }: DevecoPanelPageInjected): ReactElement {
  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        {backToConversation === undefined ? null : (
          <Button variant="ghost" size="sm" onClick={() => backToConversation()}>
            ← {t('backToConversation')}
          </Button>
        )}
        <h2 className={styles.panelTitle}>{t('panelTitle')}</h2>
      </div>
      <DevecoPluginCard t={t} />
    </div>
  )
}
