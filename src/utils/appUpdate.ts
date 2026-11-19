export const APP_VERSION = (import.meta.env.VITE_APP_VERSION || '1.0.0').trim();
export const APP_VERSION_CODE = Number(import.meta.env.VITE_APP_VERSION_CODE || '10000') || 10000;
export const DEFAULT_GITHUB_REPO = (import.meta.env.VITE_GITHUB_REPO || '').trim();

export interface ReleaseUpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  apkDownloadUrl: string | null;
  apkFileName: string | null;
  releasePageUrl: string;
  publishedAtLabel: string;
  releaseNotes: string;
}

export function normalizeGithubRepo(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const urlMatch = trimmed.match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  if (urlMatch) {
    return `${urlMatch[1]}/${urlMatch[2].replace(/\.git$/i, '')}`;
  }
  const slugMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (slugMatch) {
    return `${slugMatch[1]}/${slugMatch[2].replace(/\.git$/i, '')}`;
  }
  return '';
}

export function compareVersions(a: string, b: string): number {
  const partsA = a
    .replace(/^v/i, '')
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((n) => parseInt(n, 10));
  const partsB = b
    .replace(/^v/i, '')
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((n) => parseInt(n, 10));
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const va = partsA[i] ?? 0;
    const vb = partsB[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function formatPublishedAt(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}/${m}/${day} ${hh}:${mm}`;
}

interface GithubReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

interface GithubReleaseResponse {
  tag_name?: string;
  name?: string;
  html_url?: string;
  published_at?: string;
  body?: string;
  assets?: GithubReleaseAsset[];
}

export async function checkGithubReleaseUpdate(rawRepo: string): Promise<ReleaseUpdateInfo> {
  const repo = normalizeGithubRepo(rawRepo);
  if (!repo) {
    throw new Error('請輸入有效的 GitHub 儲存庫名稱（格式：帳號/專案名稱，例如 user/eink-clock）');
  }

  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  let res: Response;
  try {
    res = await fetch(apiUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
      },
    });
  } catch {
    throw new Error('無法連線至 GitHub，請確認電子紙裝置的 Wi-Fi 連線正常。');
  }

  if (res.status === 404) {
    throw new Error(
      `找不到 ${repo} 的公開發行版本（HTTP 404）：請確認儲存庫已設為公開（Public），且已使用最新打包流程完成至少一次 GitHub 建置。`
    );
  }
  if (res.status === 403) {
    throw new Error('GitHub API 查詢次數暫時達到上限，請幾分鐘後再試。');
  }
  if (!res.ok) {
    throw new Error(`檢查更新失敗（GitHub HTTP ${res.status}）`);
  }

  const data = (await res.json()) as GithubReleaseResponse;
  const rawTag = (data.tag_name || data.name || '').trim();
  const latestVersion = rawTag.replace(/^v/i, '') || '0.0.0';
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const apkAsset =
    assets.find((a) => typeof a.name === 'string' && a.name.toLowerCase().endsWith('.apk')) || null;

  const hasUpdate = compareVersions(latestVersion, APP_VERSION) > 0;
  const releasePageUrl = data.html_url || `https://github.com/${repo}/releases/latest`;

  return {
    hasUpdate,
    currentVersion: APP_VERSION,
    latestVersion,
    apkDownloadUrl: apkAsset?.browser_download_url || null,
    apkFileName: apkAsset?.name || null,
    releasePageUrl,
    publishedAtLabel: formatPublishedAt(data.published_at),
    releaseNotes: (data.body || '').trim(),
  };
}
