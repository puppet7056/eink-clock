import { Solar } from 'lunar-javascript';

export interface TaiwanDayInfo {
  date: Date;
  year: number;
  month: number;
  day: number;
  weekday: number;
  weekdayLabel: string;
  isWeekend: boolean;
  lunarYearGanZhi: string;
  lunarZodiac: string;
  lunarMonthText: string;
  lunarDayText: string;
  lunarShort: string;
  lunarFull: string;
  solarTerm: string | null;
  holiday: string | null;
  holidayShort: string | null;
  festival: string | null;
  cellBadgeText: string;
  cellBadgeType: 'holiday' | 'solarTerm' | 'festival' | 'lunar';
}

export interface UpcomingHolidayItem {
  date: Date;
  name: string;
  lunarText: string;
  daysUntil: number;
  isNationalHoliday: boolean;
}

const WEEK_DAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

// Simplified -> Traditional Chinese mapping for lunar-javascript terms
const S2T_MAP: Record<string, string> = {
  闰: '閏',
  腊: '臘',
  惊: '驚',
  蛰: '蟄',
  谷: '穀',
  满: '滿',
  种: '種',
  处: '處',
  龙: '龍',
  马: '馬',
  鸡: '雞',
  猪: '豬',
  节: '節',
  历: '曆',
  阳: '陽',
  阴: '陰',
  万: '萬',
};

function toTraditional(str: string): string {
  if (!str) return '';
  let out = '';
  for (const ch of str) {
    out += S2T_MAP[ch] ?? ch;
  }
  return out;
}

// Taiwan statutory fixed Gregorian national holidays (including 2025 amended national holidays)
const FIXED_NATIONAL_HOLIDAYS: Record<string, { full: string; short: string }> = {
  '1-1': { full: '元旦', short: '元旦' },
  '2-28': { full: '和平紀念日', short: '和平紀念' },
  '4-4': { full: '兒童節', short: '兒童節' },
  '5-1': { full: '勞動節', short: '勞動節' },
  '9-28': { full: '教師節', short: '教師節' },
  '10-10': { full: '國慶日', short: '國慶日' },
  '10-25': { full: '臺灣光復節', short: '光復節' },
  '12-25': { full: '行憲紀念日', short: '行憲紀念' },
};

export function getTaiwanDayInfo(date: Date): TaiwanDayInfo {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const weekday = date.getDay();

  const solar = Solar.fromYmd(year, month, day);
  const lunar = solar.getLunar();

  const lunarYearGanZhi = toTraditional(lunar.getYearInGanZhi());
  const lunarZodiac = toTraditional(lunar.getYearShengXiao());
  const rawMonthStr = toTraditional(lunar.getMonthInChinese());
  const lunarMonthText = `${rawMonthStr}月`;
  const lunarDayText = toTraditional(lunar.getDayInChinese());
  const lunarShort = lunar.getDay() === 1 ? lunarMonthText : lunarDayText;
  const lunarFull = `${lunarYearGanZhi}年${lunarMonthText}${lunarDayText}`;

  const rawJieQi = lunar.getJieQi();
  const solarTerm = rawJieQi ? toTraditional(rawJieQi) : null;

  // Check Taiwan national holidays
  let holiday: string | null = null;
  let holidayShort: string | null = null;

  const fixedKey = `${month}-${day}`;
  if (FIXED_NATIONAL_HOLIDAYS[fixedKey]) {
    holiday = FIXED_NATIONAL_HOLIDAYS[fixedKey].full;
    holidayShort = FIXED_NATIONAL_HOLIDAYS[fixedKey].short;
  }

  // Qingming (Tomb Sweeping Day) — exact astronomical solar term
  if (solarTerm === '清明') {
    holiday = holiday ? `${holiday}・清明節` : '清明節';
    holidayShort = '清明節';
  }

  // Lunar-based Taiwan national holidays (ignore leap months for festivals)
  const lMonth = lunar.getMonth(); // negative if leap month
  const lDay = lunar.getDay();

  // Check New Year's Eve (除夕) and Day Before Eve (小年夜)
  const nextSolar = solar.next(1);
  const nextLunar = nextSolar.getLunar();
  const next2Solar = solar.next(2);
  const next2Lunar = next2Solar.getLunar();

  if (nextLunar.getMonth() === 1 && nextLunar.getDay() === 1) {
    holiday = '除夕';
    holidayShort = '除夕';
  } else if (next2Lunar.getMonth() === 1 && next2Lunar.getDay() === 1) {
    holiday = '小年夜';
    holidayShort = '小年夜';
  } else if (lMonth === 1 && lDay === 1) {
    holiday = '春節';
    holidayShort = '春節';
  } else if (lMonth === 1 && lDay === 2) {
    holiday = '初二';
    holidayShort = '初二';
  } else if (lMonth === 1 && lDay === 3) {
    holiday = '初三';
    holidayShort = '初三';
  } else if (lMonth === 5 && lDay === 5) {
    holiday = '端午節';
    holidayShort = '端午節';
  } else if (lMonth === 8 && lDay === 15) {
    holiday = '中秋節';
    holidayShort = '中秋節';
  }

  // Traditional non-statutory festivals
  let festival: string | null = null;
  if (lMonth === 1 && lDay === 15) festival = '元宵節';
  else if (lMonth === 7 && lDay === 7) festival = '七夕';
  else if (lMonth === 7 && lDay === 15) festival = '中元節';
  else if (lMonth === 9 && lDay === 9) festival = '重陽節';

  let cellBadgeText = lunarShort;
  let cellBadgeType: TaiwanDayInfo['cellBadgeType'] = 'lunar';
  if (holidayShort) {
    cellBadgeText = holidayShort;
    cellBadgeType = 'holiday';
  } else if (solarTerm) {
    cellBadgeText = solarTerm;
    cellBadgeType = 'solarTerm';
  } else if (festival) {
    cellBadgeText = festival;
    cellBadgeType = 'festival';
  }

  return {
    date,
    year,
    month,
    day,
    weekday,
    weekdayLabel: WEEK_DAYS[weekday],
    isWeekend: weekday === 0 || weekday === 6,
    lunarYearGanZhi,
    lunarZodiac,
    lunarMonthText,
    lunarDayText,
    lunarShort,
    lunarFull,
    solarTerm,
    holiday,
    holidayShort,
    festival,
    cellBadgeText,
    cellBadgeType,
  };
}

export function getMonthCalendarCells(year: number, monthIndex: number): {
  info: TaiwanDayInfo;
  isCurrentMonth: boolean;
  isToday: boolean;
}[] {
  const today = new Date();
  const todayY = today.getFullYear();
  const todayM = today.getMonth();
  const todayD = today.getDate();

  const firstDay = new Date(year, monthIndex, 1);
  const startWeekday = firstDay.getDay();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const totalCells = startWeekday + daysInMonth > 35 ? 42 : 35;

  const cells: { info: TaiwanDayInfo; isCurrentMonth: boolean; isToday: boolean }[] = [];
  for (let i = 0; i < totalCells; i++) {
    const d = new Date(year, monthIndex, 1 - startWeekday + i);
    const info = getTaiwanDayInfo(d);
    cells.push({
      info,
      isCurrentMonth: d.getMonth() === monthIndex,
      isToday: d.getFullYear() === todayY && d.getMonth() === todayM && d.getDate() === todayD,
    });
  }
  return cells;
}

export function getUpcomingTaiwanHolidays(
  fromDate: Date,
  daysAhead = 90,
  limit = 4
): UpcomingHolidayItem[] {
  const start = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
  const results: UpcomingHolidayItem[] = [];

  for (let offset = 0; offset <= daysAhead; offset++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
    const info = getTaiwanDayInfo(d);
    if (info.holiday) {
      results.push({
        date: d,
        name: info.holiday,
        lunarText: `${info.lunarMonthText}${info.lunarDayText}`,
        daysUntil: offset,
        isNationalHoliday: true,
      });
      if (results.length >= limit) break;
    }
  }

  return results;
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
