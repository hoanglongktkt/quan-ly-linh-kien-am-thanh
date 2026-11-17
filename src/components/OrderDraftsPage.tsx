import React, { useEffect, useState } from 'react';
import { ArrowLeft, FileText, Loader2, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { draftTotals, type OrderDraft } from '../utils/orderDrafts';
import { formatVnd } from './PosInvoiceTemplate';
import DraftQuotation from './DraftQuotation';

export default function OrderDraftsPage({ authHeaders, onBack, onEdit, onCreate }: {
  authHeaders: () => Record<string, string>;
  onBack: () => void;
  onEdit: (draft: OrderDraft) => void;
  onCreate: (kind: 'pos' | 'manual') => void;
}) {
  const [drafts, setDrafts] = useState<OrderDraft[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [createdFrom, setCreatedFrom] = useState('');
  const [createdTo, setCreatedTo] = useState('');
  const [sortValue, setSortValue] = useState('createdAt:desc');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState('');
  const [quotation, setQuotation] = useState<OrderDraft | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(query.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void (async () => {
      try {
        const [sortBy, sortOrder] = sortValue.split(':');
        const params = new URLSearchParams({ page: String(page), q: search, sortBy, sortOrder });
        if (createdFrom) params.set('createdFrom', createdFrom);
        if (createdTo) params.set('createdTo', createdTo);
        const res = await fetch(`/api/orders/drafts?${params}`, { headers: authHeaders(), signal: controller.signal });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Không tải được đơn nháp.');
        if (controller.signal.aborted) return;
        if (page > 1 && !data.drafts.length) { setPage(page - 1); return; }
        setDrafts(data.drafts); setTotal(data.total);
      } catch (err: any) { if (!controller.signal.aborted) setError(err.message || 'Lỗi kết nối.'); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [page, search, createdFrom, createdTo, sortValue, refresh, authHeaders]);
  useEffect(() => {
    setPage(1);
  }, [search, createdFrom, createdTo, sortValue]);
  const clearFilters = () => {
    setCreatedFrom(''); setCreatedTo(''); setSortValue('createdAt:desc'); setQuery('');
  };
  const remove = async (draft: OrderDraft) => {
    if (!window.confirm(`Xóa đơn nháp ${draft.number}?`)) return;
    setDeleting(draft.id); setError('');
    try {
      const res = await fetch(`/api/orders/drafts/${encodeURIComponent(draft.id)}?version=${draft.version}`, { method: 'DELETE', headers: authHeaders() });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Không xóa được đơn nháp.');
      setRefresh((n) => n + 1);
    } catch (err: any) { setError(err.message); }
    finally { setDeleting(''); }
  };
  return <div className="space-y-5 max-w-7xl mx-auto pb-8">
    <button type="button" onClick={onBack} className="inline-flex items-center gap-2 text-sm font-bold text-slate-600"><ArrowLeft size={18} /> Quay lại đơn hàng</button>
    <div className="flex flex-wrap justify-between items-center gap-4">
      <div><h1 className="text-2xl font-extrabold text-slate-900 flex items-center gap-2"><FileText className="text-amber-600" /> Đơn nháp <span className="text-sm bg-amber-100 text-amber-800 rounded-full px-2 py-1">{total}</span></h1><p className="text-sm text-slate-500 mt-1">Lưu báo giá cho khách. Đơn nháp chưa trừ kho, tính doanh thu hay gửi vận chuyển.</p></div>
      <div className="flex gap-2 flex-wrap">
        <button type="button" onClick={() => onCreate('pos')} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-sky-600 text-white font-bold text-xs"><Plus size={16} /> Tạo đơn nhanh</button>
        <button type="button" onClick={() => onCreate('manual')} className="px-4 py-2.5 rounded-xl bg-emerald-600 text-white font-bold text-xs">Tạo đơn ngoại sàn</button>
      </div>
    </div>
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
      <div className="flex flex-wrap gap-3 p-4 border-b border-slate-100 items-end">
        <div className="relative flex-1 min-w-60 max-w-lg"><Search size={16} className="absolute top-3 left-3 text-slate-400" /><input aria-label="Tìm đơn nháp" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm mã báo giá, khách hàng, SĐT, sản phẩm…" className="w-full pl-9 pr-3 py-2.5 text-sm rounded-xl border border-slate-200" /></div>
        <label className="text-xs font-bold text-slate-600">Từ ngày<input type="date" value={createdFrom} onChange={(e) => setCreatedFrom(e.target.value)} className="block mt-1 px-3 py-2.5 text-sm rounded-xl border border-slate-200" /></label>
        <label className="text-xs font-bold text-slate-600">Đến ngày<input type="date" value={createdTo} onChange={(e) => setCreatedTo(e.target.value)} className="block mt-1 px-3 py-2.5 text-sm rounded-xl border border-slate-200" /></label>
        <label className="text-xs font-bold text-slate-600">Sắp xếp<select value={sortValue} onChange={(e) => setSortValue(e.target.value)} className="block mt-1 px-3 py-2.5 text-sm rounded-xl border border-slate-200"><option value="createdAt:desc">Ngày tạo mới nhất</option><option value="createdAt:asc">Ngày tạo cũ nhất</option><option value="updatedAt:desc">Cập nhật mới nhất</option><option value="updatedAt:asc">Cập nhật cũ nhất</option></select></label>
        <button type="button" onClick={clearFilters} className="px-3 py-2.5 rounded-xl border border-slate-200 text-xs font-bold">Xóa lọc</button>
        <button type="button" onClick={() => setRefresh((n) => n + 1)} disabled={loading} aria-label="Tải lại đơn nháp" className="p-2.5 rounded-xl border border-slate-200"><RefreshCw size={18} className={loading ? 'animate-spin' : ''} /></button>
      </div>
      {error ? <div role="alert" className="p-5 text-rose-700 bg-rose-50">{error}</div> : loading ? <div className="p-14 flex justify-center"><Loader2 className="animate-spin text-slate-400" /></div> : drafts.length === 0 ? <div className="p-14 text-center text-slate-500"><FileText className="mx-auto mb-3 text-slate-300" size={36} />{search ? 'Không tìm thấy đơn nháp phù hợp.' : 'Chưa có đơn nháp. Chọn “Lưu đơn nháp” khi tạo đơn để làm báo giá.'}</div> : <div className="divide-y divide-slate-100">
        {drafts.map((draft) => <div key={draft.id} className="p-4 md:p-5 flex flex-wrap items-center justify-between gap-4 hover:bg-slate-50/70">
          <div className="min-w-0 flex-1 basis-60"><div className="flex gap-2 items-center flex-wrap"><span className="font-extrabold text-slate-800">{draft.number}</span><span className="text-[10px] rounded-md px-2 py-1 bg-amber-50 text-amber-800 font-bold">{draft.kind === 'pos' ? 'Đơn nhanh' : 'Ngoại sàn'}</span></div><div className="text-sm font-semibold text-slate-700 mt-1">{draft.payload.customerName || 'Chưa có tên khách'} {draft.payload.customerPhone && `· ${draft.payload.customerPhone}`}</div><div className="text-xs text-slate-500 mt-1 line-clamp-2">{draft.payload.items.map((it) => `${it.productTitle} × ${it.quantity}`).join('; ')}</div><div className="text-[11px] text-slate-400 mt-1">Tạo {new Date(draft.createdAt).toLocaleString('vi-VN')} · Cập nhật {new Date(draft.updatedAt).toLocaleString('vi-VN')}</div></div>
          <div className="font-extrabold text-lg text-emerald-700">{formatVnd(draftTotals(draft).total)}₫</div>
          <div className="flex flex-wrap gap-2 text-xs font-bold">
            <button type="button" onClick={() => onEdit(draft)} className="inline-flex items-center gap-1.5 px-3 py-2.5 border border-slate-200 rounded-xl text-slate-700 bg-white"><Pencil size={15} /> Sửa / Tạo đơn</button>
            <button type="button" onClick={() => setQuotation(draft)} className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-amber-800 bg-amber-100"><FileText size={15} /> Báo giá / PDF</button>
            <button type="button" disabled={deleting === draft.id} onClick={() => void remove(draft)} aria-label={`Xóa ${draft.number}`} className="p-2.5 rounded-xl text-rose-600 hover:bg-rose-50">{deleting === draft.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}</button>
          </div>
        </div>)}
      </div>}
      <div className="p-4 border-t border-slate-100 flex justify-between items-center text-xs text-slate-500"><span>{total} đơn nháp · Trang {page}/{Math.max(1, Math.ceil(total / 30))}</span><div className="flex gap-2"><button type="button" disabled={page === 1 || loading} onClick={() => setPage((p) => p - 1)} className="px-3 py-2 border rounded-lg disabled:opacity-40">Trước</button><button type="button" disabled={page * 30 >= total || loading} onClick={() => setPage((p) => p + 1)} className="px-3 py-2 border rounded-lg disabled:opacity-40">Sau</button></div></div>
    </div>
    {quotation && <DraftQuotation draft={quotation} onClose={() => setQuotation(null)} />}
  </div>;
}
