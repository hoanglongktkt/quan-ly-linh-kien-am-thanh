/** Production API — không dùng ngrok / URL test cục bộ. */
export const PRODUCTION_API_BASE = 'https://quanly.linhkienamthanh.net';

function isLocalDevHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

/** Base URL cho API (không có slash cuối). */
export function getApiBaseUrl(): string {
  const fromBuild = String(import.meta.env.VITE_API_BASE_URL || '').trim();
  if (fromBuild) return fromBuild.replace(/\/$/, '');

  if (typeof window !== 'undefined') {
    if (isLocalDevHost(window.location.hostname)) {
      return window.location.origin.replace(/\/$/, '');
    }
    return PRODUCTION_API_BASE;
  }

  return PRODUCTION_API_BASE;
}

/** Ghép path `/api/...` thành URL đầy đủ trên hosting production. */
export function apiUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const base = getApiBaseUrl();
  if (!base) return normalized;
  return `${base}${normalized}`;
}

export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const url =
    input.startsWith('http://') || input.startsWith('https://')
      ? input
      : apiUrl(input);
  return fetch(url, init);
}

/** Gắn interceptor fetch toàn cục — mọi `fetch('/api/...')` tự trỏ production. */
export function installApiFetchInterceptor(): void {
  if (typeof window === 'undefined') return;
  const w = window as Window & { __apiFetchPatched?: boolean };
  if (w.__apiFetchPatched) return;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input === 'string' && input.startsWith('/api/')) {
      return nativeFetch(apiUrl(input), init);
    }
    if (input instanceof Request && input.url.startsWith('/api/')) {
      return nativeFetch(apiUrl(input.url), init);
    }
    return nativeFetch(input, init);
  };
  w.__apiFetchPatched = true;
}
