import type { ImportTransaction, Product, Supplier } from '../types';
import { parseJsonResponse } from './apiClient';
import { decodeJwtPayload } from './jwtClient';

export interface PendingImportBatch {
  batchId: string;
  transactions: ImportTransaction[];
}

export interface ImportBatchResult {
  success: true;
  batchId: string;
  entries: ImportTransaction[];
  updatedProducts: Product[];
  supplier: Supplier | null;
  replayed: boolean;
}

export class ImportBatchSaveError extends Error {
  constructor(message: string, public uncertain: boolean) { super(message); }
}

function pendingKey() {
  const user = decodeJwtPayload(localStorage.getItem('admin_token') || '');
  return `omni_pending_import_batch_v1:${user?.username || 'current'}`;
}

export function readPendingImportBatch(): PendingImportBatch | null {
  try {
    const pending = JSON.parse(sessionStorage.getItem(pendingKey()) || 'null');
    if (!pending || !/^[a-zA-Z0-9_-]{8,100}$/.test(pending.batchId) ||
        !Array.isArray(pending.transactions) || !pending.transactions.length ||
        !pending.transactions.every((tx: ImportTransaction) => tx?.productId && tx?.supplierId && tx.quantity > 0)) return null;
    return pending;
  } catch { return null; }
}

export function keepPendingImportBatch(pending: PendingImportBatch): void {
  try { sessionStorage.setItem(pendingKey(), JSON.stringify(pending)); } catch {
    throw new ImportBatchSaveError('Không thể giữ phiếu để thử lại. Vui lòng cho phép lưu dữ liệu trong trình duyệt.', false);
  }
}

export function clearPendingImportBatch(): void {
  try { sessionStorage.removeItem(pendingKey()); } catch { /* server deduplicates a restored receipt */ }
}

const errors: Record<string, string> = {
  import_product_not_found: 'Có sản phẩm không còn trong Kho Gốc. Vui lòng kiểm tra lại phiếu.',
  duplicate_import_product: 'Phiếu có sản phẩm bị trùng. Vui lòng kiểm tra lại.',
  ambiguous_import_product: 'Có mã sản phẩm bị trùng trong kho. Vui lòng kiểm tra lại SKU.',
  import_parent_and_child_conflict: 'Vui lòng chọn từng phân loại, không chọn cả sản phẩm cha và phân loại của nó.',
  supplier_not_found: 'Nhà cung cấp không còn tồn tại. Vui lòng chọn lại.',
  import_batch_id_conflict: 'Mã phiếu đã được dùng với nội dung khác. Vui lòng kiểm tra lịch sử nhập.',
  import_batch_requires_disk_storage: 'Cấu hình lưu Kho Gốc không hỗ trợ lưu phiếu hàng loạt.',
};

export async function saveImportBatchRequest(
  transactions: ImportTransaction[], batchId: string, headers: HeadersInit,
  fetcher: typeof fetch = fetch, timeoutMs = 60_000,
): Promise<ImportBatchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response | undefined;
  try {
    response = await fetcher('/api/imports/batch', {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({ batchId, supplierId: transactions[0]?.supplierId, items: transactions }),
    });
    const data = await parseJsonResponse<ImportBatchResult>(response);
    if (data.success !== true || data.batchId !== batchId ||
        !Array.isArray(data.entries) || data.entries.length !== transactions.length ||
        !Array.isArray(data.updatedProducts) || (!data.supplier?.id && !data.replayed)) {
      throw new ImportBatchSaveError('Phản hồi lưu phiếu chưa đầy đủ. Vui lòng thử lại cùng phiếu.', true);
    }
    return data;
  } catch (error) {
    if (error instanceof ImportBatchSaveError) throw error;
    // Keep the same receipt after timeouts/5xx: the server may already have committed.
    const uncertain = !response || response.ok || response.status >= 500 || response.status === 408 || response.status === 429;
    if (controller.signal.aborted) {
      throw new ImportBatchSaveError('Quá thời gian chờ xác nhận lưu. Phiếu đã được giữ lại; hãy nhấn Thử lưu lại để kiểm tra, không nhập trùng.', true);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ImportBatchSaveError(errors[message] || (uncertain
      ? 'Chưa xác nhận được kết quả lưu. Phiếu đã được giữ lại; hãy nhấn Thử lưu lại.'
      : `Không lưu được phiếu nhập: ${message}`), uncertain);
  } finally {
    clearTimeout(timer);
  }
}
