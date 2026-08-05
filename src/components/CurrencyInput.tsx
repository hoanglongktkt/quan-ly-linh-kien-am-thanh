import React, { useEffect, useState } from 'react';
import { applySmartShorthand, formatVndInput, parseVndInput } from '../utils/currencyFormat';

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
   * Gõ tắt thông minh (onBlur / Enter):
   * giá trị < 1000 → ×1000 (vd 15 → 15000, 9.3 → 9300);
   * ≥ 1000 giữ nguyên. Cho phép gõ số, `.`, `,` tự do.
   */
  smartShorthand?: boolean;
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
  smartShorthand = false,
}: CurrencyInputProps) {
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState('');

  useEffect(() => {
    if (!focused) {
      setText(formatVndInput(value));
    }
  }, [value, focused]);

  const emit = (next: number) => {
    let n = next;
    if (min != null) n = Math.max(min, n);
    if (max != null) n = Math.min(max, n);
    onChange(n);
    return n;
  };

  const commitSmart = () => {
    const next = emit(applySmartShorthand(text));
    setText(formatVndInput(next));
    setFocused(false);
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      disabled={disabled}
      placeholder={placeholder}
      title={title}
      value={smartShorthand && focused ? text : formatVndInput(value)}
      onClick={onClick}
      onFocus={(e) => {
        if (!smartShorthand) return;
        setFocused(true);
        setText(value > 0 ? formatVndInput(value) : '');
        requestAnimationFrame(() => e.target.select());
      }}
      onChange={(e) => {
        if (smartShorthand && focused) {
          const raw = e.target.value;
          if (raw === '' || /^[0-9.,]*$/.test(raw)) {
            setText(raw);
          }
          return;
        }
        emit(parseVndInput(e.target.value));
      }}
      onKeyDown={(e) => {
        if (!smartShorthand || !focused) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
      onBlur={() => {
        if (smartShorthand && focused) {
          commitSmart();
          return;
        }
        if (min != null && value < min) onChange(min);
      }}
      className={className}
      autoComplete="off"
    />
  );
}
