import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Order } from '../types';
import { OrderPushError, orderPushRequest } from '../utils/orderPush';

export default function OrderPushDetails({ id, onDismiss, renderDetails }: {
  id: string;
  onDismiss: () => void;
  renderDetails: (order: Order) => ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const current = dialog.current;
    current?.showModal();
    return () => current?.close();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void orderPushRequest<{ order: Order }>('/orders/' + encodeURIComponent(id), { signal: controller.signal })
      .then((data) => setOrder(data.order))
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err instanceof OrderPushError ? err.message : 'Không tải được đơn hàng.');
        }
      });
    return () => controller.abort();
  }, [id, retry]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="order-push-details-title"
      onCancel={(event) => { event.preventDefault(); onDismiss(); }}
      className="m-auto max-h-[90dvh] w-[calc(100%-1rem)] max-w-4xl overflow-y-auto rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-xl backdrop:bg-slate-950/60"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2">
        <h2 id="order-push-details-title" className="text-base font-semibold">Đơn hàng {order?.orderSn || ''}</h2>
        <button type="button" autoFocus className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold" onClick={onDismiss}>Đóng</button>
      </div>
      {order ? renderDetails(order) : (
        <div className="p-4 text-sm text-slate-700">
          <p role="status">{error || 'Đang tải đơn hàng…'}</p>
          {error && (
            <button type="button" className="min-h-11 font-semibold text-sky-700 underline" onClick={() => { setError(''); setRetry((count) => count + 1); }}>Thử lại</button>
          )}
        </div>
      )}
    </dialog>
  );
}
