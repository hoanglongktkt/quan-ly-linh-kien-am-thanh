import React, { useMemo } from 'react';

type HighlightedTextProps = {
  text?: string | number | null;
  highlight?: string | null;
  className?: string;
};

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Bôi đậm đoạn khớp từ khóa tìm kiếm (substring, không phân biệt hoa thường).
 * An toàn khi text/highlight null|undefined — không crash.
 */
export function HighlightedText({ text, highlight, className }: HighlightedTextProps) {
  const raw = text == null ? '' : String(text);
  const q = highlight == null ? '' : String(highlight).trim();

  const parts = useMemo(() => {
    if (!raw || !q) return null;
    try {
      const re = new RegExp(`(${escapeRegExp(q)})`, 'gi');
      return raw.split(re);
    } catch {
      return null;
    }
  }, [raw, q]);

  if (!parts || parts.length <= 1) {
    return className ? <span className={className}>{raw}</span> : <>{raw}</>;
  }

  const qLower = q.toLowerCase();
  return (
    <span className={className}>
      {parts.map((part, i) =>
        part && part.toLowerCase() === qLower ? (
          <mark
            key={`h-${i}`}
            className="bg-yellow-300 font-bold text-gray-900 rounded-sm px-0.5 not-italic"
          >
            {part}
          </mark>
        ) : (
          <React.Fragment key={`t-${i}`}>{part}</React.Fragment>
        ),
      )}
    </span>
  );
}
