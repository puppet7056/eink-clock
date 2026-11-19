import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findTownPreset,
  type AqiPayload,
  type CwaWeatherPayload,
} from './src/types/weather.ts';
import {
  fetchCwaLinkedAqi,
  getCwaCountyCode,
  parseCwaObservation,
  parseCwaOpenDataJson,
  parseCwaTownHtml,
} from './src/utils/cwaParser.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const CWA_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Referer: 'https://www.cwa.gov.tw/V8/C/W/Town/Town.html',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
};

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cwaCache = new Map<string, CacheEntry<CwaWeatherPayload>>();
const aqiCache = new Map<string, CacheEntry<AqiPayload>>();

async function fetchCwaPublicWeather(townId: string): Promise<CwaWeatherPayload> {
  const cacheKey = `public:${townId}`;
  const cached = cwaCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const countyCode = getCwaCountyCode(townId);
  const forecastUrl = `https://www.cwa.gov.tw/V8/C/W/Town/MOD/3hr/${townId}_3hr_PC.html`;
  const obsUrl = `https://www.cwa.gov.tw/Data/js/GT/TableData_GT_T_${countyCode}.js`;

  const [forecastRes, obsRes] = await Promise.all([
    fetch(forecastUrl, { headers: CWA_HEADERS }),
    fetch(obsUrl, { headers: CWA_HEADERS }).catch(() => null),
  ]);

  if (!forecastRes.ok) {
    throw new Error(`CWA forecast HTTP ${forecastRes.status}`);
  }

  const forecastHtml = await forecastRes.text();
  const obsJs = obsRes && obsRes.ok ? await obsRes.text() : '';
  const payload = parseCwaTownHtml(townId, forecastHtml, obsJs);

  cwaCache.set(cacheKey, { data: payload, expiresAt: Date.now() + 5 * 60 * 1000 });
  return payload;
}

async function fetchCwaOpenDataWeather(
  townId: string,
  apiKey: string
): Promise<CwaWeatherPayload> {
  const preset = findTownPreset(townId);
  const cacheKey = `opendata:${townId}:${apiKey.slice(-6)}`;
  const cached = cwaCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const openDataUrl = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/${preset.cwaDatasetId}?Authorization=${encodeURIComponent(
    apiKey
  )}&LocationName=${encodeURIComponent(preset.districtName)}`;

  const countyCode = getCwaCountyCode(townId);
  const obsUrl = `https://www.cwa.gov.tw/Data/js/GT/TableData_GT_T_${countyCode}.js`;

  const [res, obsRes] = await Promise.all([
    fetch(openDataUrl, { headers: { Accept: 'application/json' } }),
    fetch(obsUrl, { headers: CWA_HEADERS }).catch(() => null),
  ]);

  if (res.status === 401 || res.status === 403) {
    throw new Error('INVALID_CWA_KEY');
  }
  if (!res.ok) {
    throw new Error(`中央氣象署 OpenData HTTP ${res.status}`);
  }

  const json = await res.json();
  const obsJs = obsRes && obsRes.ok ? await obsRes.text() : '';
  const obs = obsJs ? parseCwaObservation(obsJs, townId) : null;
  const payload = parseCwaOpenDataJson(
    townId,
    preset.districtName,
    json,
    obs ? { sunrise: obs.sunrise, sunset: obs.sunset } : undefined
  );

  cwaCache.set(cacheKey, { data: payload, expiresAt: Date.now() + 5 * 60 * 1000 });
  return payload;
}

async function startServer() {
  const app = express();

  // Harmless stub for Cordova runtime script when previewing in a standard web browser
  app.get('/cordova.js', (_req, res) => {
    res.type('application/javascript').send('// Cordova runtime is injected only inside APK builds.\n');
  });

  app.get('/api/weather/cwa', async (req, res) => {
    const rawTownId = typeof req.query.townId === 'string' ? req.query.townId.trim() : '6801000';
    const townId = /^\d{7}$/.test(rawTownId) ? rawTownId : '6801000';
    const strictKey = req.query.strictKey === 'true';

    // Never hardcode private API keys: use user-provided header key or runtime environment variable
    const headerKey =
      typeof req.headers['x-cwa-api-key'] === 'string' ? req.headers['x-cwa-api-key'].trim() : '';
    const apiKey = headerKey || (process.env.CWA_API_KEY || '').trim();

    if (apiKey) {
      try {
        const data = await fetchCwaOpenDataWeather(townId, apiKey);
        res.json(data);
        return;
      } catch (err) {
        if (err instanceof Error && err.message === 'INVALID_CWA_KEY') {
          res.status(401).json({
            requiresApiKey: true,
            error: '中央氣象署 OpenData API Key 無效或已過期，請於設定中重新確認。',
          });
          return;
        }
        if (strictKey) {
          res.status(502).json({
            error: err instanceof Error ? err.message : '中央氣象署 OpenData 連線失敗',
          });
          return;
        }
        // If not strict mode, fall through to public town forecast
      }
    } else if (strictKey) {
      res.status(401).json({
        requiresApiKey: true,
        error: '已啟用個人 API Key 模式，請先於右上角「設定」輸入您的中央氣象署 OpenData 授權碼。',
      });
      return;
    }

    try {
      const data = await fetchCwaPublicWeather(townId);
      res.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown CWA fetch error';
      res.status(502).json({ error: '無法取得中央氣象署資料', detail: message });
    }
  });

  app.get('/api/aqi', async (req, res) => {
    const rawTownId = typeof req.query.townId === 'string' ? req.query.townId.trim() : '6801000';
    const preset = findTownPreset(rawTownId);
    const lat = Number(req.query.lat) || preset.lat;
    const lon = Number(req.query.lon) || preset.lon;

    // Reuse the single CWA API Key for CWA Linked Open Data AQI query
    const headerKey =
      typeof req.headers['x-cwa-api-key'] === 'string' ? req.headers['x-cwa-api-key'].trim() : '';
    const cwaKey = headerKey || (process.env.CWA_API_KEY || '').trim();

    if (cwaKey) {
      const linkedCacheKey = `cwa-aqi:${lat.toFixed(2)},${lon.toFixed(2)}:${cwaKey.slice(-6)}`;
      const cached = aqiCache.get(linkedCacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        res.json(cached.data);
        return;
      }
      const linkedData = await fetchCwaLinkedAqi(lat, lon, cwaKey);
      if (linkedData) {
        aqiCache.set(linkedCacheKey, { data: linkedData, expiresAt: Date.now() + 10 * 60 * 1000 });
        res.json(linkedData);
        return;
      }
    }

    const key = `om:${lat.toFixed(2)},${lon.toFixed(2)}`;
    const cached = aqiCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      res.json(cached.data);
      return;
    }

    try {
      const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi,pm2_5,pm10&timezone=Asia%2FTaipei`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`AQI HTTP ${r.status}`);
      const json = (await r.json()) as {
        current?: { us_aqi?: number; pm2_5?: number; pm10?: number };
      };
      const data: AqiPayload = {
        usAqi: Math.round(json.current?.us_aqi ?? 0),
        pm25: Math.round(json.current?.pm2_5 ?? 0),
        pm10: Math.round(json.current?.pm10 ?? 0),
        source: 'US AQI',
      };
      aqiCache.set(key, { data, expiresAt: Date.now() + 10 * 60 * 1000 });
      res.json(data);
    } catch {
      res.status(502).json({ error: '無法取得空氣品質資料' });
    }
  });

  app.get('/api/ical', async (req, res) => {
    const rawInput = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!rawInput) {
      res.status(400).json({ error: '缺少 iCal 網址' });
      return;
    }

    const normalizedUrl = rawInput.replace(/^webcals?:\/\//i, 'https://');

    try {
      const parsed = new URL(normalizedUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        res.status(400).json({ error: '無效的網址協定，請貼上 https:// 開頭的 .ics 網址' });
        return;
      }
      if (
        parsed.hostname.includes('calendar.google.com') &&
        /\/calendar\/(embed|u\/|r\b)/i.test(parsed.pathname)
      ) {
        res.status(400).json({
          error:
            '這是 Google 日曆網頁／嵌入連結，非 iCal 檔案。請至電腦版 Google 日曆「設定和共用 → 整合日曆」複製「iCal 格式的秘密網址」（結尾為 basic.ics）。',
        });
        return;
      }

      const r = await fetch(parsed.toString(), {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; EInkDashboard/1.0)',
          Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.8',
        },
      });

      if (r.status === 404) {
        res.status(404).json({
          error:
            'Google 日曆回傳 404（找不到日曆）：若複製的是「公開網址」，請先勾選公開，或改貼上「iCal 格式的秘密網址」（含 private-.../basic.ics）。',
        });
        return;
      }
      if (r.status === 401 || r.status === 403) {
        res.status(r.status).json({
          error: `無權限存取此日曆 (HTTP ${r.status})，請改用 Google 日曆「iCal 格式的秘密網址 (.ics)」。`,
        });
        return;
      }
      if (!r.ok) {
        res.status(502).json({ error: `無法取得日曆資料 (HTTP ${r.status})` });
        return;
      }

      const text = await r.text();
      if (!text.includes('BEGIN:VCALENDAR')) {
        res.status(422).json({
          error:
            '取得的內容為網頁而非 .ics 檔，請確認複製的是 Google 日曆「iCal 格式的秘密網址」（結尾為 basic.ics），而非網頁連結。',
        });
        return;
      }

      res.type('text/calendar; charset=utf-8').send(text);
    } catch (err) {
      const detail = err instanceof Error ? err.message : '連線失敗';
      res.status(502).json({ error: `日曆同步連線失敗：${detail}` });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`E-Ink dashboard server listening on http://localhost:${PORT}`);
  });
}

startServer();
