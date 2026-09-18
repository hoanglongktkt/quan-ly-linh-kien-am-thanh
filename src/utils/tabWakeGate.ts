/**
 * tabWakeGate — điều phối chung sự kiện "tab quay lại foreground" (focus / visibilitychange /
 * pageshow / online) cho TOÀN APP.
 *
 * Vấn đề trước đây: App.tsx và OrderManager.tsx mỗi bên tự đăng ký riêng focus/visibilitychange/
 * pageshow, mỗi bên tự cooldown riêng (không chia sẻ) → mỗi lần user quay lại tab, NHIỀU listener
 * cùng bắn NGAY TRONG 1 TICK → bão request (list + counter + products + reconcile + SSE reconnect
 * cùng lúc) tranh giới hạn 6 connection/origin → request bị pending/canceled kéo dài.
 *
 * Module này gộp 3 sự kiện trên thành DUY NHẤT 1 "wake" mỗi lần tab thực sự tỉnh lại (debounce
 * các sự kiện bắn dồn cùng lúc), rồi phát cho các subscriber theo priority — mỗi subscriber cách
 * nhau 1 khoảng nhỏ (STAGGER_MS) để không cùng lúc dội vào network.
 *
 * Module này đảm bảo listener không bị nhân bản/không bắn cùng tick và tuần tự hóa health gate,
 * không thay đổi logic nghiệp vụ của từng màn hình.
 *
 * Mọi lượt wake đều phải đi qua /api/health trước khi phát cho subscriber. Việc này đặc biệt quan
 * trọng trên mobile: browser có thể báo online/visible trong khi socket cũ đã chết và Passenger/
 * Mongo vẫn đang tỉnh lại. Sau khi health thành công, subscriber luôn được phát để tự refresh ngầm.
 */

type WakeInfo = {
  /** true nếu tab bị ẩn lâu hơn LONG_SLEEP_MS trước khi wake lại (khả năng cao server đang cold). */
  isLongSleep: boolean;
  /** Thời gian tab đã ẩn (ms) trước khi wake — 0 nếu không xác định được. */
  hiddenMs: number;
  /** true khi /api/health đã xác nhận backend và Mongo sẵn sàng. */
  healthReady: boolean;
};

type WakeHandler = (info: WakeInfo) => void;

type Subscriber = {
  fn: WakeHandler;
  priority: number;
};

const subscribers: Subscriber[] = [];

/** Gộp các sự kiện focus/visibilitychange/pageshow/online bắn dồn cùng lúc thành 1 wake. */
const MERGE_DEBOUNCE_MS = 350;
/** Khoảng cách giữa 2 subscriber liên tiếp khi phát wake — tránh dội request cùng lúc. */
const STAGGER_MS = 300;
/** Ẩn lâu hơn mốc này (30 phút) mới coi là "ngủ qua đêm" — tránh coi đổi tab thường là cold-start. */
const LONG_SLEEP_MS = 30 * 60_000;
/** Mỗi probe có timeout riêng; toàn bộ quá trình luôn bị chặn bởi deadline bên dưới. */
const HEALTH_PRECHECK_REQUEST_TIMEOUT_MS = 8_000;
/** Chờ cold-start tối đa 45 giây, sau đó vẫn phát wake để UI không bị khóa vô hạn. */
const HEALTH_PRECHECK_TOTAL_TIMEOUT_MS = 45_000;
/** Số probe hữu hạn + backoff để không spam Passenger/Mongo khi đang khởi động. */
const HEALTH_PRECHECK_MAX_ATTEMPTS = 6;
const HEALTH_PRECHECK_RETRY_DELAYS_MS = [0, 1_500, 3_000, 5_000, 8_000, 10_000] as const;
let pendingFireTimer: number | null = null;
/** Chặn nhiều luồng health-precheck chạy song song khi mobile bắn dồn visibility/focus/online. */
let wakeInProgress = false;
/** Ghi nhận có wake mới trong lúc health-precheck đang chạy để thực hiện ngay sau lượt hiện tại. */
let wakeQueued = false;
/** Mốc thời điểm tab chuyển sang "hidden" gần nhất — dùng để tính đã ẩn bao lâu khi wake lại. */
let lastHiddenAt: number | null = null;

function markHiddenNow() {
  lastHiddenAt = Date.now();
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, ms));

/** Đánh thức Passenger và chờ Mongo ready với số lần thử/deadline hữu hạn. */
async function healthPrecheckUntilReady(): Promise<boolean> {
  const deadlineAt = Date.now() + HEALTH_PRECHECK_TOTAL_TIMEOUT_MS;

  for (let attempt = 0; attempt < HEALTH_PRECHECK_MAX_ATTEMPTS; attempt += 1) {
    const retryDelay = HEALTH_PRECHECK_RETRY_DELAYS_MS[attempt] ?? 10_000;
    if (retryDelay > 0) await delay(retryDelay);
    if (Date.now() >= deadlineAt) break;

    const controller = new AbortController();
    const requestTimeoutMs = Math.max(
      1,
      Math.min(HEALTH_PRECHECK_REQUEST_TIMEOUT_MS, deadlineAt - Date.now()),
    );
    const timer = window.setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch('/api/health', {
        signal: controller.signal,
        cache: 'no-store',
      });
      const health = await response.json().catch(() => null);
      if (response.ok && health?.ok === true && health?.dbReady === true) return true;
    } catch {
      /* Passenger/Mongo còn cold — thử lại theo backoff hữu hạn. */
    } finally {
      window.clearTimeout(timer);
    }
  }

  return false;
}

function dispatch(info: WakeInfo) {
  // Phát theo priority tăng dần, mỗi subscriber cách nhau STAGGER_MS.
  const ordered = [...subscribers].sort((a, b) => a.priority - b.priority);
  ordered.forEach((sub, idx) => {
    window.setTimeout(() => {
      try {
        sub.fn(info);
      } catch (err) {
        console.warn('[tabWakeGate] subscriber lỗi:', err);
      }
    }, idx * STAGGER_MS);
  });
}

async function fireWake() {
  pendingFireTimer = null;
  if (wakeInProgress) {
    wakeQueued = true;
    return;
  }
  if (document.visibilityState === 'hidden') return;
  wakeInProgress = true;
  const hiddenMs = lastHiddenAt != null ? Date.now() - lastHiddenAt : 0;
  lastHiddenAt = null;
  const isLongSleep = hiddenMs > LONG_SLEEP_MS;
  if (isLongSleep) {
    console.log(
      `[tabWakeGate] Tab quay lại sau ~${Math.round(hiddenMs / 60_000)} phút ẩn — health-precheck trước khi đồng bộ.`,
    );
  }

  try {
    const healthReady = await healthPrecheckUntilReady();
    const info: WakeInfo = { isLongSleep, hiddenMs, healthReady };
    if (document.hidden) {
      wakeQueued = true;
      return;
    }
    if (healthReady) {
      // Health thành công thì luôn dispatch: subscriber là nơi refresh dữ liệu tab hiện tại.
      dispatch(info);
      return;
    }
    console.warn(
      '[tabWakeGate] Backend/Mongo chưa ready sau thời gian chờ tối đa — tiếp tục wake có kiểm soát.',
    );
    // Không khóa UI vô hạn nếu health hết deadline; vẫn cho subscriber thử refresh có kiểm soát.
    dispatch(info);
  } finally {
    wakeInProgress = false;
    if (wakeQueued) {
      wakeQueued = false;
      scheduleWake();
    }
  }
}

function scheduleWake() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (pendingFireTimer != null) return; // đã có 1 lượt đang chờ gộp — khỏi đặt thêm
  pendingFireTimer = window.setTimeout(fireWake, MERGE_DEBOUNCE_MS);
}

let installed = false;
function installGlobalListenersOnce() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('focus', scheduleWake);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleWake();
    else markHiddenNow();
  });
  window.addEventListener('pageshow', (ev: PageTransitionEvent) => {
    if (ev.persisted || document.visibilityState === 'visible') scheduleWake();
  });
  window.addEventListener('online', () => {
    if (document.visibilityState === 'visible') scheduleWake();
  });
}

/**
 * Đăng ký 1 handler chạy khi tab thực sự "tỉnh lại". `priority` thấp chạy trước — dùng để
 * cách các nhóm refresh khác nhau ra xa nhau (ví dụ SSE-check chạy trước, list/counter refresh
 * chạy sau ~300ms, các tác vụ catch-up phụ chạy sau cùng).
 * Handler nhận `WakeInfo` (isLongSleep/hiddenMs) — có thể bỏ qua nếu không cần dùng.
 * Trả về hàm hủy đăng ký (gọi trong cleanup của useEffect).
 */
export function onTabWake(fn: WakeHandler, priority = 0): () => void {
  installGlobalListenersOnce();
  const sub: Subscriber = { fn, priority };
  subscribers.push(sub);
  return () => {
    const idx = subscribers.indexOf(sub);
    if (idx >= 0) subscribers.splice(idx, 1);
  };
}

export type { WakeInfo };
