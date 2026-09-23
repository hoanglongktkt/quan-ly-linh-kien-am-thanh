import React, { useRef, useState } from 'react';
import { applySmartShorthand, formatVndInput } from '../utils/currencyFormat';

type InlineCommitInputProps = {
  value: number;
  onCommit: (value: number) => void;
  kind: 'integer' | 'vnd';
  className?: string;
  title?: string;
  onClick?: (e: React.MouseEvent<HTMLInputElement>) => void;
};

function normalizeCommitted(value: number): number {
  const n = Math.round(Number(value) || 0);
  return Math.max(0, n);
}

/** Ô nhập giữ draft cục bộ. Chỉ đẩy giá trị ra ngoài khi blur hoặc Enter. */
export default function InlineCommitInput({
  value,
  onCommit,
  kind,
  className = '',
  title,
  onClick,
}: InlineCommitInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const committed = normalizeCommitted(value);

  const setDraftValue = (next: string | null) => {
    draftRef.current = next;
    setDraft(next);
  };

  const shown =
    draft !== null
      ? draft
      : kind === 'vnd'
        ? formatVndInput(committed)
        : String(committed);

  const commit = () => {
    const raw = draftRef.current;
    if (raw === null) return;
    let next: number;
    if (kind === 'vnd') {
      // 25 → 25000, 2.5 → 2500; số ≥ 1000 giữ nguyên.
      next = applySmartShorthand(raw);
    } else {
      const parsed = Number(raw);
      next = normalizeCommitted(Number.isFinite(parsed) ? parsed : 0);
    }
    setDraftValue(null);
    if (next === committed) return;
    onCommit(next);
  };

  return (
    <input
      type={kind === 'vnd' ? 'text' : 'number'}
      inputMode={kind === 'vnd' ? 'decimal' : 'numeric'}
      value={shown}
      title={title}
      onClick={onClick}
      onFocus={(e) => {
        const initial = kind === 'vnd'
          ? (committed > 0 ? formatVndInput(committed) : '')
          : String(committed);
        setDraftValue(initial);
        requestAnimationFrame(() => e.currentTarget.select());
      }}
      onChange={(e) => {
        const raw = e.target.value;
        if (kind === 'vnd') {
          if (raw === '' || /^[0-9.,]*$/.test(raw)) setDraftValue(raw);
          return;
        }
        setDraftValue(raw);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        e.currentTarget.blur();
      }}
      className={className}
      autoComplete="off"
    />
  );
}
