/** Backend production (cPanel) — dùng khi frontend gọi API cross-origin trực tiếp. */
export const PRODUCTION_API_BASE = 'https://quanly.linhkienamthanh.net';

function isLocalDevHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

function isVercelHost(hostname: string): boolean {
  return hostname.endsWith('.vercel.app') || hostname.includes('.vercel.app');
}

function isMainProductionHost(hostname: string): boolean {
  return hostname === 'quanly.linhkienamthanh.net' || hostname.endsWith('.linhkienamthanh.net');
}

/**
 * Base URL cho API (không có slash cuối).
 * - localhost / quanly.linhkienamthanh.net / vercel.app → '' (relative `/api/...`)
 * - Chỉ dùng URL tuyệt đối khi set VITE_API_BASE_URL hoặc bắt buộc cross-origin.
 */
export function getApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;

    // Vercel: thử relative trước (vercel.json edge rewrite). Nếu vẫn lỗi → fallback cross-origin.
    if (isVercelHost(hostname)) {
      return '';
    }

    if (isLocalDevHost(hostname) || isMainProductionHost(hostname)) {
      return '';
    }
  }

  const fromEnv = String(import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  return typeof window !== 'undefined' ? PRODUCTION_API_BASE : '';
}

/** Ghép path `/api/...` — relative khi base rỗng (cùng origin hoặc Vercel proxy). */
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

/** Mọi `fetch('/api/...')` dùng apiUrl (relative trên Vercel + cPanel). */
export function installApiFetchInterceptor(): void {
  if (typeof window === 'undefined') return;
  const w = window as Window & { __apiFetchPatched?: boolean };
  if (w.__apiFetchPatched) return;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input === 'string' && input.startsWith('/api/')) {
      return nativeFetch(apiUrl(input), init);
    }
    if (input instanceof Request) {
      const reqUrl = input.url;
      const path = reqUrl.startsWith('http') ? new URL(reqUrl).pathname : reqUrl;
      if (path.startsWith('/api/')) {
        return nativeFetch(apiUrl(path), init);
      }
    }
    return nativeFetch(input, init);
  };
  w.__apiFetchPatched = true;
}
