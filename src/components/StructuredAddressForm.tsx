import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { StructuredAddressValue, VnAdminUnit } from '../utils/vietnamAddress';

function friendlyGeminiError(res: Response, data: unknown): string {
  const err = data as { error?: string; message?: string };
  const raw = String(err?.error || err?.message || '').trim();

  if (res.status === 503) {
    return 'Chưa cấu hình Gemini API Key. Vào Cài đặt → Cấu hình AI để thêm key.';
  }
  if (res.status === 401 || res.status === 403) {
    return 'Gemini API Key không hợp lệ hoặc đã hết hạn. Kiểm tra lại trong Cài đặt.';
  }
  if (raw) {
    const lower = raw.toLowerCase();
    if (
      lower.includes('api key') ||
      lower.includes('api_key') ||
      lower.includes('invalid api') ||
      (lower.includes('invalid') && lower.includes('key'))
    ) {
      return 'Gemini API Key không hợp lệ. Vào Cài đặt → Cấu hình AI để cập nhật key.';
    }
    if (raw.startsWith('{') || raw.includes('"error"') || raw.includes('GoogleGenerativeAI')) {
      return 'AI tạm thời không phản hồi. Vui lòng nhập địa chỉ thủ công hoặc thử lại sau.';
    }
    return raw;
  }
  return 'Không thể phân tích địa chỉ bằng AI. Vui lòng nhập thủ công.';
}

interface StructuredAddressFormProps {
  value: StructuredAddressValue;
  onChange: (v: StructuredAddressValue) => void;
  authHeaders: () => Record<string, string>;
}

export default function StructuredAddressForm({
  value,
  onChange,
  authHeaders,
}: StructuredAddressFormProps) {
  const [provinces, setProvinces] = useState<VnAdminUnit[]>([]);
  const [districts, setDistricts] = useState<VnAdminUnit[]>([]);
  const [wards, setWards] = useState<VnAdminUnit[]>([]);
  const [loadingProvinces, setLoadingProvinces] = useState(false);
  const [loadingDistricts, setLoadingDistricts] = useState(false);
  const [loadingWards, setLoadingWards] = useState(false);
  const [quickPaste, setQuickPaste] = useState('');
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');

  const fetchProvinces = useCallback(async () => {
    setLoadingProvinces(true);
    try {
      const res = await fetch('/api/vietnam-address/provinces', { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setProvinces(Array.isArray(data) ? data : []);
      }
    } finally {
      setLoadingProvinces(false);
    }
  }, [authHeaders]);

  const fetchDistricts = useCallback(
    async (provinceCode: string) => {
      if (!provinceCode) {
        setDistricts([]);
        return [];
      }
      setLoadingDistricts(true);
      try {
        const res = await fetch(`/api/vietnam-address/districts/${provinceCode}`, {
          headers: authHeaders(),
        });
        if (res.ok) {
          const data = await res.json();
          const list = Array.isArray(data) ? data : [];
          setDistricts(list);
          return list;
        }
      } finally {
        setLoadingDistricts(false);
      }
      setDistricts([]);
      return [];
    },
    [authHeaders]
  );

  const fetchWards = useCallback(
    async (districtCode: string) => {
      if (!districtCode) {
        setWards([]);
        return [];
      }
      setLoadingWards(true);
      try {
        const res = await fetch(`/api/vietnam-address/wards/${districtCode}`, {
          headers: authHeaders(),
        });
        if (res.ok) {
          const data = await res.json();
          const list = Array.isArray(data) ? data : [];
          setWards(list);
          return list;
        }
      } finally {
        setLoadingWards(false);
      }
      setWards([]);
      return [];
    },
    [authHeaders]
  );

  useEffect(() => {
    fetchProvinces();
  }, [fetchProvinces]);

  useEffect(() => {
    if (value.provinceCode) fetchDistricts(value.provinceCode);
    else setDistricts([]);
  }, [value.provinceCode, fetchDistricts]);

  useEffect(() => {
    if (value.districtCode) fetchWards(value.districtCode);
    else setWards([]);
  }, [value.districtCode, fetchWards]);

  const handleParseAddress = async (text: string) => {
    const raw = text.trim();
    if (raw.length < 8) return;

    setParsing(true);
    setParseError('');
    try {
      const res = await fetch('/api/orders/parse-address', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw_address: raw }),
      });
      const data = await res.json().catch(() => ({}));
      const original = String(data.raw_address || data.parsed?.detail || raw);

      if (!res.ok) {
        setParseError(friendlyGeminiError(res, data));
        onChange({ ...value, street: original });
        return;
      }

      if (data.fallback || !data.success) {
        onChange({ ...value, street: original });
        setParseError(data.message || 'Không khớp địa chỉ. Vui lòng chọn thủ công.');
        return;
      }

      const matched = data.matched || {};
      const parsed = data.parsed || {};
      if (!matched.province) {
        onChange({ ...value, street: parsed.detail || original });
        setParseError('Không khớp Tỉnh/Thành. Vui lòng chọn thủ công.');
        return;
      }

      onChange({
        provinceCode: String(matched.province.id),
        provinceName: matched.province.name,
        districtCode: matched.district ? String(matched.district.id) : '',
        districtName: matched.district?.name || '',
        wardCode: matched.ward ? String(matched.ward.id) : '',
        wardName: matched.ward?.name || '',
        street: parsed.detail || '',
      });

      if (!matched.district) {
        setParseError('Không khớp Quận/Huyện. Vui lòng chọn thủ công.');
      } else if (!matched.ward) {
        setParseError('Không khớp Phường/Xã. Vui lòng chọn thủ công.');
      }
    } catch {
      setParseError('Không thể kết nối AI phân tích địa chỉ');
      onChange({ ...value, street: raw });
    } finally {
      setParsing(false);
    }
  };

  const handleQuickPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text');
    if (pasted.trim()) {
      setTimeout(() => handleParseAddress(pasted), 50);
    }
  };

  const selectClass =
    'w-full mt-1 px-3 py-2 bg-white rounded-xl border border-gray-200 focus:border-emerald-500 focus:outline-none text-xs font-medium text-gray-800 disabled:opacity-60';

  return (
    <div className="space-y-3">
      <div className="relative">
        <label className="text-[11px] font-bold text-emerald-700 flex items-center gap-1">
          <Sparkles className="w-3.5 h-3.5" /> Dán nhanh địa chỉ (AI tự tách)
        </label>
        <input
          type="text"
          value={quickPaste}
          onChange={(e) => setQuickPaste(e.target.value)}
          onPaste={handleQuickPaste}
          onBlur={() => quickPaste.trim() && handleParseAddress(quickPaste)}
          placeholder='VD: "123 Lê Lợi, Q.1, TP. Hồ Chí Minh"'
          className="w-full mt-1 px-3 py-2.5 bg-gradient-to-r from-emerald-50 to-teal-50 rounded-xl border-2 border-emerald-200 focus:border-emerald-500 focus:outline-none text-xs font-medium text-gray-800 placeholder:text-emerald-600/50"
        />
        {parsing && (
          <span className="absolute right-3 top-9 flex items-center gap-1 text-[10px] text-emerald-600">
            <Loader2 className="w-3 h-3 animate-spin" /> Đang tách...
          </span>
        )}
        {parseError && <p className="text-[10px] text-amber-600 mt-1">{parseError}</p>}
      </div>

      <div>
        <label className="text-[11px] font-semibold text-gray-500">Tỉnh / Thành phố *</label>
        <select
          required
          value={value.provinceCode}
          disabled={loadingProvinces}
          onChange={(e) => {
            const code = e.target.value;
            const p = provinces.find((x) => String(x.code) === code);
            onChange({
              ...value,
              provinceCode: code,
              provinceName: p?.name || '',
              districtCode: '',
              districtName: '',
              wardCode: '',
              wardName: '',
            });
          }}
          className={selectClass}
        >
          <option value="">-- Chọn Tỉnh/Thành phố --</option>
          {provinces.map((p) => (
            <option key={p.code} value={String(p.code)}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-[11px] font-semibold text-gray-500">Quận / Huyện *</label>
        <select
          required
          value={value.districtCode}
          disabled={!value.provinceCode || loadingDistricts}
          onChange={(e) => {
            const code = e.target.value;
            const d = districts.find((x) => String(x.code) === code);
            onChange({
              ...value,
              districtCode: code,
              districtName: d?.name || '',
              wardCode: '',
              wardName: '',
            });
          }}
          className={selectClass}
        >
          <option value="">-- Chọn Quận/Huyện --</option>
          {districts.map((d) => (
            <option key={d.code} value={String(d.code)}>
              {d.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-[11px] font-semibold text-gray-500">Phường / Xã *</label>
        <select
          required
          value={value.wardCode}
          disabled={!value.districtCode || loadingWards}
          onChange={(e) => {
            const code = e.target.value;
            const w = wards.find((x) => String(x.code) === code);
            onChange({
              ...value,
              wardCode: code,
              wardName: w?.name || '',
            });
          }}
          className={selectClass}
        >
          <option value="">-- Chọn Phường/Xã --</option>
          {wards.map((w) => (
            <option key={w.code} value={String(w.code)}>
              {w.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-[11px] font-semibold text-gray-500">
          Địa chỉ chi tiết (Số nhà, tên đường...) *
        </label>
        <input
          type="text"
          required
          value={value.street}
          onChange={(e) => onChange({ ...value, street: e.target.value })}
          placeholder="Số nhà, tên đường, ngõ ngách..."
          className="w-full mt-1 px-3 py-2 bg-white rounded-xl border border-gray-200 focus:border-emerald-500 focus:outline-none text-xs font-medium text-gray-800"
        />
      </div>
    </div>
  );
}
