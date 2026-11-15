/**
 * 显示开关的共享快照。
 *
 * 同一张卡片会同时挂在三个地方（设置页、侧边栏整页、bundle 详情页），它们必须看到同一份
 * 开关状态；各自 `fetch` 会让刚点开的开关在另一处又弹回去。
 *
 * @module dsh-deveco/client/dock-store
 */

import type { DevecoDockFlags } from '../web-status.ts'

export const DEFAULT_DOCK_FLAGS: DevecoDockFlags = {
  dock: true,
  sidebar: false,
  settingsEntry: true,
  autoClaim: false,
}

export interface DockSnapshot {
  dock: DevecoDockFlags
  writable: boolean
  loaded: boolean
}

let snapshot: DockSnapshot = { dock: DEFAULT_DOCK_FLAGS, writable: false, loaded: false }
const listeners = new Set<() => void>()

export function dockSnapshot(): DockSnapshot {
  return snapshot
}

export function publishDock(patch: { dock?: Partial<DevecoDockFlags>; writable?: boolean }): void {
  snapshot = {
    dock: { ...snapshot.dock, ...patch.dock ?? {} },
    writable: patch.writable ?? snapshot.writable,
    loaded: true,
  }
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // 单个订阅者出错不能连累其它卡片。
    }
  }
}

export function subscribeDock(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
