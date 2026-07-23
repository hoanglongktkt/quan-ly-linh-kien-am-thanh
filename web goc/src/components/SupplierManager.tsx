import React, { useState } from 'react';
import { Supplier } from '../types';
import {
  Plus,
  Search,
  Edit3,
  Trash2,
  Check,
  HandCoins,
  UserPlus,
  Scale,
  Coins,
} from 'lucide-react';

interface SupplierManagerProps {
  suppliers: Supplier[];
  onAddSupplier: (payload: {
    name: string;
    supplierCode: string;
    status: 'active' | 'inactive';
  }) => Promise<boolean>;
  onUpdateSupplier: (supplier: Supplier) => Promise<boolean>;
  onDeleteSupplier: (id: string) => Promise<boolean>;
}

export default function SupplierManager({
  suppliers,
  onAddSupplier,
  onUpdateSupplier,
  onDeleteSupplier,
}: SupplierManagerProps) {
  const [search, setSearch] = useState('');
  const [filterDebt, setFilterDebt] = useState<'all' | 'has_debt' | 'no_debt'>('all');
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [paymentSupplier, setPaymentSupplier] = useState<Supplier | null>(null);
  const [paymentAmount, setPaymentAmount] = useState<number>(500000);
  const [paymentNotes, setPaymentNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState('');
  const [supplierCode, setSupplierCode] = useState('');
  const [status, setStatus] = useState<'active' | 'inactive'>('active');

  const totalPurchases = suppliers.reduce((sum, s) => sum + s.totalOrderValue, 0);
  const totalPaid = suppliers.reduce((sum, s) => sum + s.totalPaid, 0);
  const totalDebt = suppliers.reduce((sum, s) => sum + s.totalDebt, 0);

  const filteredSuppliers = suppliers.filter((sup) => {
    const q = search.toLowerCase();
    const matchesSearch =
      !q ||
      sup.name.toLowerCase().includes(q) ||
      sup.supplierCode.toLowerCase().includes(q);

    const matchesDebt =
      filterDebt === 'all'
        ? true
        : filterDebt === 'has_debt'
          ? sup.totalDebt > 0
          : sup.totalDebt === 0;

    return matchesSearch && matchesDebt;
  });

  const handleOpenAddModal = () => {
    setName('');
    setSupplierCode('');
    setStatus('active');
    setShowAddModal(true);
  };

  const handleOpenEditModal = (sup: Supplier) => {
    setEditingSupplier(sup);
    setName(sup.name);
    setSupplierCode(sup.supplierCode);
    setStatus(sup.status);
  };

  const handleCreateSupplier = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !supplierCode.trim()) return;
    setSaving(true);
    const ok = await onAddSupplier({
      name: name.trim(),
      supplierCode: supplierCode.trim().toUpperCase(),
      status,
    });
    setSaving(false);
    if (ok) setShowAddModal(false);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSupplier || !name.trim() || !supplierCode.trim()) return;
    setSaving(true);
    const ok = await onUpdateSupplier({
      ...editingSupplier,
      name: name.trim(),
      supplierCode: supplierCode.trim().toUpperCase(),
      status,
    });
    setSaving(false);
    if (ok) setEditingSupplier(null);
  };

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!paymentSupplier) return;
    const amount = Number(paymentAmount);
    if (amount <= 0) return;
    if (amount > paymentSupplier.totalDebt) {
      alert('Số tiền thanh toán không được lớn hơn tổng công nợ hiện tại của nhà cung cấp này!');
      return;
    }
    setSaving(true);
    const ok = await onUpdateSupplier({
      ...paymentSupplier,
      totalPaid: paymentSupplier.totalPaid + amount,
      totalDebt: paymentSupplier.totalDebt - amount,
    });
    setSaving(false);
    if (ok) {
      alert(
        `Đã thanh toán thành công ${amount.toLocaleString('vi-VN')} đ cho nhà cung cấp: ${paymentSupplier.name}`
      );
      setPaymentSupplier(null);
      setPaymentAmount(500000);
      setPaymentNotes('');
    }
  };

  const supplierFormFields = (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1">
          <label className="text-xs font-semibold text-gray-700">Tên nhà cung cấp / Tên xưởng sỉ</label>
          <input
            type="text"
            required
            placeholder="Ví dụ: Công ty TNHH May mặc ABC"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2.5 bg-gray-50/50 rounded-xl border border-gray-100 focus:border-blue-500 focus:bg-white text-sm outline-none transition-all font-medium"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-semibold text-gray-700">Mã nhà cung cấp (Viết tắt)</label>
          <input
            type="text"
            required
            placeholder="VD: ABC, SUNHOUSE"
            value={supplierCode}
            onChange={(e) => setSupplierCode(e.target.value.toUpperCase())}
            className="w-full px-3 py-2.5 bg-gray-50/50 rounded-xl border border-gray-100 focus:border-blue-500 focus:bg-white text-sm outline-none transition-all font-mono font-bold uppercase"
          />
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-xs font-semibold text-gray-700">Trạng thái quan hệ hợp tác</label>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as 'active' | 'inactive')}
          className="w-full px-3 py-2.5 bg-gray-50/50 rounded-xl border border-gray-100 focus:border-blue-500 focus:bg-white text-sm outline-none cursor-pointer"
        >
          <option value="active">Đang hợp tác tích cực</option>
          <option value="inactive">Tạm ngưng giao dịch</option>
        </select>
      </div>
    </>
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold">
            <Coins className="w-6 h-6" />
          </div>
          <div>
            <span className="text-[11px] text-gray-400 uppercase font-bold tracking-wide">Tổng tiền đặt hàng sỉ</span>
            <h3 className="text-xl font-extrabold text-gray-900 mt-0.5">{totalPurchases.toLocaleString('vi-VN')} đ</h3>
          </div>
        </div>
        <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold">
            <Check className="w-6 h-6" />
          </div>
          <div>
            <span className="text-[11px] text-gray-400 uppercase font-bold tracking-wide">Đã thanh toán sỉ</span>
            <h3 className="text-xl font-extrabold text-emerald-600 mt-0.5">{totalPaid.toLocaleString('vi-VN')} đ</h3>
          </div>
        </div>
        <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-xs flex items-center gap-4 relative overflow-hidden">
          <div
            className={`w-12 h-12 rounded-xl flex items-center justify-center font-bold ${
              totalDebt > 0 ? 'bg-amber-50 text-amber-600 animate-pulse' : 'bg-gray-50 text-gray-400'
            }`}
          >
            <Scale className="w-6 h-6" />
          </div>
          <div>
            <span className="text-[11px] text-gray-400 uppercase font-bold tracking-wide">Tổng công nợ còn lại</span>
            <h3 className={`text-xl font-extrabold mt-0.5 ${totalDebt > 0 ? 'text-amber-600' : 'text-gray-500'}`}>
              {totalDebt.toLocaleString('vi-VN')} đ
            </h3>
          </div>
        </div>
      </div>

      <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex-1 flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-3.5" />
            <input
              type="text"
              placeholder="Tìm theo Tên hoặc Mã nhà cung cấp..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 pr-4 py-2.5 w-full bg-gray-50/50 hover:bg-gray-50 focus:bg-white text-sm rounded-xl border border-gray-100 focus:border-blue-500 outline-none transition-all"
            />
          </div>
          <select
            value={filterDebt}
            onChange={(e) => setFilterDebt(e.target.value as 'all' | 'has_debt' | 'no_debt')}
            className="pl-3 pr-8 py-2.5 bg-gray-50/50 hover:bg-gray-50 text-sm rounded-xl border border-gray-100 outline-none cursor-pointer appearance-none min-w-[170px]"
          >
            <option value="all">Lọc công nợ: Tất cả</option>
            <option value="has_debt">Còn nợ đọng (&gt;0)</option>
            <option value="no_debt">Đã trả hết (0)</option>
          </select>
        </div>
        <button
          onClick={handleOpenAddModal}
          className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2 shadow-sm shrink-0"
        >
          <UserPlus className="w-4.5 h-4.5" /> Thêm Nhà Cung Cấp
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-gray-50/50 border-b border-gray-100 text-xs font-bold text-gray-500 uppercase tracking-wider">
                <th className="p-4">Nhà cung cấp</th>
                <th className="p-4">Mã NCC</th>
                <th className="p-4 text-right">Tổng hàng nhập</th>
                <th className="p-4 text-right">Đã trả</th>
                <th className="p-4 text-right">Công nợ đọng</th>
                <th className="p-4 text-center">Trạng thái</th>
                <th className="p-4 text-center">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 text-sm">
              {filteredSuppliers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-12 text-center text-gray-400">
                    Không tìm thấy nhà cung cấp nào phù hợp.
                  </td>
                </tr>
              ) : (
                filteredSuppliers.map((sup) => {
                  const hasDebt = sup.totalDebt > 0;
                  return (
                    <tr key={sup.id} className="hover:bg-gray-50/50 transition-colors">
                      <td className="p-4 max-w-xs">
                        <span className="font-bold text-gray-900 block leading-tight">{sup.name}</span>
                      </td>
                      <td className="p-4">
                        <span className="font-mono text-xs font-bold text-indigo-700 bg-indigo-50 px-2 py-1 rounded border border-indigo-100">
                          {sup.supplierCode}
                        </span>
                      </td>
                      <td className="p-4 text-right font-mono font-medium text-gray-600">
                        {sup.totalOrderValue.toLocaleString('vi-VN')} đ
                      </td>
                      <td className="p-4 text-right font-mono text-emerald-600 font-semibold">
                        {sup.totalPaid.toLocaleString('vi-VN')} đ
                      </td>
                      <td className="p-4 text-right">
                        <div className={`font-mono font-bold ${hasDebt ? 'text-amber-600' : 'text-gray-400'}`}>
                          {sup.totalDebt.toLocaleString('vi-VN')} đ
                        </div>
                      </td>
                      <td className="p-4 text-center">
                        <span
                          className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                            sup.status === 'active'
                              ? 'bg-emerald-50 text-emerald-600 border border-emerald-100'
                              : 'bg-gray-100 text-gray-400'
                          }`}
                        >
                          {sup.status === 'active' ? 'Đang hợp tác' : 'Tạm dừng'}
                        </span>
                      </td>
                      <td className="p-4">
                        <div className="flex items-center justify-center gap-1.5">
                          {hasDebt && (
                            <button
                              onClick={() => {
                                setPaymentSupplier(sup);
                                setPaymentAmount(sup.totalDebt);
                              }}
                              className="px-3 py-1 bg-amber-50 hover:bg-amber-100 text-amber-700 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all border border-amber-100"
                            >
                              <HandCoins className="w-3.5 h-3.5" /> Trả nợ
                            </button>
                          )}
                          <button
                            onClick={() => handleOpenEditModal(sup)}
                            className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={async () => {
                              if (sup.totalDebt > 0) {
                                alert('Không thể xóa nhà cung cấp này vì vẫn đang còn công nợ chưa tất toán!');
                              } else if (confirm(`Bạn có chắc muốn xóa nhà cung cấp: ${sup.name}?`)) {
                                await onDeleteSupplier(sup.id);
                              }
                            }}
                            className="p-1.5 text-gray-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-all"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showAddModal && (
        <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl max-w-lg w-full overflow-hidden shadow-2xl">
            <div className="p-6 border-b border-gray-100 flex items-start justify-between">
              <div>
                <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                  <UserPlus className="w-5 h-5 text-blue-600" /> Thêm Nhà Cung Cấp Mới
                </h3>
                <p className="text-xs text-gray-400 mt-1">Ghi nhận đối tác phân phối hoặc xưởng sỉ để quản lý nhập hàng & công nợ.</p>
              </div>
              <button onClick={() => setShowAddModal(false)} className="p-1.5 hover:bg-gray-100 rounded-full text-gray-400">
                ✕
              </button>
            </div>
            <form onSubmit={handleCreateSupplier} className="p-6 space-y-4">
              {supplierFormFields}
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowAddModal(false)} className="px-5 py-2 border border-gray-200 rounded-xl text-sm font-semibold text-gray-700">
                  Hủy bỏ
                </button>
                <button type="submit" disabled={saving} className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold disabled:opacity-60">
                  {saving ? 'Đang lưu...' : 'Tạo đối tác'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editingSupplier && (
        <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl max-w-lg w-full overflow-hidden shadow-2xl">
            <div className="p-6 border-b border-gray-100 flex items-start justify-between">
              <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                <Edit3 className="w-5 h-5 text-blue-600" /> Sửa Thông Tin Nhà Cung Cấp
              </h3>
              <button onClick={() => setEditingSupplier(null)} className="p-1.5 hover:bg-gray-100 rounded-full text-gray-400">
                ✕
              </button>
            </div>
            <form onSubmit={handleSaveEdit} className="p-6 space-y-4">
              {supplierFormFields}
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setEditingSupplier(null)} className="px-5 py-2 border border-gray-200 rounded-xl text-sm font-semibold text-gray-700">
                  Hủy bỏ
                </button>
                <button type="submit" disabled={saving} className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold disabled:opacity-60">
                  {saving ? 'Đang lưu...' : 'Lưu thay đổi'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {paymentSupplier && (
        <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl max-w-md w-full overflow-hidden shadow-2xl">
            <div className="p-6 border-b border-gray-100 flex items-start justify-between">
              <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                <HandCoins className="w-5 h-5 text-amber-600" /> Thanh Toán Công Nợ Sỉ
              </h3>
              <button onClick={() => setPaymentSupplier(null)} className="p-1.5 hover:bg-gray-100 rounded-full text-gray-400">
                ✕
              </button>
            </div>
            <form onSubmit={handleRecordPayment} className="p-6 space-y-4">
              <div className="p-4 bg-amber-50/50 border border-amber-100 rounded-2xl text-xs space-y-2">
                <div className="flex justify-between text-gray-600">
                  <span>Nhà cung cấp:</span>
                  <span className="font-bold text-gray-900">{paymentSupplier.name}</span>
                </div>
                <div className="flex justify-between text-gray-600">
                  <span>Tổng công nợ:</span>
                  <span className="font-mono font-bold text-amber-700">
                    {paymentSupplier.totalDebt.toLocaleString('vi-VN')} đ
                  </span>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-semibold text-gray-700">Số tiền thanh toán sỉ (VNĐ)</label>
                <input
                  type="number"
                  required
                  min="1000"
                  max={paymentSupplier.totalDebt}
                  value={paymentAmount}
                  onChange={(e) => setPaymentAmount(Math.max(0, Number(e.target.value)))}
                  className="w-full px-3 py-2.5 bg-gray-50/50 rounded-xl border border-gray-100 text-sm outline-none font-mono font-bold"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-semibold text-gray-700">Ghi chú thanh toán</label>
                <input
                  type="text"
                  value={paymentNotes}
                  onChange={(e) => setPaymentNotes(e.target.value)}
                  className="w-full px-3 py-2.5 bg-gray-50/50 rounded-xl border border-gray-100 text-sm outline-none"
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setPaymentSupplier(null)} className="px-5 py-2 border border-gray-200 rounded-xl text-sm font-semibold text-gray-700">
                  Hủy bỏ
                </button>
                <button type="submit" disabled={saving} className="px-5 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-sm font-semibold disabled:opacity-60">
                  {saving ? 'Đang lưu...' : 'Xác nhận chi trả'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
