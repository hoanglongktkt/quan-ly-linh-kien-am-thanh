const FALLBACK_JWT_SECRET = 'omnisales-vn-super-secret-key-2026';

export function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  return secret || FALLBACK_JWT_SECRET;
}

/** Gọi lúc khởi động backend — cảnh báo nếu thiếu JWT_SECRET (Vercel ↔ cPanel lệch key). */
export function warnJwtSecretOnStartup() {
  if (!String(process.env.JWT_SECRET || '').trim()) {
    console.warn(
      '[JWT] CẢNH BÁO: JWT_SECRET chưa được set — đang dùng secret fallback mặc định. ' +
        'Token có thể KHÔNG khớp giữa Vercel và cPanel. ' +
        'Hãy set JWT_SECRET giống nhau trên cPanel (.htaccess / Node env) và Vercel Environment Variables.',
    );
  }
}
