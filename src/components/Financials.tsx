import React, { useMemo, useState } from 'react';
import { ChannelSettings, Expense, Product, Order, SystemFee } from '../types';
import {
  Plus,
  Trash2,
  Coins,
  Calendar,
  PieChart,
  BarChart3,
  Edit,
  Save,
  X,
} from 'lucide-react';

type ExpenseCategory = Expense['category'];
type TimeFilter = 'this_month' | 'last_month' | 'this_quarter' | 'this_year';

const TIME_FILTER_LABELS: Record<TimeFilter, string> = {
  this_month: 'Tháng này',
  last_month: 'Tháng trước',
  this_quarter: 'Quý này',
  this_year: 'Năm nay',
};

const ALL_CATEGORIES: ExpenseCategory[] = [
  'advertising',
  'packaging',
  'fees',
  'shipping',
  'warehouse',
  'labor',
  'other',
];

function parseExpenseDate(dateStr: string): Date {
  const [yy, mm, dd] = dateStr.split('-').map(Number);
  return new Date(yy, (mm || 1) - 1, dd || 1);
}

function getFilterRange(filter: TimeFilter): { start: Date; end: Date } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  switch (filter) {
    case 'this_month':
      return { start: new Date(y, m, 1), end: new Date(y, m + 1, 0, 23, 59, 59, 999) };
    case 'last_month':
      return { start: new Date(y, m - 1, 1), end: new Date(y, m, 0, 23, 59, 59, 999) };
    case 'this_quarter': {
      const qStart = Math.floor(m / 3) * 3;
      return { start: new Date(y, qStart, 1), end: new Date(y, qStart + 3, 0, 23, 59, 59, 999) };
    }
    case 'this_year':
      return { start: new Date(y, 0, 1), end: new Date(y, 11, 31, 23, 59, 59, 999) };
  }
}

function filterByRange(expenses: Expense[], start: Date, end: Date): Expense[] {
  return expenses.filter((e) => {
    const d = parseExpenseDate(e.date);
    return d >= start && d <= end;
  });
}

function groupExpensesByTime(expenses: Expense[], filter: TimeFilter) {
  const buckets = new Map<string, { label: string; amount: number; sortKey: string }>();

  for (const exp of expenses) {
    const d = parseExpenseDate(exp.date);
    let label: string;
    let sortKey: string;

    if (filter === 'this_month' || filter === 'last_month') {
      label = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
      sortKey = exp.date;
    } else {
      label = `T${d.getMonth() + 1}/${d.getFullYear()}`;
      sortKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }

    const prev = buckets.get(sortKey);
    buckets.set(sortKey, {
      label,
      amount: (prev?.amount || 0) + exp.amount,
      sortKey,
    });
  }

  return Array.from(buckets.values()).sort((a, b) => a.sortKey.localeCompare(b.sortKey));
}

interface FinancialsProps {
  expenses: Expense[];
  products: Product[];
  orders: Order[];
  onAddExpense: (expense: Expense) => void;
  onDeleteExpense: (id: string) => void;
  settings: ChannelSettings;
  onUpdateSettings: (settings: ChannelSettings) => void | Promise<boolean>;
}

export default function Financials({ expenses, onAddExpense, onDeleteExpense, settings, onUpdateSettings }: FinancialsProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState(100000);
  const [category, setCategory] = useState<ExpenseCategory>('advertising');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('this_month');

  const [showSystemFeeForm, setShowSystemFeeForm] = useState(false);
  const [editingSystemFeeId, setEditingSystemFeeId] = useState<string | null>(null);
  const [systemFeeName, setSystemFeeName] = useState('');
  const [systemFeeType, setSystemFeeType] = useState<SystemFee['calculationType']>('percentage');
  const [systemFeeValue, setSystemFeeValue] = useState('');

  const handleCreateExpense = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title) return;

    onAddExpense({
      id: `exp-${Date.now()}`,
      title,
      amount: Number(amount),
      category,
      date,
      notes,
    });

    setTitle('');
    setAmount(100000);
    setCategory('advertising');
    setNotes('');
    setShowAddForm(false);
  };

  const { start, end } = useMemo(() => getFilterRange(timeFilter), [timeFilter]);

  const filteredExpenses = useMemo(
    () => filterByRange(expenses, start, end),
    [expenses, start, end]
  );

  const timeSeries = useMemo(
    () => groupExpensesByTime(filteredExpenses, timeFilter),
    [filteredExpenses, timeFilter]
  );

  const maxTimeBucket = useMemo(
    () => Math.max(...timeSeries.map((b) => b.amount), 1),
    [timeSeries]
  );

  const totalExpenses = filteredExpenses.reduce((sum, e) => sum + e.amount, 0);
  const allTimeTotal = expenses.reduce((sum, e) => sum + e.amount, 0);

  const getCategoryColor = (cat: string) => {
    switch (cat) {
      case 'advertising':
        return 'bg-blue-50 text-blue-600 border-blue-100';
      case 'packaging':
        return 'bg-emerald-50 text-emerald-600 border-emerald-100';
      case 'fees':
        return 'bg-purple-50 text-purple-600 border-purple-100';
      case 'shipping':
        return 'bg-amber-50 text-amber-600 border-amber-100';
      case 'warehouse':
        return 'bg-rose-50 text-rose-600 border-rose-100';
      case 'labor':
        return 'bg-orange-50 text-orange-600 border-orange-100';
      default:
        return 'bg-gray-50 text-gray-600 border-gray-100';
    }
  };

  const getCategoryLabel = (cat: string) => {
    switch (cat) {
      case 'advertising':
        return 'Quảng cáo (Ads)';
      case 'packaging':
        return 'Đóng gói (Bao bì)';
      case 'fees':
        return 'Phí sàn & Giao dịch';
      case 'shipping':
        return 'Vận chuyển';
      case 'warehouse':
        return 'Mặt bằng / Kho bãi';
      case 'labor':
        return 'Thuê nhân công';
      default:
        return 'Chi phí khác';
    }
  };

  const getCategoryBarColor = (cat: string) => {
    switch (cat) {
      case 'advertising':
        return 'bg-blue-500';
      case 'packaging':
        return 'bg-emerald-500';
      case 'fees':
        return 'bg-purple-500';
      case 'shipping':
        return 'bg-amber-500';
      case 'warehouse':
        return 'bg-rose-500';
      case 'labor':
        return 'bg-orange-500';
      default:
        return 'bg-gray-400';
    }
  };

  const systemFees = settings.systemFees ?? [];

  const resetSystemFeeForm = () => {
    setShowSystemFeeForm(false);
    setEditingSystemFeeId(null);
    setSystemFeeName('');
    setSystemFeeType('percentage');
    setSystemFeeValue('');
  };

  const saveSystemFees = async (nextFees: SystemFee[]) => {
    const ok = await onUpdateSettings({ ...settings, systemFees: nextFees });
    if (ok === false) alert('Lưu cấu hình phí thất bại.');
  };

  const handleSaveSystemFee = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = Math.max(0, Number(systemFeeValue) || 0);
    const name = systemFeeName.trim();
    if (!name || value <= 0) return;
    const entry: SystemFee = {
      id: editingSystemFeeId || `system-fee-${Date.now()}`,
      name,
      calculationType: systemFeeType,
      value,
      active: true,
    };
    const nextFees = editingSystemFeeId
      ? systemFees.map((fee) => (fee.id === editingSystemFeeId ? { ...fee, ...entry } : fee))
      : [...systemFees, entry];
    await saveSystemFees(nextFees);
    resetSystemFeeForm();
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-xs md:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-gray-900 text-base flex items-center gap-2">
              <Coins className="text-blue-500 w-5 h-5" /> Sổ Quản Lý Chi Phí Bán Hàng
            </h3>
            <button
              onClick={() => setShowAddForm(!showAddForm)}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" /> Ghi nhận chi phí mới
            </button>
          </div>

          {showAddForm && (
            <form onSubmit={handleCreateExpense} className="p-4 bg-gray-50 rounded-2xl border border-gray-100 space-y-4 animate-in fade-in">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-gray-700">Tên chi phí / Nội dung thanh toán</label>
                  <input
                    type="text"
                    required
                    placeholder="Ví dụ: Mua băng keo đóng hàng"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="w-full px-3 py-2 bg-white rounded-xl border border-gray-200 focus:border-blue-500 text-xs outline-none font-medium"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-gray-700">Số tiền (VNĐ)</label>
                  <input
                    type="number"
                    required
                    min="1"
                    value={amount}
                    onChange={(e) => setAmount(Math.max(1, Number(e.target.value)))}
                    className="w-full px-3 py-2 bg-white rounded-xl border border-gray-200 focus:border-blue-500 text-xs outline-none font-bold font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-gray-700">Nhóm chi phí</label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
                    className="w-full px-3 py-2 bg-white rounded-xl border border-gray-200 focus:border-blue-500 text-xs outline-none cursor-pointer"
                  >
                    <option value="advertising">Quảng cáo (Ads)</option>
                    <option value="packaging">Đóng gói (Bao bì)</option>
                    <option value="fees">Phí sàn & Giao dịch</option>
                    <option value="shipping">Vận chuyển</option>
                    <option value="warehouse">Mặt bằng / Kho bãi</option>
                    <option value="labor">Thuê nhân công</option>
                    <option value="other">Khác</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-gray-700">Ngày phát sinh</label>
                  <input
                    type="date"
                    required
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="w-full px-3 py-2 bg-white rounded-xl border border-gray-200 focus:border-blue-500 text-xs outline-none font-medium"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-gray-700">Ghi chú thêm</label>
                  <input
                    type="text"
                    placeholder="Không bắt buộc"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="w-full px-3 py-2 bg-white rounded-xl border border-gray-200 focus:border-blue-500 text-xs outline-none text-gray-600"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddForm(false)}
                  className="px-4 py-1.5 bg-white border border-gray-200 text-gray-700 font-medium text-xs rounded-xl"
                >
                  Hủy bỏ
                </button>
                <button type="submit" className="px-4 py-1.5 bg-blue-600 text-white font-semibold text-xs rounded-xl">
                  Lưu chi phí
                </button>
              </div>
            </form>
          )}

          <div className="overflow-hidden border border-gray-50 rounded-2xl">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100 text-xs font-bold text-gray-500 uppercase">
                  <th className="p-3.5">Nội dung</th>
                  <th className="p-3.5">Phân loại</th>
                  <th className="p-3.5">Ngày phát sinh</th>
                  <th className="p-3.5 text-right">Số tiền</th>
                  <th className="p-3.5 text-center">Xóa</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 text-xs">
                {expenses.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-gray-400">
                      Chưa ghi nhận bất kỳ chi phí phát sinh ngoài nào.
                    </td>
                  </tr>
                ) : (
                  expenses.map((exp) => (
                    <tr key={exp.id} className="hover:bg-gray-50/50">
                      <td className="p-3.5">
                        <div className="font-semibold text-gray-800">{exp.title}</div>
                        {exp.notes && <div className="text-[10px] text-gray-400 mt-0.5">{exp.notes}</div>}
                      </td>
                      <td className="p-3.5">
                        <span
                          className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${getCategoryColor(exp.category)}`}
                        >
                          {getCategoryLabel(exp.category)}
                        </span>
                      </td>
                      <td className="p-3.5 text-gray-500 font-mono">{exp.date}</td>
                      <td className="p-3.5 text-right font-bold font-mono text-gray-900">
                        {exp.amount.toLocaleString('vi-VN')} đ
                      </td>
                      <td className="p-3.5 text-center">
                        <button
                          onClick={() => onDeleteExpense(exp.id)}
                          className="p-1 text-gray-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-xs space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-bold text-gray-900 text-base flex items-center gap-1.5">
                <PieChart className="text-indigo-500 w-5 h-5" /> Cơ Cấu Quỹ Chi Phí
              </h3>
              <p className="text-[11px] text-gray-400 mt-0.5">Biểu đồ phân bổ theo thời gian đã chọn</p>
            </div>
            <div className="space-y-1 shrink-0">
              <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wide flex items-center gap-1">
                <Calendar className="w-3 h-3" /> Thời gian
              </label>
              <select
                value={timeFilter}
                onChange={(e) => setTimeFilter(e.target.value as TimeFilter)}
                className="px-2.5 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-xs font-semibold text-gray-700 outline-none cursor-pointer"
              >
                {(Object.keys(TIME_FILTER_LABELS) as TimeFilter[]).map((key) => (
                  <option key={key} value={key}>
                    {TIME_FILTER_LABELS[key]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="text-center p-4 bg-gray-50 rounded-2xl border border-gray-100/50">
            <span className="text-xs text-gray-500 block uppercase font-medium tracking-wide">
              Tổng chi trong {TIME_FILTER_LABELS[timeFilter].toLowerCase()}
            </span>
            <span className="text-2xl font-extrabold text-slate-900 mt-1 block">
              {totalExpenses.toLocaleString('vi-VN')} đ
            </span>
            <span className="text-[10px] text-gray-400 mt-1 block">
              Toàn hệ thống: {allTimeTotal.toLocaleString('vi-VN')} đ
            </span>
          </div>

          <div className="space-y-3">
            <h4 className="text-[11px] font-bold text-gray-500 uppercase tracking-wide flex items-center gap-1.5">
              <BarChart3 className="w-3.5 h-3.5" /> Chi phí theo mốc thời gian
            </h4>
            {timeSeries.length === 0 ? (
              <p className="text-xs text-gray-400 italic py-4 text-center">Không có chi phí trong khoảng thời gian này.</p>
            ) : (
              <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
                {timeSeries.map((bucket) => {
                  const pct = (bucket.amount / maxTimeBucket) * 100;
                  return (
                    <div key={bucket.sortKey} className="space-y-1">
                      <div className="flex justify-between items-center text-[11px] text-gray-600">
                        <span className="font-medium font-mono">{bucket.label}</span>
                        <span className="font-mono font-bold">{bucket.amount.toLocaleString('vi-VN')} đ</span>
                      </div>
                      <div className="w-full bg-gray-100 h-1.5 rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-indigo-500" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-3 pt-1 border-t border-gray-100">
            <h4 className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">Theo nhóm chi phí</h4>
            {ALL_CATEGORIES.map((cat) => {
              const catAmount = filteredExpenses.filter((e) => e.category === cat).reduce((sum, e) => sum + e.amount, 0);
              const percent = totalExpenses > 0 ? (catAmount / totalExpenses) * 100 : 0;
              if (catAmount === 0) return null;

              return (
                <div key={cat} className="space-y-1">
                  <div className="flex justify-between items-center text-xs text-gray-600">
                    <span className="font-medium">{getCategoryLabel(cat)}</span>
                    <span className="font-mono font-bold">
                      {catAmount.toLocaleString('vi-VN')} đ ({percent.toFixed(0)}%)
                    </span>
                  </div>
                  <div className="w-full bg-gray-100 h-1.5 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${getCategoryBarColor(cat)}`} style={{ width: `${percent}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-3xl border border-violet-100 shadow-xs p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-bold text-lg text-gray-900 flex items-center gap-2">
              <Coins className="w-5 h-5 text-violet-600" /> Cấu hình Chi phí Hệ thống
            </h3>
            <p className="text-xs text-gray-500 mt-1">
              Các phí đang bật được tự động dùng để ước tính doanh thu cho đơn chưa có escrow Shopee.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              resetSystemFeeForm();
              setShowSystemFeeForm(true);
            }}
            className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-xs font-bold flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" /> Thêm mới phí
          </button>
        </div>

        {showSystemFeeForm && (
          <form onSubmit={handleSaveSystemFee} className="grid grid-cols-1 md:grid-cols-4 gap-3 p-4 bg-violet-50/50 border border-violet-100 rounded-2xl">
            <input
              required
              value={systemFeeName}
              onChange={(e) => setSystemFeeName(e.target.value)}
              placeholder="Tên khoản phí"
              className="px-3 py-2 border border-violet-200 bg-white rounded-xl text-sm outline-none focus:border-violet-500"
            />
            <select
              value={systemFeeType}
              onChange={(e) => setSystemFeeType(e.target.value as SystemFee['calculationType'])}
              className="px-3 py-2 border border-violet-200 bg-white rounded-xl text-sm outline-none"
            >
              <option value="percentage">% theo giá trị đơn</option>
              <option value="fixed">VNĐ cố định</option>
            </select>
            <input
              required
              min="0"
              step={systemFeeType === 'percentage' ? '0.1' : '100'}
              type="number"
              value={systemFeeValue}
              onChange={(e) => setSystemFeeValue(e.target.value)}
              placeholder={systemFeeType === 'percentage' ? 'Ví dụ: 12' : 'Ví dụ: 5000'}
              className="px-3 py-2 border border-violet-200 bg-white rounded-xl text-sm outline-none focus:border-violet-500"
            />
            <div className="flex gap-2">
              <button type="submit" className="flex-1 px-3 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-1">
                <Save className="w-3.5 h-3.5" /> Lưu
              </button>
              <button type="button" onClick={resetSystemFeeForm} className="px-3 py-2 border border-gray-200 bg-white text-gray-600 rounded-xl text-xs font-bold">
                Hủy
              </button>
            </div>
          </form>
        )}

        {systemFees.length === 0 ? (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-100 rounded-xl px-4 py-3">
            Chưa cấu hình phí. Hệ thống sẽ dùng tỷ lệ phí Shopee mặc định cho đến khi bạn thêm phí.
          </p>
        ) : (
          <div className="divide-y divide-gray-100 border border-gray-100 rounded-2xl overflow-hidden">
            {systemFees.map((fee) => (
              <div key={fee.id} className="p-3 flex flex-wrap items-center gap-3 bg-white">
                <div className="flex-1 min-w-40">
                  <p className="text-sm font-bold text-gray-800">{fee.name}</p>
                  <p className="text-[11px] text-gray-500">
                    {fee.calculationType === 'percentage' ? `${fee.value}% theo giá trị đơn` : `${fee.value.toLocaleString('vi-VN')}đ cố định`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void saveSystemFees(systemFees.map((item) => item.id === fee.id ? { ...item, active: !item.active } : item))}
                  className={`px-2.5 py-1 text-[11px] font-bold rounded-lg border ${fee.active ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-gray-50 border-gray-200 text-gray-500'}`}
                >
                  {fee.active ? 'Đang bật' : 'Đã tắt'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingSystemFeeId(fee.id);
                    setSystemFeeName(fee.name);
                    setSystemFeeType(fee.calculationType);
                    setSystemFeeValue(String(fee.value));
                    setShowSystemFeeForm(true);
                  }}
                  className="p-2 text-gray-400 hover:text-violet-600 hover:bg-violet-50 rounded-lg"
                  title="Sửa phí"
                >
                  <Edit className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => void saveSystemFees(systemFees.filter((item) => item.id !== fee.id))}
                  className="p-2 text-gray-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg"
                  title="Xóa phí"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
