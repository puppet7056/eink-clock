import type { CwaWeatherPayload, HourlyForecastItem } from '../types/weather';

export function getCwaCountyCode(townId: string): string {
  // 63=台北, 64=高雄, 65=新北, 66=台中, 67=台南, 68=桃園 -> 2-digit county code
  if (/^6[3-8]/.test(townId)) {
    return townId.slice(0, 2);
  }
  // 100xx / 090xx -> 5-digit county code
  return townId.slice(0, 5);
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function expandRowCells(rowHtml: string): string[] {
  const cells: string[] = [];
  const regex = /<td([^>]*)>([\s\S]*?)<\/td>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(rowHtml)) !== null) {
    const attrs = match[1] || '';
    const inner = match[2] || '';
    const colspanMatch = attrs.match(/colspan=["']?(\d+)["']?/i);
    const span = colspanMatch ? Math.max(1, parseInt(colspanMatch[1], 10)) : 1;
    for (let i = 0; i < span; i++) {
      cells.push(inner);
    }
  }
  return cells;
}

function expandDateHeaders(rowHtml: string): string[] {
  const dates: string[] = [];
  const regex = /<th([^>]*)>([\s\S]*?)<\/th>/gi;
  let match: RegExpExecArray | null;
  let idx = 0;
  while ((match = regex.exec(rowHtml)) !== null) {
    idx++;
    if (idx === 1) continue;
    const attrs = match[1] || '';
    const inner = match[2] || '';
    const colspanMatch = attrs.match(/colspan=["']?(\d+)["']?/i);
    const span = colspanMatch ? Math.max(1, parseInt(colspanMatch[1], 10)) : 1;
    const dateMatch = inner.match(/(\d{1,2}\/\d{1,2})/);
    const label = dateMatch ? dateMatch[1] : stripTags(inner);
    for (let i = 0; i < span; i++) {
      dates.push(label);
    }
  }
  return dates;
}

function parseTimeHeaders(rowHtml: string): string[] {
  const times: string[] = [];
  const regex = /<th([^>]*)>([\s\S]*?)<\/th>/gi;
  let match: RegExpExecArray | null;
  let idx = 0;
  while ((match = regex.exec(rowHtml)) !== null) {
    idx++;
    if (idx === 1) continue;
    const text = stripTags(match[1] || '');
    const tMatch = text.match(/(\d{2}:\d{2})/);
    times.push(tMatch ? tMatch[1] : text);
  }
  return times;
}

function extractTempC(cellHtml: string): number {
  const cMatch = cellHtml.match(/class="[^"]*tem-C[^"]*"[^>]*>(-?\d+(?:\.\d+)?)/i);
  if (cMatch) return Math.round(parseFloat(cMatch[1]));
  const numMatch = stripTags(cellHtml).match(/-?\d+/);
  return numMatch ? parseInt(numMatch[0], 10) : 0;
}

function extractNumber(cellHtml: string): number {
  const numMatch = stripTags(cellHtml).match(/-?\d+(?:\.\d+)?/);
  return numMatch ? parseFloat(numMatch[0]) : 0;
}

function extractWxInfo(cellHtml: string): { text: string; code: string; isNight: boolean } {
  const titleMatch = cellHtml.match(/title="([^"]+)"/i);
  const altMatch = cellHtml.match(/alt="[^"]*?([^，,"]+)"/i);
  const srcMatch = cellHtml.match(/\/(day|night)\/(\d+)\.svg/i);
  return {
    text: titleMatch ? titleMatch[1].trim() : altMatch ? altMatch[1].trim() : '多雲',
    code: srcMatch ? srcMatch[2].padStart(2, '0') : '04',
    isNight: srcMatch ? srcMatch[1].toLowerCase() === 'night' : false,
  };
}

export function parseCwaObservation(jsText: string, townId: string) {
  const townRegex = new RegExp(`['"]${townId}['"]\\s*:\\s*\\{([^}]+)\\}`);
  const match = jsText.match(townRegex);
  if (!match) return null;

  const block = match[1];
  const getField = (key: string): string | null => {
    const r = new RegExp(`['"]${key}['"]\\s*:\\s*['"]([^'"]*)['"]`);
    const m = block.match(r);
    return m ? m[1] : null;
  };

  const cT = parseFloat(getField('C_T') || '');
  const cAT = parseFloat(getField('C_AT') || '');
  const rh = parseFloat(getField('RH') || '');
  const rain = parseFloat(getField('Rain') || '');

  return {
    temp: Number.isNaN(cT) ? null : Math.round(cT),
    feelsLike: Number.isNaN(cAT) ? null : Math.round(cAT),
    humidity: Number.isNaN(rh) ? null : Math.round(rh),
    rainMm: Number.isNaN(rain) ? 0 : rain,
    sunrise: getField('Sunrise') || '--:--',
    sunset: getField('Sunset') || '--:--',
  };
}

export function parseCwaTownHtml(
  townId: string,
  forecastHtml: string,
  obsJs = ''
): CwaWeatherPayload {
  const obs = obsJs ? parseCwaObservation(obsJs, townId) : null;

  const rows = [...forecastHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
  const findRowById = (id: string) =>
    rows.find((r) => r.includes(`id="${id}"`) || r.includes(`id='${id}'`)) || '';

  const dates = expandDateHeaders(findRowById('PC3_D'));
  const times = parseTimeHeaders(findRowById('PC3_Ti'));
  const temps = expandRowCells(findRowById('PC3_T')).map(extractTempC);
  const feels = expandRowCells(findRowById('PC3_AT')).map(extractTempC);
  const hums = expandRowCells(findRowById('PC3_RH')).map((c) => Math.round(extractNumber(c)));
  const wxs = expandRowCells(findRowById('PC3_Wx')).map(extractWxInfo);
  const pops = expandRowCells(findRowById('PC3_Po')).map((c) => Math.round(extractNumber(c)));
  const bfs = expandRowCells(findRowById('PC3_BF')).map((c) => Math.round(extractNumber(c)));
  const windMs = expandRowCells(findRowById('PC3_MS')).map((c) => Math.round(extractNumber(c)));
  const windDirs = expandRowCells(findRowById('PC3_WD')).map(stripTags);
  const comforts = expandRowCells(findRowById('PC3_CI')).map(stripTags);

  const count = Math.min(times.length, temps.length);
  if (count === 0) {
    throw new Error('CWA forecast table returned empty rows');
  }

  const allSlots: HourlyForecastItem[] = [];
  for (let i = 0; i < count; i++) {
    const timeLabel = times[i] || '00:00';
    const hour = parseInt(timeLabel.split(':')[0] || '0', 10);
    const wx = wxs[i] || { text: '多雲', code: '04', isNight: hour < 6 || hour >= 18 };
    allSlots.push({
      dateLabel: dates[i] || '',
      timeLabel,
      hour,
      temp: temps[i] ?? 20,
      feelsLike: feels[i] ?? temps[i] ?? 20,
      humidity: hums[i] ?? 70,
      wxText: wx.text,
      wxCode: wx.code,
      isNight: wx.isNight,
      pop: pops[i] ?? 0,
      windSpeed: windMs[i] ?? 0,
      windBeaufort: bfs[i] ?? 0,
      windDir: windDirs[i] || '',
      comfort: comforts[i] || '',
    });
  }

  const hourly12 = allSlots.slice(0, 12);
  const window24 = allSlots.slice(0, Math.min(24, allSlots.length));
  const firstSlot = hourly12[0];

  const allTempsForRange = window24.map((s) => s.temp);
  if (obs?.temp !== null && obs?.temp !== undefined) {
    allTempsForRange.push(obs.temp);
  }

  return {
    townId,
    source: '中央氣象署公開預報',
    apiMode: 'public',
    updatedAt: new Date().toISOString(),
    current: {
      temp: obs?.temp ?? firstSlot.temp,
      feelsLike: obs?.feelsLike ?? firstSlot.feelsLike,
      humidity: obs?.humidity ?? firstSlot.humidity,
      rainMm: obs?.rainMm ?? 0,
      wxText: firstSlot.wxText,
      wxCode: firstSlot.wxCode,
      isNight: firstSlot.isNight,
      pop: firstSlot.pop,
      windSpeed: firstSlot.windSpeed,
      windBeaufort: firstSlot.windBeaufort,
      windDir: firstSlot.windDir,
      comfort: firstSlot.comfort,
    },
    today: {
      tempMax: Math.max(...allTempsForRange),
      tempMin: Math.min(...allTempsForRange),
      sunrise: obs?.sunrise || '--:--',
      sunset: obs?.sunset || '--:--',
    },
    hourly: hourly12,
  };
}

// Parse official CWA OpenData REST API JSON (F-D0047-xxx) using user-supplied Authorization API Key
interface RawElementTime {
  DataTime?: string;
  StartTime?: string;
  EndTime?: string;
  dataTime?: string;
  startTime?: string;
  endTime?: string;
  ElementValue?: Array<Record<string, string>>;
  elementValue?: Array<Record<string, string>>;
}

interface RawWeatherElement {
  ElementName?: string;
  elementName?: string;
  Time?: RawElementTime[];
  time?: RawElementTime[];
}

function getTimePointMs(t: RawElementTime): number {
  const s = t.DataTime || t.StartTime || t.dataTime || t.startTime || '';
  const parsed = Date.parse(s.replace(' ', 'T'));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function getTimeRangeEndMs(t: RawElementTime): number {
  const s = t.EndTime || t.endTime || '';
  const parsed = Date.parse(s.replace(' ', 'T'));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function findElementEntryAt(
  times: RawElementTime[] | undefined,
  targetMs: number
): Record<string, string> | null {
  if (!times || times.length === 0) return null;

  // Prefer range match (StartTime <= targetMs < EndTime)
  for (const t of times) {
    const start = getTimePointMs(t);
    const end = getTimeRangeEndMs(t);
    if (start > 0 && end > 0 && targetMs >= start && targetMs < end) {
      const vals = t.ElementValue || t.elementValue;
      return vals && vals[0] ? vals[0] : null;
    }
  }

  // Otherwise pick closest timestamp
  let best = times[0];
  let bestDiff = Math.abs(getTimePointMs(best) - targetMs);
  for (const t of times) {
    const diff = Math.abs(getTimePointMs(t) - targetMs);
    if (diff < bestDiff) {
      best = t;
      bestDiff = diff;
    }
  }
  const vals = best.ElementValue || best.elementValue;
  return vals && vals[0] ? vals[0] : null;
}

function readFirstNumeric(obj: Record<string, string> | null, keys: string[], fallback = 0): number {
  if (!obj) return fallback;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== '') {
      const n = parseFloat(obj[k]);
      if (!Number.isNaN(n)) return Math.round(n);
    }
  }
  const firstVal = Object.values(obj)[0];
  const parsed = firstVal ? parseFloat(firstVal) : NaN;
  return Number.isNaN(parsed) ? fallback : Math.round(parsed);
}

function readFirstText(obj: Record<string, string> | null, keys: string[], fallback = ''): string {
  if (!obj) return fallback;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== '') return String(obj[k]).trim();
  }
  const firstVal = Object.values(obj)[0];
  return firstVal ? String(firstVal).trim() : fallback;
}

export function parseCwaOpenDataJson(
  townId: string,
  districtName: string,
  rawJson: unknown,
  sunTimes?: { sunrise: string; sunset: string }
): CwaWeatherPayload {
  interface RawLocationGroup {
    Location?: Array<Record<string, unknown>>;
    location?: Array<Record<string, unknown>>;
  }
  const root = rawJson as {
    records?: {
      Locations?: RawLocationGroup[];
      locations?: RawLocationGroup[];
    };
  };

  const groups: RawLocationGroup[] = root?.records?.Locations || root?.records?.locations || [];
  const locations: Array<Record<string, unknown>> =
    groups[0]?.Location || groups[0]?.location || [];
  const loc =
    locations.find(
      (item) =>
        item.LocationName === districtName ||
        item.locationName === districtName ||
        item.Geocode === townId ||
        item.geocode === townId
    ) || locations[0];

  if (!loc) {
    throw new Error(`找不到「${districtName}」的中央氣象署 OpenData 資料`);
  }

  const elements = (loc.WeatherElement || loc.weatherElement || []) as RawWeatherElement[];
  const getEl = (names: string[]): RawElementTime[] => {
    const found = elements.find((e) => {
      const n = e.ElementName || e.elementName || '';
      return names.includes(n);
    });
    return found?.Time || found?.time || [];
  };

  const tempTimes = getEl(['溫度', 'T']);
  const atTimes = getEl(['體感溫度', 'AT']);
  const rhTimes = getEl(['相對濕度', 'RH']);
  const wxTimes = getEl(['天氣現象', 'Wx']);
  const popTimes = getEl(['3小時降雨機率', '6小時降雨機率', 'PoP6h', 'PoP3h', 'PoP12h']);
  const wsTimes = getEl(['風速', 'WS']);
  const wdTimes = getEl(['風向', 'WD']);
  const ciTimes = getEl(['舒適度指數', 'CI']);

  if (tempTimes.length === 0) {
    throw new Error('中央氣象署 OpenData 缺少溫度時序資料');
  }

  const nowMs = Date.now();
  const futureTempTimes = tempTimes.filter((t) => getTimePointMs(t) >= nowMs - 60 * 60 * 1000);
  const baseTempTimes = futureTempTimes.length >= 6 ? futureTempTimes : tempTimes;

  const allSlots: HourlyForecastItem[] = baseTempTimes.slice(0, 24).map((t) => {
    const ms = getTimePointMs(t);
    const d = new Date(ms || Date.now());
    // Convert to Asia/Taipei (UTC+8) cleanly
    const tw = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60 * 1000);
    const hour = tw.getHours();
    const dateLabel = `${tw.getMonth() + 1}/${tw.getDate()}`;
    const timeLabel = `${String(hour).padStart(2, '0')}:00`;
    const isNight = hour < 6 || hour >= 18;

    const tVal = (t.ElementValue || t.elementValue || [])[0] || null;
    const atVal = findElementEntryAt(atTimes, ms);
    const rhVal = findElementEntryAt(rhTimes, ms);
    const wxVal = findElementEntryAt(wxTimes, ms);
    const popVal = findElementEntryAt(popTimes, ms);
    const wsVal = findElementEntryAt(wsTimes, ms);
    const wdVal = findElementEntryAt(wdTimes, ms);
    const ciVal = findElementEntryAt(ciTimes, ms);

    const temp = readFirstNumeric(tVal, ['Temperature', 'value'], 20);
    const feelsLike = readFirstNumeric(atVal, ['ApparentTemperature', 'value'], temp);
    const humidity = readFirstNumeric(rhVal, ['RelativeHumidity', 'value'], 70);
    const pop = readFirstNumeric(popVal, ['ProbabilityOfPrecipitation', 'value'], 0);
    const windSpeed = readFirstNumeric(wsVal, ['WindSpeed', 'value'], 0);
    const windBeaufort = readFirstNumeric(wsVal, ['BeaufortScale'], 0);
    const windDir = readFirstText(wdVal, ['WindDirection', 'value'], '');
    const wxText = readFirstText(wxVal, ['Weather', 'value'], '多雲');
    const wxCode = readFirstText(wxVal, ['WeatherCode'], '04').padStart(2, '0');
    const comfort = readFirstText(ciVal, ['ComfortIndexDescription', 'value'], '');

    return {
      dateLabel,
      timeLabel,
      hour,
      temp,
      feelsLike,
      humidity,
      wxText,
      wxCode,
      isNight,
      pop,
      windSpeed,
      windBeaufort,
      windDir,
      comfort,
    };
  });

  const hourly12 = allSlots.slice(0, 12);
  const firstSlot = hourly12[0];
  const temps24 = allSlots.map((s) => s.temp);

  return {
    townId,
    source: '中央氣象署 OpenData',
    apiMode: 'opendata',
    updatedAt: new Date().toISOString(),
    current: {
      temp: firstSlot.temp,
      feelsLike: firstSlot.feelsLike,
      humidity: firstSlot.humidity,
      rainMm: 0,
      wxText: firstSlot.wxText,
      wxCode: firstSlot.wxCode,
      isNight: firstSlot.isNight,
      pop: firstSlot.pop,
      windSpeed: firstSlot.windSpeed,
      windBeaufort: firstSlot.windBeaufort,
      windDir: firstSlot.windDir,
      comfort: firstSlot.comfort,
    },
    today: {
      tempMax: Math.max(...temps24),
      tempMin: Math.min(...temps24),
      sunrise: sunTimes?.sunrise || '--:--',
      sunset: sunTimes?.sunset || '--:--',
    },
    hourly: hourly12,
  };
}

// Query CWA Linked Open Data GraphQL API for nearby AQI using the SAME single CWA API Key
export async function fetchCwaLinkedAqi(
  lat: number,
  lon: number,
  cwaApiKey: string
): Promise<{ usAqi: number; pm25: number; pm10: number; source: string } | null> {
  if (!cwaApiKey) return null;

  const queries = [
    `query { aqi(longitude: ${lon}, latitude: ${lat}) { sitename aqi pm2_5 pm10 status } }`,
    `query { aqi(longitude: ${lon}, latitude: ${lat}) { siteName aqi pm25 pm10 status } }`,
  ];

  for (const query of queries) {
    try {
      const res = await fetch(
        `https://opendata.cwa.gov.tw/linked/graphql?Authorization=${encodeURIComponent(cwaApiKey)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: cwaApiKey,
          },
          body: JSON.stringify({ query }),
        }
      );
      if (!res.ok) continue;
      const json = (await res.json()) as {
        data?: {
          aqi?:
            | Array<Record<string, unknown>>
            | Record<string, unknown>
            | null;
        };
      };
      const rawAqi = json?.data?.aqi;
      const item = Array.isArray(rawAqi) ? rawAqi[0] : rawAqi;
      if (!item || typeof item !== 'object') continue;

      const aqiNum = Number(item.aqi ?? item.AQI);
      if (Number.isNaN(aqiNum) || aqiNum <= 0) continue;

      const pm25Num = Number(item.pm2_5 ?? item.pm25 ?? item.PM25 ?? 0);
      const pm10Num = Number(item.pm10 ?? item.PM10 ?? 0);
      const site = String(item.sitename ?? item.siteName ?? item.SiteName ?? '').trim();

      return {
        usAqi: Math.round(aqiNum),
        pm25: Number.isNaN(pm25Num) ? 0 : Math.round(pm25Num),
        pm10: Number.isNaN(pm10Num) ? 0 : Math.round(pm10Num),
        source: site ? `氣象署鏈結・${site}` : '氣象署鏈結 AQI',
      };
    } catch {
      // try next schema or fall back cleanly
    }
  }

  return null;
}
