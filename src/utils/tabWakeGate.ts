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
 */

type WakeHandler = () => void;

type Subscriber = {
  fn: WakeHandler;
  priority: number;
};

const subscribers: Subscriber[] = [];

/** Gộp các sự kiện focus/visibilitychange/pageshow bắn dồn cùng lúc thành 1 wake. */
const MERGE_DEBOUNCE_MS = 350;
/** Khoảng cách giữa 2 subscriber liên tiếp khi phát wake — tránh dội request cùng lúc. */
const STAGGER_MS = 300;

let pendingFireTimer: number | null = null;

function fireWake() {
  pendingFireTimer = null;
  // Phát theo priority tăng dần, mỗi subscriber cách nhau STAGGER_MS.
  const ordered = [...subscribers].sort((a, b) => a.priority - b.priority);
  ordered.forEach((sub, idx) => {
    window.setTimeout(() => {
      try {
        sub.fn();
      } catch (err) {
        console.warn('[tabWakeGate] subscriber lỗi:', err);
      }
    }, idx * STAGGER_MS);
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
  });
  window.addEventListener('pageshow', (ev: PageTransitionEvent) => {
    if (ev.persisted || document.visibilityState === 'visible') scheduleWake();
  });
}

/**
 * Đăng ký 1 handler chạy khi tab thực sự "tỉnh lại". `priority` thấp chạy trước — dùng để
 * cách các nhóm refresh khác nhau ra xa nhau (ví dụ SSE-check chạy trước, list/counter refresh
 * chạy sau ~300ms, các tác vụ catch-up phụ chạy sau cùng).
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
