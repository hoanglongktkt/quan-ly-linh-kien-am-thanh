import { useEffect, useRef, useState, type RefObject } from 'react';

export type VirtualRange = {
  start: number;
  end: number;
  top: number;
  bottom: number;
};

function resolveScrollParent(node: HTMLElement | null): HTMLElement | Window {
  let el = node?.parentElement ?? null;
  while (el && el !== document.body && el !== document.documentElement) {
    const oy = window.getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 4) {
      return el;
    }
    el = el.parentElement;
  }
  return window;
}

/**
 * Chỉ giữ các item nằm trong viewport (+ overscan).
 * Chiều cao ước lượng theo index để expand/collapse không phải đo DOM từng frame.
 */
export function useWindowVirtualRange(opts: {
  count: number;
  enabled: boolean;
  getSize: (index: number) => number;
  revision?: string;
  overscan?: number;
}): VirtualRange & { anchorRef: RefObject<HTMLElement | null> } {
  const { count, enabled, getSize, revision = '', overscan = 4 } = opts;
  const anchorRef = useRef<HTMLElement | null>(null);
  const getSizeRef = useRef(getSize);
  getSizeRef.current = getSize;
  const [range, setRange] = useState<VirtualRange>({ start: 0, end: 0, top: 0, bottom: 0 });

  useEffect(() => {
    if (!enabled || count <= 0) {
      setRange({ start: 0, end: count, top: 0, bottom: 0 });
      return;
    }

    let raf = 0;
    const run = () => {
      const sizeAt = (index: number) => Math.max(48, Number(getSizeRef.current(index)) || 48);
      const offsets = new Array<number>(count + 1);
      offsets[0] = 0;
      for (let i = 0; i < count; i++) offsets[i + 1] = offsets[i] + sizeAt(i);

      const anchor = anchorRef.current;
      const scroller = resolveScrollParent(anchor);
      let viewStart = 0;
      let viewEnd = 0;
      if (!anchor) {
        viewEnd = scroller === window ? window.innerHeight : (scroller as HTMLElement).clientHeight;
      } else if (scroller === window) {
        const anchorTop = anchor.getBoundingClientRect().top + window.scrollY;
        viewStart = window.scrollY - anchorTop;
        viewEnd = viewStart + window.innerHeight;
      } else {
        const scrollerEl = scroller as HTMLElement;
        const anchorTop =
          anchor.getBoundingClientRect().top - scrollerEl.getBoundingClientRect().top + scrollerEl.scrollTop;
        viewStart = scrollerEl.scrollTop - anchorTop;
        viewEnd = viewStart + scrollerEl.clientHeight;
      }

      let start = 0;
      while (start < count && offsets[start + 1] < viewStart) start += 1;
      let end = start;
      while (end < count && offsets[end] < viewEnd) end += 1;
      start = Math.max(0, start - overscan);
      end = Math.min(count, end + overscan);

      const top = offsets[start] || 0;
      const bottom = Math.max(0, (offsets[count] || 0) - (offsets[end] || 0));
      setRange((prev) =>
        prev.start === start && prev.end === end && prev.top === top && prev.bottom === bottom
          ? prev
          : { start, end, top, bottom },
      );
    };

    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        run();
      });
    };

    run();
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll);
    const anchor = anchorRef.current;
    const resizeObserver =
      anchor && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => onScroll())
        : null;
    if (anchor && resizeObserver) resizeObserver.observe(anchor);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      resizeObserver?.disconnect();
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [count, enabled, overscan, revision]);

  if (!enabled) {
    return { anchorRef, start: 0, end: count, top: 0, bottom: 0 };
  }

  // Frame đầu (trước khi đo scroll) vẫn vẽ ~1 màn hình, có spacer để không co list.
  if (count > 0 && range.end === 0 && range.start === 0 && range.top === 0 && range.bottom === 0) {
    const end = Math.min(count, 10);
    let bottom = 0;
    for (let i = end; i < count; i++) bottom += Math.max(48, Number(getSize(i)) || 48);
    return { anchorRef, start: 0, end, top: 0, bottom };
  }

  return { anchorRef, ...range };
}
