/** Kiểm tra lỗi vượt quota localStorage (~5MB). */
export function isQuotaExceededError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as DOMException & { code?: number };
  return (
    e.name === 'QuotaExceededError' ||
    e.code === 22 ||
    e.code === 1014 ||
    String(err).includes('quota')
  );
}

export function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeRemoveItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * Ghi localStorage an toàn — không throw, tự xóa key cũ nếu QuotaExceededError.
 * @returns true nếu ghi thành công
 */
export function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    if (isQuotaExceededError(err)) {
      safeRemoveItem(key);
      try {
        localStorage.setItem(key, value);
        return true;
      } catch (retryErr) {
        console.warn(`[safeStorage] Quota exceeded — cannot save "${key}"`, retryErr);
        return false;
      }
    }
    console.warn(`[safeStorage] setItem failed for "${key}":`, err);
    return false;
  }
}

/** Parse JSON từ localStorage an toàn. */
export function safeGetJson<T>(key: string, fallback: T): T {
  const raw = safeGetItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
