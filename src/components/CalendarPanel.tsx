import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  getMonthCalendarCells,
  getTaiwanDayInfo,
  getUpcomingTaiwanHolidays,
  isSameDay,
  type TaiwanDayInfo,
} from '../utils/taiwanCalendar';
import type { DeviceScale } from './WeatherPanel';

export interface CalendarEventItem {
  id: string;
  date: Date;
  timeLabel: string;
  summary: string;
  isAllDay: boolean;
}

interface CalendarPanelProps {
  today: Date;
  events: CalendarEventItem[];
  hasIcalUrl: boolean;
  syncStatus: string;
  isLandscape: boolean;
  deviceScale: DeviceScale;
  onOpenSettings: () => void;
}

type CalendarView = 'agenda' | 'month';

const WEEKDAY_HEADERS = ['日', '一', '二', '三', '四', '五', '六'];

export function CalendarPanel({
  today,
  events,
  hasIcalUrl,
  syncStatus,
  isLandscape,
  deviceScale,
  onOpenSettings,
}: CalendarPanelProps) {
  const [view, setView] = useState<CalendarView>('month');
  const [cursorYear, setCursorYear] = useState<number>(() => today.getFullYear());
  const [cursorMonth, setCursorMonth] = useState<number>(() => today.getMonth());
  const [selectedDate, setSelectedDate] = useState<Date>(() => today);

  const todayY = today.getFullYear();
  const todayM = today.getMonth();
  const todayD = today.getDate();
  const todayKey = `${todayY}-${todayM}-${todayD}`;
  const prevTodayRef = useRef<Date>(new Date(todayY, todayM, todayD));

  // 跨午夜 00:00 自動更新今日標記與當前月曆（適合 24 小時常亮電子紙時鐘）
  useEffect(() => {
    const prevToday = prevTodayRef.current;
    const nextToday = new Date(todayY, todayM, todayD);
    if (!isSameDay(prevToday, nextToday)) {
      setSelectedDate((prevSel) => (isSameDay(prevSel, prevToday) ? nextToday : prevSel));
      if (cursorYear === prevToday.getFullYear() && cursorMonth === prevToday.getMonth()) {
        setCursorYear(todayY);
        setCursorMonth(todayM);
      }
      prevTodayRef.current = nextToday;
    }
  }, [todayKey, todayY, todayM, todayD, cursorYear, cursorMonth]);

  const stableToday = useMemo(() => new Date(todayY, todayM, todayD), [todayY, todayM, todayD]);
  const todayInfo = useMemo(() => getTaiwanDayInfo(stableToday), [stableToday]);
  const upcomingHolidays = useMemo(
    () => getUpcomingTaiwanHolidays(stableToday, 120, 4),
    [stableToday]
  );
  const nextHoliday = upcomingHolidays[0] || null;

  const monthCells = useMemo(
    () => getMonthCalendarCells(cursorYear, cursorMonth),
    // todayKey ensures isToday highlight refreshes automatically at midnight
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cursorYear, cursorMonth, todayKey]
  );

  const selectedInfo: TaiwanDayInfo = useMemo(
    () => getTaiwanDayInfo(selectedDate),
    [selectedDate]
  );

  const selectedDayEvents = useMemo(
    () => events.filter((ev) => isSameDay(ev.date, selectedDate)),
    [events, selectedDate]
  );

  const handlePrevMonth = () => {
    if (cursorMonth === 0) {
      setCursorYear((y) => y - 1);
      setCursorMonth(11);
    } else {
      setCursorMonth((m) => m - 1);
    }
  };

  const handleNextMonth = () => {
    if (cursorMonth === 11) {
      setCursorYear((y) => y + 1);
      setCursorMonth(0);
    } else {
      setCursorMonth((m) => m + 1);
    }
  };

  const handleGoToday = () => {
    setCursorYear(today.getFullYear());
    setCursorMonth(today.getMonth());
    setSelectedDate(today);
  };

  const isViewingCurrentMonth =
    cursorYear === today.getFullYear() && cursorMonth === today.getMonth();

  const dayNumClass =
    deviceScale === 'tablet10'
      ? 'text-[18px]'
      : deviceScale === 'phone'
        ? 'text-[12px]'
        : isLandscape
          ? 'text-[14px]'
          : 'text-[13px]';

  const lunarSubClass =
    deviceScale === 'tablet10'
      ? 'text-[12px]'
      : deviceScale === 'phone'
        ? 'text-[9px]'
        : 'text-[10px]';

  return (
    <section className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Header Row with View Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b-[2px] border-[var(--border-color)] shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div
            role="tablist"
            aria-label="日曆檢視切換"
            className="inline-flex items-center border-[1.5px] border-[var(--border-color)] rounded-[6px] overflow-hidden shrink-0"
          >
            <button
              type="button"
              role="tab"
              aria-selected={view === 'month'}
              onClick={() => setView('month')}
              className={`${
                deviceScale === 'tablet10' ? 'px-3 py-1 text-[13px]' : 'px-2.5 py-0.5 text-[12px]'
              } font-extrabold whitespace-nowrap cursor-pointer ${
                view === 'month'
                  ? 'bg-[var(--surface-active)] text-[var(--fg-inverse)]'
                  : 'bg-[var(--bg-color)] text-[var(--fg-color)]'
              }`}
            >
              農曆月曆
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'agenda'}
              onClick={() => setView('agenda')}
              className={`${
                deviceScale === 'tablet10' ? 'px-3 py-1 text-[13px]' : 'px-2.5 py-0.5 text-[12px]'
              } font-extrabold whitespace-nowrap cursor-pointer ${
                view === 'agenda'
                  ? 'bg-[var(--surface-active)] text-[var(--fg-inverse)]'
                  : 'bg-[var(--bg-color)] text-[var(--fg-color)]'
              }`}
            >
              近期日程
            </button>
          </div>

          {view === 'month' && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handlePrevMonth}
                aria-label="上個月"
                className="p-1 rounded border border-[var(--border-subtle)] hover:border-[var(--border-color)] cursor-pointer"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <span
                className={`${
                  deviceScale === 'tablet10' ? 'text-[16px]' : 'text-[13px]'
                } font-extrabold font-num whitespace-nowrap px-1`}
              >
                {cursorYear}年{cursorMonth + 1}月
              </span>
              <button
                type="button"
                onClick={handleNextMonth}
                aria-label="下個月"
                className="p-1 rounded border border-[var(--border-subtle)] hover:border-[var(--border-color)] cursor-pointer"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
              {!isViewingCurrentMonth && (
                <button
                  type="button"
                  onClick={handleGoToday}
                  className="ml-0.5 px-1.5 py-0.5 text-[11px] font-bold border border-[var(--border-color)] rounded cursor-pointer whitespace-nowrap"
                >
                  今天
                </button>
              )}
            </div>
          )}
        </div>

        <span
          className={`${
            deviceScale === 'tablet10' ? 'text-[13px]' : 'text-[11px]'
          } font-bold text-[var(--fg-muted)] whitespace-nowrap truncate`}
        >
          {view === 'month'
            ? nextHoliday
              ? nextHoliday.daysUntil === 0
                ? `今日：${nextHoliday.name}`
                : `距 ${nextHoliday.name} ${nextHoliday.daysUntil} 天`
              : `農曆 ${todayInfo.lunarFull}`
            : syncStatus}
        </span>
      </div>

      {/* MONTH VIEW (Gregorian + Lunar + Taiwan National Holidays + 24 Solar Terms) */}
      {view === 'month' && (
        <div className="flex-1 flex flex-col min-h-0 pt-1.5">
          {/* Weekday Header */}
          <div className="grid grid-cols-7 text-center pb-1 shrink-0">
            {WEEKDAY_HEADERS.map((wd, idx) => (
              <div
                key={wd}
                className={`${
                  deviceScale === 'tablet10' ? 'text-[13px]' : 'text-[11px]'
                } font-extrabold ${
                  idx === 0 || idx === 6 ? 'underline underline-offset-2' : 'text-[var(--fg-muted)]'
                }`}
              >
                {wd}
              </div>
            ))}
          </div>

          {/* Calendar Grid */}
          <div
            className={`flex-1 grid grid-cols-7 border-t border-l border-[var(--border-subtle)] min-h-0 ${
              monthCells.length > 35 ? 'grid-rows-6' : 'grid-rows-5'
            }`}
          >
            {monthCells.map(({ info, isCurrentMonth, isToday }) => {
              const isSelected = isSameDay(info.date, selectedDate);
              const hasEvent = events.some((ev) => isSameDay(ev.date, info.date));
              const isHoliday = info.cellBadgeType === 'holiday';
              const isSolarTerm = info.cellBadgeType === 'solarTerm';

              return (
                <button
                  key={`${info.year}-${info.month}-${info.day}`}
                  type="button"
                  onClick={() => setSelectedDate(info.date)}
                  className={`relative flex flex-col items-center justify-center border-r border-b border-[var(--border-subtle)] px-0.5 py-0.5 text-center cursor-pointer transition-colors ${
                    !isCurrentMonth ? 'opacity-35' : ''
                  } ${
                    isToday
                      ? 'bg-[var(--surface-active)] text-[var(--fg-inverse)]'
                      : isSelected
                        ? 'bg-[var(--surface-subtle)] outline-2 -outline-offset-2 outline-[var(--border-color)]'
                        : isHoliday
                          ? 'bg-[var(--surface-subtle)]'
                          : 'bg-[var(--bg-color)]'
                  }`}
                >
                  <div className="flex items-center justify-center gap-0.5 leading-none">
                    <span className={`${dayNumClass} font-extrabold font-num`}>{info.day}</span>
                    {hasEvent && (
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          isToday ? 'bg-[var(--fg-inverse)]' : 'bg-[var(--fg-color)]'
                        }`}
                        aria-label="有行程"
                      />
                    )}
                  </div>
                  <span
                    className={`mt-0.5 ${lunarSubClass} leading-tight truncate max-w-full ${
                      isToday
                        ? 'font-extrabold text-[var(--fg-inverse)]'
                        : isHoliday
                          ? 'font-black underline underline-offset-2'
                          : isSolarTerm
                            ? 'font-extrabold'
                            : 'font-medium text-[var(--fg-muted)]'
                    }`}
                  >
                    {info.cellBadgeText}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Selected Day Info Strip */}
          <div
            className={`pt-1.5 flex items-center justify-between gap-2 ${
              deviceScale === 'tablet10' ? 'text-[14px]' : deviceScale === 'phone' ? 'text-[11px]' : 'text-[12px]'
            } shrink-0`}
          >
            <div className="flex items-center gap-1.5 min-w-0 truncate">
              <span className="font-extrabold font-num whitespace-nowrap">
                {selectedInfo.month}/{selectedInfo.day}（{selectedInfo.weekdayLabel}）
              </span>
              <span aria-hidden="true" className="text-[var(--fg-muted)]">·</span>
              <span className="font-bold whitespace-nowrap">
                農曆 {selectedInfo.lunarMonthText}
                {selectedInfo.lunarDayText}
              </span>
              {selectedInfo.holiday && (
                <>
                  <span aria-hidden="true" className="text-[var(--fg-muted)]">·</span>
                  <span className="font-black underline underline-offset-2 whitespace-nowrap">
                    國定假日：{selectedInfo.holiday}
                  </span>
                </>
              )}
              {selectedInfo.solarTerm && (
                <>
                  <span aria-hidden="true" className="text-[var(--fg-muted)]">·</span>
                  <span className="font-extrabold whitespace-nowrap">
                    節氣：{selectedInfo.solarTerm}
                  </span>
                </>
              )}
              {!selectedInfo.holiday && selectedInfo.festival && (
                <>
                  <span aria-hidden="true" className="text-[var(--fg-muted)]">·</span>
                  <span className="font-bold whitespace-nowrap">{selectedInfo.festival}</span>
                </>
              )}
            </div>
            {selectedDayEvents.length > 0 && (
              <span className="text-[11px] font-extrabold whitespace-nowrap truncate max-w-[40%]">
                行程：{selectedDayEvents[0].summary}
                {selectedDayEvents.length > 1 ? ` +${selectedDayEvents.length - 1}` : ''}
              </span>
            )}
          </div>
        </div>
      )}

      {/* AGENDA VIEW (Google Calendar Events + Upcoming Taiwan National Holidays) */}
      {view === 'agenda' && (
        <div className="flex-1 flex flex-col gap-2 pt-2 overflow-y-auto min-h-0">
          {/* Today's Lunar & Holiday Summary */}
          <div
            className={`flex flex-wrap items-center justify-between gap-1 ${
              deviceScale === 'tablet10' ? 'text-[14px] px-3 py-2' : 'text-[12px] px-2.5 py-1.5'
            } font-bold bg-[var(--surface-subtle)] border border-[var(--border-subtle)] rounded-[6px] shrink-0`}
          >
            <span>
              農曆 {todayInfo.lunarFull}（{todayInfo.lunarZodiac}年）
              {todayInfo.solarTerm ? ` · ${todayInfo.solarTerm}` : ''}
            </span>
            {todayInfo.holiday ? (
              <span className="font-black underline underline-offset-2">
                今日國定假日：{todayInfo.holiday}
              </span>
            ) : nextHoliday ? (
              <span className="font-num text-[var(--fg-muted)]">
                下次假日：{nextHoliday.name}（{nextHoliday.date.getMonth() + 1}/
                {nextHoliday.date.getDate()}，{nextHoliday.daysUntil}天後）
              </span>
            ) : null}
          </div>

          {/* Google Calendar Events */}
          <div className="flex flex-col">
            <div className="text-[11px] font-extrabold text-[var(--fg-muted)] pb-1">
              Google 日曆行程
            </div>
            {!hasIcalUrl ? (
              <div className="flex items-center justify-between gap-2 py-2 border-t border-[var(--border-subtle)] text-[13px]">
                <span className="font-semibold text-[var(--fg-muted)]">
                  尚未連結 Google 日曆 iCal 網址
                </span>
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="px-2.5 py-1 text-[12px] font-bold border-[1.5px] border-[var(--border-color)] rounded-[5px] cursor-pointer whitespace-nowrap"
                >
                  前往設定
                </button>
              </div>
            ) : events.length === 0 ? (
              <div className="py-2 border-t border-[var(--border-subtle)] text-[13px] font-semibold text-[var(--fg-muted)]">
                近期無排定行程
              </div>
            ) : (
              <ul className="list-none flex flex-col divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)]">
                {events.slice(0, 6).map((ev) => (
                  <li
                    key={ev.id}
                    className={`py-2 flex items-center gap-3 ${
                      deviceScale === 'tablet10' ? 'text-[16px]' : 'text-[14px]'
                    }`}
                  >
                    <span className="text-[12px] font-extrabold font-num whitespace-nowrap w-[84px] shrink-0">
                      {ev.timeLabel}
                    </span>
                    <span className="font-bold truncate">{ev.summary}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Upcoming Taiwan National Holidays */}
          {upcomingHolidays.length > 0 && (
            <div className="flex flex-col pt-1">
              <div className="text-[11px] font-extrabold text-[var(--fg-muted)] pb-1">
                近期台灣國定假日
              </div>
              <ul className="list-none flex flex-col divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)]">
                {upcomingHolidays.map((h) => (
                  <li
                    key={`${h.date.getTime()}-${h.name}`}
                    className={`py-1.5 flex items-center justify-between gap-2 ${
                      deviceScale === 'tablet10' ? 'text-[15px]' : 'text-[13px]'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="text-[12px] font-extrabold font-num whitespace-nowrap w-[78px] shrink-0">
                        {h.date.getMonth() + 1}/{h.date.getDate()}（
                        {WEEKDAY_HEADERS[h.date.getDay()]}）
                      </span>
                      <span className="font-extrabold truncate">{h.name}</span>
                      <span className="text-[11px] font-semibold text-[var(--fg-muted)] whitespace-nowrap">
                        農曆 {h.lunarText}
                      </span>
                    </div>
                    <span className="text-[11px] font-bold font-num text-[var(--fg-muted)] whitespace-nowrap">
                      {h.daysUntil === 0 ? '今天' : `${h.daysUntil} 天後`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
