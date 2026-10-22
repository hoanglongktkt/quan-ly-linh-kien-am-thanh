type BatchPrintOptions = {
  headers: HeadersInit;
  body: string;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
};

/** Every network hop is short; the background job owns Shopee's longer wait. */
export async function fetchMergedPrint(options: BatchPrintOptions): Promise<Response> {
  const request = async (url: string, init: RequestInit = {}, timeoutMs = 20_000) => {
    const response = await fetch(url, {
      ...init, headers: options.headers,
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]),
      cache: 'no-store',
    });
    // Consume the body inside the same per-request deadline.
    const body = await response.arrayBuffer();
    return new Response(body, { status: response.status, headers: response.headers });
  };
  const start = await request('/api/orders/batch-print-async', { method: 'POST', body: options.body });
  // Allow frontend and cPanel to be rolled out separately. Never retry an
  // accepted or timed-out job: only an explicitly missing endpoint is safe.
  if (start.status === 404 || start.status === 405) {
    options.onProgress?.('Đang chuẩn bị file PDF...');
    return request('/api/orders/batch-print', { method: 'POST', body: options.body }, 150_000);
  }
  const accepted = await start.json();
  if (!start.ok || !accepted.jobId) throw new Error(accepted.message || `HTTP ${start.status}`);
  for (;;) {
    options.signal.throwIfAborted();
    const response = await request(`/api/orders/batch-print-jobs/${encodeURIComponent(accepted.jobId)}`);
    const job = await response.json();
    if (!response.ok || job.status === 'failed') throw new Error(job.message || 'Không thể tạo file in.');
    if (job.status === 'done') {
      const result = job.result;
      if (!result?.filename || !result?.printedOrders?.length) throw new Error('Không có PDF hợp lệ để in.');
      options.onProgress?.('Đang mở file PDF...');
      const pdf = await request(`/api/public/labels/${encodeURIComponent(result.filename)}`);
      if (!pdf.ok || !pdf.headers.get('content-type')?.includes('application/pdf')) {
        throw new Error('Không tải được file PDF. Hãy bấm In lại.');
      }
      const headers = new Headers(pdf.headers);
      headers.set('X-Print-Success-Count', String(result.printedOrders.length));
      headers.set('X-Print-Total', String(result.total || result.printedOrders.length + (result.failedOrders?.length || 0)));
      headers.set('X-Print-Filename', result.filename);
      headers.set('X-Print-Printed-Orders', result.printedOrders.join(','));
      headers.set('X-Print-Failed-Orders', (result.failedOrders || []).map((item: any) => item.orderSn).join(','));
      return new Response(pdf.body, { headers });
    }
    if (job.message) options.onProgress?.(job.message);
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(options.signal.reason); };
      const timer = setTimeout(() => { options.signal.removeEventListener('abort', abort); resolve(); }, 1500);
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
    });
  }
}
