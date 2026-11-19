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
    const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!rawUrl) {
      res.status(400).json({ error: '缺少 iCal 網址' });
      return;
    }

    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        res.status(400).json({ error: '無效的網址協定' });
        return;
      }
      const r = await fetch(parsed.toString(), {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!r.ok) throw new Error(`iCal HTTP ${r.status}`);
      const text = await r.text();
      res.type('text/calendar; charset=utf-8').send(text);
    } catch {
      res.status(502).json({ error: '日曆同步失敗' });
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
