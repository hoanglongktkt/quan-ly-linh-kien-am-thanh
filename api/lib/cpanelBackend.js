/** Domain frontend (Vercel) — KHÔNG được dùng làm CPANEL_BACKEND_URL. */
const FRONTEND_HOSTS = new Set([
  'quanly.linhkienamthanh.net',
  'www.quanly.linhkienamthanh.net',
]);

function hostnameFromUrl(raw) {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Chỉ dùng CPANEL_BACKEND_URL (VD: https://api.linhkienamthanh.net).
 * Không fallback APP_URL — tránh proxy vòng lặp về Vercel.
 */
export function resolveCpanelBackend() {
  const raw = String(process.env.CPANEL_BACKEND_URL || '').trim().replace(/\/$/, '');

  if (!raw) {
    return {
      url: '',
      ok: false,
      error:
        'CPANEL_BACKEND_URL chưa được set trên Vercel. Thêm biến trỏ subdomain cPanel (VD: https://api.linhkienamthanh.net).',
    };
  }

  const hostname = hostnameFromUrl(raw);
  if (!hostname) {
    return { url: '', ok: false, error: `CPANEL_BACKEND_URL không hợp lệ: ${raw}` };
  }

  const vercelHost = process.env.VERCEL_URL
    ? String(process.env.VERCEL_URL).replace(/^https?:\/\//, '').split('/')[0].toLowerCase()
    : null;

  if (FRONTEND_HOSTS.has(hostname)) {
    return {
      url: '',
      ok: false,
      error: `CPANEL_BACKEND_URL trỏ domain frontend (${hostname}) — gây vòng lặp proxy. Dùng subdomain backend riêng.`,
    };
  }

  if (vercelHost && (hostname === vercelHost || hostname.endsWith('.vercel.app'))) {
    return {
      url: '',
      ok: false,
      error: `CPANEL_BACKEND_URL trỏ domain Vercel (${hostname}) — gây vòng lặp proxy.`,
    };
  }

  return { url: raw, ok: true, error: null, hostname };
}

export function cpanelBackendBase() {
  return resolveCpanelBackend().url;
}
