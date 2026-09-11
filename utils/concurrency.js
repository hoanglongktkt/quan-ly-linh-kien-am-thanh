/** Default giữ nguyên giá trị hằng số cũ trong server.ts. */
const DEFAULT_DELAY_MS = 1000;
const DEFAULT_YIELD_MS = 50;
const DEFAULT_BATCH_ITEM_DELAY_MS = 1000;
const DEFAULT_BATCH_PAUSE_MS = 2500;

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Chạy worker theo lô (chunk) — mỗi lô Promise.all nội bộ, sleep giữa các lô.
 * Dùng cho confirm-ship Shopee: không Promise.all trần cả danh sách.
 */
export async function mapInChunks(items, chunkSize, worker, pauseMs = 300) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.floor(Number(chunkSize) || 10));
  const gap = Math.max(0, Math.floor(Number(pauseMs) || 0));
  const results = [];
  for (let i = 0; i < list.length; i += size) {
    const chunk = list.slice(i, i + size);
    const part = await Promise.all(chunk.map((item, j) => worker(item, i + j)));
    results.push(...part);
    if (i + size < list.length && gap > 0) await sleep(gap);
  }
  return results;
}

/**
 * Chạy async tasks song song với giới hạn concurrency (tránh rate-limit Shopee
 * khi Promise.all toàn bộ cùng lúc). Giữ thứ tự kết quả theo input.
 */
export async function mapWithConcurrency(items, concurrency, worker) {
  const n = items.length;
  if (n === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, n));
  const results = new Array(n);
  let next = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (true) {
      const i = next++;
      if (i >= n) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        // Không để 1 item reject làm Promise.all chết cả pool (treo/dở dang runner).
        results[i] = undefined;
        console.error("[mapWithConcurrency] worker error at index", i, err);
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/** Nghỉ giữa các batch sync (mặc định 1s) — GC / chống spike process cPanel. */
export function delay(ms = DEFAULT_DELAY_MS) {
  return sleep(ms);
}

/** Nhường CPU cho OS (Event Loop Yielding) — bắt buộc trên cPanel/CloudLinux. */
export async function yieldEventLoop(ms = DEFAULT_YIELD_MS) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runInBatches(items, batchSize, worker, opts) {
  const size = Math.max(1, batchSize);
  const itemDelayMs = opts?.itemDelayMs ?? DEFAULT_BATCH_ITEM_DELAY_MS;
  const batchPauseMs = opts?.batchPauseMs ?? DEFAULT_BATCH_PAUSE_MS;
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    for (const item of batch) {
      await worker(item);
      await sleep(itemDelayMs);
    }
    if (i + size < items.length) {
      await sleep(batchPauseMs);
    }
  }
}

export async function withOperationTimeout(work, ms, label) {
  const controller = new AbortController();
  let timer;
  const promise = typeof work === "function" ? work(controller.signal) : work;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`${label} timeout sau ${ms / 1000} giây.`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
