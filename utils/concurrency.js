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

/**
 * Xác nhận / tải PDF theo NHÓM shopId: các SHOP KHÁC NHAU chạy SONG SONG (mỗi
 * shop dùng access_token Shopee riêng — không tranh rate-limit với nhau). Bên
 * trong CÙNG 1 shop vẫn xử lý theo lô nhỏ + nghỉ giữa lô để không dội rate-limit
 * lên 1 access_token. Nhanh hơn (đa shop chạy song song) & an toàn hơn so với
 * chia lô cố định N đơn xuyên nhiều shop (dễ dính rate-limit khi trộn nhiều shop
 * vào cùng 1 lô, và không tận dụng được việc các shop độc lập token với nhau).
 * CẤM chạy quá maxParallelShops nhóm cùng lúc (chống tràn CPU/spike cPanel).
 */
export async function mapByShopGroups(items, resolveShopId, worker, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return;
  const perShopChunk = Math.max(1, Math.floor(Number(opts.perShopChunk) || 4));
  const pauseMs = Math.max(0, Math.floor(Number(opts.pauseMs) || 250));
  const maxParallelShops = Math.max(1, Math.floor(Number(opts.maxParallelShops) || 6));

  const groups = new Map();
  const noShopGroup = [];
  for (const item of list) {
    let sid = "";
    try {
      sid = String(resolveShopId(item) || "").trim();
    } catch {
      sid = "";
    }
    if (!sid) {
      noShopGroup.push(item);
      continue;
    }
    const arr = groups.get(sid);
    if (arr) arr.push(item);
    else groups.set(sid, [item]);
  }
  const allGroups = [...groups.values()];
  if (noShopGroup.length) allGroups.push(noShopGroup);
  if (allGroups.length === 0) return;

  // Giới hạn số shop chạy đồng thời — mỗi shop bên trong vẫn chia lô nhỏ + nghỉ.
  await mapWithConcurrency(allGroups, maxParallelShops, (group) =>
    mapInChunks(group, perShopChunk, worker, pauseMs),
  );
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
