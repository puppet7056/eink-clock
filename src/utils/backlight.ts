export type BacklightMode = 'off' | 'night' | 'manual' | 'system';

export interface BacklightSettings {
  mode: BacklightMode;
  nightLevel: number; // 5 ~ 80 (%)
  manualLevel: number; // 0 ~ 100 (%)
  nightStartHour: number; // 0 ~ 23
  nightEndHour: number; // 0 ~ 23
  followSunTimes: boolean;
}

export const DEFAULT_BACKLIGHT_SETTINGS: BacklightSettings = {
  mode: 'off',
  nightLevel: 18,
  manualLevel: 35,
  nightStartHour: 19,
  nightEndHour: 6,
  followSunTimes: true,
};

export interface BacklightEvaluation {
  brightnessValue: number; // -1 for system default, or 0.0 ~ 1.0
  percent: number | null;
  isNightNow: boolean;
  isExtremePowerSave: boolean;
  shortLabel: string;
  detailLabel: string;
}

function parseHmToMinutes(hm?: string): number | null {
  if (!hm) return null;
  const m = hm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (Number.isNaN(h) || Number.isNaN(min)) return null;
  return h * 60 + min;
}

export function loadBacklightSettings(): BacklightSettings {
  try {
    const raw = localStorage.getItem('eink_backlight_settings');
    if (!raw) return DEFAULT_BACKLIGHT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<BacklightSettings>;
    const mode: BacklightMode =
      parsed.mode === 'off' ||
      parsed.mode === 'night' ||
      parsed.mode === 'manual' ||
      parsed.mode === 'system'
        ? parsed.mode
        : DEFAULT_BACKLIGHT_SETTINGS.mode;
    return {
      mode,
      nightLevel: Math.min(80, Math.max(5, Number(parsed.nightLevel) || 18)),
      manualLevel: Math.min(100, Math.max(0, Number(parsed.manualLevel ?? 35))),
      nightStartHour: Math.min(23, Math.max(0, Number(parsed.nightStartHour ?? 19))),
      nightEndHour: Math.min(23, Math.max(0, Number(parsed.nightEndHour ?? 6))),
      followSunTimes: parsed.followSunTimes !== false,
    };
  } catch {
    return DEFAULT_BACKLIGHT_SETTINGS;
  }
}

export function saveBacklightSettings(settings: BacklightSettings): void {
  try {
    localStorage.setItem('eink_backlight_settings', JSON.stringify(settings));
  } catch {
    // ignore storage errors
  }
}

export function computeTargetBacklight(
  settings: BacklightSettings,
  now: Date,
  sunrise?: string,
  sunset?: string
): BacklightEvaluation {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  let startMin = settings.nightStartHour * 60;
  let endMin = settings.nightEndHour * 60;
  let usingSun = false;

  if (settings.followSunTimes) {
    const sunsetMin = parseHmToMinutes(sunset);
    const sunriseMin = parseHmToMinutes(sunrise);
    if (sunsetMin !== null && sunriseMin !== null) {
      startMin = sunsetMin;
      endMin = sunriseMin;
      usingSun = true;
    }
  }

  const isNightNow =
    startMin > endMin
      ? nowMinutes >= startMin || nowMinutes < endMin
      : nowMinutes >= startMin && nowMinutes < endMin;

  if (settings.mode === 'off') {
    return {
      brightnessValue: 0,
      percent: 0,
      isNightNow,
      isExtremePowerSave: true,
      shortLabel: '極致省電',
      detailLabel: '完全無背光（0%），可搭配下方「進階續航與休眠開關」進一步延長續航',
    };
  }

  if (settings.mode === 'night') {
    const activePercent = isNightNow ? settings.nightLevel : 0;
    const windowText = usingSun
      ? `日落 ${sunset} ～ 日出 ${sunrise}`
      : `${String(settings.nightStartHour).padStart(2, '0')}:00 ～ ${String(settings.nightEndHour).padStart(2, '0')}:00`;
    return {
      brightnessValue: activePercent / 100,
      percent: activePercent,
      isNightNow,
      isExtremePowerSave: false,
      shortLabel: isNightNow ? `夜光 ${activePercent}%` : '日間無光',
      detailLabel: isNightNow
        ? `夜晚部分背光已開啟（${activePercent}%｜排程 ${windowText}）`
        : `日間自動關閉背光（0%｜夜間 ${windowText} 將啟用 ${settings.nightLevel}%）`,
    };
  }

  if (settings.mode === 'manual') {
    return {
      brightnessValue: settings.manualLevel / 100,
      percent: settings.manualLevel,
      isNightNow,
      isExtremePowerSave: settings.manualLevel === 0,
      shortLabel: `背光 ${settings.manualLevel}%`,
      detailLabel: `手動固定前光亮度（${settings.manualLevel}%）`,
    };
  }

  return {
    brightnessValue: -1,
    percent: null,
    isNightNow,
    isExtremePowerSave: false,
    shortLabel: '系統背光',
    detailLabel: '跟隨閱讀器系統前光設定（無背光機型亦適用）',
  };
}

interface CordovaBrightnessPlugin {
  setBrightness?: (
    value: number,
    success?: (res: unknown) => void,
    error?: (err: unknown) => void
  ) => void;
}

export function applyHardwareBacklight(brightnessValue: number): 'applied' | 'unsupported' {
  try {
    const w = window as unknown as {
      cordova?: { plugins?: { brightness?: CordovaBrightnessPlugin } };
    };
    const plugin = w.cordova?.plugins?.brightness;
    if (plugin && typeof plugin.setBrightness === 'function') {
      const clamped =
        brightnessValue < 0 ? -1 : Math.min(1, Math.max(0, Number(brightnessValue.toFixed(2))));
      plugin.setBrightness(clamped);
      return 'applied';
    }
  } catch {
    // Hardware brightness not supported (e.g. non-backlit BOOX Go 10.3 or web browser)
  }
  return 'unsupported';
}
