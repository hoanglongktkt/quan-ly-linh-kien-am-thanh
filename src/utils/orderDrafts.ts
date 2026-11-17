import type { StoreInvoiceInfo } from '../components/PosInvoiceTemplate';

export type OrderDraft = {
  id: string;
  number: string;
  kind: 'pos' | 'manual';
  version: number;
  payload: Record<string, any> & { items: any[] };
  formState?: { shippingAddress?: any };
  storeInfo: StoreInvoiceInfo;
  createdAt: string;
  updatedAt: string;
};

export async function saveOrderDraft(
  input: Pick<OrderDraft, 'kind' | 'payload' | 'storeInfo' | 'formState'>,
  current: OrderDraft | null,
  newId: string,
  authHeaders: () => Record<string, string>,
): Promise<OrderDraft> {
  const res = await fetch(current ? `/api/orders/drafts/${encodeURIComponent(current.id)}` : '/api/orders/drafts', {
    method: current ? 'PUT' : 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, id: current?.id || newId, version: current?.version }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success || !data.draft?.id) throw new Error(data.error || 'Không lưu được đơn nháp. Vui lòng thử lại.');
  return data.draft;
}

export function draftTotals(draft: Pick<OrderDraft, 'kind' | 'payload'>) {
  const p = draft.payload;
  const subtotal = p.items.reduce((sum, it) => sum + Number(it.price ?? it.sellingPrice ?? 0) * Number(it.quantity || 0), 0);
  const shippingFee = draft.kind === 'manual' && p.shippingFeePayer === 'sender' ? 0 : Number(p.shippingFee || 0);
  const discount = Number(p.orderDiscount || 0);
  const prepaid = Number(p.prepaidAmount || 0);
  const total = Math.max(0, subtotal + shippingFee - discount);
  return { subtotal, shippingFee, discount, prepaid, total, amountDue: Math.max(0, total - prepaid) };
}
