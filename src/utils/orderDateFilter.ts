export type OrderDatePreset = '7d' | 'this_month' | '30d' | 'custom';

export const ORDER_DATE_PRESET_OPTIONS: { value: OrderDatePreset; label: string }[] = [
  { value: '7d', label: '7 ngày qua' },
  { value: 'this_month', label: 'Tháng này' },
  { value: '30d', label: '30 ngày qua' },
  { value: 'custom', label: 'Tùy chọn' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

export function toDateInputValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function startOfLocalDay(d: Date): Date {
  const x = new Date(d.getTime());
  x.setHours(0, 0, 0, 0);
  return x;
}

export function endOfLocalDay(d: Date): Date {
  const x = new Date(d.getTime());
  x.setHours(23, 59, 59, 999);
  return x;
}

export function defaultCustomDateInputs(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(Date.now() - 30 * DAY_MS);
  return { start: toDateInputValue(start), end: toDateInputValue(end) };
}

/** Mặc định 30 ngày gần nhất (Date.now() lùi 30 ngày). */
export function resolveOrderDateRange(
  preset: OrderDatePreset,
  customStart?: string,
  customEnd?: string,
): { startDate: string; endDate: string } {
  const now = new Date();
  const end = endOfLocalDay(now);
  if (preset === '7d') {
    const start = startOfLocalDay(new Date(Date.now() - 7 * DAY_MS));
    return { startDate: start.toISOString(), endDate: end.toISOString() };
  }
  if (preset === 'this_month') {
    const start = startOfLocalDay(new Date(now.getFullYear(), now.getMonth(), 1));
    return { startDate: start.toISOString(), endDate: end.toISOString() };
  }
  if (preset === 'custom') {
    const parsedStart = customStart ? new Date(`${customStart}T00:00:00`) : new Date(Date.now() - 30 * DAY_MS);
    const parsedEnd = customEnd ? new Date(`${customEnd}T00:00:00`) : now;
    const start = startOfLocalDay(Number.isNaN(parsedStart.getTime()) ? new Date(Date.now() - 30 * DAY_MS) : parsedStart);
    const endCustom = endOfLocalDay(Number.isNaN(parsedEnd.getTime()) ? now : parsedEnd);
    if (start.getTime() > endCustom.getTime()) {
      return { startDate: endCustom.toISOString(), endDate: start.toISOString() };
    }
    return { startDate: start.toISOString(), endDate: endCustom.toISOString() };
  }
  const start = startOfLocalDay(new Date(Date.now() - 30 * DAY_MS));
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}
