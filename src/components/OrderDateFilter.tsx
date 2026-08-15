import React from 'react';
import { Calendar } from 'lucide-react';
import {
  ORDER_DATE_PRESET_OPTIONS,
  type OrderDatePreset,
} from '../utils/orderDateFilter';

type OrderDateFilterProps = {
  preset: OrderDatePreset;
  customStart: string;
  customEnd: string;
  onPresetChange: (preset: OrderDatePreset) => void;
  onCustomStartChange: (value: string) => void;
  onCustomEndChange: (value: string) => void;
};

export default function OrderDateFilter({
  preset,
  customStart,
  customEnd,
  onPresetChange,
  onCustomStartChange,
  onCustomEndChange,
}: OrderDateFilterProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 shrink-0">
      <span className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-600">
        <Calendar className="w-3.5 h-3.5 text-slate-400" />
        Thời gian
      </span>
      <select
        value={preset}
        onChange={(e) => onPresetChange(e.target.value as OrderDatePreset)}
        className="text-xs font-semibold text-slate-700 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 outline-none focus:border-blue-500 focus:bg-white cursor-pointer"
        aria-label="Lọc theo thời gian"
      >
        {ORDER_DATE_PRESET_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {preset === 'custom' && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-500">
            Từ ngày
            <input
              type="date"
              value={customStart}
              max={customEnd || undefined}
              onChange={(e) => onCustomStartChange(e.target.value)}
              className="text-xs font-medium text-slate-700 bg-gray-50 border border-gray-200 rounded-xl px-2.5 py-2 outline-none focus:border-blue-500 focus:bg-white"
            />
          </label>
          <label className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-500">
            Đến ngày
            <input
              type="date"
              value={customEnd}
              min={customStart || undefined}
              onChange={(e) => onCustomEndChange(e.target.value)}
              className="text-xs font-medium text-slate-700 bg-gray-50 border border-gray-200 rounded-xl px-2.5 py-2 outline-none focus:border-blue-500 focus:bg-white"
            />
          </label>
        </div>
      )}
    </div>
  );
}
