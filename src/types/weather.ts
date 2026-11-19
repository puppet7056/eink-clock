export interface HourlyForecastItem {
  dateLabel: string;
  timeLabel: string;
  hour: number;
  temp: number;
  feelsLike: number;
  humidity: number;
  wxText: string;
  wxCode: string;
  isNight: boolean;
  pop: number;
  windSpeed: number;
  windBeaufort: number;
  windDir: string;
  comfort: string;
}

export interface CwaWeatherPayload {
  townId: string;
  source: string;
  apiMode?: 'opendata' | 'public';
  updatedAt: string;
  current: {
    temp: number;
    feelsLike: number;
    humidity: number;
    rainMm: number;
    wxText: string;
    wxCode: string;
    isNight: boolean;
    pop: number;
    windSpeed: number;
    windBeaufort: number;
    windDir: string;
    comfort: string;
  };
  today: {
    tempMax: number;
    tempMin: number;
    sunrise: string;
    sunset: string;
  };
  hourly: HourlyForecastItem[];
}

export interface AqiPayload {
  usAqi: number;
  pm25: number;
  pm10: number;
  source?: string;
}

export interface TaiwanTownOption {
  id: string;
  name: string;
  districtName: string;
  cwaDatasetId: string;
  moenvSite: string;
  lat: number;
  lon: number;
}

export const TAIWAN_TOWN_PRESETS: TaiwanTownOption[] = [
  { id: '6801000', name: '桃園市 平鎮區', districtName: '平鎮區', cwaDatasetId: 'F-D0047-005', moenvSite: '平鎮', lat: 24.9457, lon: 121.2054 },
  { id: '6800200', name: '桃園市 中壢區', districtName: '中壢區', cwaDatasetId: 'F-D0047-005', moenvSite: '中壢', lat: 24.9722, lon: 121.2248 },
  { id: '6800100', name: '桃園市 桃園區', districtName: '桃園區', cwaDatasetId: 'F-D0047-005', moenvSite: '桃園', lat: 24.9937, lon: 121.301 },
  { id: '6800400', name: '桃園市 楊梅區', districtName: '楊梅區', cwaDatasetId: 'F-D0047-005', moenvSite: '平鎮', lat: 24.9076, lon: 121.1459 },
  { id: '6800900', name: '桃園市 龍潭區', districtName: '龍潭區', cwaDatasetId: 'F-D0047-005', moenvSite: '龍潭', lat: 24.8639, lon: 121.2165 },
  { id: '6300200', name: '臺北市 信義區', districtName: '信義區', cwaDatasetId: 'F-D0047-061', moenvSite: '松山', lat: 25.033, lon: 121.5654 },
  { id: '6300500', name: '臺北市 中正區', districtName: '中正區', cwaDatasetId: 'F-D0047-061', moenvSite: '古亭', lat: 25.0324, lon: 121.5183 },
  { id: '6500100', name: '新北市 板橋區', districtName: '板橋區', cwaDatasetId: 'F-D0047-069', moenvSite: '板橋', lat: 25.0114, lon: 121.4628 },
  { id: '1001801', name: '新竹市 東區', districtName: '東區', cwaDatasetId: 'F-D0047-053', moenvSite: '新竹', lat: 24.8039, lon: 120.9879 },
  { id: '6600600', name: '臺中市 西屯區', districtName: '西屯區', cwaDatasetId: 'F-D0047-073', moenvSite: '西屯', lat: 24.1649, lon: 120.6469 },
  { id: '6703200', name: '臺南市 東區', districtName: '東區', cwaDatasetId: 'F-D0047-077', moenvSite: '臺南', lat: 22.9804, lon: 120.227 },
  { id: '6400300', name: '高雄市 左營區', districtName: '左營區', cwaDatasetId: 'F-D0047-065', moenvSite: '左營', lat: 22.6897, lon: 120.293 },
];

export function findTownPreset(townId: string): TaiwanTownOption {
  return TAIWAN_TOWN_PRESETS.find((t) => t.id === townId) || TAIWAN_TOWN_PRESETS[0];
}
