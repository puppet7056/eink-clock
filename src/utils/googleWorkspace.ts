import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  type User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import type { CalendarEventItem } from '../components/CalendarPanel';

export const GOOGLE_WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/tasks.readonly',
] as const;

export interface GoogleTaskItem {
  id: string;
  title: string;
  notes?: string;
  listTitle: string;
  dueDate: Date | null;
  dueLabel: string;
  isOverdue: boolean;
}

export class GoogleAuthExpiredError extends Error {
  constructor(message = 'Google 授權已過期，請重新登入 Google 帳號以繼續同步日曆與待辦工作。') {
    super(message);
    this.name = 'GoogleAuthExpiredError';
  }
}

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);

const provider = new GoogleAuthProvider();
for (const scope of GOOGLE_WORKSPACE_SCOPES) {
  provider.addScope(scope);
}
provider.setCustomParameters({ prompt: 'select_account' });

// Flag to indicate if we are in the middle of a sign-in flow.
let isSigningIn = false;
// Cache the OAuth access token in memory ONLY (never persist to localStorage/sessionStorage).
let cachedAccessToken: string | null = null;

export function initGoogleAuth(
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: (signedInUserWithoutToken: User | null) => void
): () => void {
  return onAuthStateChanged(auth, (user: User | null) => {
    if (user) {
      if (cachedAccessToken) {
        onAuthSuccess?.(user, cachedAccessToken);
      } else if (!isSigningIn) {
        cachedAccessToken = null;
        onAuthFailure?.(user);
      }
    } else {
      cachedAccessToken = null;
      onAuthFailure?.(null);
    }
  });
}

function mapFirebaseAuthError(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';

  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return '已取消 Google 登入視窗。';
  }
  if (code === 'auth/popup-blocked') {
    return '瀏覽器封鎖了 Google 登入彈出視窗，請允許彈出視窗後再試一次。';
  }
  if (code === 'auth/unauthorized-domain') {
    return '目前執行環境的網域未授權 Google 登入（若是 Android 獨立 APK 內嵌視窗，請改用電子紙瀏覽器開啟本頁，或使用下方 .ics 網址方式同步）。';
  }
  if (code === 'auth/network-request-failed') {
    return '網路連線異常，無法連線至 Google 驗證服務。';
  }
  if (error instanceof Error && error.message) {
    return `Google 登入失敗：${error.message}`;
  }
  return 'Google 登入失敗，請稍後再試。';
}

export async function googleSignIn(): Promise<{ user: User; accessToken: string }> {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('未取得 Google 存取憑證，請確認已勾選日曆與待辦工作讀取權限。');
    }

    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error) {
    throw new Error(mapFirebaseAuthError(error));
  } finally {
    isSigningIn = false;
  }
}

export async function getGoogleAccessToken(): Promise<string | null> {
  return cachedAccessToken;
}

export function clearGoogleAccessToken(): void {
  cachedAccessToken = null;
}

export async function googleLogout(): Promise<void> {
  cachedAccessToken = null;
  await auth.signOut();
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function parseDateOnlyLocal(dateStr: string): Date | null {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(y, mo, d, 0, 0, 0, 0);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

interface RawGoogleCalendarEvent {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
}

export async function fetchGoogleCalendarEvents(
  accessToken: string,
  referenceNow: Date = new Date()
): Promise<CalendarEventItem[]> {
  const windowStart = new Date(referenceNow.getFullYear(), referenceNow.getMonth(), 1, 0, 0, 0, 0);
  const windowEnd = new Date(referenceNow.getTime() + 62 * 24 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    timeMin: windowStart.toISOString(),
    timeMax: windowEnd.toISOString(),
    maxResults: '250',
  });

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (res.status === 401) {
    cachedAccessToken = null;
    throw new GoogleAuthExpiredError();
  }

  if (res.status === 403) {
    throw new Error('Google 日曆讀取權限不足，請重新登入並勾選允許檢視日曆活動。');
  }

  if (!res.ok) {
    throw new Error(`無法讀取 Google 日曆活動 (HTTP ${res.status})`);
  }

  const data = (await res.json()) as { items?: RawGoogleCalendarEvent[] };
  const rawItems = Array.isArray(data.items) ? data.items : [];
  const results: CalendarEventItem[] = [];

  for (const item of rawItems) {
    if (item.status === 'cancelled') continue;
    const summary = (item.summary || '').trim() || '（無標題活動）';
    const baseId = item.id || `${summary}-${Math.random().toString(36).slice(2, 8)}`;

    if (item.start?.date) {
      // All-day event (may span multiple days; end.date is exclusive in Google Calendar API)
      const startDay = parseDateOnlyLocal(item.start.date);
      if (!startDay) continue;
      const endDayExclusive = item.end?.date ? parseDateOnlyLocal(item.end.date) : null;
      const totalDays = endDayExclusive
        ? Math.max(
            1,
            Math.min(
              31,
              Math.round((endDayExclusive.getTime() - startDay.getTime()) / (24 * 60 * 60 * 1000))
            )
          )
        : 1;

      for (let offset = 0; offset < totalDays; offset++) {
        const d = new Date(
          startDay.getFullYear(),
          startDay.getMonth(),
          startDay.getDate() + offset,
          0,
          0,
          0,
          0
        );
        if (d < windowStart || d > windowEnd) continue;
        results.push({
          id: `${baseId}-d${offset}`,
          date: d,
          timeLabel: `${d.getMonth() + 1}/${d.getDate()} 全天`,
          summary: totalDays > 1 ? `${summary} (${offset + 1}/${totalDays})` : summary,
          isAllDay: true,
          kind: 'event',
        });
      }
    } else if (item.start?.dateTime) {
      const startDt = new Date(item.start.dateTime);
      if (Number.isNaN(startDt.getTime())) continue;
      if (startDt < windowStart || startDt > windowEnd) continue;
      results.push({
        id: baseId,
        date: startDt,
        timeLabel: `${startDt.getMonth() + 1}/${startDt.getDate()} ${pad2(startDt.getHours())}:${pad2(startDt.getMinutes())}`,
        summary,
        isAllDay: false,
        kind: 'event',
      });
    }
  }

  results.sort((a, b) => a.date.getTime() - b.date.getTime());
  return results;
}

interface RawGoogleTaskList {
  id?: string;
  title?: string;
}

interface RawGoogleTask {
  id?: string;
  title?: string;
  notes?: string;
  due?: string;
  status?: string;
  deleted?: boolean;
  hidden?: boolean;
}

export async function fetchGoogleTasks(
  accessToken: string,
  referenceNow: Date = new Date()
): Promise<GoogleTaskItem[]> {
  const listsRes = await fetch('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=50', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (listsRes.status === 401) {
    cachedAccessToken = null;
    throw new GoogleAuthExpiredError();
  }

  if (listsRes.status === 403) {
    throw new Error('Google Tasks 讀取權限不足，請重新登入並勾選允許檢視待辦工作。');
  }

  if (!listsRes.ok) {
    throw new Error(`無法讀取 Google 待辦工作清單 (HTTP ${listsRes.status})`);
  }

  const listsData = (await listsRes.json()) as { items?: RawGoogleTaskList[] };
  const taskLists = Array.isArray(listsData.items) ? listsData.items : [];
  if (taskLists.length === 0) return [];

  const startOfToday = new Date(
    referenceNow.getFullYear(),
    referenceNow.getMonth(),
    referenceNow.getDate(),
    0,
    0,
    0,
    0
  );

  const perListResults = await Promise.all(
    taskLists.map(async (list): Promise<GoogleTaskItem[]> => {
      if (!list.id) return [];
      const listTitle = (list.title || '').trim() || '我的工作';
      const params = new URLSearchParams({
        showCompleted: 'false',
        showHidden: 'false',
        maxResults: '100',
      });
      const res = await fetch(
        `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(list.id)}/tasks?${params.toString()}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (res.status === 401) {
        cachedAccessToken = null;
        throw new GoogleAuthExpiredError();
      }
      if (!res.ok) return [];

      const data = (await res.json()) as { items?: RawGoogleTask[] };
      const items = Array.isArray(data.items) ? data.items : [];
      const mapped: GoogleTaskItem[] = [];

      for (const t of items) {
        if (t.deleted || t.hidden || t.status === 'completed') continue;
        const title = (t.title || '').trim();
        if (!title) continue;

        // Google Tasks `due` is RFC 3339 date-only UTC midnight (YYYY-MM-DDT00:00:00.000Z).
        // Parse the YYYY-MM-DD part directly into local midnight to avoid timezone day shift.
        const dueDate = t.due ? parseDateOnlyLocal(t.due) : null;
        const isOverdue = Boolean(dueDate && dueDate < startOfToday);
        const dueLabel = dueDate
          ? `${dueDate.getMonth() + 1}/${dueDate.getDate()}`
          : '未設期限';

        mapped.push({
          id: `${list.id}:${t.id || title}`,
          title,
          notes: t.notes?.trim() || undefined,
          listTitle,
          dueDate,
          dueLabel,
          isOverdue,
        });
      }

      return mapped;
    })
  );

  const allTasks = perListResults.flat();
  allTasks.sort((a, b) => {
    if (a.dueDate && b.dueDate) {
      return a.dueDate.getTime() - b.dueDate.getTime();
    }
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return a.title.localeCompare(b.title, 'zh-Hant');
  });

  return allTasks;
}
