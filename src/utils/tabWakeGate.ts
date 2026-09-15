/**
 * tabWakeGate — điều phối chung sự kiện "tab quay lại foreground" (focus / visibilitychange /
 * pageshow) cho TOÀN APP.
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
 * Các cooldown "có nên refresh không" (800ms, 3000ms...) vẫn giữ nguyên bên trong từng handler —
 * module này chỉ đảm bảo listener không bị nhân bản/không bắn cùng tick, KHÔNG thay đổi logic
 * nghiệp vụ refresh của từng nơi.
 *
 * Cold-start buổi sáng: nếu tab bị ẩn/máy sleep lâu hơn LONG_SLEEP_MS trước khi wake lại, server
 * cPanel/Passenger nhiều khả năng đang "ngủ đông" — bắn thẳng /refresh + /counter + SSE reconnect
 * vào lúc đó dễ bị nghẽn 10-45s (đúng triệu chứng cold-start). Nên trước khi phát wake cho các
 * subscriber, module tự "đánh thức" server bằng 1 GET /api/health nhẹ (không phải request nghiệp
 * vụ), rồi chờ thêm LONG_SLEEP_EXTRA_DELAY_MS mới phát wake — không thay đổi thứ tự/priority hiện có.
 */

type WakeInfo = {
  /** true nếu tab bị ẩn lâu hơn LONG_SLEEP_MS trước khi wake lại (khả năng cao server đang cold). */
  isLongSleep: boolean;
  /** Thời gian tab đã ẩn (ms) trước khi wake — 0 nếu không xác định được. */
  hiddenMs: number;
};

type WakeHandler = (info: WakeInfo) => void;

type Subscriber = {
  fn: WakeHandler;
  priority: number;
};

const subscribers: Subscriber[] = [];

/** Gộp các sự kiện focus/visibilitychange/pageshow bắn dồn cùng lúc thành 1 wake. */
const MERGE_DEBOUNCE_MS = 350;
/** Khoảng cách giữa 2 subscriber liên tiếp khi phát wake — tránh dội request cùng lúc. */
const STAGGER_MS = 300;
/** Ẩn lâu hơn mốc này (30 phút) mới coi là "ngủ qua đêm" — tránh coi đổi tab thường là cold-start. */
const LONG_SLEEP_MS = 30 * 60_000;
/** Timeout cho GET /api/health "đánh thức" server — không chặn wake quá lâu nếu server vẫn chết. */
const HEALTH_PRECHECK_TIMEOUT_MS = 6_000;
/** Chờ thêm sau health-precheck trước khi phát wake cho subscriber — cho Mongo kịp connect. */
const LONG_SLEEP_EXTRA_DELAY_MS = 1_200;

let pendingFireTimer: number | null = null;
/** Mốc thời điểm tab chuyển sang "hidden" gần nhất — dùng để tính đã ẩn bao lâu khi wake lại. */
let lastHiddenAt: number | null = null;

function markHiddenNow() {
  lastHiddenAt = Date.now();
}

/** Chỉ để "đánh thức" server cPanel đang cold — lỗi/timeout không chặn wake tiếp theo. */
async function healthPrecheckOnce(): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), HEALTH_PRECHECK_TIMEOUT_MS);
    await fetch('/api/health', { signal: controller.signal, cache: 'no-store' });
    window.clearTimeout(timer);
  } catch {
    /* ignore — mục đích chỉ là ping đánh thức, không cần biết kết quả */
  }
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

function fireWake() {
  pendingFireTimer = null;
  const hiddenMs = lastHiddenAt != null ? Date.now() - lastHiddenAt : 0;
  lastHiddenAt = null;
  const isLongSleep = hiddenMs > LONG_SLEEP_MS;
  const info: WakeInfo = { isLongSleep, hiddenMs };
  if (!isLongSleep) {
    dispatch(info);
    return;
  }
  console.log(
    `[tabWakeGate] Tab quay lại sau ~${Math.round(hiddenMs / 60_000)} phút ẩn — health-precheck trước khi đồng bộ (chống dội request vào server cold-start).`,
  );
  void healthPrecheckOnce().then(() => {
    window.setTimeout(() => dispatch(info), LONG_SLEEP_EXTRA_DELAY_MS);
  });
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
