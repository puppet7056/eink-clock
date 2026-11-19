export type SyncIntervalMinutes = 15 | 30 | 60 | 120 | 0; // 0 = 僅手動同步
export type GhostCleanIntervalMinutes = 30 | 60 | 120 | 0; // 0 = 關閉自動全刷

export interface PowerSettings {
  /** 是否啟用螢幕常亮（防休眠鎖 WakeLock）；關閉則交由閱讀器系統自行待機休眠 */
  keepScreenAwake: boolean;
  /** 是否啟用夜間自動休眠排程（時段內自動釋放常亮鎖，讓 Android 進入深度省電） */
  nightSleepEnabled: boolean;
  /** 夜間自動休眠開始小時 (0 ~ 23) */
  nightSleepStartHour: number;
  /** 夜間自動休眠結束小時 (0 ~ 23) */
  nightSleepEndHour: number;
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
  syncIntervalMinutes: 30,
  ghostCleanIntervalMinutes: 60,
  offlineClockMode: false,
};

export const MAX_BATTERY_POWER_PRESET: PowerSettings = {
  keepScreenAwake: true,
  nightSleepEnabled: true,
  nightSleepStartHour: 23,
  nightSleepEndHour: 7,
  syncIntervalMinutes: 60,
  ghostCleanIntervalMinutes: 120,
  offlineClockMode: false,
};

export interface PowerEvaluation {
  shouldKeepAwake: boolean;
  isNightSleepActive: boolean;
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

export function evaluatePowerState(settings: PowerSettings, now: Date): PowerEvaluation {
  const isNightSleepActive =
    settings.nightSleepEnabled && isWithinNightSleepWindow(settings, now);
  const shouldKeepAwake = settings.keepScreenAwake && !isNightSleepActive;
  const effectiveSyncMinutes: SyncIntervalMinutes =
    settings.offlineClockMode || isNightSleepActive ? 0 : settings.syncIntervalMinutes;
  const effectiveGhostCleanMinutes: GhostCleanIntervalMinutes = isNightSleepActive
    ? 0
    : settings.ghostCleanIntervalMinutes;

  const parts: string[] = [];
  if (!settings.keepScreenAwake) {
    parts.push('跟隨系統休眠');
  } else if (isNightSleepActive) {
    parts.push('夜間休眠中');
  } else if (settings.nightSleepEnabled) {
    parts.push(
      `夜休 ${String(settings.nightSleepStartHour).padStart(2, '0')}-${String(settings.nightSleepEndHour).padStart(2, '0')}`
    );
  } else {
    parts.push('常亮');
  }

  if (settings.offlineClockMode) {
    parts.push('離線模式');
  } else if (effectiveSyncMinutes === 0) {
    parts.push('手動同步');
  } else {
    parts.push(`${effectiveSyncMinutes}分同步`);
  }

  if (effectiveGhostCleanMinutes === 0) {
    parts.push('關閉自動全刷');
  } else {
    parts.push(`${effectiveGhostCleanMinutes}分全刷`);
  }

  return {
    shouldKeepAwake,
    isNightSleepActive,
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
  try {
    const w = window as unknown as {
      plugins?: { insomnia?: CordovaInsomniaPlugin };
    };
    const insomnia = w.plugins?.insomnia;
    if (!insomnia) return 'unsupported';
    if (shouldKeepAwake && typeof insomnia.keepAwake === 'function') {
      insomnia.keepAwake();
      return 'applied';
    }
    if (!shouldKeepAwake && typeof insomnia.allowSleepAgain === 'function') {
      insomnia.allowSleepAgain();
      return 'applied';
    }
  } catch {
    // ignore on web or devices without insomnia plugin
  }
  return 'unsupported';
}
