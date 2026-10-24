export type LogisticsLane = 'confirm' | 'print';
type SavedJob = { requestId: string; jobId?: string; input: any; createdAt: number };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function storageKey(lane: LogisticsLane, headers: Record<string, string>) {
  // Scope recovery to the login session without storing a token in the journal.
  let hash = 2166136261;
  for (const c of headers.Authorization || headers.authorization || '') hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return `oms-logistics-${lane}-${hash >>> 0}`;
}
export function readLogisticsJob(lane: LogisticsLane, headers: Record<string, string>): SavedJob | null {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(lane, headers)) || 'null');
    return saved && Date.now() - saved.createdAt < 7 * 86400000 ? saved : null;
  } catch { return null; }
}
export function clearLogisticsJob(lane: LogisticsLane, headers: Record<string, string>) {
  try { localStorage.removeItem(storageKey(lane, headers)); } catch { /* unavailable storage */ }
}
function save(lane: LogisticsLane, headers: Record<string, string>, job: SavedJob) {
  try { localStorage.setItem(storageKey(lane, headers), JSON.stringify(job)); } catch { /* keep in memory */ }
}
export class LogisticsJobPendingError extends Error {}

// The deadline covers both headers and the complete body. Each poll is bounded;
// network errors never mean that an accepted shipment failed on Shopee.
export async function logisticsRequest(url: string, headers: Record<string, string>, body?: unknown, binary = false, timeoutMs?: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || (binary ? 60000 : 15000));
  try {
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
    });
    let data: any;
    if (binary && response.ok) data = await response.arrayBuffer();
    else if (response.headers && !String(response.headers.get('content-type')).includes('json')) {
      await response.text();
      data = { message: `Máy chủ trả HTTP ${response.status}.` };
    } else data = await response.json();
    return { response, data };
  } finally { clearTimeout(timer); }
}

export async function runLogisticsJob(
  lane: LogisticsLane, input: any, headers: Record<string, string>, onProgress: (job: any) => void,
): Promise<any> {
  let saved = readLogisticsJob(lane, headers);
  if (saved && JSON.stringify(saved.input) !== JSON.stringify(input)) {
    throw new LogisticsJobPendingError('Lô trước đang được theo dõi. Tải lại trang để tiếp tục lô đó.');
  }
  saved ||= { requestId: crypto.randomUUID(), input, createdAt: Date.now() };
  save(lane, headers, saved);
  const deadline = Date.now() + 40 * 60 * 1000;
  let failures = 0;
  for (let attempt = 0; Date.now() < deadline && attempt < 2400; attempt++) {
    if (attempt) await sleep(Math.min(5000, 1000 + failures * 750));
    try {
      if (!saved.jobId) {
        const url = lane === 'confirm' ? '/api/orders/batch-confirm-async' : '/api/orders/batch-print/async';
        const { response, data } = await logisticsRequest(url, headers, { ...input, requestId: saved.requestId });
        // During rollout, only an explicitly absent new endpoint permits the
        // old print API. Never fall back after acceptance or an ambiguous timeout.
        if (lane === 'print' && (response.status === 404 || response.status === 405)) {
          clearLogisticsJob(lane, headers);
          return { status: 'legacy' };
        }
        if (response.status === 400 || response.status === 401 || response.status === 403) {
          clearLogisticsJob(lane, headers);
          throw Object.assign(new Error(data.message || 'Không tiếp nhận được tác vụ.'), { permanent: true });
        }
        if (!response.ok || !data.accepted || !data.jobId) throw new Error(data.message || 'Chưa kết nối được máy chủ.');
        saved.jobId = data.jobId;
        save(lane, headers, saved);
      }
      const url = lane === 'confirm' ? `/api/shopee/ship-order/job/${saved.jobId}` : `/api/orders/batch-print/job/${saved.jobId}`;
      const { response, data } = await logisticsRequest(url, headers);
      if (response.status === 401 || response.status === 403) {
        throw new LogisticsJobPendingError('Phiên đăng nhập hết hạn. Đơn đã tiếp nhận vẫn được xử lý trên máy chủ.');
      }
      if (!response.ok) throw new Error(data.message || 'Đang kết nối lại để đọc tiến độ...');
      failures = 0;
      onProgress(data);
      if (data.status === 'done' || data.status === 'failed') return data;
    } catch (error: any) {
      if (error.permanent || error instanceof LogisticsJobPendingError) throw error;
      failures++;
      onProgress({ status: 'reconnecting', message: 'Đang kết nối lại. Máy chủ vẫn tiếp tục xử lý; không cần xác nhận lại đơn.' });
      if (failures >= 12) break;
    }
  }
  throw new LogisticsJobPendingError('Chưa đọc được kết quả cuối. Tác vụ đã được lưu; tải lại trang để tiếp tục theo dõi.');
}
