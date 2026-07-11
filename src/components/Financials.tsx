import React, { useMemo, useState } from 'react';
import { Expense, Product, Order } from '../types';
import {
  Plus,
  Trash2,
  Coins,
  Calendar,
  PieChart,
  Calculator,
  BarChart3,
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
}

export default function Financials({ expenses, onAddExpense, onDeleteExpense }: FinancialsProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState(100000);
  const [category, setCategory] = useState<ExpenseCategory>('advertising');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('this_month');

  const [calcImportPrice, setCalcImportPrice] = useState(150000);
  const [calcSellingPrice, setCalcSellingPrice] = useState(300000);
  const [calcPlatformFeePercent, setCalcPlatformFeePercent] = useState(12);
  const [calcQuantity, setCalcQuantity] = useState(100);
  const [calcAdSpend, setCalcAdSpend] = useState(1500000);

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

  const feeRate = calcPlatformFeePercent / 100;
  const calcTotalRevenue = calcSellingPrice * calcQuantity;
  const calcTotalCOGS = calcImportPrice * calcQuantity;
  const calcTotalFees = calcTotalRevenue * feeRate;
  const calcNetRevenue = calcTotalRevenue - calcTotalFees;
  const calcNetProfit = calcNetRevenue - calcTotalCOGS - calcAdSpend;
  const calcMargin = calcTotalRevenue > 0 ? (calcNetProfit / calcTotalRevenue) * 100 : 0;
  const calcROI =
    calcTotalCOGS + calcAdSpend > 0 ? (calcNetProfit / (calcTotalCOGS + calcAdSpend)) * 100 : 0;

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

      <div className="bg-linear-to-r from-slate-900 to-indigo-950 text-white rounded-3xl p-6 shadow-xl space-y-6">
        <div>
          <h3 className="font-bold text-lg flex items-center gap-2 text-indigo-200">
            <Calculator className="w-5 h-5 text-indigo-400" /> Công Cụ Mô Phỏng Lợi Nhuận & Định Giá Bán
          </h3>
          <p className="text-xs text-indigo-200/80 mt-1">
            Nhập giá vốn, phí sàn TMĐT tùy chỉnh và ngân sách Ads để hoạch định giá bán tối ưu.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-5 grid grid-cols-2 gap-4">
            <div className="space-y-1 text-xs col-span-2">
              <label className="text-indigo-200 font-medium">Phí sàn TMĐT (%)</label>
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={calcPlatformFeePercent}
                onChange={(e) => setCalcPlatformFeePercent(Math.max(0, Math.min(100, Number(e.target.value))))}
                placeholder="VD: 10.5, 12.0"
                className="w-full bg-white/10 text-white font-mono font-bold text-sm px-3 py-2 rounded-xl border border-white/10 outline-none"
              />
              <p className="text-[10px] text-indigo-300/80 pt-0.5">Nhập % phí sàn thực tế (Shopee, TikTok, Lazada...)</p>
            </div>

            <div className="space-y-1 text-xs">
              <label className="text-indigo-200 font-medium">Giá vốn nhập sỉ (đ)</label>
              <input
                type="number"
                value={calcImportPrice}
                onChange={(e) => setCalcImportPrice(Math.max(0, Number(e.target.value)))}
                className="w-full bg-white/10 text-white font-mono font-bold text-sm px-3 py-2 rounded-xl border border-white/10 outline-none"
              />
            </div>

            <div className="space-y-1 text-xs">
              <label className="text-indigo-200 font-medium">Giá niêm yết bán (đ)</label>
              <input
                type="number"
                value={calcSellingPrice}
                onChange={(e) => setCalcSellingPrice(Math.max(0, Number(e.target.value)))}
                className="w-full bg-white/10 text-white font-mono font-bold text-sm px-3 py-2 rounded-xl border border-white/10 outline-none"
              />
            </div>

            <div className="space-y-1 text-xs">
              <label className="text-indigo-200 font-medium">Số lượng nhập bán (đợt)</label>
              <input
                type="number"
                value={calcQuantity}
                onChange={(e) => setCalcQuantity(Math.max(1, Number(e.target.value)))}
                className="w-full bg-white/10 text-white font-mono font-bold text-sm px-3 py-2 rounded-xl border border-white/10 outline-none"
              />
            </div>

            <div className="space-y-1 text-xs">
              <label className="text-indigo-200 font-medium">Tổng ngân sách Ads (đ)</label>
              <input
                type="number"
                value={calcAdSpend}
                onChange={(e) => setCalcAdSpend(Math.max(0, Number(e.target.value)))}
                className="w-full bg-white/10 text-white font-mono font-bold text-sm px-3 py-2 rounded-xl border border-white/10 outline-none"
              />
            </div>
          </div>

          <div className="lg:col-span-7 bg-white/5 border border-white/10 rounded-2xl p-5 grid grid-cols-2 md:grid-cols-4 gap-4 items-center">
            <div className="space-y-1">
              <span className="text-[10px] text-indigo-300 block uppercase font-bold">Tổng doanh số</span>
              <span className="text-base font-extrabold font-mono block text-white">
                {calcTotalRevenue.toLocaleString('vi-VN')} đ
              </span>
            </div>

            <div className="space-y-1">
              <span className="text-[10px] text-indigo-300 block uppercase font-bold">Thu từ sàn (Net)</span>
              <span className="text-base font-extrabold font-mono block text-emerald-400">
                {calcNetRevenue.toLocaleString('vi-VN')} đ
              </span>
              <span className="text-[9px] text-indigo-200 block">
                Đã trừ {calcPlatformFeePercent.toFixed(1)}% phí sàn
              </span>
            </div>

            <div className="space-y-1">
              <span className="text-[10px] text-indigo-300 block uppercase font-bold">Lợi nhuận thực</span>
              <span
                className={`text-base font-extrabold font-mono block ${calcNetProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}
              >
                {calcNetProfit.toLocaleString('vi-VN')} đ
              </span>
            </div>

            <div className="space-y-1">
              <span className="text-[10px] text-indigo-300 block uppercase font-bold">Tỷ suất LN Ròng</span>
              <span
                className={`text-base font-extrabold font-mono block ${calcMargin >= 30 ? 'text-emerald-400' : calcMargin >= 15 ? 'text-blue-300' : 'text-amber-400'}`}
              >
                {calcMargin.toFixed(1)}%
              </span>
            </div>

            <div className="col-span-2 md:col-span-4 p-3 bg-white/5 border border-white/5 rounded-xl flex items-center justify-between text-xs">
              <span className="text-indigo-200">Hiệu số ROI (Chỉ số sinh lời trên vốn):</span>
              <span className={`font-mono font-bold text-sm ${calcROI >= 100 ? 'text-emerald-400' : 'text-indigo-300'}`}>
                {calcROI.toFixed(0)}% ROI
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
