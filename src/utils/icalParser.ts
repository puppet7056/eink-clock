export interface ParsedCalendarEvent {
  id: string;
  date: Date;
  timeLabel: string;
  summary: string;
  isAllDay: boolean;
}

const WEEKDAY_MAP: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

function unescapeICalText(raw: string): string {
  return raw
    .replace(/\\n|\\N/g, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseICalDateValue(rawVal: string, params = ''): { date: Date; isAllDay: boolean } | null {
  const value = rawVal.trim();
  if (!value) return null;

  const isDateOnly = /VALUE=DATE\b/i.test(params) || /^\d{8}$/.test(value);
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/i);
  if (!match) return null;

  const y = Number(match[1]);
  const m = Number(match[2]) - 1;
  const d = Number(match[3]);
  const hh = match[4] ? Number(match[4]) : 0;
  const mm = match[5] ? Number(match[5]) : 0;
  const ss = match[6] ? Number(match[6]) : 0;
  const isUtc = Boolean(match[7]) || /TZID=(?:UTC|GMT|Etc\/UTC)/i.test(params);

  if (isDateOnly) {
    return { date: new Date(y, m, d, 0, 0, 0), isAllDay: true };
  }

  const parsed = isUtc
    ? new Date(Date.UTC(y, m, d, hh, mm, ss))
    : new Date(y, m, d, hh, mm, ss);

  if (Number.isNaN(parsed.getTime())) return null;
  return { date: parsed, isAllDay: false };
}

function parseRRule(rawRule: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const part of rawRule.trim().split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      map[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).trim();
    }
  }
  return map;
}

function withTimeFrom(baseDate: Date, targetY: number, targetM: number, targetD: number, isAllDay: boolean): Date {
  if (isAllDay) return new Date(targetY, targetM, targetD, 0, 0, 0);
  return new Date(targetY, targetM, targetD, baseDate.getHours(), baseDate.getMinutes(), baseDate.getSeconds());
}

function getNthWeekdayInMonth(year: number, month: number, weekday: number, nth: number): Date | null {
  if (nth > 0) {
    const first = new Date(year, month, 1);
    const offset = (weekday - first.getDay() + 7) % 7;
    const day = 1 + offset + (nth - 1) * 7;
    const d = new Date(year, month, day);
    return d.getMonth() === month ? d : null;
  }
  const last = new Date(year, month + 1, 0);
  const offset = (last.getDay() - weekday + 7) % 7;
  const day = last.getDate() - offset + (nth + 1) * 7;
  if (day < 1) return null;
  const d = new Date(year, month, day);
  return d.getMonth() === month ? d : null;
}

function expandRecurringStarts(
  dtStart: Date,
  isAllDay: boolean,
  rruleStr: string,
  windowStart: Date,
  windowEnd: Date
): Date[] {
  const rule = parseRRule(rruleStr);
  const freq = rule.FREQ;
  if (!freq) return [dtStart];

  const interval = Math.max(1, parseInt(rule.INTERVAL || '1', 10) || 1);
  const maxCount = rule.COUNT ? Math.max(1, parseInt(rule.COUNT, 10) || 0) : Infinity;
  let untilDate: Date | null = null;
  if (rule.UNTIL) {
    const parsedUntil = parseICalDateValue(rule.UNTIL);
    if (parsedUntil) {
      untilDate = parsedUntil.isAllDay
        ? new Date(
            parsedUntil.date.getFullYear(),
            parsedUntil.date.getMonth(),
            parsedUntil.date.getDate(),
            23,
            59,
            59
          )
        : parsedUntil.date;
    }
  }

  const effectiveEnd = untilDate && untilDate < windowEnd ? untilDate : windowEnd;
  if (dtStart > effectiveEnd) return [];

  const results: Date[] = [];
  const HARD_LIMIT = 4000;
  let emittedCount = 0;

  const pushIfValid = (candidate: Date): boolean => {
    if (candidate < dtStart) return true;
    if (candidate > effectiveEnd) return false;
    emittedCount += 1;
    if (emittedCount > maxCount) return false;
    if (candidate >= windowStart && candidate <= windowEnd) {
      results.push(candidate);
    }
    return emittedCount < maxCount;
  };

  if (freq === 'DAILY') {
    let cursor = new Date(dtStart.getTime());
    if (maxCount === Infinity && cursor < windowStart) {
      const diffDays = Math.floor((startOfDay(windowStart).getTime() - startOfDay(cursor).getTime()) / 86400000);
      const skipSteps = Math.max(0, Math.floor(diffDays / interval) - 1);
      cursor = withTimeFrom(dtStart, cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + skipSteps * interval, isAllDay);
    }
    for (let iter = 0; iter < HARD_LIMIT; iter++) {
      if (!pushIfValid(cursor)) break;
      cursor = withTimeFrom(dtStart, cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + interval, isAllDay);
    }
    return results;
  }

  if (freq === 'WEEKLY') {
    const byDays = rule.BYDAY
      ? rule.BYDAY.split(',')
          .map((t) => WEEKDAY_MAP[t.replace(/^[-+]?\d+/, '').toUpperCase()])
          .filter((v) => v !== undefined)
      : [dtStart.getDay()];
    const uniqueDays = Array.from(new Set(byDays)).sort((a, b) => a - b);

    // Anchor to Sunday of dtStart's week
    const startSunday = startOfDay(dtStart);
    startSunday.setDate(startSunday.getDate() - startSunday.getDay());

    let weekIndex = 0;
    if (maxCount === Infinity && startSunday < windowStart) {
      const diffWeeks = Math.floor((startOfDay(windowStart).getTime() - startSunday.getTime()) / (7 * 86400000));
      weekIndex = Math.max(0, Math.floor(diffWeeks / interval) - 1);
    }

    for (let iter = 0; iter < HARD_LIMIT; iter++) {
      const weekBase = new Date(startSunday.getFullYear(), startSunday.getMonth(), startSunday.getDate() + weekIndex * interval * 7);
      if (weekBase > effectiveEnd) break;
      let shouldContinue = true;
      for (const wd of uniqueDays) {
        const candidate = withTimeFrom(dtStart, weekBase.getFullYear(), weekBase.getMonth(), weekBase.getDate() + wd, isAllDay);
        if (!pushIfValid(candidate)) {
          shouldContinue = false;
          break;
        }
      }
      if (!shouldContinue) break;
      weekIndex += 1;
    }
    return results;
  }

  if (freq === 'MONTHLY') {
    const byDayTokens = rule.BYDAY ? rule.BYDAY.split(',') : [];
    const byMonthDays = rule.BYMONTHDAY
      ? rule.BYMONTHDAY.split(',').map((n) => parseInt(n, 10)).filter((n) => !Number.isNaN(n))
      : [];

    let monthStep = 0;
    if (maxCount === Infinity && dtStart < windowStart) {
      const diffMonths = (windowStart.getFullYear() - dtStart.getFullYear()) * 12 + (windowStart.getMonth() - dtStart.getMonth());
      monthStep = Math.max(0, Math.floor(diffMonths / interval) - 1);
    }

    for (let iter = 0; iter < HARD_LIMIT; iter++) {
      const totalMonths = dtStart.getFullYear() * 12 + dtStart.getMonth() + monthStep * interval;
      const y = Math.floor(totalMonths / 12);
      const m = totalMonths % 12;
      if (new Date(y, m, 1) > effectiveEnd) break;

      const monthCandidates: Date[] = [];
      if (byDayTokens.length > 0) {
        for (const token of byDayTokens) {
          const mToken = token.match(/^([-+]?\d+)?([A-Z]{2})$/i);
          if (!mToken) continue;
          const wd = WEEKDAY_MAP[mToken[2].toUpperCase()];
          if (wd === undefined) continue;
          if (mToken[1]) {
            const d = getNthWeekdayInMonth(y, m, wd, parseInt(mToken[1], 10));
            if (d) monthCandidates.push(withTimeFrom(dtStart, d.getFullYear(), d.getMonth(), d.getDate(), isAllDay));
          } else {
            const daysInMonth = new Date(y, m + 1, 0).getDate();
            for (let day = 1; day <= daysInMonth; day++) {
              const d = new Date(y, m, day);
              if (d.getDay() === wd) {
                monthCandidates.push(withTimeFrom(dtStart, y, m, day, isAllDay));
              }
            }
          }
        }
      } else {
        const targetDays = byMonthDays.length > 0 ? byMonthDays : [dtStart.getDate()];
        const daysInMonth = new Date(y, m + 1, 0).getDate();
        for (const td of targetDays) {
          const actualDay = td < 0 ? daysInMonth + td + 1 : td;
          if (actualDay >= 1 && actualDay <= daysInMonth) {
            monthCandidates.push(withTimeFrom(dtStart, y, m, actualDay, isAllDay));
          }
        }
      }

      monthCandidates.sort((a, b) => a.getTime() - b.getTime());
      let shouldContinue = true;
      for (const c of monthCandidates) {
        if (!pushIfValid(c)) {
          shouldContinue = false;
          break;
        }
      }
      if (!shouldContinue) break;
      monthStep += 1;
    }
    return results;
  }

  if (freq === 'YEARLY') {
    let yearStep = 0;
    if (maxCount === Infinity && dtStart < windowStart) {
      const diffYears = windowStart.getFullYear() - dtStart.getFullYear();
      yearStep = Math.max(0, Math.floor(diffYears / interval) - 1);
    }
    for (let iter = 0; iter < 500; iter++) {
      const y = dtStart.getFullYear() + yearStep * interval;
      if (y > effectiveEnd.getFullYear() + 1) break;
      const m = rule.BYMONTH ? Math.max(0, parseInt(rule.BYMONTH.split(',')[0], 10) - 1) : dtStart.getMonth();
      const targetDay = rule.BYMONTHDAY ? parseInt(rule.BYMONTHDAY.split(',')[0], 10) : dtStart.getDate();
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      if (targetDay >= 1 && targetDay <= daysInMonth) {
        const candidate = withTimeFrom(dtStart, y, m, targetDay, isAllDay);
        if (!pushIfValid(candidate)) break;
      }
      yearStep += 1;
    }
    return results;
  }

  return [dtStart];
}

function formatEventTimeLabel(date: Date, isAllDay: boolean): string {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  if (isAllDay) return `${m}/${d} 全天`;
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${m}/${d} ${hh}:${mm}`;
}

export function parseGoogleICalEvents(
  rawIcsText: string,
  now: Date = new Date()
): ParsedCalendarEvent[] {
  if (!rawIcsText || !rawIcsText.includes('BEGIN:VCALENDAR')) {
    if (/<html|<!doctype html/i.test(rawIcsText)) {
      throw new Error('取得的內容為網頁而非 .ics 檔，請確認已貼上 Google 日曆「iCal 格式的秘密網址 (.ics)」');
    }
    throw new Error('無效的 iCal (.ics) 格式內容');
  }

  // RFC 5545 line unfolding: join lines starting with space or tab
  const unfolded = rawIcsText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '');

  const todayStart = startOfDay(now);
  // Cover full current month (for month dots) through +62 days ahead
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const windowStart = monthStart < todayStart ? monthStart : todayStart;
  const windowEnd = new Date(todayStart.getTime() + 62 * 24 * 60 * 60 * 1000);

  const rawBlocks = unfolded.split('BEGIN:VEVENT').slice(1);

  // First collect RECURRENCE-ID overrides so master recurring series skip overridden dates
  const overriddenKeys = new Set<string>();
  const eventBlocks: string[] = [];

  for (const rawBlock of rawBlocks) {
    const endIdx = rawBlock.indexOf('END:VEVENT');
    const veventBody = endIdx >= 0 ? rawBlock.slice(0, endIdx) : rawBlock;
    // Strip VALARM sub-blocks so alarm SUMMARY/TRIGGER never pollute the event
    const cleaned = veventBody.replace(/BEGIN:VALARM[\s\S]*?END:VALARM/g, '');
    eventBlocks.push(cleaned);

    const uidMatch = cleaned.match(/^UID(?:;[^:]*)?:(.*)$/m);
    const recIdMatch = cleaned.match(/^RECURRENCE-ID([^:]*):(.*)$/m);
    if (uidMatch && recIdMatch) {
      const parsedRec = parseICalDateValue(recIdMatch[2], recIdMatch[1]);
      if (parsedRec) {
        overriddenKeys.add(`${uidMatch[1].trim()}|${dayKey(parsedRec.date)}`);
      }
    }
  }

  const parsedEvents: ParsedCalendarEvent[] = [];

  for (let i = 0; i < eventBlocks.length; i++) {
    const block = eventBlocks[i];

    const statusMatch = block.match(/^STATUS(?:;[^:]*)?:(.*)$/m);
    if (statusMatch && statusMatch[1].trim().toUpperCase() === 'CANCELLED') {
      continue;
    }

    const summaryMatch = block.match(/^SUMMARY(?:;[^:]*)?:(.*)$/m);
    const dtStartMatch = block.match(/^DTSTART([^:]*):(.*)$/m);
    if (!summaryMatch || !dtStartMatch) continue;

    const summary = unescapeICalText(summaryMatch[1]);
    if (!summary) continue;

    const startParsed = parseICalDateValue(dtStartMatch[2], dtStartMatch[1]);
    if (!startParsed) continue;

    const dtEndMatch = block.match(/^DTEND([^:]*):(.*)$/m);
    const endParsed = dtEndMatch ? parseICalDateValue(dtEndMatch[2], dtEndMatch[1]) : null;

    // Calculate multi-day span (all-day DTEND in iCal is exclusive!)
    let spanDays = 1;
    if (endParsed && endParsed.date > startParsed.date) {
      if (startParsed.isAllDay) {
        const diffDays = Math.round(
          (startOfDay(endParsed.date).getTime() - startOfDay(startParsed.date).getTime()) / 86400000
        );
        spanDays = Math.max(1, Math.min(diffDays, 14));
      } else {
        const startDayMs = startOfDay(startParsed.date).getTime();
        const endDayMs = startOfDay(new Date(endParsed.date.getTime() - 1000)).getTime();
        const diffDays = Math.round((endDayMs - startDayMs) / 86400000) + 1;
        spanDays = Math.max(1, Math.min(diffDays, 14));
      }
    }

    const uid = block.match(/^UID(?:;[^:]*)?:(.*)$/m)?.[1]?.trim() || `ev-${i}`;
    const hasRecurrenceId = /^RECURRENCE-ID(?:;[^:]*)?:/m.test(block);
    const rruleMatch = block.match(/^RRULE(?:;[^:]*)?:(.*)$/m);

    // Collect EXDATE excluded day keys
    const exdateKeys = new Set<string>();
    const exdateMatches = block.matchAll(/^EXDATE([^:]*):(.*)$/gm);
    for (const ex of exdateMatches) {
      for (const token of ex[2].split(',')) {
        const p = parseICalDateValue(token, ex[1]);
        if (p) exdateKeys.add(dayKey(p.date));
      }
    }

    // Shift search window back by spanDays so ongoing multi-day events are included
    const searchStart = new Date(windowStart.getTime() - spanDays * 86400000);
    const occurrenceStarts = rruleMatch
      ? expandRecurringStarts(startParsed.date, startParsed.isAllDay, rruleMatch[1], searchStart, windowEnd)
      : [startParsed.date];

    for (let occIdx = 0; occIdx < occurrenceStarts.length; occIdx++) {
      const occStart = occurrenceStarts[occIdx];
      const occDay = dayKey(occStart);

      if (exdateKeys.has(occDay)) continue;
      if (rruleMatch && !hasRecurrenceId && overriddenKeys.has(`${uid}|${occDay}`)) continue;

      for (let dOffset = 0; dOffset < spanDays; dOffset++) {
        const evDate =
          dOffset === 0
            ? occStart
            : new Date(occStart.getFullYear(), occStart.getMonth(), occStart.getDate() + dOffset, 0, 0, 0);
        const evAllDay = dOffset > 0 ? true : startParsed.isAllDay;

        if (evDate >= windowStart && evDate <= windowEnd) {
          parsedEvents.push({
            id: `${uid}-${occStart.getTime()}-${dOffset}-${i}-${occIdx}`,
            date: evDate,
            timeLabel: formatEventTimeLabel(evDate, evAllDay),
            summary,
            isAllDay: evAllDay,
          });
        }
      }
    }
  }

  parsedEvents.sort((a, b) => a.date.getTime() - b.date.getTime());
  return parsedEvents;
}
