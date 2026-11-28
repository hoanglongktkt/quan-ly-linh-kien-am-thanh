import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { createPortal } from 'react-dom';
import type { OrderShopFilterValue, ShopFilterOption } from '../utils/orderShopGroup';

interface OrderShopFilterDropdownProps {
  value: OrderShopFilterValue;
  options: ShopFilterOption[];
  onChange: (value: OrderShopFilterValue) => void;
  className?: string;
  ariaLabel?: string;
}

type MenuPosition = {
  top: number;
  left: number;
  minWidth: number;
  maxHeight: number;
};

// Chuẩn hóa nhãn chỉ ở tầng hiển thị để không làm thay đổi dữ liệu lọc gốc.
function displayLabel(label: string): string {
  return String(label || '').toLocaleUpperCase('vi-VN');
}

function getOptionClasses(value: OrderShopFilterValue, selected: boolean): string {
  // “Tất cả gian hàng” dùng xanh dương; mọi phạm vi cụ thể dùng xanh lá.
  const isAll = value === 'all';
  const colorClasses = isAll
    ? selected
      ? 'bg-blue-600 text-white'
      : 'bg-blue-500 text-white hover:bg-blue-700'
    : selected
      ? 'bg-emerald-600 text-white'
      : 'bg-emerald-500 text-white hover:bg-emerald-700';

  return `flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-bold uppercase transition-colors ${colorClasses}`;
}

export default function OrderShopFilterDropdown({
  value,
  options,
  onChange,
  className = '',
  ariaLabel = 'Lọc gian hàng',
}: OrderShopFilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(() =>
    Math.max(0, options.findIndex((option) => option.value === value)),
  );
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((option) => option.value === value) || options[0];
  const isAll = value === 'all';

  useEffect(() => {
    const nextIndex = options.findIndex((option) => option.value === value);
    setHighlightedIndex(nextIndex >= 0 ? nextIndex : 0);
  }, [options, value]);

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    // Menu đi qua portal và cập nhật khi cuộn/resize để không bị vùng overflow cắt.
    const viewportPadding = 8;
    const estimatedMenuHeight = Math.min(320, Math.max(80, options.length * 40 + 12));
    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding;
    const spaceAbove = rect.top - viewportPadding;
    const openAbove = spaceBelow < estimatedMenuHeight && spaceAbove > spaceBelow;
    const maxHeight = Math.max(80, Math.min(320, openAbove ? spaceAbove : spaceBelow));
    const menuWidth = Math.max(rect.width, 180);
    const left = Math.max(
      viewportPadding,
      Math.min(rect.left, window.innerWidth - menuWidth - viewportPadding),
    );

    setMenuPosition({
      top: openAbove ? Math.max(viewportPadding, rect.top - maxHeight - 4) : rect.bottom + 4,
      left,
      minWidth: menuWidth,
      maxHeight,
    });
  }, [options.length]);

  useEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return;
    }

    updateMenuPosition();
    const handleViewportChange = () => updateMenuPosition();
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };

    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [open, updateMenuPosition]);

  const selectOption = (nextValue: OrderShopFilterValue) => {
    onChange(nextValue);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setHighlightedIndex((current) => {
        if (!options.length) return 0;
        const offset = event.key === 'ArrowDown' ? 1 : -1;
        return (current + offset + options.length) % options.length;
      });
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const option = options[highlightedIndex];
      if (option) selectOption(option.value);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
        className={`order-0 inline-flex min-h-10 min-w-[180px] shrink-0 items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[11px] font-bold uppercase text-white shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-slate-300 md:min-h-0 ${
          isAll
            ? 'border-blue-600 bg-blue-600 hover:bg-blue-700'
            : 'border-emerald-600 bg-emerald-600 hover:bg-emerald-700'
        } ${className}`}
      >
        <span className="truncate">{displayLabel(selectedOption?.label || '')}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && menuPosition && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              role="listbox"
              aria-label={ariaLabel}
              className="fixed z-[120] rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl"
              style={{
                top: menuPosition.top,
                left: menuPosition.left,
                minWidth: menuPosition.minWidth,
                maxHeight: menuPosition.maxHeight,
                overflowY: 'auto',
              }}
            >
              {options.map((option, index) => {
                const selected = option.value === value;
                return (
                  <button
                    key={String(option.value)}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => selectOption(option.value)}
                    className={`${getOptionClasses(option.value, selected)} ${
                      highlightedIndex === index ? 'ring-2 ring-slate-300 ring-offset-1' : ''
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{displayLabel(option.label)}</span>
                    {selected ? <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
