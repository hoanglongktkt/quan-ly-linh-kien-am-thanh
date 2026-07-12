/** Backend production (cPanel Node) — KHÔNG dùng domain frontend quanly (Vercel). */
export const PRODUCTION_API_BASE = 'https://api.linhkienamthanh.net';

/** Domain chính thức của ứng dụng (frontend). */
export const PRODUCTION_APP_ORIGIN = 'https://quanly.linhkienamthanh.net';

export function getPublicAppOrigin(): string {
  if (typeof window !== 'undefined') {
    return window.location.origin.replace(/\/$/, '');
  }
  return PRODUCTION_APP_ORIGIN;
}

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

/**
 * URL mở file vận đơn PDF.
 * Vercel / quanly: relative `/labels/...` → vercel.json proxy `/api/labels/...` → cPanel (tránh 508 loop).
 * Khác origin: trỏ thẳng api.linhkienamthanh.net.
 */
export function resolveBackendFileUrl(path: string): string {
  return resolveLabelFetchUrl(path);
}

/** URL fetch PDF vận đơn — dùng /api/labels/ trực tiếp (tránh rewrite /labels 400). */
export function resolveLabelFetchUrl(path: string): string {
  let pathname = String(path || '').trim();
  if (/^https?:\/\//i.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname;
    } catch {
      pathname = String(path || '').trim();
      if (!pathname.startsWith('/')) pathname = `/${pathname}`;
    }
  } else if (!pathname.startsWith('/')) {
    pathname = `/${pathname}`;
  }

  const filename = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
  if (!filename || !/\.pdf$/i.test(filename)) {
    if (typeof window === 'undefined') return `${PRODUCTION_API_BASE}${pathname}`;
    const hostname = window.location.hostname;
    if (isLocalDevHost(hostname) || isVercelHost(hostname) || isMainProductionHost(hostname)) {
      return pathname.startsWith('/') ? pathname : `/${pathname}`;
    }
    return `${PRODUCTION_API_BASE}${pathname}`;
  }

  const encoded = encodeURIComponent(filename);
  if (typeof window === 'undefined') {
    return `${PRODUCTION_API_BASE}/api/public/labels/${encoded}`;
  }
  const hostname = window.location.hostname;
  if (isLocalDevHost(hostname) || isVercelHost(hostname) || isMainProductionHost(hostname)) {
    return `/api/labels/${encoded}`;
  }
  return `${PRODUCTION_API_BASE}/api/public/labels/${encoded}`;
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

/** Parse JSON an toàn — báo lỗi rõ nếu server trả HTML (404/proxy lỗi). */
export async function parseJsonResponse<T = Record<string, unknown>>(
  response: Response,
): Promise<T> {
  const text = await response.text();
  const contentType = response.headers.get('content-type') || '';

  if (
    !contentType.includes('application/json') &&
    (text.trimStart().startsWith('<') || text.includes('The page could not be found'))
  ) {
    throw new Error(
      'API trả về trang HTML thay vì JSON (404/proxy). Kiểm tra vercel.json và backend quanly.linhkienamthanh.net.',
    );
  }

  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new Error(`Phản hồi API không hợp lệ: ${text.slice(0, 120)}`);
  }
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
