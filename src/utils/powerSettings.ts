export type SyncIntervalMinutes = 15 | 30 | 60 | 120 | 0; // 0 = 僅手動同步
export type GhostCleanIntervalMinutes = 30 | 60 | 120 | 0; // 0 = 關閉自動全刷

export interface PowerSettings {
  /** 是否啟用螢幕常亮（防休眠鎖 WakeLock）；關閉則交由閱讀器系統自行待機休眠 */
  keepScreenAwake: boolean;
  /** 是否啟用夜間休眠排程（時段內自動釋放常亮鎖由系統休眠，早上自行喚醒，並停用全刷與同步） */
  nightSleepEnabled: boolean;
  /** 夜間休眠開始小時 (0 ~ 23) */
  nightSleepStartHour: number;
  /** 夜間休眠結束小時 (0 ~ 23) */
  nightSleepEndHour: number;
  /** 夜間自動嘗試開啟飛航模式並關閉 Wi-Fi／藍牙（退出夜間模式時自動還原由本程式關閉之項目） */
  nightAutoAirplaneRadio: boolean;
  /** 夜間模式強制背光歸零（0%） */
  nightForceZeroBacklight: boolean;
  /** 夜間模式時鐘數字改為每 5 分鐘更新一次（大幅減少 CPU 喚醒與電子紙刷新） */
  nightFiveMinuteClock: boolean;
  /** 氣象與日曆背景同步週期（分鐘）：15 / 30 / 60 / 120 / 0(僅手動) */
  syncIntervalMinutes: SyncIntervalMinutes;
  /** 電子紙自動清殘影全刷週期（分鐘）：30 / 60 / 120 / 0(關閉自動全刷) */
  ghostCleanIntervalMinutes: GhostCleanIntervalMinutes;
  /** 純離線時鐘省電模式（停用所有背景網路自動同步，僅保留手動刷新） */
  offlineClockMode: boolean;
}

export const DEFAULT_POWER_SETTINGS: PowerSettings = {
  keepScreenAwake: true,
  nightSleepEnabled: false,
  nightSleepStartHour: 23,
  nightSleepEndHour: 7,
  nightAutoAirplaneRadio: true,
  nightForceZeroBacklight: true,
  nightFiveMinuteClock: true,
  syncIntervalMinutes: 30,
  ghostCleanIntervalMinutes: 60,
  offlineClockMode: false,
};

export const MAX_BATTERY_POWER_PRESET: PowerSettings = {
  keepScreenAwake: true,
  nightSleepEnabled: true,
  nightSleepStartHour: 23,
  nightSleepEndHour: 7,
  nightAutoAirplaneRadio: true,
  nightForceZeroBacklight: true,
  nightFiveMinuteClock: true,
  syncIntervalMinutes: 60,
  ghostCleanIntervalMinutes: 120,
  offlineClockMode: false,
};

export interface NightOverrideState {
  manualNightExitKey?: string | null;
  manualNightForceActive?: boolean;
}

export interface PowerEvaluation {
  shouldKeepAwake: boolean;
  isNightSleepActive: boolean;
  isScheduledNightWindow: boolean;
  isManuallyExitedTonight: boolean;
  scheduledWindowKey: string | null;
  forceZeroBacklight: boolean;
  isFiveMinuteClockActive: boolean;
  shouldDisableNightRadios: boolean;
  effectiveSyncMinutes: SyncIntervalMinutes;
  effectiveGhostCleanMinutes: GhostCleanIntervalMinutes;
  summaryText: string;
}

const STORAGE_KEY = 'eink_power_settings';

function normalizeSyncInterval(val: unknown): SyncIntervalMinutes {
  const n = Number(val);
  if (n === 15 || n === 30 || n === 60 || n === 120 || n === 0) return n;
  return DEFAULT_POWER_SETTINGS.syncIntervalMinutes;
}

function normalizeGhostInterval(val: unknown): GhostCleanIntervalMinutes {
  const n = Number(val);
  if (n === 30 || n === 60 || n === 120 || n === 0) return n;
  return DEFAULT_POWER_SETTINGS.ghostCleanIntervalMinutes;
}

function normalizeHour(val: unknown, fallback: number): number {
  const n = Number(val);
  if (Number.isFinite(n) && n >= 0 && n <= 23) return Math.floor(n);
  return fallback;
}

export function loadPowerSettings(): PowerSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_POWER_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<PowerSettings>;
    return {
      keepScreenAwake: parsed.keepScreenAwake !== false,
      nightSleepEnabled: Boolean(parsed.nightSleepEnabled),
      nightSleepStartHour: normalizeHour(
        parsed.nightSleepStartHour,
        DEFAULT_POWER_SETTINGS.nightSleepStartHour
      ),
      nightSleepEndHour: normalizeHour(
        parsed.nightSleepEndHour,
        DEFAULT_POWER_SETTINGS.nightSleepEndHour
      ),
      nightAutoAirplaneRadio: parsed.nightAutoAirplaneRadio !== false,
      nightForceZeroBacklight: parsed.nightForceZeroBacklight !== false,
      nightFiveMinuteClock: parsed.nightFiveMinuteClock !== false,
      syncIntervalMinutes: normalizeSyncInterval(parsed.syncIntervalMinutes),
      ghostCleanIntervalMinutes: normalizeGhostInterval(parsed.ghostCleanIntervalMinutes),
      offlineClockMode: Boolean(parsed.offlineClockMode),
    };
  } catch {
    return DEFAULT_POWER_SETTINGS;
  }
}

export function savePowerSettings(settings: PowerSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore storage errors
  }
}

export function isWithinNightSleepWindow(settings: PowerSettings, now: Date): boolean {
  const hour = now.getHours();
  const start = settings.nightSleepStartHour;
  const end = settings.nightSleepEndHour;
  if (start === end) return false;
  if (start > end) {
    return hour >= start || hour < end;
  }
  return hour >= start && hour < end;
}

export function getNightWindowKey(settings: PowerSettings, now: Date): string | null {
  if (!settings.nightSleepEnabled || !isWithinNightSleepWindow(settings, now)) {
    return null;
  }
  const anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (settings.nightSleepStartHour > settings.nightSleepEndHour && now.getHours() < settings.nightSleepEndHour) {
    anchor.setDate(anchor.getDate() - 1);
  }
  const y = anchor.getFullYear();
  const m = String(anchor.getMonth() + 1).padStart(2, '0');
  const d = String(anchor.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}_${settings.nightSleepStartHour}-${settings.nightSleepEndHour}`;
}

export function evaluatePowerState(
  settings: PowerSettings,
  now: Date,
  overrides?: NightOverrideState
): PowerEvaluation {
  const scheduledWindowKey = getNightWindowKey(settings, now);
  const isScheduledNightWindow = scheduledWindowKey !== null;
  const isManuallyExitedTonight = Boolean(
    isScheduledNightWindow &&
      overrides?.manualNightExitKey &&
      overrides.manualNightExitKey === scheduledWindowKey
  );
  const isNightSleepActive =
    Boolean(overrides?.manualNightForceActive) ||
    (isScheduledNightWindow && !isManuallyExitedTonight);

  const shouldKeepAwake = settings.keepScreenAwake && !isNightSleepActive;
  const forceZeroBacklight = isNightSleepActive && settings.nightForceZeroBacklight;
  const isFiveMinuteClockActive = isNightSleepActive && settings.nightFiveMinuteClock;
  const shouldDisableNightRadios = isNightSleepActive && settings.nightAutoAirplaneRadio;
  const effectiveSyncMinutes: SyncIntervalMinutes =
    settings.offlineClockMode || isNightSleepActive ? 0 : settings.syncIntervalMinutes;
  const effectiveGhostCleanMinutes: GhostCleanIntervalMinutes = isNightSleepActive
    ? 0
    : settings.ghostCleanIntervalMinutes;

  const parts: string[] = [];
  if (!settings.keepScreenAwake) {
    parts.push('跟隨系統休眠');
  } else if (isNightSleepActive) {
    const nightTags: string[] = ['夜間模式中'];
    if (isFiveMinuteClockActive) nightTags.push('5分一跳');
    if (forceZeroBacklight) nightTags.push('背光0%');
    if (shouldDisableNightRadios) nightTags.push('飛航/無線省電');
    parts.push(nightTags.join('·'));
  } else if (settings.nightSleepEnabled) {
    const startLabel = String(settings.nightSleepStartHour).padStart(2, '0');
    const endLabel = String(settings.nightSleepEndHour).padStart(2, '0');
    const extras: string[] = [];
    if (settings.nightFiveMinuteClock) extras.push('5分跳');
    if (settings.nightForceZeroBacklight) extras.push('背光0');
    if (settings.nightAutoAirplaneRadio) extras.push('飛航/無線');
    parts.push(
      `夜休 ${startLabel}-${endLabel}${extras.length > 0 ? `(${extras.join('/')})` : ''}`
    );
  } else {
    parts.push('常亮');
  }

  if (settings.offlineClockMode) {
    parts.push('離線模式');
  } else if (effectiveSyncMinutes === 0) {
    parts.push(isNightSleepActive ? '暫停同步' : '手動同步');
  } else {
    parts.push(`${effectiveSyncMinutes}分同步`);
  }

  if (effectiveGhostCleanMinutes === 0) {
    parts.push(isNightSleepActive ? '停全刷' : '關閉自動全刷');
  } else {
    parts.push(`${effectiveGhostCleanMinutes}分全刷`);
  }

  return {
    shouldKeepAwake,
    isNightSleepActive,
    isScheduledNightWindow,
    isManuallyExitedTonight,
    scheduledWindowKey,
    forceZeroBacklight,
    isFiveMinuteClockActive,
    shouldDisableNightRadios,
    effectiveSyncMinutes,
    effectiveGhostCleanMinutes,
    summaryText: parts.join(' · '),
  };
}

export function shouldTriggerGhostCleanAt(
  now: Date,
  intervalMinutes: GhostCleanIntervalMinutes
): boolean {
  if (intervalMinutes === 0) return false;
  const mins = now.getMinutes();
  const hours = now.getHours();
  if (intervalMinutes === 30) return mins === 0 || mins === 30;
  if (intervalMinutes === 60) return mins === 0;
  if (intervalMinutes === 120) return mins === 0 && hours % 2 === 0;
  return false;
}

interface CordovaInsomniaPlugin {
  keepAwake?: (success?: () => void, error?: () => void) => void;
  allowSleepAgain?: (success?: () => void, error?: () => void) => void;
}

export function applyHardwareKeepAwake(shouldKeepAwake: boolean): 'applied' | 'unsupported' {
  let applied = false;

  // 優先透過原生 EInkOAuth 外掛直接設定 Android 視窗 FLAG_KEEP_SCREEN_ON（啟動與恢復前景也會自動續套）
  try {
    const bridge = getNativeRadioBridge();
    if (bridge && typeof bridge.setKeepScreenOn === 'function') {
      bridge.setKeepScreenOn(shouldKeepAwake);
      applied = true;
    }
  } catch {
    // 網頁環境或舊版外掛略過
  }

  // 同步呼叫 cordova-plugin-insomnia 作為雙重防休眠保險
  try {
    const w = window as unknown as {
      plugins?: { insomnia?: CordovaInsomniaPlugin };
    };
    const insomnia = w.plugins?.insomnia;
    if (insomnia) {
      if (shouldKeepAwake && typeof insomnia.keepAwake === 'function') {
        insomnia.keepAwake();
        applied = true;
      } else if (!shouldKeepAwake && typeof insomnia.allowSleepAgain === 'function') {
        insomnia.allowSleepAgain();
        applied = true;
      }
    }
  } catch {
    // 網頁環境或無 insomnia 外掛時略過
  }

  return applied ? 'applied' : 'unsupported';
}

export type WirelessSettingsTarget = 'airplane' | 'wifi' | 'bluetooth';

export interface NightRadioResult {
  status: 'applied' | 'unsupported' | 'error';
  sdkInt?: number;
  enterNightMode: boolean;
  airplane?: string;
  wifi?: string;
  bluetooth?: string;
  needsManualShortcut?: boolean;
  summary?: string;
}

interface NativeRadioBridge {
  setKeepScreenOn?: (
    keepOn: boolean,
    onSuccess?: () => void,
    onError?: (err: unknown) => void
  ) => void;
  listenTimeTick?: (
    onTick?: (timestampMillis: number) => void,
    onError?: (err: unknown) => void
  ) => void;
  setNightRadioMode?: (
    enterNightMode: boolean,
    onSuccess?: (res: {
      sdkInt?: number;
      enterNightMode?: boolean;
      airplane?: string;
      wifi?: string;
      bluetooth?: string;
      needsManualShortcut?: boolean;
    }) => void,
    onError?: (err: unknown) => void
  ) => void;
  openWirelessSettings?: (
    target: WirelessSettingsTarget,
    onSuccess?: () => void,
    onError?: (err: unknown) => void
  ) => void;
}

function getNativeRadioBridge(): NativeRadioBridge | null {
  try {
    const w = window as unknown as { EInkOAuth?: NativeRadioBridge };
    return w.EInkOAuth ?? null;
  } catch {
    return null;
  }
}

export function subscribeNativeTimeTick(onTick: () => void): () => void {
  let active = true;
  let bound = false;

  const tryBind = () => {
    if (!active || bound) return;
    const bridge = getNativeRadioBridge();
    if (!bridge || typeof bridge.listenTimeTick !== 'function') return;
    bound = true;
    try {
      bridge.listenTimeTick(() => {
        if (active) onTick();
      });
    } catch {
      bound = false;
    }
  };

  tryBind();
  document.addEventListener('deviceready', tryBind, false);
  window.addEventListener('eink-cordova-ready', tryBind);

  return () => {
    active = false;
    document.removeEventListener('deviceready', tryBind, false);
    window.removeEventListener('eink-cordova-ready', tryBind);
  };
}

export function formatNightRadioSummary(res: NightRadioResult): string {
  if (res.status === 'unsupported') {
    return '';
  }
  if (res.status === 'error') {
    return res.summary || '無線開關控制發生錯誤';
  }
  if (!res.enterNightMode) {
    const restored: string[] = [];
    if (res.airplane === 'restored') restored.push('飛航已關閉');
    if (res.wifi === 'restored') restored.push('Wi-Fi已恢復');
    if (res.bluetooth === 'restored') restored.push('藍牙已恢復');
    return restored.join('、');
  }

  const done: string[] = [];
  const restricted: string[] = [];

  if (res.airplane === 'enabled' || res.airplane === 'already_on') {
    done.push('飛航已開');
  } else if (res.airplane === 'os_restricted') {
    restricted.push('飛航');
  }

  if (res.wifi === 'disabled' || res.wifi === 'already_off') {
    done.push('Wi-Fi已關');
  } else if (res.wifi === 'os_restricted') {
    restricted.push('Wi-Fi');
  }

  if (res.bluetooth === 'disabled' || res.bluetooth === 'already_off') {
    done.push('藍牙已關');
  } else if (res.bluetooth === 'permission_needed' || res.bluetooth === 'os_restricted') {
    restricted.push('藍牙');
  }

  const chunks: string[] = [];
  if (done.length > 0) chunks.push(done.join('·'));
  if (restricted.length > 0) {
    chunks.push(`系統限制無法靜默切換${restricted.join('/')}`);
  }
  return chunks.join('；');
}

export function applyNativeNightRadioMode(enterNightMode: boolean): Promise<NightRadioResult> {
  const bridge = getNativeRadioBridge();
  if (!bridge || typeof bridge.setNightRadioMode !== 'function') {
    return Promise.resolve({ status: 'unsupported', enterNightMode });
  }

  return new Promise((resolve) => {
    try {
      bridge.setNightRadioMode?.(
        enterNightMode,
        (res) => {
          const payload: NightRadioResult = {
            status: 'applied',
            sdkInt: res?.sdkInt,
            enterNightMode,
            airplane: res?.airplane,
            wifi: res?.wifi,
            bluetooth: res?.bluetooth,
            needsManualShortcut: Boolean(res?.needsManualShortcut),
          };
          payload.summary = formatNightRadioSummary(payload);
          resolve(payload);
        },
        (err) => {
          resolve({
            status: 'error',
            enterNightMode,
            summary: typeof err === 'string' ? err : '夜間無線控制失敗',
          });
        }
      );
    } catch {
      resolve({ status: 'error', enterNightMode, summary: '夜間無線控制發生例外' });
    }
  });
}

export function openNativeWirelessSettings(target: WirelessSettingsTarget = 'airplane'): Promise<boolean> {
  const bridge = getNativeRadioBridge();
  if (!bridge || typeof bridge.openWirelessSettings !== 'function') {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    try {
      bridge.openWirelessSettings?.(
        target,
        () => resolve(true),
        () => resolve(false)
      );
    } catch {
      resolve(false);
    }
  });
}
