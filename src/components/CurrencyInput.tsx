import React from 'react';
import { formatVndInput, parseVndInput } from '../utils/currencyFormat';

interface CurrencyInputProps {
  value: number;
  onChange: (value: number) => void;
  className?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  disabled?: boolean;
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
}: CurrencyInputProps) {
  return (
    <input
      type="text"
      inputMode="numeric"
      disabled={disabled}
      placeholder={placeholder}
      value={formatVndInput(value)}
      onChange={(e) => {
        let next = parseVndInput(e.target.value);
        if (min != null) next = Math.max(min, next);
        if (max != null) next = Math.min(max, next);
        onChange(next);
      }}
      onBlur={() => {
        if (min != null && value < min) onChange(min);
      }}
      className={className}
      autoComplete="off"
    />
  );
}
