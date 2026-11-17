import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Printer, X } from 'lucide-react';
import { PosInvoiceTemplate } from './PosInvoiceTemplate';
import { draftTotals, type OrderDraft } from '../utils/orderDrafts';

export default function DraftQuotation({ draft, onClose }: { draft: OrderDraft; onClose: () => void }) {
  const p = draft.payload;
  const totals = draftTotals(draft);
  const addr = p.shippingAddress;
  const address = draft.kind === 'pos'
    ? (p.walk_in ? 'Mua tại cửa hàng' : p.customerAddress)
    : [addr?.street, addr?.ward, addr?.district, addr?.province].filter(Boolean).join(', ');
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `Bao-gia-${draft.number}-${p.customerName || 'Khach-hang'}`;
    const keydown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', keydown);
    return () => { document.title = previousTitle; document.removeEventListener('keydown', keydown); };
  }, [draft.number, p.customerName, onClose]);
  return createPortal(
    <div id="draft-quote-root" role="dialog" aria-modal="true" aria-label="Xem báo giá" className="fixed inset-0 z-[200] bg-slate-900/60 overflow-y-auto p-3 md:p-8">
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 15mm; }
          html, body { height: auto !important; overflow: visible !important; background: white !important; }
          body > *:not(#draft-quote-root) { display: none !important; }
          body > #draft-quote-root { display: block !important; position: static !important; padding: 0 !important; background: white !important; overflow: visible !important; }
          #draft-quote-root, #draft-quote-root * { visibility: visible !important; }
          #draft-quote-root .quote-controls { display: none !important; }
          #draft-quote-root #pos-invoice { display: block !important; position: static !important; width: 100% !important; max-width: none !important; border: 0 !important; padding: 0 !important; margin: 0 !important; }
          #draft-quote-root tr, #draft-quote-root .invoice-totals { break-inside: avoid; }
          #draft-quote-root thead { display: table-header-group; }
        }
      `}</style>
      <div className="max-w-4xl mx-auto">
        <div className="quote-controls flex flex-wrap justify-between items-center gap-3 bg-white rounded-xl p-4 mb-4">
          <div><h2 className="font-bold text-slate-900">Báo giá {draft.number}</h2><p className="text-xs text-slate-500 mt-1">Chọn “Lưu dưới dạng PDF” trong hộp thoại in để gửi khách.</p></div>
          <div className="flex gap-2">
            <button type="button" onClick={() => window.print()} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 text-white font-bold text-sm"><Printer size={16} /> In / Lưu PDF</button>
            <button type="button" onClick={onClose} aria-label="Đóng báo giá" className="p-2 rounded-xl border border-slate-200"><X size={20} /></button>
          </div>
        </div>
        <PosInvoiceTemplate
          storeInfo={draft.storeInfo} documentTitle="BÁO GIÁ" quotation
          orderSn={draft.number} dateText={new Date(draft.updatedAt).toLocaleString('vi-VN')}
          customerName={p.customerName || 'Khách hàng'} customerPhone={p.customerPhone || '—'} customerAddress={address || '—'}
          lines={p.items.map((it) => ({ productTitle: it.productTitle, quantity: it.quantity, sellingPrice: it.price, lineTotal: it.price * it.quantity }))}
          subtotal={totals.subtotal} shippingFee={totals.shippingFee} prepaid={totals.prepaid} discount={totals.discount} amountDue={totals.amountDue} note={p.note}
        />
      </div>
    </div>, document.body,
  );
}
