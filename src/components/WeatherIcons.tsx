interface WeatherIconProps {
  code?: string;
  text?: string;
  isNight?: boolean;
  size?: number;
  className?: string;
}

type WeatherKind =
  | 'clear-day'
  | 'clear-night'
  | 'partly-day'
  | 'partly-night'
  | 'cloudy'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'thunder';

function resolveWeatherKind(code?: string, text?: string, isNight?: boolean): WeatherKind {
  const t = text || '';
  const num = code ? parseInt(code, 10) : NaN;

  if (t.includes('雷') || (num >= 15 && num <= 18) || num === 21 || num === 22 || num === 33 || num === 34) {
    return 'thunder';
  }
  if (t.includes('霧') || (num >= 24 && num <= 28)) {
    return 'fog';
  }
  if (t.includes('大雨') || t.includes('豪雨') || t.includes('陣雨') || num === 11 || num === 12 || num === 13 || num === 14) {
    return 'rain';
  }
  if (t.includes('雨') || (num >= 8 && num <= 10) || num === 19 || num === 20 || num === 29 || num === 30) {
    return 'drizzle';
  }
  if (t === '陰' || t === '陰天' || t === '多雲' || t.includes('陰時多雲') || t.includes('多雲時陰') || num === 4 || num === 5 || num === 6 || num === 7) {
    return 'cloudy';
  }
  if (t.includes('多雲') || num === 2 || num === 3) {
    return isNight ? 'partly-night' : 'partly-day';
  }
  return isNight ? 'clear-night' : 'clear-day';
}

export function WeatherIcon({
  code,
  text,
  isNight = false,
  size = 44,
  className = '',
}: WeatherIconProps) {
  const kind = resolveWeatherKind(code, text, isNight);

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {kind === 'clear-day' && (
        <>
          <circle cx="24" cy="24" r="9.5" fill="currentColor" fillOpacity="0.14" />
          <line x1="24" y1="5.5" x2="24" y2="10" />
          <line x1="24" y1="38" x2="24" y2="42.5" />
          <line x1="5.5" y1="24" x2="10" y2="24" />
          <line x1="38" y1="24" x2="42.5" y2="24" />
          <line x1="10.9" y1="10.9" x2="14.1" y2="14.1" />
          <line x1="33.9" y1="33.9" x2="37.1" y2="37.1" />
          <line x1="37.1" y1="10.9" x2="33.9" y2="14.1" />
          <line x1="14.1" y1="33.9" x2="10.9" y2="37.1" />
        </>
      )}

      {kind === 'clear-night' && (
        <>
          <path
            d="M34.5 29.8A13 13 0 0 1 18.2 13.5a13 13 0 1 0 16.3 16.3Z"
            fill="currentColor"
            fillOpacity="0.14"
          />
          <path d="M35 12v4M33 14h4" strokeWidth="2" />
        </>
      )}

      {kind === 'partly-day' && (
        <>
          <circle cx="18" cy="18" r="6.5" fill="currentColor" fillOpacity="0.14" />
          <line x1="18" y1="7" x2="18" y2="9.5" />
          <line x1="7" y1="18" x2="9.5" y2="18" />
          <line x1="10.5" y1="10.5" x2="12.3" y2="12.3" />
          <line x1="25.5" y1="10.5" x2="23.7" y2="12.3" />
          <path
            d="M17.5 36h17a7 7 0 0 0 1.4-13.85A9.5 9.5 0 0 0 17.6 20.5a6.5 6.5 0 0 0-.1 15.5Z"
            fill="var(--bg-color)"
          />
        </>
      )}

      {kind === 'partly-night' && (
        <>
          <path
            d="M23.5 20.5A8.5 8.5 0 0 1 14 11.2a8.5 8.5 0 1 0 9.5 9.3Z"
            fill="currentColor"
            fillOpacity="0.14"
          />
          <path
            d="M17.5 36h17a7 7 0 0 0 1.4-13.85A9.5 9.5 0 0 0 17.6 20.5a6.5 6.5 0 0 0-.1 15.5Z"
            fill="var(--bg-color)"
          />
        </>
      )}

      {kind === 'cloudy' && (
        <>
          <path
            d="M14 35.5h21a7.5 7.5 0 0 0 1.2-14.9A10.5 10.5 0 0 0 15.9 18 7.5 7.5 0 0 0 14 35.5Z"
            fill="currentColor"
            fillOpacity="0.12"
          />
        </>
      )}

      {kind === 'fog' && (
        <>
          <path
            d="M14 26.5h20a6.5 6.5 0 0 0 1.1-12.9A9 9 0 0 0 17.3 12 6.5 6.5 0 0 0 14 26.5Z"
            fill="currentColor"
            fillOpacity="0.1"
          />
          <line x1="10" y1="32.5" x2="38" y2="32.5" />
          <line x1="14" y1="38" x2="34" y2="38" />
        </>
      )}

      {kind === 'drizzle' && (
        <>
          <path
            d="M14 29h20a6.8 6.8 0 0 0 1.1-13.5A9.4 9.4 0 0 0 17 13.5 6.8 6.8 0 0 0 14 29Z"
            fill="currentColor"
            fillOpacity="0.12"
          />
          <line x1="18" y1="34" x2="16.2" y2="38.5" />
          <line x1="25.5" y1="34" x2="23.7" y2="38.5" />
          <line x1="33" y1="34" x2="31.2" y2="38.5" />
        </>
      )}

      {kind === 'rain' && (
        <>
          <path
            d="M14 28h20a6.8 6.8 0 0 0 1.1-13.5A9.4 9.4 0 0 0 17 12.5 6.8 6.8 0 0 0 14 28Z"
            fill="currentColor"
            fillOpacity="0.16"
          />
          <line x1="16.5" y1="33" x2="13.8" y2="41" />
          <line x1="24" y1="33" x2="21.3" y2="41" />
          <line x1="31.5" y1="33" x2="28.8" y2="41" />
        </>
      )}

      {kind === 'thunder' && (
        <>
          <path
            d="M14 27.5h20a6.8 6.8 0 0 0 1.1-13.5A9.4 9.4 0 0 0 17 12 6.8 6.8 0 0 0 14 27.5Z"
            fill="currentColor"
            fillOpacity="0.16"
          />
          <polyline points="25 28 20.5 35 25.5 35 22 42" strokeWidth="2.6" />
          <line x1="15" y1="33" x2="13.5" y2="37.5" />
          <line x1="33" y1="33" x2="31.5" y2="37.5" />
        </>
      )}
    </svg>
  );
}
