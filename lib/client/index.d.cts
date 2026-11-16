import { Context } from "@deepseek-ai/cordis";
/**
 * 卡片文案（中/英）。
 *
 * 两种语言的键**必须完全一致**：`DevecoSettingsKey` 是接口，漏一个键就编译不过。
 *
 * @module dsh-deveco/client/locales
 */
/** 卡片用到的全部文案键。 */
interface DevecoSettingsKey {
  tabLabel: string;
  panelTitle: string;
  backToConversation: string;
  cardTitle: string;
  cardSubtitle: string;
  providerLabel: string;
  statusLoading: string;
  loadFailed: string;
  tabAccounts: string;
  tabModels: string;
  tabCheckin: string;
  tabDisplay: string;
  signedOut: string;
  signedInCount: string;
  signIn: string;
  signInHint: string;
  signInOpening: string;
  signInWaiting: string;
  signInDone: string;
  signInFailed: string;
  pasteToken: string;
  pasteTokenPlaceholder: string;
  pasteTokenSubmit: string;
  pasteTokenInvalid: string;
  refreshCredential: string;
  accountUsable: string;
  accountNeedsLogin: string;
  accountPaused: string;
  accountPinned: string;
  accountBusy: string;
  accountNotRealName: string;
  accountDelete: string;
  accountPause: string;
  accountResume: string;
  accountPin: string;
  accountUnpin: string;
  accountRename: string;
  accountRenamePlaceholder: string;
  accountNoLabel: string;
  streakDays: string;
  accountAccessExpires: string;
  accountTtlLearned: string;
  modelsEmpty: string;
  modelsEmptyHint: string;
  catalogStale: string;
  refreshModels: string;
  refreshing: string;
  modelContext: string;
  modelOutput: string;
  modelVision: string;
  modelReasoning: string;
  modelHidden: string;
  modelLevels: string;
  selectAll: string;
  clearSelection: string;
  selectionAll: string;
  selectionRestricted: string;
  checkinTitle: string;
  checkinNote: string;
  checkinNow: string;
  checking: string;
  checkinOk: string;
  checkinFailed: string;
  checkinAlready: string;
  checkinNever: string;
  checkinStreak: string;
  checkinToday: string;
  quotaTitle: string;
  quotaWindow: string;
  quotaResetIn: string;
  quotaExhaustedTag: string;
  quotaUsage: string;
  quotaRefresh: string;
  quotaRefreshing: string;
  quotaNote: string;
  quotaProbeDone: string;
  quotaExhaustedNotice: string;
  displayTitle: string;
  showDock: string;
  showSidebar: string;
  showSettings: string;
  autoCheckin: string;
  autoCheckinHint: string;
  displayReadonly: string;
  usageTitle: string;
  usageTodayRequests: string;
  usageTodayInput: string;
  usageTodayOutput: string;
  usageScope: string;
  versionLabel: string;
  doctor: string;
  doctorOk: string;
  doctorFail: string;
  dockProvider: string;
  dockUsage: string;
  dockCheckin: string;
  dockNone: string;
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.deveco': keyof DevecoSettingsKey;
  }
  interface SlotMap {
    /** bundle 详情页里的配置卡片（rc.2 起），key = 包名。 */
    'plugins.bundle.config': {
      kind: 'keyed';
      scope: 'root';
      owner: {
        children?: never;
      };
    };
    'sidebar.panellist': {
      kind: 'list';
      scope: 'root';
      owner: {
        size: number;
        active: boolean;
      };
    };
    main: {
      kind: 'keyed';
      scope: 'root';
      owner: {
        children?: never;
      };
    };
    'settings.section': {
      kind: 'list';
      scope: 'root';
    };
  }
}
declare const name = "dsh-deveco-client";
declare const inject: string[];
declare function apply(ctx: Context): void;
export { apply, inject, name };