/** Decode JWT payload phía client (không verify chữ ký — chỉ đọc exp/username). */
export type JwtPayload = {
  username?: string;
  exp?: number;
  iat?: number;
};

export function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(atob(padded)) as JwtPayload;
  } catch {
    return null;
  }
}

/** Token còn hạn theo claim `exp` — dùng bypass khi verify API tạm lỗi mạng/5xx. */
export function isJwtLocallyValid(token: string): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return false;
  return Date.now() < payload.exp * 1000;
}
