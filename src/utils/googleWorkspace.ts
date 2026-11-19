import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  type User,
} from 'firebase/auth';
import androidOAuthConfig from '../../android-oauth-config.json';
import firebaseConfig from '../../firebase-applet-config.json';
import type { CalendarEventItem } from '../components/CalendarPanel';

export const GOOGLE_WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/tasks.readonly',
] as const;

export interface GoogleAccountProfile {
  email: string;
  displayName?: string | null;
  authMode: 'web-firebase' | 'android-native';
}

export interface GoogleTaskItem {
  id: string;
  title: string;
  notes?: string;
  listTitle: string;
  dueDate: Date | null;
  dueLabel: string;
  isOverdue: boolean;
}

export interface GoogleCalendarFetchResult {
  events: CalendarEventItem[];
  calendarEmail: string | null;
}

export class GoogleAuthExpiredError extends Error {
  constructor(message = 'Google 授權已過期，請重新登入 Google 帳號以繼續同步日曆與待辦工作。') {
    super(message);
    this.name = 'GoogleAuthExpiredError';
  }
}

interface EInkOAuthCordovaBridge {
  openAuthUrl: (
    url: string,
    onSuccess?: () => void,
    onError?: (err: unknown) => void
  ) => void;
  listen: (
    onCallbackUrl: (url: string) => void,
    onError?: (err: unknown) => void
  ) => void;
  consumePendingCallback: (
    onSuccess: (url: string) => void,
    onError?: (err: unknown) => void
  ) => void;
}

declare global {
  interface Window {
    EInkOAuth?: EInkOAuthCordovaBridge;
  }
}

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);

const provider = new GoogleAuthProvider();
for (const scope of GOOGLE_WORKSPACE_SCOPES) {
  provider.addScope(scope);
}
provider.setCustomParameters({ prompt: 'select_account' });

// Flag to indicate if we are in the middle of a web sign-in flow.
let isSigningIn = false;
// Cache OAuth tokens strictly in memory ONLY (never persist access/refresh tokens to localStorage/sessionStorage).
let cachedAccessToken: string | null = null;
let cachedRefreshToken: string | null = null;
let cachedTokenExpiresAt = 0;

// Ephemeral PKCE handshake state (verifier + CSRF state only; cleared immediately upon callback).
const PKCE_HANDSHAKE_KEY = 'eink_oauth_pkce_handshake';
let inMemoryPkceHandshake: { codeVerifier: string; state: string; createdAt: number } | null = null;

export function getAndroidOAuthClientId(): string {
  const fromEnv = (import.meta.env.VITE_ANDROID_OAUTH_CLIENT_ID || '').trim();
  if (fromEnv) return fromEnv;
  return (androidOAuthConfig.androidOAuthClientId || '').trim();
}

export function isAndroidNativeOAuthConfigured(): boolean {
  const cid = getAndroidOAuthClientId();
  return cid.endsWith('.apps.googleusercontent.com') && cid.length > 30;
}

export function getAndroidRedirectUri(clientId: string = getAndroidOAuthClientId()): string {
  const cleaned = clientId.trim();
  const suffix = '.apps.googleusercontent.com';
  if (cleaned.endsWith(suffix)) {
    const prefix = cleaned.slice(0, -suffix.length);
    return `com.googleusercontent.apps.${prefix}:/oauth2redirect`;
  }
  return 'tw.eink.clockdashboard.oauth:/oauth2redirect';
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateRandomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

function savePkceHandshake(handshake: { codeVerifier: string; state: string; createdAt: number }): void {
  inMemoryPkceHandshake = handshake;
  try {
    sessionStorage.setItem(PKCE_HANDSHAKE_KEY, JSON.stringify(handshake));
  } catch {
    // ignore storage errors
  }
}

function consumePkceHandshake(): { codeVerifier: string; state: string; createdAt: number } | null {
  let handshake = inMemoryPkceHandshake;
  inMemoryPkceHandshake = null;
  if (!handshake) {
    try {
      const raw = sessionStorage.getItem(PKCE_HANDSHAKE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          codeVerifier?: string;
          state?: string;
          createdAt?: number;
        };
        if (parsed.codeVerifier && parsed.state) {
          handshake = {
            codeVerifier: parsed.codeVerifier,
            state: parsed.state,
            createdAt: parsed.createdAt || Date.now(),
          };
        }
      }
    } catch {
      // ignore
    }
  }
  try {
    sessionStorage.removeItem(PKCE_HANDSHAKE_KEY);
  } catch {
    // ignore
  }
  return handshake;
}

/**
 * Initiates native Android OAuth 2.0 + PKCE sign-in by launching the system browser
 * (BOOX NeoBrowser / Chrome / etc. — no GMS required). Google redirects back to
 * `com.googleusercontent.apps.<clientIdPrefix>:/oauth2redirect` which Android routes
 * straight back into our running Cordova APK via EInkOAuthPlugin.onNewIntent().
 */
export async function startAndroidNativeGoogleSignIn(): Promise<void> {
  const clientId = getAndroidOAuthClientId();
  if (!isAndroidNativeOAuthConfigured()) {
    throw new Error(
      '尚未設定 Android OAuth 用戶端 ID，請先於 Google Cloud Console 建立 Android 類型用戶端並寫入 android-oauth-config.json 後重新打包 APK。'
    );
  }

  const codeVerifier = generateRandomBase64Url(32);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const state = generateRandomBase64Url(18);
  const redirectUri = getAndroidRedirectUri(clientId);

  savePkceHandshake({ codeVerifier, state, createdAt: Date.now() });

  const authParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_WORKSPACE_SCOPES.join(' '),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'select_account consent',
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${authParams.toString()}`;

  if (window.EInkOAuth && typeof window.EInkOAuth.openAuthUrl === 'function') {
    await new Promise<void>((resolve, reject) => {
      window.EInkOAuth!.openAuthUrl(
        authUrl,
        () => resolve(),
        (err) => reject(new Error(typeof err === 'string' ? err : '無法開啟系統瀏覽器進行 Google 登入'))
      );
    });
    return;
  }

  // Fallback for environments where Cordova plugin bridge isn't ready yet
  window.location.href = authUrl;
}

async function exchangeAndroidAuthCode(callbackUrl: string): Promise<{
  account: GoogleAccountProfile;
  accessToken: string;
}> {
  let parsed: URL;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    throw new Error('Google 登入返回網址格式無效，請再試一次。');
  }

  const errorCode = parsed.searchParams.get('error');
  if (errorCode) {
    consumePkceHandshake();
    if (errorCode === 'access_denied') {
      throw new Error('您已取消 Google 帳號授權。');
    }
    throw new Error(`Google 授權未完成（${errorCode}），請再試一次。`);
  }

  const code = parsed.searchParams.get('code');
  const returnedState = parsed.searchParams.get('state');
  const handshake = consumePkceHandshake();

  if (!code) {
    throw new Error('未收到 Google 授權碼，請重新點選登入。');
  }
  if (!handshake || !returnedState || returnedState !== handshake.state) {
    throw new Error('安全驗證碼（state）不符或已逾時，請重新點選 Sign in with Google。');
  }

  const clientId = getAndroidOAuthClientId();
  const redirectUri = getAndroidRedirectUri(clientId);

  const tokenBody = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: handshake.codeVerifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody.toString(),
  });

  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !data.access_token) {
    throw new Error(
      data.error_description || data.error || `Google 憑證交換失敗 (HTTP ${res.status})`
    );
  }

  cachedAccessToken = data.access_token;
  if (data.refresh_token) {
    cachedRefreshToken = data.refresh_token;
  }
  const expiresInSec = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  cachedTokenExpiresAt = Date.now() + Math.max(60, expiresInSec - 120) * 1000;

  return {
    account: {
      email: 'Google 帳號（已授權）',
      displayName: null,
      authMode: 'android-native',
    },
    accessToken: cachedAccessToken,
  };
}

/**
 * Registers the Cordova deep-link callback listener so Android automatically delivers
 * `com.googleusercontent.apps.<prefix>:/oauth2redirect?code=...` back to the app.
 */
export function initAndroidNativeOAuthListener(
  onAuthSuccess: (account: GoogleAccountProfile, token: string) => void,
  onAuthError: (message: string) => void
): () => void {
  let active = true;
  let listenerBound = false;

  const handleCallbackUrl = async (url: string) => {
    if (!active || !url) return;
    try {
      const result = await exchangeAndroidAuthCode(url);
      if (active) {
        onAuthSuccess(result.account, result.accessToken);
      }
    } catch (err) {
      if (active) {
        onAuthError(err instanceof Error ? err.message : 'Google 登入失敗');
      }
    }
  };

  const bindBridge = () => {
    if (!active || listenerBound) return;
    if (!window.EInkOAuth || typeof window.EInkOAuth.listen !== 'function') return;
    listenerBound = true;
    window.EInkOAuth.listen(
      (url) => {
        void handleCallbackUrl(url);
      },
      (err) => {
        if (active && err) {
          onAuthError(typeof err === 'string' ? err : '監聽 Google 登入回呼失敗');
        }
      }
    );
  };

  bindBridge();
  document.addEventListener('deviceready', bindBridge, false);
  window.addEventListener('eink-cordova-ready', bindBridge);

  return () => {
    active = false;
    document.removeEventListener('deviceready', bindBridge, false);
    window.removeEventListener('eink-cordova-ready', bindBridge);
  };
}

/**
 * Silently refreshes the in-memory Android OAuth access token using the in-memory
 * refresh token when approaching expiry (keeps 24/7 E-Ink desk clock running nonstop).
 */
export async function refreshAndroidGoogleTokenIfNeeded(force = false): Promise<string | null> {
  if (!cachedRefreshToken) return cachedAccessToken;
  if (!force && cachedAccessToken && Date.now() < cachedTokenExpiresAt) {
    return cachedAccessToken;
  }

  const clientId = getAndroidOAuthClientId();
  if (!clientId) return cachedAccessToken;

  const body = new URLSearchParams({
    client_id: clientId,
    refresh_token: cachedRefreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    cachedAccessToken = null;
    cachedRefreshToken = null;
    cachedTokenExpiresAt = 0;
    throw new GoogleAuthExpiredError();
  }

  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!data.access_token) {
    cachedAccessToken = null;
    throw new GoogleAuthExpiredError();
  }

  cachedAccessToken = data.access_token;
  const expiresInSec = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  cachedTokenExpiresAt = Date.now() + Math.max(60, expiresInSec - 120) * 1000;
  return cachedAccessToken;
}

export function initGoogleAuth(
  onAuthSuccess?: (account: GoogleAccountProfile, token: string) => void,
  onAuthFailure?: (signedInAccountWithoutToken: GoogleAccountProfile | null) => void
): () => void {
  return onAuthStateChanged(auth, (user: User | null) => {
    if (user) {
      const profile: GoogleAccountProfile = {
        email: user.email || 'Google 帳號',
        displayName: user.displayName,
        authMode: 'web-firebase',
      };
      if (cachedAccessToken) {
        onAuthSuccess?.(profile, cachedAccessToken);
      } else if (!isSigningIn) {
        cachedAccessToken = null;
        onAuthFailure?.(profile);
      }
    } else if (!cachedRefreshToken) {
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
    return '目前執行環境的網域未授權 Google 登入，請改用網頁版瀏覽器開啟或使用下方 .ics 網址方式同步。';
  }
  if (code === 'auth/network-request-failed') {
    return '網路連線異常，無法連線至 Google 驗證服務。';
  }
  if (error instanceof Error && error.message) {
    return `Google 登入失敗：${error.message}`;
  }
  return 'Google 登入失敗，請稍後再試。';
}

export async function googleSignIn(): Promise<{
  account: GoogleAccountProfile;
  accessToken: string;
}> {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('未取得 Google 存取憑證，請確認已勾選日曆與待辦工作讀取權限。');
    }

    cachedAccessToken = credential.accessToken;
    cachedRefreshToken = null;
    cachedTokenExpiresAt = Date.now() + 50 * 60 * 1000;

    return {
      account: {
        email: result.user.email || 'Google 帳號',
        displayName: result.user.displayName,
        authMode: 'web-firebase',
      },
      accessToken: cachedAccessToken,
    };
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
  cachedRefreshToken = null;
  cachedTokenExpiresAt = 0;
}

export async function googleLogout(): Promise<void> {
  const tokenToRevoke = cachedRefreshToken || cachedAccessToken;
  cachedAccessToken = null;
  cachedRefreshToken = null;
  cachedTokenExpiresAt = 0;

  if (tokenToRevoke) {
    fetch(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokenToRevoke)}`,
      { method: 'POST' }
    ).catch(() => {
      // ignore revoke network failure
    });
  }

  try {
    await auth.signOut();
  } catch {
    // ignore if signed in via Android native OAuth without Firebase session
  }
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
): Promise<GoogleCalendarFetchResult> {
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

  const data = (await res.json()) as {
    summary?: string;
    items?: RawGoogleCalendarEvent[];
  };
  const calendarEmail =
    typeof data.summary === 'string' && data.summary.includes('@') ? data.summary.trim() : null;
  const rawItems = Array.isArray(data.items) ? data.items : [];
  const results: CalendarEventItem[] = [];

  for (const item of rawItems) {
    if (item.status === 'cancelled') continue;
    const summary = (item.summary || '').trim() || '（無標題活動）';
    const baseId = item.id || `${summary}-${Math.random().toString(36).slice(2, 8)}`;

    if (item.start?.date) {
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
  return { events: results, calendarEmail };
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
