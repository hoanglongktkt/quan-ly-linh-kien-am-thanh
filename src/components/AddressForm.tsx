import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BookUser, Loader2, MapPin } from 'lucide-react';
import {
  AddressMode,
  StructuredAddressValue,
  VnAdminUnit,
  formatFullAddress,
  normalizePhone,
} from '../utils/vietnamAddress';
import { AddressBookEntry, loadAddressBook } from '../utils/addressBook';

const PARSE_TIMEOUT_MS = 5_000;
const LIST_TIMEOUT_MS = 8_000;
const MANUAL_ERROR = 'AI tách lỗi hoặc quá tải. Vui lòng chọn thủ công.';

const PASTE_PLACEHOLDER =
  'Nhập toàn bộ thông tin và hệ thống sẽ tự động điền tên, số điện thoại và địa chỉ.\nVí dụ: Nguyen Van A, 0908888888, 12 Le Duan, Phuong Ben Nghe, Quan 1, TP. HCM';

type WardUnit = VnAdminUnit & { districtCode?: number; districtName?: string };

interface AddressFormProps {
  value: StructuredAddressValue;
  onChange: (v: StructuredAddressValue) => void;
  authHeaders: () => Record<string, string>;
}

function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => {
      controller.abort();
      reject(new Error('TIMEOUT'));
    }, ms);
  });
  return Promise.race([
    fetch(url, { ...init, signal: controller.signal }),
    timeout,
  ]).finally(() => {
    if (timer) window.clearTimeout(timer);
  });
}

export default function AddressForm({ value, onChange, authHeaders }: AddressFormProps) {
  const [provinces, setProvinces] = useState<VnAdminUnit[]>([]);
  const [districts, setDistricts] = useState<VnAdminUnit[]>([]);
  const [wards, setWards] = useState<WardUnit[]>([]);
  const [pasteText, setPasteText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [parseError, setParseError] = useState('');
  const [bookOpen, setBookOpen] = useState(false);
  const [addressBook, setAddressBook] = useState<AddressBookEntry[]>([]);
  const bookRef = useRef<HTMLDivElement>(null);

  const inputClass =
    'w-full h-10 px-3 bg-white rounded-lg border border-gray-200 focus:border-orange-500 focus:ring-1 focus:ring-orange-200 focus:outline-none text-sm text-gray-800';
  const selectClass = inputClass;
  const labelClass = 'text-[12px] font-medium text-gray-600';
  const star = <span className="text-red-500">*</span>;

  const fetchJsonList = useCallback(async (url: string): Promise<WardUnit[]> => {
    try {
      const res = await fetchWithTimeout(url, { headers: authHeaders() }, LIST_TIMEOUT_MS);
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }, [authHeaders]);

  useEffect(() => {
    fetchJsonList('/api/vietnam-address/provinces').then(setProvinces);
  }, [fetchJsonList]);

  useEffect(() => {
    if (!value.provinceCode) {
      setDistricts([]);
      setWards([]);
      return;
    }
    if (value.addressMode === 'new2') {
      fetchJsonList(`/api/vietnam-address/wards-by-province/${value.provinceCode}`).then(setWards);
      setDistricts([]);
      return;
    }
    fetchJsonList(`/api/vietnam-address/districts/${value.provinceCode}`).then(setDistricts);
  }, [value.provinceCode, value.addressMode, fetchJsonList]);

  useEffect(() => {
    if (value.addressMode === 'new2') return;
    if (!value.districtCode) {
      setWards([]);
      return;
    }
    fetchJsonList(`/api/vietnam-address/wards/${value.districtCode}`).then(setWards);
  }, [value.addressMode, value.districtCode, fetchJsonList]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (bookRef.current && !bookRef.current.contains(e.target as Node)) setBookOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const setMode = (addressMode: AddressMode) => {
    onChange({
      ...value,
      addressMode,
      districtCode: '',
      districtName: '',
      wardCode: '',
      wardName: '',
    });
  };

  const applyBookEntry = (entry: AddressBookEntry) => {
    onChange({
      ...value,
      name: entry.name,
      phone: normalizePhone(entry.phone),
      provinceCode: entry.provinceCode,
      provinceName: entry.provinceName,
      districtCode: entry.districtCode,
      districtName: entry.districtName,
      wardCode: entry.wardCode,
      wardName: entry.wardName,
      street: entry.street,
      addressMode: entry.addressMode || value.addressMode,
    });
    setBookOpen(false);
  };

  const handleParseAddress = async () => {
    const raw = pasteText.trim();
    if (raw.length < 8) {
      setParseError('Vui lòng dán đầy đủ tên, SĐT và địa chỉ.');
      return;
    }

    setIsLoading(true);
    setParseError('');
    try {
      const res = await fetchWithTimeout(
        '/api/orders/parse-address',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw_address: raw, address_mode: value.addressMode }),
        },
        PARSE_TIMEOUT_MS,
      );
      const data = await res.json().catch(() => ({}));
      const parsed = data.parsed || {};
      const matched = data.matched || {};

      if (!res.ok || data.fallback || !data.success) {
        onChange({
          ...value,
          name: parsed.name || value.name,
          phone: normalizePhone(parsed.phone || value.phone),
          street: parsed.detail || raw,
        });
        setParseError(data.message || data.error || MANUAL_ERROR);
        window.alert(MANUAL_ERROR);
        return;
      }

      const province = matched.province;
      const district = matched.district;
      const ward = matched.ward;
      onChange({
        ...value,
        name: String(parsed.name || value.name || '').trim(),
        phone: normalizePhone(parsed.phone || value.phone),
        provinceCode: province ? String(province.id) : value.provinceCode,
        provinceName: province?.name || parsed.province || value.provinceName,
        districtCode: district ? String(district.id) : '',
        districtName: district?.name || parsed.district || '',
        wardCode: ward ? String(ward.id) : '',
        wardName: ward?.name || parsed.ward || '',
        street: String(parsed.detail || '').trim(),
      });

      if (!province || !ward || (value.addressMode === 'old3' && !district)) {
        setParseError('Chưa khớp đủ địa chỉ. Vui lòng chọn thủ công.');
      }
    } catch {
      onChange({ ...value, street: value.street || raw });
      setParseError(MANUAL_ERROR);
      window.alert(MANUAL_ERROR);
    } finally {
      setIsLoading(false);
    }
  };

  const mapQuery = formatFullAddress(value);
  const mapHref = mapQuery
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`
    : 'https://www.google.com/maps';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-bold text-gray-900">2. Địa chỉ người nhận</h2>
        <div className="relative" ref={bookRef}>
          <button
            type="button"
            onClick={() => {
              setAddressBook(loadAddressBook());
              setBookOpen((open) => !open);
            }}
            className="inline-flex items-center gap-1 text-[13px] font-semibold text-orange-600 hover:text-orange-700"
          >
            <BookUser className="w-4 h-4" />
            Sổ địa chỉ
          </button>
          {bookOpen && (
            <div className="absolute right-0 top-8 z-30 w-80 max-h-72 overflow-y-auto bg-white border border-gray-200 rounded-xl shadow-lg">
              {addressBook.length === 0 ? (
                <p className="px-3 py-4 text-xs text-gray-400">Chưa có khách quen. Tick “Lưu vào sổ địa chỉ” khi tạo đơn.</p>
              ) : (
                <ul>
                  {addressBook.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        onClick={() => applyBookEntry(entry)}
                        className="w-full text-left px-3 py-2.5 hover:bg-orange-50 border-b border-gray-50 last:border-0"
                      >
                        <p className="text-sm font-semibold text-gray-800 truncate">
                          {entry.name} · {entry.phone}
                        </p>
                        <p className="text-[11px] text-gray-500 line-clamp-2">{entry.fullAddress}</p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-4 px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-200">
        <label className="inline-flex items-center gap-2 text-[13px] font-medium text-gray-800 cursor-pointer">
          <input
            type="radio"
            name="address-mode"
            checked={value.addressMode === 'new2'}
            onChange={() => setMode('new2')}
            className="accent-orange-500"
          />
          Địa chỉ MỚI (2 cấp)
        </label>
        <label className="inline-flex items-center gap-2 text-[13px] font-medium text-gray-800 cursor-pointer">
          <input
            type="radio"
            name="address-mode"
            checked={value.addressMode === 'old3'}
            onChange={() => setMode('old3')}
            className="accent-orange-500"
          />
          Địa chỉ CŨ (3 cấp)
        </label>
      </div>

      <div className="space-y-2">
        <textarea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          rows={4}
          placeholder={PASTE_PLACEHOLDER}
          className="w-full px-3 py-2.5 bg-white rounded-lg border border-gray-200 focus:border-orange-500 focus:ring-1 focus:ring-orange-200 focus:outline-none text-sm text-gray-800 placeholder:text-gray-400 resize-y min-h-[96px]"
        />
        <button
          type="button"
          onClick={handleParseAddress}
          className="inline-flex items-center justify-center gap-2 h-10 px-4 rounded-lg bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold shadow-sm"
        >
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Đang tách...
            </>
          ) : (
            'Dán và nhập tự động'
          )}
        </button>
        {parseError && <p className="text-[12px] text-amber-700">{parseError}</p>}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>{star} Điện thoại</label>
          <div className="mt-1 flex">
            <span className="inline-flex items-center px-2.5 h-10 rounded-l-lg border border-r-0 border-gray-200 bg-gray-50 text-[12px] font-semibold text-gray-500">
              +84
            </span>
            <input
              type="tel"
              value={value.phone}
              onChange={(e) => onChange({ ...value, phone: normalizePhone(e.target.value) })}
              placeholder="908888888"
              className={`${inputClass} rounded-l-none`}
            />
          </div>
        </div>
        <div>
          <label className={labelClass}>{star} Tên</label>
          <input
            type="text"
            value={value.name}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
            placeholder="Nguyễn Văn A"
            className={`mt-1 ${inputClass}`}
          />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <label className={labelClass}>{star} Địa chỉ chi tiết</label>
          <a
            href={mapHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[12px] font-semibold text-orange-600 hover:text-orange-700"
          >
            <MapPin className="w-3.5 h-3.5" />
            Xem trên Bản Đồ
          </a>
        </div>
        <input
          type="text"
          value={value.street}
          onChange={(e) => onChange({ ...value, street: e.target.value })}
          placeholder="Số nhà, tên đường, ngõ ngách..."
          className={`mt-1 ${inputClass}`}
        />
      </div>

      <div>
        <label className={labelClass}>
          {star} {value.addressMode === 'new2' ? 'Tỉnh / Phường-Xã' : 'Tỉnh / Quận-Huyện / Phường-Xã'}
        </label>
        <div
          className={`mt-1 grid gap-2 ${value.addressMode === 'new2' ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-3'}`}
        >
          <select
            value={value.provinceCode}
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
            <option value="">Chọn Tỉnh/Thành</option>
            {provinces.map((p) => (
              <option key={p.code} value={String(p.code)}>
                {p.name}
              </option>
            ))}
          </select>

          {value.addressMode === 'old3' && (
            <select
              value={value.districtCode}
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
              <option value="">Chọn Quận/Huyện</option>
              {districts.map((d) => (
                <option key={d.code} value={String(d.code)}>
                  {d.name}
                </option>
              ))}
            </select>
          )}

          <select
            value={value.wardCode}
            onChange={(e) => {
              const code = e.target.value;
              const w = wards.find((x) => String(x.code) === code);
              onChange({
                ...value,
                wardCode: code,
                wardName: w?.name || '',
                ...(value.addressMode === 'new2' && w?.districtCode
                  ? {
                      districtCode: String(w.districtCode),
                      districtName: w.districtName || '',
                    }
                  : {}),
              });
            }}
            className={selectClass}
          >
            <option value="">Chọn Phường/Xã</option>
            {wards.map((w) => (
              <option key={w.code} value={String(w.code)}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <label className="inline-flex items-center gap-2 text-[13px] text-gray-700 cursor-pointer">
        <input
          type="checkbox"
          checked={value.saveToAddressBook}
          onChange={(e) => onChange({ ...value, saveToAddressBook: e.target.checked })}
          className="accent-orange-500 w-4 h-4"
        />
        Lưu vào sổ địa chỉ
      </label>
    </div>
  );
}
