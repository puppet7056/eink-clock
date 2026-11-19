import { useMemo, useState } from 'react';
import { Droplets, KeyRound, RefreshCw, Sunrise, Sunset, Wind } from 'lucide-react';
import type { AqiPayload, CwaWeatherPayload, HourlyForecastItem } from '../types/weather';
import { WeatherIcon } from './WeatherIcons';

export type DeviceScale = 'phone' | 'reader6' | 'tablet10';

interface WeatherPanelProps {
  townName: string;
  weather: CwaWeatherPayload | null;
  aqi: AqiPayload | null;
  loading: boolean;
  error: string | null;
  requiresApiKey?: boolean;
  isLandscape: boolean;
  deviceScale: DeviceScale;
  fontScale?: number;
  onRefresh: () => void;
  onOpenSettings: () => void;
}

type ForecastMetric = 'temp' | 'rain' | 'wind';

function getAqiLabel(aqi: number): string {
  if (aqi > 150) return '不健康';
  if (aqi > 100) return '敏感注意';
  if (aqi > 50) return '普通';
  return '良好';
}

function buildSmoothCurvePath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2 < points.length ? i + 2 : points.length - 1];

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

function HourlyChart({
  hourly,
  metric,
  deviceScale,
  fontScale,
}: {
  hourly: HourlyForecastItem[];
  metric: ForecastMetric;
  deviceScale: DeviceScale;
  fontScale: number;
}) {
  const slots = hourly.slice(0, 12);
  const count = slots.length;

  const clampedChartScale = Math.min(1.45, Math.max(0.88, fontScale));
  const baseChartHeight = deviceScale === 'tablet10' ? 92 : deviceScale === 'phone' ? 58 : 70;
  const chartHeight = Math.round(baseChartHeight * (0.72 + 0.28 * clampedChartScale));
  const heightClass =
    deviceScale === 'tablet10'
      ? 'h-[calc(92px*var(--fs-ctrl))]'
      : deviceScale === 'phone'
        ? 'h-[calc(58px*var(--fs-ctrl))]'
        : 'h-[calc(70px*var(--fs-ctrl))]';
  const baseIconSize = deviceScale === 'tablet10' ? 26 : deviceScale === 'phone' ? 18 : 21;
  const iconSize = Math.round(baseIconSize * Math.min(1.38, Math.max(0.88, fontScale)));

  const svgTempFont = Number(
    ((deviceScale === 'tablet10' ? 14.5 : 12.5) * Math.min(1.24, Math.max(0.9, fontScale))).toFixed(1)
  );
  const svgRainFont = Number(
    ((deviceScale === 'tablet10' ? 13 : 11.5) * Math.min(1.22, Math.max(0.9, fontScale))).toFixed(1)
  );
  const svgWindFont = Number(
    ((deviceScale === 'tablet10' ? 12 : 10.5) * Math.min(1.18, Math.max(0.9, fontScale))).toFixed(1)
  );

  const { linePath, areaPath, points, maxRain, maxWind } = useMemo(() => {
    if (count === 0) {
      return { linePath: '', areaPath: '', points: [], maxRain: 100, maxWind: 10 };
    }
    const width = 600;
    const topPad = Math.round(24 * Math.min(1.25, Math.max(0.95, fontScale)));
    const bottomPad = 12;
    const plotH = Math.max(24, chartHeight - topPad - bottomPad);

    const temps = slots.map((s) => s.temp);
    const minT = Math.min(...temps);
    const maxT = Math.max(...temps);
    const span = Math.max(2, maxT - minT);

    const stepX = width / count;
    const pts = slots.map((slot, idx) => {
      const x = stepX * idx + stepX / 2;
      const ratio = (slot.temp - minT) / span;
      const y = topPad + (1 - ratio) * plotH;
      return { x, y, slot };
    });

    const lp = buildSmoothCurvePath(pts);
    const first = pts[0];
    const last = pts[pts.length - 1];
    const ap = `${lp} L ${last.x.toFixed(1)} ${chartHeight} L ${first.x.toFixed(1)} ${chartHeight} Z`;

    return {
      linePath: lp,
      areaPath: ap,
      points: pts,
      maxRain: Math.max(40, ...slots.map((s) => s.pop)),
      maxWind: Math.max(6, ...slots.map((s) => s.windSpeed)),
    };
  }, [slots, count, chartHeight, fontScale]);

  if (count === 0) return null;

  const minWidthClass =
    fontScale >= 1.5
      ? 'min-w-[620px] w-full'
      : fontScale >= 1.3
        ? 'min-w-[540px] w-full'
        : deviceScale === 'phone'
          ? 'min-w-[440px]'
          : 'min-w-[420px] w-full';

  return (
    <div className="w-full overflow-x-auto">
      <div className={minWidthClass}>
        {metric === 'temp' && (
          <svg
            viewBox={`0 0 600 ${chartHeight}`}
            className={`w-full block overflow-visible ${heightClass}`}
            role="img"
            aria-label="未來 12 小時溫度變化曲線"
          >
            <defs>
              <pattern
                id="eink-hatch"
                width="6"
                height="6"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <line
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="6"
                  stroke="currentColor"
                  strokeOpacity="0.13"
                  strokeWidth="1.5"
                />
              </pattern>
            </defs>
            <path d={areaPath} fill="url(#eink-hatch)" />
            <path
              d={linePath}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
            />
            {points.map(({ x, y, slot }, idx) => (
              <g key={`${slot.dateLabel}-${slot.timeLabel}-${idx}`}>
                <circle
                  cx={x}
                  cy={y}
                  r={idx === 0 ? 4.2 : 2.8}
                  fill={idx === 0 ? 'currentColor' : 'var(--bg-color)'}
                  stroke="currentColor"
                  strokeWidth="2"
                />
                <text
                  x={x}
                  y={y - 9}
                  textAnchor="middle"
                  fill="currentColor"
                  fontSize={svgTempFont}
                  fontWeight={idx === 0 ? '900' : '700'}
                  className="font-num"
                >
                  {slot.temp}°
                </text>
              </g>
            ))}
          </svg>
        )}

        {metric === 'rain' && (
          <svg
            viewBox={`0 0 600 ${chartHeight}`}
            className={`w-full block overflow-visible ${heightClass}`}
            role="img"
            aria-label="未來 12 小時降雨機率柱狀圖"
          >
            {slots.map((slot, idx) => {
              const stepX = 600 / count;
              const cx = stepX * idx + stepX / 2;
              const maxBarH = chartHeight - 22;
              const barH = Math.max(4, Math.round((slot.pop / maxRain) * maxBarH));
              const barY = chartHeight - barH - 2;
              return (
                <g key={`${slot.dateLabel}-${slot.timeLabel}-rain-${idx}`}>
                  <text
                    x={cx}
                    y={barY - 5}
                    textAnchor="middle"
                    fill="currentColor"
                    fontSize={svgRainFont}
                    fontWeight="700"
                    className="font-num"
                  >
                    {slot.pop}%
                  </text>
                  <rect
                    x={cx - 10}
                    y={barY}
                    width={20}
                    height={barH}
                    rx={2}
                    fill={slot.pop >= 40 ? 'currentColor' : 'var(--surface-subtle)'}
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                </g>
              );
            })}
          </svg>
        )}

        {metric === 'wind' && (
          <svg
            viewBox={`0 0 600 ${chartHeight}`}
            className={`w-full block overflow-visible ${heightClass}`}
            role="img"
            aria-label="未來 12 小時風速與濕度圖"
          >
            {slots.map((slot, idx) => {
              const stepX = 600 / count;
              const cx = stepX * idx + stepX / 2;
              const maxBarH = chartHeight - 30;
              const barH = Math.max(5, Math.round((slot.windSpeed / maxWind) * maxBarH));
              const barY = chartHeight - barH - 13;
              return (
                <g key={`${slot.dateLabel}-${slot.timeLabel}-wind-${idx}`}>
                  <text
                    x={cx}
                    y={barY - 4}
                    textAnchor="middle"
                    fill="currentColor"
                    fontSize={svgWindFont}
                    fontWeight="700"
                    className="font-num"
                  >
                    {slot.windSpeed}m/s
                  </text>
                  <rect
                    x={cx - 8}
                    y={barY}
                    width={16}
                    height={barH}
                    rx={2}
                    fill="var(--surface-subtle)"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <text
                    x={cx}
                    y={chartHeight - 1}
                    textAnchor="middle"
                    fill="var(--fg-muted)"
                    fontSize={svgWindFont}
                    fontWeight="600"
                    className="font-num"
                  >
                    {slot.humidity}%
                  </text>
                </g>
              );
            })}
          </svg>
        )}

        {/* Hourly icon + precipitation + timestamp strip */}
        <div className="grid grid-cols-12 border-t border-[var(--border-subtle)] pt-1.5 mt-0.5">
          {slots.map((slot, idx) => (
            <div
              key={`${slot.dateLabel}-${slot.timeLabel}-meta-${idx}`}
              className={`flex flex-col items-center gap-0.5 ${
                idx === 0 ? 'font-extrabold' : 'font-semibold'
              }`}
            >
              <WeatherIcon
                code={slot.wxCode}
                text={slot.wxText}
                isNight={slot.isNight}
                size={iconSize}
              />
              {metric === 'temp' && (
                <span
                  className={`${
                    deviceScale === 'tablet10'
                      ? 'text-[length:calc(12.5px*var(--fs))]'
                      : 'text-[length:calc(10.5px*var(--fs))]'
                  } font-num leading-none text-[var(--fg-muted)]`}
                >
                  {slot.pop > 0 ? `${slot.pop}%` : '·'}
                </span>
              )}
              {metric === 'wind' && (
                <span
                  className={`${
                    deviceScale === 'tablet10'
                      ? 'text-[length:calc(12px*var(--fs))]'
                      : 'text-[length:calc(10.5px*var(--fs))]'
                  } leading-none text-[var(--fg-muted)] truncate max-w-full`}
                >
                  {slot.windDir.replace('風', '') || '—'}
                </span>
              )}
              <span
                className={`${
                  deviceScale === 'tablet10'
                    ? 'text-[length:calc(13.5px*var(--fs))]'
                    : 'text-[length:calc(11.5px*var(--fs))]'
                } font-num leading-tight`}
              >
                {idx === 0 ? '現在' : `${String(slot.hour).padStart(2, '0')}時`}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function WeatherPanel({
  townName,
  weather,
  aqi,
  loading,
  error,
  requiresApiKey = false,
  isLandscape,
  deviceScale,
  fontScale = 1,
  onRefresh,
  onOpenSettings,
}: WeatherPanelProps) {
  const [metric, setMetric] = useState<ForecastMetric>('temp');

  if (loading && !weather) {
    return (
      <section className="flex flex-col justify-center gap-3 py-3">
        <div className="flex items-center justify-between">
          <div className="h-12 w-40 bg-[var(--surface-subtle)] rounded" />
          <div className="h-10 w-36 bg-[var(--surface-subtle)] rounded" />
        </div>
        <div className="h-24 w-full bg-[var(--surface-subtle)] rounded" />
      </section>
    );
  }

  if (error && !weather) {
    return (
      <section className="py-3 flex flex-col items-start gap-2.5">
        <div className="text-[15px] font-black flex items-center gap-1.5">
          {requiresApiKey && <KeyRound className="w-4 h-4 shrink-0" />}
          <span>
            {requiresApiKey
              ? `${townName} · 請輸入中央氣象署 OpenData API Key`
              : `${townName} · 中央氣象署資料暫時無法取得`}
          </span>
        </div>
        <p className="text-[13px] text-[var(--fg-muted)] leading-snug">{error}</p>
        <div className="flex items-center gap-2">
          {requiresApiKey && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="inline-flex items-center gap-1.5 border-2 border-[var(--border-color)] bg-[var(--surface-active)] text-[var(--fg-inverse)] px-3 py-1.5 text-[13px] font-extrabold rounded-[6px] cursor-pointer"
            >
              <KeyRound className="w-3.5 h-3.5" />
              前往設定輸入 API Key
            </button>
          )}
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-1.5 border-2 border-[var(--border-color)] px-3 py-1.5 text-[13px] font-bold rounded-[6px] cursor-pointer active:bg-[var(--fg-color)] active:text-[var(--bg-color)]"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            重新整理
          </button>
        </div>
      </section>
    );
  }

  if (!weather) return null;

  const { current, today, hourly } = weather;
  const aqiText = aqi ? `AQI ${aqi.usAqi} ${getAqiLabel(aqi.usAqi)}` : 'AQI --';

  const baseHeroIcon =
    deviceScale === 'tablet10' ? 68 : deviceScale === 'phone' ? 42 : isLandscape ? 50 : 54;
  const heroIconSize = Math.round(baseHeroIcon * Math.min(1.4, Math.max(0.85, fontScale)));
  const heroTempClass =
    deviceScale === 'tablet10'
      ? 'text-[length:calc(66px*var(--fs))]'
      : deviceScale === 'phone'
        ? 'text-[length:calc(40px*var(--fs))]'
        : isLandscape
          ? 'text-[length:calc(48px*var(--fs))]'
          : 'text-[length:calc(54px*var(--fs))]';
  const metricTextClass =
    deviceScale === 'tablet10'
      ? 'text-[length:calc(16px*var(--fs))]'
      : deviceScale === 'phone'
        ? 'text-[length:calc(11.5px*var(--fs))]'
        : 'text-[length:calc(13px*var(--fs))]';

  return (
    <section className="flex flex-col justify-between gap-2.5">
      {/* Top Hero Row — Google Weather inspired */}
      <div
        className={`flex ${
          deviceScale === 'phone' ? 'flex-col gap-2' : 'flex-wrap items-center justify-between gap-x-4 gap-y-2'
        }`}
      >
        {/* Left: Weather Icon + Hero Temperature + Condition */}
        <div className="flex items-center gap-2.5 min-w-0">
          <WeatherIcon
            code={current.wxCode}
            text={current.wxText}
            isNight={current.isNight}
            size={heroIconSize}
            className="shrink-0"
          />
          <div className="flex items-baseline gap-2.5 min-w-0">
            <span className={`${heroTempClass} font-black leading-none tracking-[-2px] font-num`}>
              {current.temp}°
            </span>
            <div className="flex flex-col min-w-0">
              <div className="flex items-baseline gap-1.5 flex-wrap">
                <span
                  className={`${
                    deviceScale === 'tablet10'
                      ? 'text-[length:calc(24px*var(--fs))]'
                      : deviceScale === 'phone'
                        ? 'text-[length:calc(16px*var(--fs))]'
                        : 'text-[length:calc(19px*var(--fs))]'
                  } font-extrabold leading-tight`}
                >
                  {current.wxText}
                </span>
                {current.comfort && (
                  <span
                    className={`${
                      deviceScale === 'tablet10'
                        ? 'text-[length:calc(16px*var(--fs))]'
                        : 'text-[length:calc(12.5px*var(--fs))]'
                    } font-semibold text-[var(--fg-muted)]`}
                  >
                    · {current.comfort}
                  </span>
                )}
              </div>
              <div
                className={`${
                  deviceScale === 'tablet10'
                    ? 'text-[length:calc(15.5px*var(--fs))]'
                    : deviceScale === 'phone'
                      ? 'text-[length:calc(11.5px*var(--fs))]'
                      : 'text-[length:calc(13px*var(--fs))]'
                } font-semibold text-[var(--fg-muted)] font-num mt-0.5`}
              >
                最高 {today.tempMax}° / 最低 {today.tempMin}° · 體感 {current.feelsLike}°
              </div>
            </div>
          </div>
        </div>

        {/* Right: Clean unboxed metrics grid */}
        <div
          className={`grid grid-cols-2 gap-x-4 gap-y-1.5 font-semibold ${metricTextClass} ${
            deviceScale === 'phone'
              ? 'border-t border-[var(--border-subtle)] pt-1.5'
              : 'border-l border-[var(--border-subtle)] pl-3.5'
          }`}
        >
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <Droplets className="w-[1em] h-[1em] shrink-0" />
            <span className="text-[var(--fg-muted)]">降雨</span>
            <span className="font-extrabold font-num">{current.pop}%</span>
          </div>
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-[var(--fg-muted)]">濕度</span>
            <span className="font-extrabold font-num">{current.humidity}%</span>
          </div>
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <Wind className="w-[1em] h-[1em] shrink-0" />
            <span className="font-extrabold font-num">
              {current.windSpeed}m/s {current.windDir}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-1.5 whitespace-nowrap font-num">
            <span className="font-extrabold">{aqiText}</span>
            {aqi && <span className="text-[var(--fg-muted)]">PM2.5 {aqi.pm25}</span>}
          </div>
        </div>
      </div>

      {/* 12-Hour Forecast Header & Segmented Metric Switch */}
      <div className="border-t border-[var(--border-subtle)] pt-2">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
          <div
            className={`flex items-center gap-1.5 ${
              deviceScale === 'tablet10'
                ? 'text-[length:calc(14px*var(--fs))]'
                : 'text-[length:calc(12px*var(--fs))]'
            } font-bold min-w-0 truncate`}
          >
            <span
              className={`${
                deviceScale === 'tablet10'
                  ? 'text-[length:calc(16.5px*var(--fs))]'
                  : deviceScale === 'phone'
                    ? 'text-[length:calc(12.5px*var(--fs))]'
                    : 'text-[length:calc(14px*var(--fs))]'
              } font-extrabold whitespace-nowrap`}
            >
              未來 12 小時變化
            </span>
            <span aria-hidden="true" className="text-[var(--fg-muted)]">·</span>
            <span className="text-[var(--fg-muted)] truncate">
              {townName}（{weather.source}）
            </span>
            {deviceScale !== 'phone' && today.sunrise !== '--:--' && (
              <span className="hidden sm:inline-flex items-center gap-1 text-[length:calc(12.5px*var(--fs))] font-num text-[var(--fg-muted)] whitespace-nowrap">
                <span aria-hidden="true">·</span>
                <Sunrise className="w-[1em] h-[1em]" />
                {today.sunrise}
                <Sunset className="w-[1em] h-[1em] ml-1" />
                {today.sunset}
              </span>
            )}
          </div>

          <div
            role="tablist"
            aria-label="12小時預報指標切換"
            className="inline-flex items-center border-[1.5px] border-[var(--border-color)] rounded-[6px] overflow-hidden shrink-0"
          >
            {(
              [
                { id: 'temp', label: '溫度' },
                { id: 'rain', label: '降雨' },
                { id: 'wind', label: '風速' },
              ] as const
            ).map((tab) => {
              const active = metric === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setMetric(tab.id)}
                  className={`${
                    deviceScale === 'tablet10'
                      ? 'px-3 py-1 text-[length:calc(13.5px*var(--fs-ctrl))]'
                      : 'px-2 py-0.5 text-[length:calc(11.5px*var(--fs-ctrl))]'
                  } font-bold whitespace-nowrap cursor-pointer transition-colors ${
                    active
                      ? 'bg-[var(--surface-active)] text-[var(--fg-inverse)]'
                      : 'bg-[var(--bg-color)] text-[var(--fg-color)]'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        <HourlyChart hourly={hourly} metric={metric} deviceScale={deviceScale} fontScale={fontScale} />
      </div>
    </section>
  );
}
