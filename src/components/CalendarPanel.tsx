import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, CheckSquare, ChevronLeft, ChevronRight, Maximize2, X } from 'lucide-react';
import {
  getMonthCalendarCells,
  getTaiwanDayInfo,
  getUpcomingTaiwanHolidays,
  isSameDay,
  type TaiwanDayInfo,
} from '../utils/taiwanCalendar';
import type { GoogleTaskItem } from '../utils/googleWorkspace';
import { GoogleSignInButton } from './GoogleSignInButton';
import type { DeviceScale } from './WeatherPanel';

export interface CalendarEventItem {
  id: string;
  date: Date;
  timeLabel: string;
  summary: string;
  isAllDay: boolean;
  kind?: 'event' | 'task';
  listTitle?: string;
  notes?: string;
}

interface CalendarPanelProps {
  today: Date;
  events: CalendarEventItem[];
  tasks: GoogleTaskItem[];
  hasIcalUrl: boolean;
  isGoogleConnected: boolean;
  needsGoogleAuth: boolean;
  googleUserEmail: string | null;
  googleAuthLoading: boolean;
  syncStatus: string;
  calendarError?: string | null;
  isLandscape: boolean;
  deviceScale: DeviceScale;
  onGoogleSignIn: () => void;
  onOpenSettings: () => void;
}

type CalendarView = 'agenda' | 'month';
type EventModalMode = 'day' | 'all' | 'tasks' | null;

const WEEKDAY_HEADERS = ['日', '一', '二', '三', '四', '五', '六'];

export function CalendarPanel({
  today,
  events,
  tasks,
  hasIcalUrl,
  isGoogleConnected,
  needsGoogleAuth,
  googleUserEmail,
  googleAuthLoading,
  syncStatus,
  calendarError = null,
  isLandscape,
  deviceScale,
  onGoogleSignIn,
  onOpenSettings,
}: CalendarPanelProps) {
  const [view, setView] = useState<CalendarView>('month');
  const [cursorYear, setCursorYear] = useState<number>(() => today.getFullYear());
  const [cursorMonth, setCursorMonth] = useState<number>(() => today.getMonth());
  const [selectedDate, setSelectedDate] = useState<Date>(() => today);
  const [eventModalMode, setEventModalMode] = useState<EventModalMode>(null);

  const hasCalendarSource = isGoogleConnected || hasIcalUrl;

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

  const selectedDayTasks = useMemo(
    () => tasks.filter((t) => t.dueDate !== null && isSameDay(t.dueDate, selectedDate)),
    [tasks, selectedDate]
  );

  const upcomingEvents = useMemo(
    () => events.filter((ev) => ev.date >= stableToday),
    [events, stableToday]
  );

  const totalBadgeCount = upcomingEvents.length + tasks.length;

  // 依日期分組全部未來行程與有截止日的待辦工作（供放大檢視清單使用）
  const groupedUpcomingEvents = useMemo(() => {
    const datedTasksAsItems: CalendarEventItem[] = tasks
      .filter((t): t is GoogleTaskItem & { dueDate: Date } => t.dueDate !== null && t.dueDate >= stableToday)
      .map((t) => ({
        id: `task-${t.id}`,
        date: t.dueDate,
        timeLabel: `${t.dueLabel} 待辦`,
        summary: t.title,
        isAllDay: true,
        kind: 'task',
        listTitle: t.listTitle,
        notes: t.notes,
      }));

    const combined = [...upcomingEvents, ...datedTasksAsItems].sort(
      (a, b) => a.date.getTime() - b.date.getTime()
    );

    const groups: { key: string; date: Date; info: TaiwanDayInfo; items: CalendarEventItem[] }[] = [];
    for (const ev of combined) {
      const key = `${ev.date.getFullYear()}-${ev.date.getMonth()}-${ev.date.getDate()}`;
      const last = groups[groups.length - 1];
      if (last && last.key === key) {
        last.items.push(ev);
      } else {
        const dayDate = new Date(ev.date.getFullYear(), ev.date.getMonth(), ev.date.getDate());
        groups.push({
          key,
          date: dayDate,
          info: getTaiwanDayInfo(dayDate),
          items: [ev],
        });
      }
    }
    return groups;
  }, [upcomingEvents, tasks, stableToday]);

  // Esc 鍵關閉放大行程視窗
  useEffect(() => {
    if (!eventModalMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setEventModalMode(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [eventModalMode]);

  const handleShiftSelectedDay = (deltaDays: number) => {
    setSelectedDate((prev) => {
      const next = new Date(prev.getFullYear(), prev.getMonth(), prev.getDate() + deltaDays);
      setCursorYear(next.getFullYear());
      setCursorMonth(next.getMonth());
      return next;
    });
  };

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

  // compact4 (4.3吋)、phone (Viwoods) 與 reader6 (6吋) 皆採獨立第 2 頁全畫面顯示，字體更清晰寬鬆
  const dayNumClass =
    deviceScale === 'tablet10'
      ? 'text-[length:calc(20px*var(--fs))]'
      : deviceScale === 'reader6'
        ? 'text-[length:calc(18px*var(--fs))]'
        : deviceScale === 'phone'
          ? 'text-[length:calc(16.5px*var(--fs))]'
          : 'text-[length:calc(15px*var(--fs))]';

  const lunarSubClass =
    deviceScale === 'tablet10'
      ? 'text-[length:calc(13px*var(--fs))]'
      : deviceScale === 'reader6'
        ? 'text-[length:calc(12px*var(--fs))]'
        : deviceScale === 'phone'
          ? 'text-[length:calc(11px*var(--fs))]'
          : 'text-[length:calc(10.5px*var(--fs))]';

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
                deviceScale === 'tablet10'
                  ? 'px-3 py-1 text-[length:calc(14.5px*var(--fs-ctrl))]'
                  : 'px-2.5 py-0.5 text-[length:calc(12.5px*var(--fs-ctrl))]'
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
                deviceScale === 'tablet10'
                  ? 'px-3 py-1 text-[length:calc(14.5px*var(--fs-ctrl))]'
                  : 'px-2.5 py-0.5 text-[length:calc(12.5px*var(--fs-ctrl))]'
              } font-extrabold whitespace-nowrap cursor-pointer ${
                view === 'agenda'
                  ? 'bg-[var(--surface-active)] text-[var(--fg-inverse)]'
                  : 'bg-[var(--bg-color)] text-[var(--fg-color)]'
              }`}
            >
              近期日程
              {hasCalendarSource && calendarError
                ? ' (!)'
                : hasCalendarSource && totalBadgeCount > 0
                  ? ` (${totalBadgeCount})`
                  : ''}
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
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span
                className={`${
                  deviceScale === 'tablet10'
                    ? 'text-[length:calc(18px*var(--fs))]'
                    : 'text-[length:calc(14px*var(--fs))]'
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
                <ChevronRight className="w-4 h-4" />
              </button>
              {!isViewingCurrentMonth && (
                <button
                  type="button"
                  onClick={handleGoToday}
                  className="ml-0.5 px-2 py-0.5 text-[length:calc(12px*var(--fs-ctrl))] font-bold border border-[var(--border-color)] rounded cursor-pointer whitespace-nowrap"
                >
                  今天
                </button>
              )}
            </div>
          )}
        </div>

        {view === 'month' && hasCalendarSource && calendarError ? (
          <button
            type="button"
            onClick={onOpenSettings}
            className={`${
              deviceScale === 'tablet10'
                ? 'text-[length:calc(13.5px*var(--fs))]'
                : 'text-[length:calc(11.5px*var(--fs))]'
            } font-black underline underline-offset-2 whitespace-nowrap truncate cursor-pointer`}
            title={calendarError}
          >
            日曆同步異常（點此檢查）
          </button>
        ) : (
          <span
            className={`${
              deviceScale === 'tablet10'
                ? 'text-[length:calc(14.5px*var(--fs))]'
                : 'text-[length:calc(12px*var(--fs))]'
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
        )}
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
                  deviceScale === 'tablet10'
                    ? 'text-[length:calc(14.5px*var(--fs))]'
                    : 'text-[length:calc(12px*var(--fs))]'
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
              const dayEventCount = events.filter((ev) => isSameDay(ev.date, info.date)).length;
              const dayTaskCount = tasks.filter(
                (t) => t.dueDate !== null && isSameDay(t.dueDate, info.date)
              ).length;
              const dayTotalCount = dayEventCount + dayTaskCount;
              const isHoliday = info.cellBadgeType === 'holiday';
              const isSolarTerm = info.cellBadgeType === 'solarTerm';

              return (
                <button
                  key={`${info.year}-${info.month}-${info.day}`}
                  type="button"
                  onClick={() => {
                    if (isSelected && dayTotalCount > 0) {
                      setEventModalMode('day');
                    } else {
                      setSelectedDate(info.date);
                    }
                  }}
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
                    {dayTotalCount > 0 && (
                      <span
                        className="inline-flex items-center gap-[2px]"
                        aria-label={`有 ${dayEventCount} 筆行程與 ${dayTaskCount} 筆待辦`}
                      >
                        {dayEventCount > 0 && (
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              isToday ? 'bg-[var(--fg-inverse)]' : 'bg-[var(--fg-color)]'
                            }`}
                          />
                        )}
                        {dayEventCount > 1 && (
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              isToday ? 'bg-[var(--fg-inverse)]' : 'bg-[var(--fg-color)]'
                            }`}
                          />
                        )}
                        {dayTaskCount > 0 && (
                          <span
                            className={`w-1.5 h-1.5 border-[1.5px] ${
                              isToday ? 'border-[var(--fg-inverse)]' : 'border-[var(--fg-color)]'
                            }`}
                          />
                        )}
                      </span>
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
            className={`pt-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 ${
              deviceScale === 'tablet10'
                ? 'text-[length:calc(15.5px*var(--fs))]'
                : deviceScale === 'reader6'
                  ? 'text-[length:calc(14px*var(--fs))]'
                  : deviceScale === 'phone'
                    ? 'text-[length:calc(13px*var(--fs))]'
                    : 'text-[length:calc(12.5px*var(--fs))]'
            } shrink-0`}
          >
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0">
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
            {selectedDayEvents.length + selectedDayTasks.length > 0 ? (
              <button
                type="button"
                onClick={() => setEventModalMode('day')}
                className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[length:calc(12.5px*var(--fs))] font-extrabold border-[1.5px] border-[var(--border-color)] rounded-[5px] bg-[var(--surface-subtle)] text-[var(--fg-color)] cursor-pointer max-w-full active:bg-[var(--surface-active)] active:text-[var(--fg-inverse)]"
                title="點擊放大檢視當日所有行程與待辦工作"
              >
                <span className="truncate">
                  {selectedDayEvents.length > 0
                    ? `行程：${selectedDayEvents[0].summary}`
                    : `待辦：${selectedDayTasks[0].title}`}
                </span>
                {selectedDayEvents.length + selectedDayTasks.length > 1 && (
                  <span className="px-1 py-0.25 text-[0.85em] font-black font-num rounded bg-[var(--surface-active)] text-[var(--fg-inverse)] whitespace-nowrap shrink-0">
                    共{selectedDayEvents.length + selectedDayTasks.length}筆
                  </span>
                )}
                <Maximize2 className="w-[0.95em] h-[0.95em] shrink-0" />
              </button>
            ) : tasks.length > 0 ? (
              <button
                type="button"
                onClick={() => setEventModalMode('tasks')}
                className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[length:calc(12.5px*var(--fs))] font-extrabold border-[1.5px] border-[var(--border-color)] rounded-[5px] bg-[var(--bg-color)] text-[var(--fg-color)] cursor-pointer whitespace-nowrap shrink-0"
                title="檢視所有 Google 待辦工作"
              >
                <CheckSquare className="w-[0.95em] h-[0.95em] shrink-0" />
                <span className="font-num">待辦工作 {tasks.length} 筆</span>
                <Maximize2 className="w-[0.9em] h-[0.9em] shrink-0" />
              </button>
            ) : hasCalendarSource && calendarError ? (
              <button
                type="button"
                onClick={onOpenSettings}
                className="text-[length:calc(12px*var(--fs))] font-bold underline underline-offset-2 truncate max-w-full cursor-pointer"
              >
                {calendarError}
              </button>
            ) : !hasCalendarSource ? (
              <button
                type="button"
                onClick={onGoogleSignIn}
                disabled={googleAuthLoading}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[length:calc(12px*var(--fs-ctrl))] font-extrabold border border-[var(--border-color)] rounded-[5px] bg-[var(--bg-color)] text-[var(--fg-color)] cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                {googleAuthLoading ? '登入中...' : '登入 Google 同步行程與待辦'}
              </button>
            ) : null}
          </div>
        </div>
      )}

      {/* AGENDA VIEW (Google Calendar Events + Upcoming Taiwan National Holidays) */}
      {view === 'agenda' && (
        <div className="flex-1 flex flex-col gap-2 pt-2 overflow-y-auto min-h-0">
          {/* Today's Lunar & Holiday Summary */}
          <div
            className={`flex flex-wrap items-center justify-between gap-1 ${
              deviceScale === 'tablet10'
                ? 'text-[length:calc(15.5px*var(--fs))] px-3 py-2'
                : 'text-[length:calc(13px*var(--fs))] px-2.5 py-1.5'
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

          {/* Google 帳號重新授權提示（當曾登入但記憶體憑證因重整頁面失效時） */}
          {needsGoogleAuth && !isGoogleConnected && googleUserEmail && (
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-[1.5px] border-[var(--border-color)] rounded-[6px] bg-[var(--surface-subtle)] shrink-0">
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-[length:calc(13px*var(--fs))] font-black">
                  請重新授權 Google 帳號（{googleUserEmail}）
                </span>
                <span className="text-[length:calc(11.5px*var(--fs))] font-semibold text-[var(--fg-muted)]">
                  重新載入頁面後需再次驗證，以讀取最新日曆活動與待辦工作。
                </span>
              </div>
              <GoogleSignInButton
                onClick={onGoogleSignIn}
                loading={googleAuthLoading}
                label="Sign in with Google"
                compact
              />
            </div>
          )}

          {/* Google Calendar Events */}
          <div className="flex flex-col">
            <div className="flex items-center justify-between gap-2 pb-1">
              <span className="text-[length:calc(12.5px*var(--fs))] font-extrabold text-[var(--fg-muted)]">
                Google 日曆活動（點擊可放大查看全部）
              </span>
              {upcomingEvents.length > 0 && (
                <button
                  type="button"
                  onClick={() => setEventModalMode('all')}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[length:calc(12px*var(--fs-ctrl))] font-extrabold border border-[var(--border-color)] rounded-[5px] bg-[var(--bg-color)] text-[var(--fg-color)] cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Maximize2 className="w-[0.9em] h-[0.9em]" />
                  展開全部 ({upcomingEvents.length})
                </button>
              )}
            </div>
            {!hasCalendarSource ? (
              <div className="flex flex-col gap-2.5 py-2.5 px-3 border border-[var(--border-subtle)] rounded-[6px] bg-[var(--surface-subtle)]">
                <span className="text-[length:calc(13.5px*var(--fs))] font-bold leading-[1.45]">
                  直接登入您的 Google 帳號，即可同步顯示「日曆活動」與「Google 待辦工作」。
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <GoogleSignInButton
                    onClick={onGoogleSignIn}
                    loading={googleAuthLoading}
                    label="Sign in with Google"
                    compact
                  />
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    className="px-2.5 py-1.5 text-[length:calc(12.5px*var(--fs-ctrl))] font-bold border border-[var(--border-color)] rounded-[5px] bg-[var(--bg-color)] cursor-pointer whitespace-nowrap"
                  >
                    或貼上 .ics 網址
                  </button>
                </div>
              </div>
            ) : calendarError ? (
              <div className="flex flex-col gap-2 py-2 px-2.5 border border-[var(--border-color)] rounded-[6px] bg-[var(--surface-subtle)] text-[length:calc(13px*var(--fs))]">
                <span className="font-extrabold leading-[1.45]">{calendarError}</span>
                <div className="flex flex-wrap items-center gap-2">
                  <GoogleSignInButton
                    onClick={onGoogleSignIn}
                    loading={googleAuthLoading}
                    label="Sign in with Google"
                    compact
                  />
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    className="px-2.5 py-1.5 text-[length:calc(12.5px*var(--fs-ctrl))] font-extrabold border-[1.5px] border-[var(--border-color)] rounded-[5px] bg-[var(--bg-color)] cursor-pointer whitespace-nowrap"
                  >
                    檢查日曆設定
                  </button>
                </div>
              </div>
            ) : upcomingEvents.length === 0 ? (
              <div className="py-2 border-t border-[var(--border-subtle)] text-[length:calc(14px*var(--fs))] font-semibold text-[var(--fg-muted)]">
                未來 60 天內無排定活動（{syncStatus}）
              </div>
            ) : (
              <>
                <ul className="list-none flex flex-col divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)]">
                  {upcomingEvents.slice(0, 8).map((ev) => (
                    <li key={ev.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedDate(
                            new Date(ev.date.getFullYear(), ev.date.getMonth(), ev.date.getDate())
                          );
                          setEventModalMode('all');
                        }}
                        className={`w-full py-2 flex items-center gap-3 text-left cursor-pointer hover:bg-[var(--surface-subtle)] ${
                          deviceScale === 'tablet10'
                            ? 'text-[length:calc(17.5px*var(--fs))]'
                            : 'text-[length:calc(14.5px*var(--fs))]'
                        }`}
                      >
                        <span className="text-[length:calc(13.5px*var(--fs))] font-extrabold font-num whitespace-nowrap min-w-[6.2em] shrink-0">
                          {ev.timeLabel}
                        </span>
                        <span className="font-bold truncate flex-1">{ev.summary}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {upcomingEvents.length > 8 && (
                  <button
                    type="button"
                    onClick={() => setEventModalMode('all')}
                    className="mt-1.5 py-1.5 px-3 text-[length:calc(13px*var(--fs))] font-extrabold border-[1.5px] border-[var(--border-color)] rounded-[6px] bg-[var(--surface-subtle)] text-[var(--fg-color)] cursor-pointer"
                  >
                    尚有 {upcomingEvents.length - 8} 筆活動，點此放大查看全部
                  </button>
                )}
              </>
            )}
          </div>

          {/* Google Tasks（待辦工作） */}
          {(isGoogleConnected || hasIcalUrl) && (
            <div className="flex flex-col pt-1">
              <div className="flex items-center justify-between gap-2 pb-1">
                <span className="text-[length:calc(12.5px*var(--fs))] font-extrabold text-[var(--fg-muted)] flex items-center gap-1">
                  <CheckSquare className="w-[1em] h-[1em] shrink-0" />
                  Google 待辦工作（Tasks）
                </span>
                {tasks.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setEventModalMode('tasks')}
                    className="inline-flex items-center gap-1 px-2 py-0.5 text-[length:calc(12px*var(--fs-ctrl))] font-extrabold border border-[var(--border-color)] rounded-[5px] bg-[var(--bg-color)] text-[var(--fg-color)] cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Maximize2 className="w-[0.9em] h-[0.9em]" />
                    展開全部 ({tasks.length})
                  </button>
                )}
              </div>

              {!isGoogleConnected ? (
                <div className="flex flex-wrap items-center justify-between gap-2 py-2 px-2.5 border border-[var(--border-subtle)] rounded-[6px] bg-[var(--surface-subtle)]">
                  <span className="text-[length:calc(12.5px*var(--fs))] font-semibold text-[var(--fg-muted)]">
                    .ics 僅含日曆活動；登入 Google 帳號可一併顯示待辦工作
                  </span>
                  <GoogleSignInButton
                    onClick={onGoogleSignIn}
                    loading={googleAuthLoading}
                    label="Sign in with Google"
                    compact
                  />
                </div>
              ) : tasks.length === 0 ? (
                <div className="py-2 border-t border-[var(--border-subtle)] text-[length:calc(13.5px*var(--fs))] font-semibold text-[var(--fg-muted)]">
                  目前無未完成的待辦工作
                </div>
              ) : (
                <>
                  <ul className="list-none flex flex-col divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)]">
                    {tasks.slice(0, 6).map((task) => (
                      <li key={task.id}>
                        <button
                          type="button"
                          onClick={() => setEventModalMode('tasks')}
                          className={`w-full py-2 flex items-center gap-2.5 text-left cursor-pointer hover:bg-[var(--surface-subtle)] ${
                            deviceScale === 'tablet10'
                              ? 'text-[length:calc(17px*var(--fs))]'
                              : 'text-[length:calc(14px*var(--fs))]'
                          }`}
                        >
                          <span
                            className={`px-1.5 py-0.5 text-[length:calc(12px*var(--fs))] font-extrabold font-num rounded-[4px] border whitespace-nowrap shrink-0 ${
                              task.isOverdue
                                ? 'bg-[var(--surface-active)] text-[var(--fg-inverse)] border-[var(--border-color)]'
                                : 'bg-[var(--surface-subtle)] text-[var(--fg-color)] border-[var(--border-subtle)]'
                            }`}
                          >
                            {task.isOverdue ? `逾期 ${task.dueLabel}` : task.dueLabel}
                          </span>
                          <span className="font-bold truncate flex-1">{task.title}</span>
                          <span className="text-[length:calc(11.5px*var(--fs))] font-semibold text-[var(--fg-muted)] whitespace-nowrap shrink-0">
                            {task.listTitle}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {tasks.length > 6 && (
                    <button
                      type="button"
                      onClick={() => setEventModalMode('tasks')}
                      className="mt-1.5 py-1.5 px-3 text-[length:calc(13px*var(--fs))] font-extrabold border-[1.5px] border-[var(--border-color)] rounded-[6px] bg-[var(--surface-subtle)] text-[var(--fg-color)] cursor-pointer"
                    >
                      尚有 {tasks.length - 6} 筆待辦工作，點此放大查看全部
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {/* Upcoming Taiwan National Holidays */}
          {upcomingHolidays.length > 0 && (
            <div className="flex flex-col pt-1">
              <div className="text-[length:calc(12.5px*var(--fs))] font-extrabold text-[var(--fg-muted)] pb-1">
                近期台灣國定假日
              </div>
              <ul className="list-none flex flex-col divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)]">
                {upcomingHolidays.map((h) => (
                  <li
                    key={`${h.date.getTime()}-${h.name}`}
                    className={`py-1.5 flex items-center justify-between gap-2 ${
                      deviceScale === 'tablet10'
                        ? 'text-[length:calc(16.5px*var(--fs))]'
                        : 'text-[length:calc(14px*var(--fs))]'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="text-[length:calc(13.5px*var(--fs))] font-extrabold font-num whitespace-nowrap min-w-[5.6em] shrink-0">
                        {h.date.getMonth() + 1}/{h.date.getDate()}（
                        {WEEKDAY_HEADERS[h.date.getDay()]}）
                      </span>
                      <span className="font-extrabold truncate">{h.name}</span>
                      <span className="text-[length:calc(12.5px*var(--fs))] font-semibold text-[var(--fg-muted)] whitespace-nowrap">
                        農曆 {h.lunarText}
                      </span>
                    </div>
                    <span className="text-[length:calc(12.5px*var(--fs))] font-bold font-num text-[var(--fg-muted)] whitespace-nowrap">
                      {h.daysUntil === 0 ? '今天' : `${h.daysUntil} 天後`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* 放大檢視所有行程彈窗（支援完整換行顯示當日多筆行程與全部近期行程） */}
      {eventModalMode && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="放大檢視行程列表"
          className="fixed inset-0 z-[95] bg-[var(--bg-color)] text-[var(--fg-color)] p-3 sm:p-6 flex flex-col items-center justify-center overflow-hidden"
        >
          <div className="w-full max-w-[760px] max-h-full flex flex-col border-2 border-[var(--border-color)] rounded-[10px] p-4 sm:p-5 bg-[var(--bg-color)]">
            {/* Modal Header */}
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b-2 border-[var(--border-color)] shrink-0">
              <div className="flex flex-wrap items-center gap-2">
                <CalendarDays className="w-[1.2em] h-[1.2em] text-[length:calc(18px*var(--fs))] shrink-0" />
                <div
                  role="tablist"
                  aria-label="行程檢視範圍切換"
                  className="inline-flex items-center border-[1.5px] border-[var(--border-color)] rounded-[6px] overflow-hidden"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={eventModalMode === 'day'}
                    onClick={() => setEventModalMode('day')}
                    className={`px-3 py-1 text-[length:calc(14px*var(--fs))] font-black cursor-pointer whitespace-nowrap ${
                      eventModalMode === 'day'
                        ? 'bg-[var(--surface-active)] text-[var(--fg-inverse)]'
                        : 'bg-[var(--bg-color)] text-[var(--fg-color)]'
                    }`}
                  >
                    當日（{selectedInfo.month}/{selectedInfo.day}）
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={eventModalMode === 'all'}
                    onClick={() => setEventModalMode('all')}
                    className={`px-3 py-1 text-[length:calc(14px*var(--fs))] font-black cursor-pointer whitespace-nowrap border-l-[1.5px] border-[var(--border-color)] ${
                      eventModalMode === 'all'
                        ? 'bg-[var(--surface-active)] text-[var(--fg-inverse)]'
                        : 'bg-[var(--bg-color)] text-[var(--fg-color)]'
                    }`}
                  >
                    全部日程（{upcomingEvents.length}）
                  </button>
                  {isGoogleConnected && (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={eventModalMode === 'tasks'}
                      onClick={() => setEventModalMode('tasks')}
                      className={`px-3 py-1 text-[length:calc(14px*var(--fs))] font-black cursor-pointer whitespace-nowrap border-l-[1.5px] border-[var(--border-color)] ${
                        eventModalMode === 'tasks'
                          ? 'bg-[var(--surface-active)] text-[var(--fg-inverse)]'
                          : 'bg-[var(--bg-color)] text-[var(--fg-color)]'
                      }`}
                    >
                      待辦工作（{tasks.length}）
                    </button>
                  )}
                </div>
              </div>

              <button
                type="button"
                onClick={() => setEventModalMode(null)}
                className="inline-flex items-center gap-1 px-3 py-1 text-[length:calc(14px*var(--fs))] font-black border-2 border-[var(--border-color)] rounded-[6px] bg-[var(--surface-active)] text-[var(--fg-inverse)] cursor-pointer whitespace-nowrap"
              >
                <X className="w-[1.05em] h-[1.05em]" />
                關閉
              </button>
            </div>

            {/* Modal Content */}
            <div className="flex-1 overflow-y-auto pt-3 min-h-0 flex flex-col gap-3">
              {eventModalMode === 'day' ? (
                <>
                  {/* Day Navigation & Info */}
                  <div className="flex flex-wrap items-center justify-between gap-2 bg-[var(--surface-subtle)] border border-[var(--border-subtle)] rounded-[8px] px-3 py-2 shrink-0">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-[length:calc(18px*var(--fs))] font-black font-num">
                        {selectedInfo.year}/{selectedInfo.month}/{selectedInfo.day}（
                        {selectedInfo.weekdayLabel}）
                      </span>
                      <span className="text-[length:calc(14px*var(--fs))] font-bold text-[var(--fg-muted)]">
                        農曆 {selectedInfo.lunarMonthText}
                        {selectedInfo.lunarDayText}
                        {selectedInfo.holiday ? ` · 國定假日：${selectedInfo.holiday}` : ''}
                        {selectedInfo.solarTerm ? ` · ${selectedInfo.solarTerm}` : ''}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleShiftSelectedDay(-1)}
                        className="inline-flex items-center gap-0.5 px-2 py-1 text-[length:calc(13px*var(--fs))] font-extrabold border border-[var(--border-color)] rounded-[5px] bg-[var(--bg-color)] cursor-pointer"
                      >
                        <ChevronLeft className="w-[1em] h-[1em]" />
                        前一天
                      </button>
                      <button
                        type="button"
                        onClick={() => handleShiftSelectedDay(1)}
                        className="inline-flex items-center gap-0.5 px-2 py-1 text-[length:calc(13px*var(--fs))] font-extrabold border border-[var(--border-color)] rounded-[5px] bg-[var(--bg-color)] cursor-pointer"
                      >
                        後一天
                        <ChevronRight className="w-[1em] h-[1em]" />
                      </button>
                    </div>
                  </div>

                  {selectedDayEvents.length === 0 && selectedDayTasks.length === 0 ? (
                    <div className="py-8 text-center text-[length:calc(16px*var(--fs))] font-bold text-[var(--fg-muted)]">
                      這一天沒有排定行程或到期之待辦工作
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {selectedDayEvents.length > 0 && (
                        <div>
                          <div className="text-[length:calc(13px*var(--fs))] font-extrabold text-[var(--fg-muted)] pb-1.5">
                            日曆活動（{selectedDayEvents.length} 筆）
                          </div>
                          <ul className="list-none flex flex-col divide-y-2 divide-[var(--border-subtle)] border-y-2 border-[var(--border-color)]">
                            {selectedDayEvents.map((ev, idx) => (
                              <li key={ev.id} className="py-3 flex items-start gap-3">
                                <span className="px-2 py-0.5 text-[length:calc(14px*var(--fs))] font-black font-num border-[1.5px] border-[var(--border-color)] rounded-[5px] bg-[var(--surface-subtle)] whitespace-nowrap shrink-0 mt-0.5">
                                  {ev.isAllDay ? '全天' : ev.timeLabel.split(' ')[1] || ev.timeLabel}
                                </span>
                                <div className="flex-1 min-w-0">
                                  <div className="text-[length:calc(18px*var(--fs))] font-black leading-[1.45] break-words whitespace-normal">
                                    {ev.summary}
                                  </div>
                                  <div className="text-[length:calc(12.5px*var(--fs))] font-bold text-[var(--fg-muted)] font-num mt-0.5">
                                    第 {idx + 1} / {selectedDayEvents.length} 項活動
                                  </div>
                                </div>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {selectedDayTasks.length > 0 && (
                        <div>
                          <div className="text-[length:calc(13px*var(--fs))] font-extrabold text-[var(--fg-muted)] pb-1.5 flex items-center gap-1">
                            <CheckSquare className="w-[1em] h-[1em]" />
                            當日到期之待辦工作（{selectedDayTasks.length} 筆）
                          </div>
                          <ul className="list-none flex flex-col divide-y-2 divide-[var(--border-subtle)] border-y-2 border-[var(--border-color)]">
                            {selectedDayTasks.map((task) => (
                              <li key={task.id} className="py-3 flex items-start gap-3">
                                <span
                                  className={`px-2 py-0.5 text-[length:calc(13.5px*var(--fs))] font-black border-[1.5px] border-[var(--border-color)] rounded-[5px] whitespace-nowrap shrink-0 mt-0.5 ${
                                    task.isOverdue
                                      ? 'bg-[var(--surface-active)] text-[var(--fg-inverse)]'
                                      : 'bg-[var(--bg-color)] text-[var(--fg-color)]'
                                  }`}
                                >
                                  {task.isOverdue ? '逾期待辦' : '待辦工作'}
                                </span>
                                <div className="flex-1 min-w-0">
                                  <div className="text-[length:calc(18px*var(--fs))] font-black leading-[1.45] break-words whitespace-normal">
                                    {task.title}
                                  </div>
                                  {task.notes && (
                                    <div className="text-[length:calc(14px*var(--fs))] font-semibold text-[var(--fg-muted)] leading-[1.45] break-words whitespace-pre-line mt-1">
                                      {task.notes}
                                    </div>
                                  )}
                                  <div className="text-[length:calc(12.5px*var(--fs))] font-bold text-[var(--fg-muted)] mt-0.5">
                                    清單：{task.listTitle}
                                  </div>
                                </div>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : eventModalMode === 'tasks' ? (
                tasks.length === 0 ? (
                  <div className="py-8 text-center text-[length:calc(16px*var(--fs))] font-bold text-[var(--fg-muted)]">
                    目前沒有未完成的 Google 待辦工作
                  </div>
                ) : (
                  <ul className="list-none flex flex-col divide-y-2 divide-[var(--border-subtle)] border-y-2 border-[var(--border-color)]">
                    {tasks.map((task) => (
                      <li key={task.id} className="py-3 flex items-start gap-3">
                        <span
                          className={`px-2 py-0.5 text-[length:calc(13.5px*var(--fs))] font-black font-num border-[1.5px] border-[var(--border-color)] rounded-[5px] whitespace-nowrap shrink-0 mt-0.5 ${
                            task.isOverdue
                              ? 'bg-[var(--surface-active)] text-[var(--fg-inverse)]'
                              : 'bg-[var(--surface-subtle)] text-[var(--fg-color)]'
                          }`}
                        >
                          {task.isOverdue ? `逾期 ${task.dueLabel}` : task.dueLabel}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-[length:calc(18px*var(--fs))] font-black leading-[1.45] break-words whitespace-normal">
                            {task.title}
                          </div>
                          {task.notes && (
                            <div className="text-[length:calc(14px*var(--fs))] font-semibold text-[var(--fg-muted)] leading-[1.45] break-words whitespace-pre-line mt-1">
                              {task.notes}
                            </div>
                          )}
                          <div className="text-[length:calc(12.5px*var(--fs))] font-bold text-[var(--fg-muted)] mt-0.5">
                            清單：{task.listTitle}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )
              ) : groupedUpcomingEvents.length === 0 ? (
                <div className="py-8 text-center text-[length:calc(16px*var(--fs))] font-bold text-[var(--fg-muted)]">
                  未來 60 天內無排定行程（{syncStatus}）
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {groupedUpcomingEvents.map((group) => {
                    const isGroupToday = isSameDay(group.date, stableToday);
                    return (
                      <div
                        key={group.key}
                        className="border-[1.5px] border-[var(--border-color)] rounded-[8px] overflow-hidden"
                      >
                        <div
                          className={`px-3 py-1.5 flex flex-wrap items-center justify-between gap-2 ${
                            isGroupToday
                              ? 'bg-[var(--surface-active)] text-[var(--fg-inverse)]'
                              : 'bg-[var(--surface-subtle)] text-[var(--fg-color)]'
                          } border-b border-[var(--border-color)]`}
                        >
                          <span className="text-[length:calc(15px*var(--fs))] font-black font-num">
                            {group.info.month}/{group.info.day}（{group.info.weekdayLabel}）
                            {isGroupToday ? ' · 今天' : ''}
                          </span>
                          <span
                            className={`text-[length:calc(12.5px*var(--fs))] font-bold ${
                              isGroupToday ? 'text-[var(--fg-inverse)]' : 'text-[var(--fg-muted)]'
                            }`}
                          >
                            農曆 {group.info.lunarMonthText}
                            {group.info.lunarDayText}
                            {group.info.holiday ? ` · ${group.info.holiday}` : ''} · 共{' '}
                            {group.items.length} 筆
                          </span>
                        </div>
                        <ul className="list-none flex flex-col divide-y divide-[var(--border-subtle)] bg-[var(--bg-color)]">
                          {group.items.map((ev) => (
                            <li key={ev.id} className="px-3 py-2.5 flex items-start gap-3">
                              <span
                                className={`text-[length:calc(14px*var(--fs))] font-extrabold font-num whitespace-nowrap min-w-[4.5em] shrink-0 pt-0.5 ${
                                  ev.kind === 'task'
                                    ? 'underline underline-offset-2'
                                    : ''
                                }`}
                              >
                                {ev.kind === 'task'
                                  ? '□ 待辦'
                                  : ev.isAllDay
                                    ? '全天'
                                    : ev.timeLabel.split(' ')[1] || ev.timeLabel}
                              </span>
                              <div className="flex-1 min-w-0">
                                <span className="text-[length:calc(16.5px*var(--fs))] font-extrabold leading-[1.45] break-words whitespace-normal block">
                                  {ev.summary}
                                </span>
                                {ev.notes && (
                                  <span className="text-[length:calc(13.5px*var(--fs))] font-semibold text-[var(--fg-muted)] leading-[1.4] break-words whitespace-pre-line block mt-0.5">
                                    {ev.notes}
                                  </span>
                                )}
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
