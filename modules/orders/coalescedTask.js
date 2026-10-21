// A snapshot request means "refresh to the latest state", not one job per event.
export function createCoalescedTask(work, { minIntervalMs = 30000, initialDelayMs = 1000, onError = () => {} } = {}) {
  let dirty = false, running = false, timer = null, lastStartedAt = null;
  function schedule() {
    if (!dirty || running || timer) return;
    const delay = lastStartedAt == null ? initialDelayMs : Math.max(0, lastStartedAt + minIntervalMs - Date.now());
    timer = setTimeout(async () => {
      timer = null;
      dirty = false;
      running = true;
      lastStartedAt = Date.now();
      try { await work(); }
      catch (error) { onError(error); }
      finally { running = false; schedule(); }
    }, delay);
    timer.unref?.();
  }
  return {
    request() { dirty = true; schedule(); },
    cancel() { dirty = false; if (timer) clearTimeout(timer); timer = null; },
  };
}
