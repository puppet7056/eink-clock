import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type TouchEvent } from 'react';
import {
  BatteryCharging,
  BookOpen,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  EyeOff,
  KeyRound,
  Monitor,
  Moon,
  RefreshCw,
  Settings,
  Smartphone,
  Sparkles,
  Sun,
  SunDim,
  Type,
} from 'lucide-react';
import { CalendarPanel, type CalendarEventItem } from './components/CalendarPanel';
import { WeatherPanel, type DeviceScale } from './components/WeatherPanel';
import {
  findTownPreset,
  TAIWAN_TOWN_PRESETS,
  type AqiPayload,
  type CwaWeatherPayload,
} from './types/weather';
import {
  applyHardwareBacklight,
  computeTargetBacklight,
  loadBacklightSettings,
  saveBacklightSettings,
  type BacklightMode,
  type BacklightSettings,
} from './utils/backlight';
import {
  fetchCwaLinkedAqi,
  getCwaCountyCode,
  parseCwaObservation,
  parseCwaOpenDataJson,
  parseCwaTownHtml,
} from './utils/cwaParser';
import { getTaiwanDayInfo } from './utils/taiwanCalendar';

type OrientationMode = 'auto' | 'portrait' | 'landscape';
type DeviceProfileMode = 'auto' | DeviceScale;

const FONT_SCALE_OPTIONS = [
  { value: 85, label: '偏小', short: '85%' },
  { value: 100, label: '標準', short: '100%' },
  { value: 115, label: '稍大', short: '115%' },
  { value: 130, label: '大字', short: '130%' },
  { value: 150, label: '特大', short: '150%' },
  { value: 170, label: '超大', short: '170%' },
] as const;

type FontScalePreset = (typeof FONT_SCALE_OPTIONS)[number]['value'];

function parseFontScale(raw: string): FontScalePreset {
  const num = Number(raw);
  const found = FONT_SCALE_OPTIONS.find((opt) => opt.value === num);
  return found ? found.value : 100;
}

// 解析 iCal 日期字串
function parseICalDate(str: string): Date | null {
  if (!str) return null;
  const clean = str.replace(/[^0-9T]/g, '');
  const y = parseInt(clean.slice(0, 4), 10);
  const m = parseInt(clean.slice(4, 6), 10) - 1;
  const d = parseInt(clean.slice(6, 8), 10);
  if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return null;

  if (clean.includes('T')) {
    const hh = parseInt(clean.slice(9, 11), 10);
    const mm = parseInt(clean.slice(11, 13), 10);
    if (str.endsWith('Z')) {
      return new Date(Date.UTC(y, m, d, hh, mm));
    }
    return new Date(y, m, d, hh, mm);
  }
  return new Date(y, m, d, 0, 0);
}

function readStorage(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (value === '') {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // ignore storage errors
  }
}

function isStandaloneApkRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.location.protocol === 'file:' ||
    Boolean((window as unknown as { cordova?: unknown }).cordova)
  );
}

async function fetchTextWithCorsFallback(targetUrl: string): Promise<string> {
  try {
    const direct = await fetch(targetUrl);
    if (direct.ok) return await direct.text();
  } catch {
    // fallback to CORS proxy when direct fetch is blocked
  }
  const proxied = await fetch(
    `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`
  );
  if (!proxied.ok) throw new Error(`HTTP ${proxied.status}`);
  return await proxied.text();
}

export default function App() {
  const [isDark, setIsDark] = useState<boolean>(() => readStorage('eink_theme', 'light') === 'dark');
  const [orientationMode, setOrientationMode] = useState<OrientationMode>(() => {
    const saved = readStorage('eink_orientation', 'auto');
    return saved === 'portrait' || saved === 'landscape' ? saved : 'auto';
  });
  const [deviceProfile, setDeviceProfile] = useState<DeviceProfileMode>(() => {
    const saved = readStorage('eink_device_profile', 'auto');
    return saved === 'compact4' || saved === 'phone' || saved === 'reader6' || saved === 'tablet10'
      ? saved
      : 'auto';
  });
  const [fontScale, setFontScale] = useState<FontScalePreset>(() =>
    parseFontScale(readStorage('eink_font_scale', '100'))
  );
  // 4.3 吋小螢幕（閱星瞳 XTEINK X4）雙頁切換：0 = 時鐘與天氣、1 = 農曆日曆與行程
  const [compactPage, setCompactPage] = useState<0 | 1>(0);

  // 背光與極致省電設定（完全儲存在本機）
  const [backlight, setBacklight] = useState<BacklightSettings>(() => loadBacklightSettings());

  // 私人 API 金鑰與個人日曆網址：一律僅儲存於本機 localStorage，絕不寫死或打包進 APK
  const [cwaApiKey, setCwaApiKey] = useState<string>(() => readStorage('eink_cwa_api_key', ''));
  const [strictApiKeyOnly, setStrictApiKeyOnly] = useState<boolean>(
    () => readStorage('eink_strict_api_key', 'false') === 'true'
  );
  const [townId, setTownId] = useState<string>(() => readStorage('eink_town_id', '6801000'));
  const [icalUrl, setIcalUrl] = useState<string>(() => readStorage('eink_ical_url', ''));

  const [viewport, setViewport] = useState<{ w: number; h: number }>(() =>
    typeof window !== 'undefined'
      ? { w: window.innerWidth, h: window.innerHeight }
      : { w: 1024, h: 768 }
  );

  const [ghostPhase, setGhostPhase] = useState<'none' | 'black' | 'white'>('none');
  const [now, setNow] = useState<Date>(() => new Date());

  const [weather, setWeather] = useState<CwaWeatherPayload | null>(null);
  const [weatherLoading, setWeatherLoading] = useState<boolean>(true);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [requiresApiKey, setRequiresApiKey] = useState<boolean>(false);
  const [aqi, setAqi] = useState<AqiPayload | null>(null);

  const [events, setEvents] = useState<CalendarEventItem[]>([]);
  const [syncStatus, setSyncStatus] = useState<string>('每15分同步');

  // 設定彈窗草稿狀態
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [draftIcalUrl, setDraftIcalUrl] = useState<string>('');
  const [draftTownId, setDraftTownId] = useState<string>(townId);
  const [draftDeviceProfile, setDraftDeviceProfile] = useState<DeviceProfileMode>(deviceProfile);
  const [draftOrientationMode, setDraftOrientationMode] = useState<OrientationMode>(orientationMode);
  const [draftFontScale, setDraftFontScale] = useState<FontScalePreset>(fontScale);
  const [draftCwaApiKey, setDraftCwaApiKey] = useState<string>('');
  const [draftStrictKey, setDraftStrictKey] = useState<boolean>(false);
  const [draftBacklight, setDraftBacklight] = useState<BacklightSettings>(backlight);
  const [showCwaKey, setShowCwaKey] = useState<boolean>(false);

  const ghostTimersRef = useRef<number[]>([]);
  const swipeOriginRef = useRef<{ x: number; y: number } | null>(null);
  const townPreset = useMemo(() => findTownPreset(townId), [townId]);

  const systemIsLandscape = viewport.w >= viewport.h;
  const effectiveOrientation: 'portrait' | 'landscape' =
    orientationMode === 'auto' ? (systemIsLandscape ? 'landscape' : 'portrait') : orientationMode;
  const isLandscape = effectiveOrientation === 'landscape';

  // 自動偵測閱讀器尺寸：4.3吋 (閱星瞳 XTEINK X4) / 手機型 (Viwoods) / 6吋原生 / 10.3吋大螢幕 (BOOX)
  const detectedScale: DeviceScale = useMemo(() => {
    const minSide = Math.min(viewport.w, viewport.h);
    const maxSide = Math.max(viewport.w, viewport.h);
    if (minSide <= 360 || (minSide < 400 && maxSide <= 680)) return 'compact4';
    if (viewport.w < 460 || minSide < 440) return 'phone';
    if (maxSide >= 860 && minSide >= 600) return 'tablet10';
    return 'reader6';
  }, [viewport]);

  const effectiveDeviceScale: DeviceScale =
    deviceProfile === 'auto' ? detectedScale : deviceProfile;
  const isCompact4 = effectiveDeviceScale === 'compact4';

  // 計算當下目標背光狀態（完全無背光極致省電 / 夜晚部分背光 / 手動 / 系統）
  const backlightEval = useMemo(
    () =>
      computeTargetBacklight(
        backlight,
        now,
        weather?.today.sunrise,
        weather?.today.sunset
      ),
    [backlight, now, weather?.today.sunrise, weather?.today.sunset]
  );

  // 套用硬體背光（Cordova Android 支援前光機型自動控制，無前光機型與瀏覽器安全略過）
  useEffect(() => {
    applyHardwareBacklight(backlightEval.brightnessValue);
  }, [backlightEval.brightnessValue]);

  // 監聽 Cordova deviceready / resume 以確保喚醒後立即套用背光設定
  useEffect(() => {
    const handleCordovaReady = () => {
      applyHardwareBacklight(backlightEval.brightnessValue);
    };
    window.addEventListener('eink-cordova-ready', handleCordovaReady);
    return () => window.removeEventListener('eink-cordova-ready', handleCordovaReady);
  }, [backlightEval.brightnessValue]);

  // 監聽視窗尺寸變化
  useEffect(() => {
    const handleResize = () => {
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 同步深淺色主題與字體縮放到 documentElement
  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    document.body.classList.toggle('dark-mode', isDark);
  }, [isDark]);

  useEffect(() => {
    document.documentElement.dataset.fontScale = String(fontScale);
  }, [fontScale]);

  // 4.3 吋（閱星瞳 XTEINK X4）實體翻頁鍵 / 音量鍵 / 方向鍵雙頁切換（支援無觸控機型）
  useEffect(() => {
    if (!isCompact4) {
      setCompactPage(0);
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isSettingsOpen) return;
      const targetTag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const isFormEl = targetTag === 'input' || targetTag === 'select' || targetTag === 'textarea';
      if (isFormEl) return;

      if (
        e.key === 'ArrowRight' ||
        e.key === 'PageDown' ||
        e.key === 'VolumeDown' ||
        e.key === 'MediaTrackNext'
      ) {
        e.preventDefault();
        setCompactPage(1);
      } else if (
        e.key === 'ArrowLeft' ||
        e.key === 'PageUp' ||
        e.key === 'VolumeUp' ||
        e.key === 'MediaTrackPrevious'
      ) {
        e.preventDefault();
        setCompactPage(0);
      } else if ((e.key === ' ' || e.key === 'Enter') && targetTag !== 'button') {
        e.preventDefault();
        setCompactPage((prev) => (prev === 0 ? 1 : 0));
      }
    };

    const handleVolUp = () => {
      if (!isSettingsOpen) setCompactPage(0);
    };
    const handleVolDown = () => {
      if (!isSettingsOpen) setCompactPage(1);
    };

    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('volumeupbutton', handleVolUp);
    document.addEventListener('volumedownbutton', handleVolDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('volumeupbutton', handleVolUp);
      document.removeEventListener('volumedownbutton', handleVolDown);
    };
  }, [isCompact4, isSettingsOpen]);

  const handleCompactTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    if (!isCompact4 || e.touches.length !== 1) return;
    swipeOriginRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };

  const handleCompactTouchEnd = (e: TouchEvent<HTMLDivElement>) => {
    if (!isCompact4 || !swipeOriginRef.current || e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - swipeOriginRef.current.x;
    const dy = e.changedTouches[0].clientY - swipeOriginRef.current.y;
    swipeOriginRef.current = null;
    if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      setCompactPage(dx < 0 ? 1 : 0);
    }
  };

  const handleCompactPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!isCompact4 || e.pointerType === 'touch') return;
    swipeOriginRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleCompactPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!isCompact4 || e.pointerType === 'touch' || !swipeOriginRef.current) return;
    const dx = e.clientX - swipeOriginRef.current.x;
    const dy = e.clientY - swipeOriginRef.current.y;
    swipeOriginRef.current = null;
    if (Math.abs(dx) >= 56 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      setCompactPage(dx < 0 ? 1 : 0);
    }
  };

  // 電子紙防殘影全螢幕刷新（黑->白->正常）
  const forceFullRefresh = useCallback(() => {
    ghostTimersRef.current.forEach((id) => window.clearTimeout(id));
    ghostTimersRef.current = [];

    setGhostPhase('black');
    const t1 = window.setTimeout(() => {
      setGhostPhase('white');
      const t2 = window.setTimeout(() => {
        setGhostPhase('none');
      }, 250);
      ghostTimersRef.current.push(t2);
    }, 250);
    ghostTimersRef.current.push(t1);
  }, []);

  useEffect(() => {
    return () => {
      ghostTimersRef.current.forEach((id) => window.clearTimeout(id));
    };
  }, []);

  const toggleTheme = useCallback(() => {
    setIsDark((prev) => {
      const next = !prev;
      writeStorage('eink_theme', next ? 'dark' : 'light');
      return next;
    });
    forceFullRefresh();
  }, [forceFullRefresh]);

  const handleSelectOrientation = (mode: OrientationMode) => {
    setOrientationMode(mode);
    writeStorage('eink_orientation', mode);
  };

  // 頂部快速切換背光模式：極致省電(0%) -> 夜晚部分背光 -> 系統背光
  const cycleBacklightMode = () => {
    setBacklight((prev) => {
      const order: BacklightMode[] = ['off', 'night', 'system'];
      const idx = order.indexOf(prev.mode);
      const nextMode = order[(idx + 1) % order.length];
      const next = { ...prev, mode: nextMode };
      saveBacklightSettings(next);
      return next;
    });
  };

  // 抓取台灣中央氣象署天氣 + 空氣品質（只需一組中央氣象署 API Key，同時支援 APK 獨立運作）
  const fetchWeatherAndAQI = useCallback(async () => {
    setWeatherLoading(true);
    setWeatherError(null);
    setRequiresApiKey(false);
    const standalone = isStandaloneApkRuntime();
    const trimmedCwaKey = cwaApiKey.trim();

    try {
      let weatherPayload: CwaWeatherPayload | null = null;

      if (!standalone) {
        try {
          const headers: Record<string, string> = {};
          if (trimmedCwaKey) headers['X-CWA-API-Key'] = trimmedCwaKey;
          const wRes = await fetch(
            `/api/weather/cwa?townId=${encodeURIComponent(townPreset.id)}&strictKey=${strictApiKeyOnly}`,
            { headers }
          );
          if (wRes.status === 401) {
            const errJson = (await wRes.json().catch(() => ({}))) as {
              error?: string;
              requiresApiKey?: boolean;
            };
            setWeather(null);
            setRequiresApiKey(true);
            setWeatherError(errJson.error || '請先設定中央氣象署 OpenData API Key');
            setWeatherLoading(false);
            return;
          }
          if (wRes.ok) {
            weatherPayload = (await wRes.json()) as CwaWeatherPayload;
          }
        } catch {
          // fallback below
        }
      }

      if (!weatherPayload) {
        // Standalone Cordova APK or server fallback
        if (trimmedCwaKey) {
          const openDataUrl = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/${townPreset.cwaDatasetId}?Authorization=${encodeURIComponent(
            trimmedCwaKey
          )}&LocationName=${encodeURIComponent(townPreset.districtName)}`;
          const res = await fetch(openDataUrl);
          if (res.status === 401 || res.status === 403) {
            setWeather(null);
            setRequiresApiKey(true);
            setWeatherError('中央氣象署 OpenData API Key 無效或已過期，請於設定中重新確認。');
            setWeatherLoading(false);
            return;
          }
          if (!res.ok) throw new Error(`中央氣象署 OpenData HTTP ${res.status}`);
          const json = await res.json();

          // Optional sunrise/sunset enrichment
          const countyCode = getCwaCountyCode(townPreset.id);
          const obsUrl = `https://www.cwa.gov.tw/Data/js/GT/TableData_GT_T_${countyCode}.js`;
          const obsJs = await fetchTextWithCorsFallback(obsUrl).catch(() => '');
          const obs = obsJs ? parseCwaObservation(obsJs, townPreset.id) : null;
          weatherPayload = parseCwaOpenDataJson(
            townPreset.id,
            townPreset.districtName,
            json,
            obs ? { sunrise: obs.sunrise, sunset: obs.sunset } : undefined
          );
        } else if (strictApiKeyOnly) {
          setWeather(null);
          setRequiresApiKey(true);
          setWeatherError(
            '已啟用個人 API Key 模式，請先於右上角「設定」輸入您的中央氣象署 OpenData 授權碼。'
          );
          setWeatherLoading(false);
          return;
        } else {
          const countyCode = getCwaCountyCode(townPreset.id);
          const forecastUrl = `https://www.cwa.gov.tw/V8/C/W/Town/MOD/3hr/${townPreset.id}_3hr_PC.html`;
          const obsUrl = `https://www.cwa.gov.tw/Data/js/GT/TableData_GT_T_${countyCode}.js`;
          const [forecastHtml, obsJs] = await Promise.all([
            fetchTextWithCorsFallback(forecastUrl),
            fetchTextWithCorsFallback(obsUrl).catch(() => ''),
          ]);
          weatherPayload = parseCwaTownHtml(townPreset.id, forecastHtml, obsJs);
        }
      }

      setWeather(weatherPayload);

      // 空氣品質：共用同一組中央氣象署 API Key（氣象署開放鏈結 GraphQL），未取得時自動補齊免金鑰空品
      try {
        let aqiData: AqiPayload | null = null;
        if (!standalone) {
          const headers: Record<string, string> = {};
          if (trimmedCwaKey) headers['X-CWA-API-Key'] = trimmedCwaKey;
          const aRes = await fetch(
            `/api/aqi?townId=${encodeURIComponent(townPreset.id)}&lat=${townPreset.lat}&lon=${townPreset.lon}`,
            { headers }
          );
          if (aRes.ok) {
            aqiData = (await aRes.json()) as AqiPayload;
          }
        } else {
          if (trimmedCwaKey) {
            aqiData = await fetchCwaLinkedAqi(townPreset.lat, townPreset.lon, trimmedCwaKey);
          }
          if (!aqiData) {
            const directAqi = await fetch(
              `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${townPreset.lat}&longitude=${townPreset.lon}&current=us_aqi,pm2_5,pm10&timezone=Asia%2FTaipei`
            );
            if (directAqi.ok) {
              const j = (await directAqi.json()) as {
                current?: { us_aqi?: number; pm2_5?: number; pm10?: number };
              };
              aqiData = {
                usAqi: Math.round(j.current?.us_aqi ?? 0),
                pm25: Math.round(j.current?.pm2_5 ?? 0),
                pm10: Math.round(j.current?.pm10 ?? 0),
                source: 'US AQI',
              };
            }
          }
        }
        setAqi(aqiData);
      } catch {
        setAqi(null);
      }
    } catch (err) {
      setWeatherError(err instanceof Error ? err.message : '連線失敗');
    } finally {
      setWeatherLoading(false);
    }
  }, [townPreset, cwaApiKey, strictApiKeyOnly]);

  // 抓取並解析 Google 日曆 iCal（僅使用本機設定之私人網址）
  const fetchCalendar = useCallback(async () => {
    const syncCadenceMin = backlightEval.isExtremePowerSave ? 30 : 15;
    if (!icalUrl) {
      setEvents([]);
      setSyncStatus(`每${syncCadenceMin}分同步`);
      return;
    }

    const standalone = isStandaloneApkRuntime();
    try {
      let text = '';
      if (!standalone) {
        try {
          const res = await fetch(`/api/ical?url=${encodeURIComponent(icalUrl)}`);
          if (res.ok) text = await res.text();
        } catch {
          // fallback below
        }
      }
      if (!text) {
        text = await fetchTextWithCorsFallback(icalUrl);
      }

      const parsedEvents: CalendarEventItem[] = [];
      const blocks = text.split('BEGIN:VEVENT');
      const currentNow = new Date();
      const startOfToday = new Date(
        currentNow.getFullYear(),
        currentNow.getMonth(),
        currentNow.getDate()
      );
      const rangeEnd = new Date(startOfToday.getTime() + 31 * 24 * 60 * 60 * 1000);

      for (let i = 1; i < blocks.length; i++) {
        const block = blocks[i];
        const summaryMatch = block.match(/SUMMARY:(.*)/);
        const dtStartMatch = block.match(/DTSTART[^:]*:(.*)/);
        if (summaryMatch && dtStartMatch) {
          const summary = summaryMatch[1].trim();
          const rawDate = dtStartMatch[1].trim();
          const startDate = parseICalDate(rawDate);
          const isAllDay = !rawDate.includes('T');

          if (startDate && startDate >= startOfToday && startDate <= rangeEnd) {
            const m = startDate.getMonth() + 1;
            const d = startDate.getDate();
            const hh = String(startDate.getHours()).padStart(2, '0');
            const mm = String(startDate.getMinutes()).padStart(2, '0');
            const timeLabel = isAllDay ? `${m}/${d} 全天` : `${m}/${d} ${hh}:${mm}`;
            parsedEvents.push({
              id: `${startDate.getTime()}-${i}`,
              date: startDate,
              timeLabel,
              summary,
              isAllDay,
            });
          }
        }
      }

      parsedEvents.sort((a, b) => a.date.getTime() - b.date.getTime());
      setEvents(parsedEvents);
      setSyncStatus(
        `已同步 ${String(currentNow.getHours()).padStart(2, '0')}:${String(currentNow.getMinutes()).padStart(2, '0')}`
      );
    } catch {
      setSyncStatus('日曆同步失敗');
    }
  }, [icalUrl, backlightEval.isExtremePowerSave]);

  // 時鐘對齊整分鐘更新
  useEffect(() => {
    const tick = (allowClean: boolean) => {
      const current = new Date();
      setNow(current);
      const mins = current.getMinutes();
      if (allowClean && (mins === 0 || mins === 30)) {
        forceFullRefresh();
      }
    };

    tick(false);
    let minuteInterval: number | undefined;
    const msToNextMinute = (60 - new Date().getSeconds()) * 1000;
    const alignTimeout = window.setTimeout(() => {
      tick(true);
      minuteInterval = window.setInterval(() => tick(true), 60 * 1000);
    }, msToNextMinute);

    return () => {
      window.clearTimeout(alignTimeout);
      if (minuteInterval !== undefined) window.clearInterval(minuteInterval);
    };
  }, [forceFullRefresh]);

  // 天氣與日曆排程更新（極致省電模式降頻為 30 分鐘，一般模式 15 分鐘）
  useEffect(() => {
    fetchWeatherAndAQI();
    fetchCalendar();
    const intervalMs = (backlightEval.isExtremePowerSave ? 30 : 15) * 60 * 1000;
    const interval = window.setInterval(() => {
      fetchWeatherAndAQI();
      fetchCalendar();
    }, intervalMs);
    return () => window.clearInterval(interval);
  }, [fetchWeatherAndAQI, fetchCalendar, backlightEval.isExtremePowerSave]);

  const openSettings = () => {
    setDraftIcalUrl(icalUrl);
    setDraftTownId(townId);
    setDraftDeviceProfile(deviceProfile);
    setDraftOrientationMode(orientationMode);
    setDraftFontScale(fontScale);
    setDraftCwaApiKey(cwaApiKey);
    setDraftStrictKey(strictApiKeyOnly);
    setDraftBacklight(backlight);
    setShowCwaKey(false);
    setIsSettingsOpen(true);
  };

  const stepDraftFontScale = (delta: -1 | 1) => {
    const idx = FONT_SCALE_OPTIONS.findIndex((opt) => opt.value === draftFontScale);
    const nextIdx = Math.min(FONT_SCALE_OPTIONS.length - 1, Math.max(0, idx + delta));
    setDraftFontScale(FONT_SCALE_OPTIONS[nextIdx].value);
  };

  const saveSettings = () => {
    const cleanedIcal = draftIcalUrl.trim();
    const cleanedCwaKey = draftCwaApiKey.trim();

    setIcalUrl(cleanedIcal);
    setTownId(draftTownId);
    setDeviceProfile(draftDeviceProfile);
    setOrientationMode(draftOrientationMode);
    setFontScale(draftFontScale);
    setCwaApiKey(cleanedCwaKey);
    setStrictApiKeyOnly(draftStrictKey);
    setBacklight(draftBacklight);

    writeStorage('eink_ical_url', cleanedIcal);
    writeStorage('eink_town_id', draftTownId);
    writeStorage('eink_device_profile', draftDeviceProfile);
    writeStorage('eink_orientation', draftOrientationMode);
    writeStorage('eink_font_scale', String(draftFontScale));
    writeStorage('eink_cwa_api_key', cleanedCwaKey);
    writeStorage('eink_strict_api_key', String(draftStrictKey));
    saveBacklightSettings(draftBacklight);

    setIsSettingsOpen(false);
  };

  const draftBacklightPreview = useMemo(
    () =>
      computeTargetBacklight(
        draftBacklight,
        now,
        weather?.today.sunrise,
        weather?.today.sunset
      ),
    [draftBacklight, now, weather?.today.sunrise, weather?.today.sunset]
  );

  const todayInfo = useMemo(() => getTaiwanDayInfo(now), [now]);
  const timeDisplay = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const dateDisplay = isCompact4
    ? `${todayInfo.month}/${todayInfo.day}（${todayInfo.weekdayLabel}）`
    : `${todayInfo.year}/${todayInfo.month}/${todayInfo.day}（${todayInfo.weekdayLabel}）`;

  const containerWidthClass = useMemo(() => {
    if (!isLandscape && systemIsLandscape && viewport.w >= 820) {
      if (effectiveDeviceScale === 'compact4') {
        return 'max-w-[360px] border-x-[2px] border-[var(--border-subtle)] px-2.5 py-2';
      }
      if (effectiveDeviceScale === 'phone') {
        return 'max-w-[410px] border-x-[2px] border-[var(--border-subtle)] px-3.5 py-3';
      }
      if (effectiveDeviceScale === 'tablet10') {
        return 'max-w-[820px] border-x-[2px] border-[var(--border-subtle)] px-6 py-5';
      }
      return 'max-w-[640px] border-x-[2px] border-[var(--border-subtle)] px-5 py-4';
    }
    if (isLandscape && effectiveDeviceScale === 'compact4' && viewport.w >= 820) {
      return 'max-w-[620px] border-x-[2px] border-[var(--border-subtle)] px-3 py-2';
    }
    if (effectiveDeviceScale === 'compact4') {
      return 'px-2.5 py-2';
    }
    if (effectiveDeviceScale === 'phone') {
      return 'px-3 py-2.5';
    }
    if (effectiveDeviceScale === 'tablet10') {
      return 'px-6 py-5';
    }
    return 'p-4';
  }, [isLandscape, systemIsLandscape, viewport.w, effectiveDeviceScale]);

  const btnClass = `inline-flex items-center gap-1 bg-[var(--bg-color)] text-[var(--fg-color)] border-[1.5px] border-[var(--border-color)] ${
    effectiveDeviceScale === 'tablet10'
      ? 'px-3 py-1.5 text-[length:calc(14px*var(--fs-ctrl))]'
      : effectiveDeviceScale === 'compact4' || effectiveDeviceScale === 'phone'
        ? 'px-1.5 py-1 text-[length:calc(11.5px*var(--fs-ctrl))]'
        : 'px-2.5 py-1 text-[length:calc(12.5px*var(--fs-ctrl))]'
  } font-extrabold rounded-[6px] cursor-pointer whitespace-nowrap shrink-0 active:bg-[var(--surface-active)] active:text-[var(--fg-inverse)]`;

  const landscapeClockClass =
    effectiveDeviceScale === 'tablet10'
      ? 'text-[length:min(15.5vw,calc(clamp(92px,9.8vw,148px)*var(--fs-clock)))]'
      : effectiveDeviceScale === 'compact4'
        ? 'text-[length:min(16vw,calc(clamp(56px,11vw,82px)*var(--fs-clock)))]'
        : effectiveDeviceScale === 'phone'
          ? 'text-[length:min(15vw,calc(clamp(48px,10vw,74px)*var(--fs-clock)))]'
          : 'text-[length:min(15.5vw,calc(clamp(68px,8.6vw,112px)*var(--fs-clock)))]';

  const portraitClockClass =
    effectiveDeviceScale === 'tablet10'
      ? 'text-[length:min(25vw,calc(clamp(96px,15vw,160px)*var(--fs-clock)))]'
      : effectiveDeviceScale === 'compact4'
        ? 'text-[length:min(26vw,calc(clamp(66px,21vw,94px)*var(--fs-clock)))]'
        : effectiveDeviceScale === 'phone'
          ? 'text-[length:min(24vw,calc(clamp(54px,18vw,82px)*var(--fs-clock)))]'
          : 'text-[length:min(25vw,calc(clamp(68px,16vw,106px)*var(--fs-clock)))]';

  const fontScaleRatio = fontScale / 100;
  const hideHeaderLabels = effectiveDeviceScale === 'phone' || isCompact4;

  const cycleOrientationCompact = () => {
    const order: OrientationMode[] = ['auto', 'portrait', 'landscape'];
    const next = order[(order.indexOf(orientationMode) + 1) % order.length];
    handleSelectOrientation(next);
  };

  return (
    <div
      data-font-scale={String(fontScale)}
      className={`${
        isDark ? 'dark dark-mode ' : ''
      }h-screen w-screen overflow-hidden select-none bg-[var(--bg-color)] text-[var(--fg-color)] flex justify-center`}
    >
      {/* 防殘影全螢幕刷新遮罩 */}
      {ghostPhase !== 'none' && (
        <div
          id="ghost-cleaner"
          className={`fixed inset-0 z-[9999] ${ghostPhase === 'black' ? 'bg-black' : 'bg-white'}`}
        />
      )}

      {/* 主看板容器 */}
      <div className={`h-full w-full flex flex-col overflow-hidden ${containerWidthClass}`}>
        {/* 頂部工具列：國曆日期 + 農曆/節氣/假日 + 直橫/背光/刷新/主題/設定 */}
        <header
          className={`flex flex-wrap items-center justify-between ${
            isCompact4 ? 'gap-1.5 border-b-[2px] pb-1.5' : 'gap-2 border-b-[3px] pb-2'
          } border-[var(--border-color)] shrink-0`}
        >
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
            <span
              className={`${
                effectiveDeviceScale === 'tablet10'
                  ? 'text-[length:calc(25px*var(--fs))]'
                  : isCompact4
                    ? 'text-[length:calc(16px*var(--fs))]'
                    : effectiveDeviceScale === 'phone'
                      ? 'text-[length:calc(16.5px*var(--fs))]'
                      : 'text-[length:calc(20px*var(--fs))]'
              } font-black tracking-[0.5px] font-num whitespace-nowrap`}
            >
              {dateDisplay}
            </span>
            <span
              className={`${
                effectiveDeviceScale === 'tablet10'
                  ? 'text-[length:calc(17px*var(--fs))]'
                  : hideHeaderLabels
                    ? 'text-[length:calc(11.5px*var(--fs))]'
                    : 'text-[length:calc(14px*var(--fs))]'
              } font-bold text-[var(--fg-muted)] whitespace-nowrap`}
            >
              {isCompact4
                ? `農曆 ${todayInfo.lunarMonthText}${todayInfo.lunarDayText}`
                : `農曆 ${todayInfo.lunarFull}`}
              {todayInfo.solarTerm ? ` · ${todayInfo.solarTerm}` : ''}
              {todayInfo.holiday ? ` · ${todayInfo.holiday}` : ''}
            </span>
          </div>

          <div className="flex items-center gap-1 shrink-0 flex-wrap">
            {/* 直橫顯示切換：4.3 吋採單顆循環鍵節省頂部空間，其他尺寸顯示三段切換 */}
            {isCompact4 ? (
              <button
                type="button"
                onClick={cycleOrientationCompact}
                className={btnClass}
                title={`方向：${
                  orientationMode === 'auto' ? '自動' : orientationMode === 'portrait' ? '直向' : '橫向'
                }（點按切換）`}
                aria-label="切換直橫顯示方向"
              >
                {isLandscape ? <Monitor className="w-3.5 h-3.5" /> : <Smartphone className="w-3.5 h-3.5" />}
              </button>
            ) : (
              <div
                role="group"
                aria-label="直橫顯示切換"
                className="inline-flex items-center border-[1.5px] border-[var(--border-color)] rounded-[6px] overflow-hidden shrink-0"
              >
                {(
                  [
                    { id: 'auto', label: '自動', icon: null },
                    { id: 'portrait', label: '直向', icon: Smartphone },
                    { id: 'landscape', label: '橫向', icon: Monitor },
                  ] as const
                ).map((item) => {
                  const active = orientationMode === item.id;
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleSelectOrientation(item.id)}
                      aria-pressed={active}
                      className={`inline-flex items-center gap-1 ${
                        effectiveDeviceScale === 'tablet10'
                          ? 'px-2.5 py-1.5 text-[length:calc(14px*var(--fs-ctrl))]'
                          : effectiveDeviceScale === 'phone'
                            ? 'px-1.5 py-1 text-[length:calc(11.5px*var(--fs-ctrl))]'
                            : 'px-2 py-1 text-[length:calc(12.5px*var(--fs-ctrl))]'
                      } font-extrabold whitespace-nowrap cursor-pointer ${
                        active
                          ? 'bg-[var(--surface-active)] text-[var(--fg-inverse)]'
                          : 'bg-[var(--bg-color)] text-[var(--fg-color)]'
                      }`}
                    >
                      {Icon && effectiveDeviceScale !== 'phone' && <Icon className="w-[0.95em] h-[0.95em]" />}
                      {item.label}
                    </button>
                  );
                })}
              </div>
            )}

            {/* 背光 / 極致省電快速切換按鈕 */}
            <button
              type="button"
              onClick={cycleBacklightMode}
              className={btnClass}
              title={backlightEval.detailLabel}
            >
              {backlight.mode === 'off' ? (
                <BatteryCharging className="w-3.5 h-3.5" />
              ) : (
                <SunDim className="w-3.5 h-3.5" />
              )}
              {!hideHeaderLabels && backlightEval.shortLabel}
            </button>

            <button type="button" onClick={forceFullRefresh} className={btnClass} title="防殘影刷新">
              <Sparkles className="w-3.5 h-3.5" />
              {!hideHeaderLabels && '清殘影'}
            </button>
            <button type="button" onClick={toggleTheme} className={btnClass} title="黑白反轉">
              {isDark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
              {!hideHeaderLabels && (isDark ? '淺色' : '深色')}
            </button>
            <button type="button" onClick={openSettings} className={btnClass} title="看板設定">
              <Settings className="w-3.5 h-3.5" />
              {!hideHeaderLabels && '設定'}
            </button>
          </div>
        </header>

        {/* 內容主區域：4.3 吋（閱星瞳 XTEINK X4）採雙頁切換（第1頁時鐘天氣 / 第2頁農曆日曆），支援觸控滑動、底部按鈕與實體按鍵 */}
        {isCompact4 ? (
          <div
            className="flex-1 flex flex-col min-h-0 overflow-hidden"
            onTouchStart={handleCompactTouchStart}
            onTouchEnd={handleCompactTouchEnd}
            onPointerDown={handleCompactPointerDown}
            onPointerUp={handleCompactPointerUp}
          >
            {compactPage === 0 ? (
              isLandscape ? (
                <main className="flex-1 grid grid-cols-[0.92fr_1.08fr] gap-3 pt-2 min-h-0 overflow-hidden">
                  <section className="flex flex-col justify-center items-center text-center pr-3 border-r-[2px] border-[var(--border-color)] min-h-0">
                    <div
                      className={`${landscapeClockClass} font-black leading-[0.95] tracking-[-3px] font-num`}
                    >
                      {timeDisplay}
                    </div>
                    <div className="mt-2 text-[length:calc(13.5px*var(--fs))] font-extrabold">
                      {townPreset.name}
                    </div>
                    <div className="text-[length:calc(11.5px*var(--fs))] font-semibold text-[var(--fg-muted)]">
                      {todayInfo.holiday
                        ? `國定假日 · ${todayInfo.holiday}`
                        : todayInfo.solarTerm
                          ? `節氣 · ${todayInfo.solarTerm}`
                          : backlightEval.shortLabel}
                    </div>
                  </section>
                  <div className="flex flex-col justify-center min-h-0 overflow-y-auto">
                    <WeatherPanel
                      townName={townPreset.name}
                      weather={weather}
                      aqi={aqi}
                      loading={weatherLoading}
                      error={weatherError}
                      requiresApiKey={requiresApiKey}
                      isLandscape={true}
                      deviceScale="compact4"
                      fontScale={fontScaleRatio}
                      onRefresh={fetchWeatherAndAQI}
                      onOpenSettings={openSettings}
                    />
                  </div>
                </main>
              ) : (
                <main className="flex-1 flex flex-col justify-between min-h-0 overflow-y-auto">
                  {/* 第 1 頁：大時鐘 */}
                  <section className="text-center py-2.5 border-b-[2px] border-[var(--border-color)] shrink-0">
                    <div
                      className={`${portraitClockClass} font-black leading-[0.92] tracking-[-3px] font-num`}
                    >
                      {timeDisplay}
                    </div>
                    <div className="mt-1 flex items-center justify-center gap-1.5 text-[length:calc(11.5px*var(--fs))] font-bold text-[var(--fg-muted)]">
                      <span>{townPreset.name}</span>
                      <span aria-hidden="true">·</span>
                      <span>{backlightEval.shortLabel}</span>
                      {todayInfo.holiday && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-black text-[var(--fg-color)] underline underline-offset-2">
                            {todayInfo.holiday}
                          </span>
                        </>
                      )}
                    </div>
                  </section>

                  {/* 第 1 頁：Google 天氣風格 + 未來 12 小時變化（6 格清爽版） */}
                  <div className="flex-1 flex flex-col justify-center py-2 min-h-0">
                    <WeatherPanel
                      townName={townPreset.name}
                      weather={weather}
                      aqi={aqi}
                      loading={weatherLoading}
                      error={weatherError}
                      requiresApiKey={requiresApiKey}
                      isLandscape={false}
                      deviceScale="compact4"
                      fontScale={fontScaleRatio}
                      onRefresh={fetchWeatherAndAQI}
                      onOpenSettings={openSettings}
                    />
                  </div>
                </main>
              )
            ) : (
              /* 第 2 頁：全畫面農曆月曆與行程 */
              <main className="flex-1 flex flex-col pt-2 min-h-0 overflow-hidden">
                <CalendarPanel
                  today={now}
                  events={events}
                  hasIcalUrl={Boolean(icalUrl)}
                  syncStatus={syncStatus}
                  isLandscape={isLandscape}
                  deviceScale="compact4"
                  onOpenSettings={openSettings}
                />
              </main>
            )}

            {/* 4.3 吋底部雙頁切換列（支援按鈕點擊、觸控滑動與實體翻頁鍵／音量鍵／方向鍵） */}
            <nav
              aria-label="4.3吋雙頁切換"
              className="pt-1.5 mt-1 border-t-[2px] border-[var(--border-color)] shrink-0 flex flex-col gap-1"
            >
              <div className="grid grid-cols-2 border-[1.5px] border-[var(--border-color)] rounded-[6px] overflow-hidden">
                <button
                  type="button"
                  onClick={() => setCompactPage(0)}
                  aria-pressed={compactPage === 0}
                  className={`flex items-center justify-center gap-1 py-1.5 px-2 text-[length:calc(12.5px*var(--fs-ctrl))] font-black cursor-pointer whitespace-nowrap ${
                    compactPage === 0
                      ? 'bg-[var(--surface-active)] text-[var(--fg-inverse)]'
                      : 'bg-[var(--bg-color)] text-[var(--fg-color)]'
                  }`}
                >
                  <ChevronLeft className="w-3.5 h-3.5 shrink-0" />
                  <Clock className="w-3.5 h-3.5 shrink-0" />
                  <span>時鐘天氣</span>
                  <span className="font-num opacity-80">1/2</span>
                </button>
                <button
                  type="button"
                  onClick={() => setCompactPage(1)}
                  aria-pressed={compactPage === 1}
                  className={`flex items-center justify-center gap-1 py-1.5 px-2 text-[length:calc(12.5px*var(--fs-ctrl))] font-black cursor-pointer whitespace-nowrap border-l-[1.5px] border-[var(--border-color)] ${
                    compactPage === 1
                      ? 'bg-[var(--surface-active)] text-[var(--fg-inverse)]'
                      : 'bg-[var(--bg-color)] text-[var(--fg-color)]'
                  }`}
                >
                  <CalendarDays className="w-3.5 h-3.5 shrink-0" />
                  <span>農曆日曆</span>
                  <span className="font-num opacity-80">2/2</span>
                  <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                </button>
              </div>
            </nav>
          </div>
        ) : isLandscape ? (
          <main className="flex-1 grid grid-cols-[1.12fr_0.88fr] gap-4 pt-3 min-h-0 overflow-hidden">
            <div className="flex flex-col justify-between pr-4 border-r-[3px] border-[var(--border-color)] min-h-0 overflow-y-auto">
              {/* 大時鐘 */}
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b-[2px] border-[var(--border-color)] pb-3">
                <div className={`${landscapeClockClass} font-black leading-[0.95] tracking-[-3px] font-num`}>
                  {timeDisplay}
                </div>
                <div className="text-right flex flex-col items-end gap-0.5 ml-auto">
                  <span
                    className={`${
                      effectiveDeviceScale === 'tablet10'
                        ? 'text-[length:calc(19px*var(--fs))]'
                        : 'text-[length:calc(15px*var(--fs))]'
                    } font-extrabold`}
                  >
                    {townPreset.name}
                  </span>
                  <span
                    className={`${
                      effectiveDeviceScale === 'tablet10'
                        ? 'text-[length:calc(15.5px*var(--fs))]'
                        : 'text-[length:calc(12.5px*var(--fs))]'
                    } font-semibold text-[var(--fg-muted)]`}
                  >
                    {todayInfo.holiday
                      ? `國定假日 · ${todayInfo.holiday}`
                      : todayInfo.solarTerm
                        ? `二十四節氣 · ${todayInfo.solarTerm}`
                        : `農曆 ${todayInfo.lunarMonthText}${todayInfo.lunarDayText}`}
                  </span>
                  <span className="text-[length:calc(12.5px*var(--fs))] font-semibold text-[var(--fg-muted)]">
                    {backlightEval.shortLabel}
                    {backlightEval.isExtremePowerSave ? ' · 30分更新' : ''}
                  </span>
                </div>
              </div>

              {/* Google 天氣風格 12 小時天氣變化 */}
              <div className="pt-3 flex-1 flex flex-col justify-end">
                <WeatherPanel
                  townName={townPreset.name}
                  weather={weather}
                  aqi={aqi}
                  loading={weatherLoading}
                  error={weatherError}
                  requiresApiKey={requiresApiKey}
                  isLandscape={true}
                  deviceScale={effectiveDeviceScale}
                  fontScale={fontScaleRatio}
                  onRefresh={fetchWeatherAndAQI}
                  onOpenSettings={openSettings}
                />
              </div>
            </div>

            {/* 右欄：農曆與國定假日月曆 / 近期日程 */}
            <div className="flex flex-col min-h-0 overflow-hidden">
              <CalendarPanel
                today={now}
                events={events}
                hasIcalUrl={Boolean(icalUrl)}
                syncStatus={syncStatus}
                isLandscape={true}
                deviceScale={effectiveDeviceScale}
                onOpenSettings={openSettings}
              />
            </div>
          </main>
        ) : (
          <main className="flex-1 flex flex-col min-h-0 overflow-y-auto">
            {/* 大時鐘 */}
            <section
              className={`text-center ${
                effectiveDeviceScale === 'phone' ? 'py-2' : 'py-3'
              } border-b-[3px] border-[var(--border-color)] shrink-0`}
            >
              <div className={`${portraitClockClass} font-black leading-[0.95] tracking-[-3px] font-num`}>
                {timeDisplay}
              </div>
            </section>

            {/* Google 天氣風格 12 小時天氣變化 */}
            <div
              className={`${
                effectiveDeviceScale === 'phone' ? 'py-2.5' : 'py-3'
              } border-b-[3px] border-[var(--border-color)] shrink-0`}
            >
              <WeatherPanel
                townName={townPreset.name}
                weather={weather}
                aqi={aqi}
                loading={weatherLoading}
                error={weatherError}
                requiresApiKey={requiresApiKey}
                isLandscape={false}
                deviceScale={effectiveDeviceScale}
                fontScale={fontScaleRatio}
                onRefresh={fetchWeatherAndAQI}
                onOpenSettings={openSettings}
              />
            </div>

            {/* 農曆與國定假日月曆 / 近期日程 */}
            <div
              className={`flex-1 ${
                effectiveDeviceScale === 'phone' ? 'pt-2 min-h-[240px]' : 'pt-3 min-h-[270px]'
              } flex flex-col`}
            >
              <CalendarPanel
                today={now}
                events={events}
                hasIcalUrl={Boolean(icalUrl)}
                syncStatus={syncStatus}
                isLandscape={false}
                deviceScale={effectiveDeviceScale}
                onOpenSettings={openSettings}
              />
            </div>
          </main>
        )}
      </div>

      {/* 設定視窗（字體大小 + 背光與省電 + 私人 API 金鑰本機儲存 + 閱讀器尺寸與地區） */}
      {isSettingsOpen && (
        <div className="fixed inset-0 bg-[var(--bg-color)] text-[var(--fg-color)] z-[100] p-4 sm:p-6 flex flex-col items-center overflow-y-auto">
          <div className="w-full max-w-[640px] my-auto flex flex-col gap-4 border-2 border-[var(--border-color)] rounded-[10px] p-5">
            <div className="flex items-center justify-between border-b-2 border-[var(--border-color)] pb-2.5">
              <h2 className="text-[length:calc(20px*var(--fs-ctrl))] font-black">看板設定</h2>
              <button type="button" onClick={fetchWeatherAndAQI} className={btnClass}>
                <RefreshCw className="w-3.5 h-3.5" />
                立即更新氣象
              </button>
            </div>

            {/* 區塊零：字體大小調整（10.3 吋等大螢幕電子紙推薦放大） */}
            <div className="flex flex-col gap-2.5 border-b border-[var(--border-subtle)] pb-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[length:calc(15px*var(--fs-ctrl))] font-black flex items-center gap-1.5">
                  <Type className="w-4 h-4 shrink-0" />
                  字體大小調整（10.3 吋大螢幕必調）
                </h3>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => stepDraftFontScale(-1)}
                    disabled={draftFontScale === FONT_SCALE_OPTIONS[0].value}
                    aria-label="縮小字體"
                    className="px-2.5 py-1 text-[length:calc(13px*var(--fs-ctrl))] font-black border-[1.5px] border-[var(--border-color)] rounded-[6px] cursor-pointer disabled:opacity-35"
                  >
                    A-
                  </button>
                  <span className="min-w-[52px] text-center text-[length:calc(14px*var(--fs-ctrl))] font-black font-num">
                    {draftFontScale}%
                  </span>
                  <button
                    type="button"
                    onClick={() => stepDraftFontScale(1)}
                    disabled={
                      draftFontScale === FONT_SCALE_OPTIONS[FONT_SCALE_OPTIONS.length - 1].value
                    }
                    aria-label="放大字體"
                    className="px-2.5 py-1 text-[length:calc(13px*var(--fs-ctrl))] font-black border-[1.5px] border-[var(--border-color)] rounded-[6px] cursor-pointer disabled:opacity-35"
                  >
                    A+
                  </button>
                </div>
              </div>

              <div
                role="group"
                aria-label="字體大小級距選擇"
                className="grid grid-cols-3 sm:grid-cols-6 border-[1.5px] border-[var(--border-color)] rounded-[6px] overflow-hidden"
              >
                {FONT_SCALE_OPTIONS.map((opt) => {
                  const active = draftFontScale === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setDraftFontScale(opt.value)}
                      aria-pressed={active}
                      className={`py-2 px-1.5 flex flex-col items-center justify-center leading-tight cursor-pointer ${
                        active
                          ? 'bg-[var(--surface-active)] text-[var(--fg-inverse)]'
                          : 'bg-[var(--bg-color)] text-[var(--fg-color)]'
                      }`}
                    >
                      <span className="text-[length:calc(13px*var(--fs-ctrl))] font-black">
                        {opt.label}
                      </span>
                      <span className="text-[length:calc(11px*var(--fs-ctrl))] font-bold font-num opacity-80">
                        {opt.short}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* 即時字體大小預覽 */}
              <div
                data-font-scale={String(draftFontScale)}
                className="flex flex-wrap items-baseline justify-between gap-2 bg-[var(--surface-subtle)] border border-[var(--border-subtle)] rounded-[8px] px-3.5 py-2.5"
              >
                <span className="text-[length:calc(28px*var(--fs))] font-black font-num leading-none">
                  {timeDisplay}
                </span>
                <span className="text-[length:calc(18px*var(--fs))] font-extrabold font-num leading-tight">
                  {weather ? `${weather.current.temp}° ${weather.current.wxText}` : '24° 多雲時晴'}
                </span>
                <span className="text-[length:calc(13.5px*var(--fs))] font-bold text-[var(--fg-muted)] leading-tight">
                  農曆 {todayInfo.lunarMonthText}
                  {todayInfo.lunarDayText} · 預覽大小
                </span>
              </div>

              <p className="text-[length:calc(12px*var(--fs-ctrl))] font-semibold text-[var(--fg-muted)] leading-[1.45]">
                10.3 吋高解析電子紙閱讀器（如 BOOX 10.3）建議選擇「大字 130%」或「特大 150%」，遠距桌面擺放可調至「超大 170%」。
              </p>
            </div>

            {/* 區塊一：背光與極致省電設定 */}
            <div className="flex flex-col gap-2.5 border-b border-[var(--border-subtle)] pb-4">
              <div className="flex items-center justify-between">
                <h3 className="text-[15px] font-black flex items-center gap-1.5">
                  <SunDim className="w-4 h-4" />
                  背光與省電模式（具前光之電子紙適用）
                </h3>
                <span className="text-[12px] font-bold font-num text-[var(--fg-muted)]">
                  {draftBacklightPreview.shortLabel}
                </span>
              </div>

              <div
                role="group"
                aria-label="背光模式選擇"
                className="grid grid-cols-2 sm:grid-cols-4 border-[1.5px] border-[var(--border-color)] rounded-[6px] overflow-hidden"
              >
                {(
                  [
                    { id: 'off', label: '極致省電 0%' },
                    { id: 'night', label: '夜晚部分背光' },
                    { id: 'manual', label: '手動固定亮度' },
                    { id: 'system', label: '跟隨系統' },
                  ] as const
                ).map((opt) => {
                  const active = draftBacklight.mode === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() =>
                        setDraftBacklight((prev) => ({ ...prev, mode: opt.id }))
                      }
                      className={`py-2 px-2 text-[12px] font-extrabold cursor-pointer whitespace-nowrap ${
                        active
                          ? 'bg-[var(--surface-active)] text-[var(--fg-inverse)]'
                          : 'bg-[var(--bg-color)] text-[var(--fg-color)]'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>

              <p className="text-[12px] font-semibold text-[var(--fg-muted)] leading-[1.45]">
                {draftBacklightPreview.detailLabel}
              </p>

              {/* 夜晚部分背光細部調整 */}
              {draftBacklight.mode === 'night' && (
                <div className="flex flex-col gap-2.5 bg-[var(--surface-subtle)] border border-[var(--border-subtle)] rounded-[8px] p-3">
                  <div className="flex items-center justify-between text-[13px] font-bold">
                    <label htmlFor="night-level-slider">夜晚背光強度</label>
                    <span className="font-num font-black">{draftBacklight.nightLevel}%</span>
                  </div>
                  <input
                    id="night-level-slider"
                    type="range"
                    min={5}
                    max={80}
                    step={1}
                    value={draftBacklight.nightLevel}
                    onChange={(e) =>
                      setDraftBacklight((prev) => ({
                        ...prev,
                        nightLevel: Number(e.target.value),
                      }))
                    }
                    className="w-full accent-[var(--fg-color)] cursor-pointer"
                  />

                  <label className="flex items-center gap-2 text-[12px] font-bold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={draftBacklight.followSunTimes}
                      onChange={(e) =>
                        setDraftBacklight((prev) => ({
                          ...prev,
                          followSunTimes: e.target.checked,
                        }))
                      }
                      className="w-4 h-4 accent-[var(--fg-color)]"
                    />
                    <span>
                      自動依中央氣象署日落／日出時間切換（
                      {weather?.today.sunset && weather.today.sunset !== '--:--'
                        ? `今日 ${weather.today.sunset} ～ 明日 ${weather.today.sunrise}`
                        : '無日出日落資料時套用下方自訂時段'}
                      ）
                    </span>
                  </label>

                  <div className="flex items-center gap-2 text-[12px] font-bold">
                    <span>備用夜間時段：</span>
                    <select
                      aria-label="夜間開始小時"
                      value={draftBacklight.nightStartHour}
                      onChange={(e) =>
                        setDraftBacklight((prev) => ({
                          ...prev,
                          nightStartHour: Number(e.target.value),
                        }))
                      }
                      className="px-2 py-1 border border-[var(--border-color)] rounded bg-[var(--bg-color)] text-[var(--fg-color)] font-num"
                    >
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={h}>
                          {String(h).padStart(2, '0')}:00
                        </option>
                      ))}
                    </select>
                    <span>～</span>
                    <select
                      aria-label="夜間結束小時"
                      value={draftBacklight.nightEndHour}
                      onChange={(e) =>
                        setDraftBacklight((prev) => ({
                          ...prev,
                          nightEndHour: Number(e.target.value),
                        }))
                      }
                      className="px-2 py-1 border border-[var(--border-color)] rounded bg-[var(--bg-color)] text-[var(--fg-color)] font-num"
                    >
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={h}>
                          {String(h).padStart(2, '0')}:00
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {/* 手動固定亮度滑桿 */}
              {draftBacklight.mode === 'manual' && (
                <div className="flex flex-col gap-2 bg-[var(--surface-subtle)] border border-[var(--border-subtle)] rounded-[8px] p-3">
                  <div className="flex items-center justify-between text-[13px] font-bold">
                    <label htmlFor="manual-level-slider">固定前光亮度</label>
                    <span className="font-num font-black">{draftBacklight.manualLevel}%</span>
                  </div>
                  <input
                    id="manual-level-slider"
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={draftBacklight.manualLevel}
                    onChange={(e) =>
                      setDraftBacklight((prev) => ({
                        ...prev,
                        manualLevel: Number(e.target.value),
                      }))
                    }
                    className="w-full accent-[var(--fg-color)] cursor-pointer"
                  />
                </div>
              )}
            </div>

            {/* 區塊二：個人 API 金鑰與私密網址（僅存於本機，絕不打包進程式碼或 APK） */}
            <div className="flex flex-col gap-3 border-b border-[var(--border-subtle)] pb-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[15px] font-black flex items-center gap-1.5">
                  <KeyRound className="w-4 h-4" />
                  API 金鑰與個人資料來源
                </h3>
                <span className="text-[11px] font-bold text-[var(--fg-muted)]">
                  僅存本機 · 不打包進 APK
                </span>
              </div>

              {/* 中央氣象署 OpenData API Key（單一金鑰整合天氣預報與空氣品質） */}
              <div className="flex flex-col gap-1">
                <label htmlFor="cwa-key-input" className="text-[13px] font-extrabold">
                  台灣中央氣象署 API Key（單一授權碼，整合天氣與空品）：
                </label>
                <div className="flex gap-1.5">
                  <input
                    id="cwa-key-input"
                    type={showCwaKey ? 'text' : 'password'}
                    value={draftCwaApiKey}
                    onChange={(e) => setDraftCwaApiKey(e.target.value)}
                    placeholder="CWA-XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
                    autoComplete="off"
                    className="flex-1 p-2 text-[13px] font-mono-num border-2 border-[var(--border-color)] rounded-[6px] bg-[var(--bg-color)] text-[var(--fg-color)]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCwaKey((v) => !v)}
                    aria-label={showCwaKey ? '隱藏金鑰' : '顯示金鑰'}
                    className={btnClass}
                  >
                    {showCwaKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-[11px] text-[var(--fg-muted)] leading-[1.4]">
                  前往 opendata.cwa.gov.tw 免費註冊取得授權碼；只需填寫此一組金鑰，即可串接官方鄉鎮預報與開放鏈結空氣品質資料。
                </p>
              </div>

              {/* 嚴格個人金鑰模式 */}
              <label className="flex items-center gap-2 text-[12px] font-bold cursor-pointer">
                <input
                  type="checkbox"
                  checked={draftStrictKey}
                  onChange={(e) => setDraftStrictKey(e.target.checked)}
                  className="w-4 h-4 accent-[var(--fg-color)]"
                />
                <span>嚴格 API Key 模式（未輸入個人金鑰時不自動改用免金鑰公開資料）</span>
              </label>

              {/* Google 日曆 iCal URL */}
              <div className="flex flex-col gap-1">
                <label htmlFor="ical-input" className="text-[13px] font-extrabold">
                  Google 日曆「iCal 格式的秘密網址 (.ics)」：
                </label>
                <input
                  id="ical-input"
                  type="text"
                  value={draftIcalUrl}
                  onChange={(e) => setDraftIcalUrl(e.target.value)}
                  placeholder="https://calendar.google.com/calendar/ical/..."
                  className="w-full p-2 text-[13px] border-2 border-[var(--border-color)] rounded-[6px] bg-[var(--bg-color)] text-[var(--fg-color)]"
                />
              </div>
            </div>

            {/* 區塊三：閱讀器尺寸、顯示方向與天氣地區 */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 border-b border-[var(--border-subtle)] pb-4">
              <div className="flex flex-col gap-1">
                <label htmlFor="device-profile-select" className="text-[13px] font-extrabold">
                  閱讀器尺寸適配：
                </label>
                <select
                  id="device-profile-select"
                  value={draftDeviceProfile}
                  onChange={(e) => setDraftDeviceProfile(e.target.value as DeviceProfileMode)}
                  className="w-full p-2 text-[13px] font-bold border-2 border-[var(--border-color)] rounded-[6px] bg-[var(--bg-color)] text-[var(--fg-color)]"
                >
                  <option value="auto">自動偵測（推薦）</option>
                  <option value="compact4">4.3 吋（閱星瞳 XTEINK X4・雙頁）</option>
                  <option value="phone">手機型（Viwoods）</option>
                  <option value="reader6">6 吋電子紙閱讀器</option>
                  <option value="tablet10">10.3 吋（BOOX）</option>
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="orientation-select" className="text-[13px] font-extrabold">
                  直橫顯示方向：
                </label>
                <select
                  id="orientation-select"
                  value={draftOrientationMode}
                  onChange={(e) => setDraftOrientationMode(e.target.value as OrientationMode)}
                  className="w-full p-2 text-[13px] font-bold border-2 border-[var(--border-color)] rounded-[6px] bg-[var(--bg-color)] text-[var(--fg-color)]"
                >
                  <option value="auto">自動偵測</option>
                  <option value="portrait">直向顯示</option>
                  <option value="landscape">橫向顯示</option>
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="town-select" className="text-[13px] font-extrabold">
                  天氣地區（中央氣象署）：
                </label>
                <select
                  id="town-select"
                  value={draftTownId}
                  onChange={(e) => setDraftTownId(e.target.value)}
                  className="w-full p-2 text-[13px] font-bold border-2 border-[var(--border-color)] rounded-[6px] bg-[var(--bg-color)] text-[var(--fg-color)]"
                >
                  {TAIWAN_TOWN_PRESETS.map((town) => (
                    <option key={town.id} value={town.id}>
                      {town.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* 區塊四：電子紙專用簡易使用說明 */}
            <div className="flex flex-col gap-2 bg-[var(--surface-subtle)] border border-[var(--border-subtle)] rounded-[8px] p-3.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[14px] font-black flex items-center gap-1.5">
                  <BookOpen className="w-4 h-4 shrink-0" />
                  簡易使用說明（電子紙閱讀器專用）
                </h3>
                <span className="text-[11px] font-extrabold text-[var(--fg-muted)] whitespace-nowrap">
                  E-Ink 專用版
                </span>
              </div>
              <ol className="list-decimal pl-4 flex flex-col gap-1.5 text-[12px] leading-[1.5] font-semibold">
                <li>
                  <span className="font-extrabold">尺寸、雙頁切換與字體大小：</span>
                  支援 4.3 吋（閱星瞳 XTEINK X4）、6 吋原生閱讀器、10.3 吋黑白（如 BOOX 10.3）及手機型閱讀器（如 Viwoods AiPaper）。其中 4.3 吋採雙頁排版（第 1 頁時鐘天氣、第 2 頁農曆日曆），可透過「左右滑動」、「底部切換按鈕」或「實體翻頁鍵／音量鍵／方向鍵」切換；字體大小可在設定最上方調整 85%～170%（10.3 吋建議 130%～150%）。
                </li>
                <li>
                  <span className="font-extrabold">電子紙防殘影：</span>
                  每逢整點（00 分）與半點（30 分）自動全螢幕黑白刷新清除殘影，亦可隨時點擊頂部「清殘影」或切換「淺色／深色」反白顯示。
                </li>
                <li>
                  <span className="font-extrabold">背光與極致省電：</span>
                  「極致省電 0%」可完全關閉前光並降頻為每 30 分鐘同步；具前光機型可選「夜晚部分背光」依日落／日出自動微亮，無背光機型會安全略過前光指令。
                </li>
                <li>
                  <span className="font-extrabold">單一 API Key 與隱私：</span>
                  只需填入一組免費申請的「中央氣象署 OpenData 授權碼」即可同時使用氣象預報與空品；金鑰與 Google 日曆 .ics 網址皆僅存於本機閱讀器，絕不打包進程式碼或 APK。
                </li>
                <li>
                  <span className="font-extrabold">Android APK 獨立運作：</span>
                  安裝為電子紙 APK 後，啟動與喚醒時會自動啟用螢幕常亮（不休眠）與沉浸式全螢幕；農曆、二十四節氣與台灣國定假日支援離線顯示。
                </li>
              </ol>
            </div>

            <div className="flex gap-2.5 pt-1">
              <button
                type="button"
                onClick={saveSettings}
                className="flex-1 py-2.5 text-[14px] font-extrabold border-2 border-[var(--border-color)] rounded-[6px] bg-[var(--surface-active)] text-[var(--fg-inverse)] cursor-pointer"
              >
                儲存並套用
              </button>
              <button
                type="button"
                onClick={() => setIsSettingsOpen(false)}
                className="px-5 py-2.5 text-[14px] font-extrabold border-2 border-[var(--border-color)] rounded-[6px] bg-[var(--bg-color)] text-[var(--fg-color)] cursor-pointer"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
