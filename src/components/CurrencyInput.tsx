import React, { useEffect, useRef, useState } from 'react';
import { formatVndInput, parseVndInput } from '../utils/currencyFormat';

interface CurrencyInputProps {
  value: number;
  onChange: (value: number) => void;
  className?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  disabled?: boolean;
  onClick?: (e: React.MouseEvent<HTMLInputElement>) => void;
  title?: string;
  /**
   * Khi bật: giá trị 0 hiển thị "000"; gõ số (vd "15") tự nối thành "15000".
   * Dùng cho ô Đơn giá khi tạo đơn nhập hàng.
   */
  zerosSuffix?: boolean;
}

/** Ô nhập tiền tự format dấu chấm hàng nghìn (1.200.000). Value state luôn là số nguyên. */
export default function CurrencyInput({
  value,
  onChange,
  className = '',
  placeholder = '0',
  min = 0,
  max,
  disabled,
  onClick,
  title,
  zerosSuffix = false,
}: CurrencyInputProps) {
  const [suffixMode, setSuffixMode] = useState(zerosSuffix && value === 0);
  const [prefix, setPrefix] = useState('');
  const prevValueRef = useRef(value);

  useEffect(() => {
    if (!zerosSuffix) return;
    // Dòng mới / reset về 0 → quay lại chế độ "000"
    if (value === 0 && prevValueRef.current !== 0) {
      setSuffixMode(true);
      setPrefix('');
    }
    prevValueRef.current = value;
  }, [value, zerosSuffix]);

  const emit = (next: number) => {
    let n = next;
    if (min != null) n = Math.max(min, n);
    if (max != null) n = Math.min(max, n);
    onChange(n);
  };

  const displayValue =
    zerosSuffix && suffixMode ? (prefix ? `${prefix}000` : '000') : formatVndInput(value);

  return (
    <input
      type="text"
      inputMode="numeric"
      disabled={disabled}
      placeholder={zerosSuffix ? '000' : placeholder}
      title={title}
      value={displayValue}
      onClick={onClick}
      onFocus={() => {
        if (zerosSuffix && value === 0) {
          setSuffixMode(true);
          setPrefix('');
        }
      }}
      onChange={(e) => {
        if (zerosSuffix && suffixMode) return; // digit xử lý ở onKeyDown
        emit(parseVndInput(e.target.value));
      }}
      onKeyDown={(e) => {
        if (!zerosSuffix || !suffixMode) return;
        if (e.key >= '0' && e.key <= '9') {
          e.preventDefault();
          const nextPrefix = prefix + e.key;
          setPrefix(nextPrefix);
          emit(Number(nextPrefix + '000') || 0);
        } else if (e.key === 'Backspace') {
          e.preventDefault();
          const nextPrefix = prefix.slice(0, -1);
          setPrefix(nextPrefix);
          emit(nextPrefix ? Number(nextPrefix + '000') || 0 : 0);
        } else if (e.key === 'Delete') {
          e.preventDefault();
          setPrefix('');
          emit(0);
        }
      }}
      onBlur={() => {
        if (zerosSuffix && suffixMode && prefix) {
          setSuffixMode(false);
        }
        if (min != null && value < min) onChange(min);
      }}
      className={className}
      autoComplete="off"
    />
  );
}
