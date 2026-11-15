/**
 * 卡片文案（中/英）。
 *
 * 两种语言的键**必须完全一致**：`DevecoSettingsKey` 是接口，漏一个键就编译不过。
 *
 * @module dsh-deveco/client/locales
 */

/** 卡片用到的全部文案键。 */
export interface DevecoSettingsKey {
  tabLabel: string
  panelTitle: string
  backToConversation: string
  cardTitle: string
  cardSubtitle: string
  providerLabel: string
  statusLoading: string
  loadFailed: string

  tabAccounts: string
  tabModels: string
  tabCheckin: string
  tabDisplay: string

  signedOut: string
  signedInCount: string
  signIn: string
  signInHint: string
  signInOpening: string
  signInWaiting: string
  signInDone: string
  signInFailed: string
  pasteToken: string
  pasteTokenPlaceholder: string
  pasteTokenSubmit: string
  pasteTokenInvalid: string
  refreshCredential: string

  accountUsable: string
  accountNeedsLogin: string
  accountPaused: string
  accountPinned: string
  accountBusy: string
  accountNotRealName: string
  accountDelete: string
  accountPause: string
  accountResume: string
  accountPin: string
  accountUnpin: string
  accountRename: string
  accountRenamePlaceholder: string
  accountNoLabel: string
  streakDays: string
  accountAccessExpires: string

  modelsEmpty: string
  modelsEmptyHint: string
  refreshModels: string
  refreshing: string
  modelContext: string
  modelOutput: string
  modelVision: string
  modelReasoning: string
  modelHidden: string
  modelLevels: string
  selectAll: string
  clearSelection: string
  selectionAll: string
  selectionRestricted: string

  checkinTitle: string
  checkinNote: string
  checkinNow: string
  checking: string
  checkinOk: string
  checkinFailed: string
  checkinAlready: string
  checkinNever: string
  checkinStreak: string
  checkinToday: string

  quotaTitle: string
  quotaWindow: string
  quotaResetIn: string
  quotaExhaustedTag: string
  quotaUsage: string
  quotaRefresh: string
  quotaRefreshing: string
  quotaNote: string
  quotaProbeDone: string
  quotaExhaustedNotice: string

  displayTitle: string
  showDock: string
  showSidebar: string
  showSettings: string
  autoCheckin: string
  autoCheckinHint: string
  displayReadonly: string

  usageTitle: string
  usageTodayRequests: string
  usageTodayInput: string
  usageTodayOutput: string
  usageScope: string
  versionLabel: string
  doctor: string
  doctorOk: string
  doctorFail: string

  dockProvider: string
  dockUsage: string
  dockCheckin: string
  dockNone: string
}

export const zh: DevecoSettingsKey = {
  tabLabel: 'DevEco',
  panelTitle: 'DevEco Code',
  backToConversation: '返回对话',
  cardTitle: 'DevEco Code',
  cardSubtitle: '华为 CodeGenie MaaS · GLM-5.1 / GLM-5.3 / Qwen 视觉',
  providerLabel: '供应商',
  statusLoading: '读取中…',
  loadFailed: '读取状态失败：{message}',

  tabAccounts: '账号',
  tabModels: '模型',
  tabCheckin: '额度 · 签到',
  tabDisplay: '显示',

  signedOut: '还没有登录任何账号',
  signedInCount: '已登录 {count} 个账号',
  signIn: '登录华为账号',
  signInHint: '会打开华为登录页，授权完成后自动回到这里。只支持中国大陆账号。',
  signInOpening: '正在打开登录页…',
  signInWaiting: '已打开登录页，等你在浏览器里完成登录…',
  signInDone: '登录成功',
  signInFailed: '登录失败：{message}',
  pasteToken: '或者直接粘贴 jwtToken',
  pasteTokenPlaceholder: '粘贴以 eyJ 开头的 jwtToken',
  pasteTokenSubmit: '保存令牌',
  pasteTokenInvalid: '这看起来不是 jwtToken（需要三段、用点分隔）',
  refreshCredential: '刷新凭证',

  accountUsable: '可用',
  accountNeedsLogin: '需重新登录',
  accountPaused: '已暂停',
  accountPinned: '置顶',
  accountBusy: '忙碌中',
  accountNotRealName: '未实名',
  accountDelete: '删除',
  accountPause: '暂停',
  accountResume: '恢复',
  accountPin: '置顶',
  accountUnpin: '取消置顶',
  accountRename: '改备注',
  accountRenamePlaceholder: '备注名（留空清除）',
  accountNoLabel: '未命名账号',
  streakDays: '连续 {days} 天',
  accountAccessExpires: '访问令牌 {time} 到期',

  modelsEmpty: '模型目录是空的',
  modelsEmptyHint: '登录后会自动从上游拉取模型列表；也可以点下面的「刷新模型」。',
  refreshModels: '刷新模型',
  refreshing: '刷新中…',
  modelContext: '{tokens} 上下文',
  modelOutput: '{tokens} 输出',
  modelVision: '识图',
  modelReasoning: '思考',
  modelHidden: '隐藏',
  modelLevels: '档位 {levels}',
  selectAll: '全选',
  clearSelection: '全不选',
  selectionAll: '全部模型都会出现在选择器里',
  selectionRestricted: '只显示勾选的模型',

  checkinTitle: '每日签到',
  checkinNote: 'DevEco 没有积分/领取接口，免费额度每天自动重置。这里的签到是每天一次的真实体检：逐个账号拉一次模型目录，证明凭证今天还能用，并记录连续天数。',
  checkinNow: '立即签到',
  checking: '签到中…',
  checkinOk: '签到成功',
  checkinFailed: '签到失败：{message}',
  checkinAlready: '今天已签到',
  checkinNever: '还没签到',
  checkinStreak: '连续签到 {days} 天',
  checkinToday: '今日',

  quotaTitle: '额度',
  quotaWindow: '额度窗口 {window}',
  quotaResetIn: '{time} 后重置',
  quotaExhaustedTag: '额度用尽',
  quotaUsage: '本窗口本机 {tokens} tokens',
  quotaRefresh: '刷新额度',
  quotaRefreshing: '探测中…',
  quotaNote: 'DevEco 不提供额度查询接口，所以这里没有「剩余额度」这个数字。「刷新额度」也不会让额度变多：它重新探测每个账号现在还能不能用（拉一次模型目录），并刷新本窗口的重置时间；真正用尽时上游会拒绝请求，插件会把那个账号标成「额度用尽」直到窗口重置。',
  quotaProbeDone: '已探测 {count} 个账号',
  quotaExhaustedNotice: '{count} 个账号在本窗口被上游判为额度用尽',

  displayTitle: '显示',
  showDock: '在对话输入框下方显示 DevEco 状态行',
  showSidebar: '在侧边栏图标列显示 DevEco 入口',
  showSettings: '在设置左侧导航显示 DevEco 入口',
  autoCheckin: '每天自动签到',
  autoCheckinHint: '打开后，DSH 启动 30 秒后会签到一次，之后每 6 小时检查一次（一天只签一次）。',
  displayReadonly: '当前宿主没有设置服务，这些开关不可写。',

  usageTitle: '本机用量',
  usageTodayRequests: '今日请求 {count}',
  usageTodayInput: '输入 {tokens}',
  usageTodayOutput: '输出 {tokens}',
  usageScope: '只统计本机经本插件发出的请求，不等于账号总额度',
  versionLabel: '版本 {version}',
  doctor: '体检',
  doctorOk: '体检通过',
  doctorFail: '体检发现问题：{detail}',

  dockProvider: 'Provider DevEco',
  dockUsage: '今日 {tokens} tokens',
  dockCheckin: '已签到',
  dockNone: '未登录',
}

export const en: DevecoSettingsKey = {
  tabLabel: 'DevEco',
  panelTitle: 'DevEco Code',
  backToConversation: 'Back to conversation',
  cardTitle: 'DevEco Code',
  cardSubtitle: 'Huawei CodeGenie MaaS · GLM-5.1 / GLM-5.3 / Qwen vision',
  providerLabel: 'Provider',
  statusLoading: 'Loading…',
  loadFailed: 'Could not read the plugin status: {message}',

  tabAccounts: 'Accounts',
  tabModels: 'Models',
  tabCheckin: 'Quota · Check-in',
  tabDisplay: 'Display',

  signedOut: 'No account signed in yet',
  signedInCount: '{count} account(s) signed in',
  signIn: 'Sign in with Huawei',
  signInHint: 'Opens the Huawei sign-in page; it comes back here when you are done. China-region accounts only.',
  signInOpening: 'Opening the sign-in page…',
  signInWaiting: 'Waiting for you to finish signing in in the browser…',
  signInDone: 'Signed in',
  signInFailed: 'Sign-in failed: {message}',
  pasteToken: 'Or paste a jwtToken directly',
  pasteTokenPlaceholder: 'Paste the jwtToken that starts with eyJ',
  pasteTokenSubmit: 'Save token',
  pasteTokenInvalid: 'That does not look like a jwtToken (three dot-separated parts)',
  refreshCredential: 'Refresh credential',

  accountUsable: 'Ready',
  accountNeedsLogin: 'Sign in again',
  accountPaused: 'Paused',
  accountPinned: 'Pinned',
  accountBusy: 'Busy',
  accountNotRealName: 'Not real-name verified',
  accountDelete: 'Remove',
  accountPause: 'Pause',
  accountResume: 'Resume',
  accountPin: 'Pin',
  accountUnpin: 'Unpin',
  accountRename: 'Rename',
  accountRenamePlaceholder: 'Label (empty clears it)',
  accountNoLabel: 'Unnamed account',
  streakDays: '{days}-day streak',
  accountAccessExpires: 'Access token expires {time}',

  modelsEmpty: 'The model catalog is empty',
  modelsEmptyHint: 'Signing in pulls the upstream catalog automatically; you can also press "Refresh models".',
  refreshModels: 'Refresh models',
  refreshing: 'Refreshing…',
  modelContext: '{tokens} context',
  modelOutput: '{tokens} output',
  modelVision: 'Vision',
  modelReasoning: 'Thinking',
  modelHidden: 'Hidden',
  modelLevels: 'Levels {levels}',
  selectAll: 'Select all',
  clearSelection: 'Select none',
  selectionAll: 'Every model is offered in the pickers',
  selectionRestricted: 'Only the checked models are offered',

  checkinTitle: 'Daily check-in',
  checkinNote: 'DevEco has no points or claim endpoint — the free quota resets daily on its own. This check-in is a real daily probe: it fetches the model catalog for each account, proves the credential still works, and keeps a streak.',
  checkinNow: 'Check in now',
  checking: 'Checking in…',
  checkinOk: 'Checked in',
  checkinFailed: 'Check-in failed: {message}',
  checkinAlready: 'Checked in today',
  checkinNever: 'Not checked in yet',
  checkinStreak: '{days}-day streak',
  checkinToday: 'Today',

  quotaTitle: 'Quota',
  quotaWindow: 'Quota window {window}',
  quotaResetIn: 'resets in {time}',
  quotaExhaustedTag: 'Out of quota',
  quotaUsage: '{tokens} tokens from this device this window',
  quotaRefresh: 'Refresh quota',
  quotaRefreshing: 'Probing…',
  quotaNote: 'DevEco exposes no quota endpoint, so there is no "remaining" number here. "Refresh quota" does not add any quota: it re-probes whether each account can still be used (one model-catalog fetch) and refreshes this window\'s reset time. When the quota really runs out the upstream rejects requests, and the plugin marks that account "out of quota" until the window resets.',
  quotaProbeDone: 'Probed {count} account(s)',
  quotaExhaustedNotice: '{count} account(s) are out of quota for this window',

  displayTitle: 'Display',
  showDock: 'Show the DevEco status line under the chat input box',
  showSidebar: 'Show a DevEco entry in the sidebar icon column',
  showSettings: 'Show a DevEco entry in the settings left navigation',
  autoCheckin: 'Check in automatically every day',
  autoCheckinHint: 'When on, it checks in 30 seconds after DSH starts and re-checks every 6 hours (once per day).',
  displayReadonly: 'This host has no settings service, so these switches are read-only.',

  usageTitle: 'Local usage',
  usageTodayRequests: '{count} request(s) today',
  usageTodayInput: '{tokens} in',
  usageTodayOutput: '{tokens} out',
  usageScope: 'Only requests this plugin sent from this machine; not the account total',
  versionLabel: 'Version {version}',
  doctor: 'Diagnose',
  doctorOk: 'All checks passed',
  doctorFail: 'A check failed: {detail}',

  dockProvider: 'Provider DevEco',
  dockUsage: '{tokens} tokens today',
  dockCheckin: 'Checked in',
  dockNone: 'Not signed in',
}
