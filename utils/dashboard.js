export function toDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function getDashboardDateRange(rangeKey) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  switch (rangeKey) {
    case "this_month":
      return { start: new Date(y, m, 1), end, key: "this_month", label: "Tháng này" };
    case "last_month":
      return {
        start: new Date(y, m - 1, 1),
        end: new Date(y, m, 0, 23, 59, 59, 999),
        key: "last_month",
        label: "Tháng trước",
      };
    case "this_quarter": {
      const qStart = Math.floor(m / 3) * 3;
      return { start: new Date(y, qStart, 1), end, key: "this_quarter", label: "Quý này" };
    }
    case "this_year":
      return { start: new Date(y, 0, 1), end, key: "this_year", label: "Năm nay" };
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { start, end, key: "today", label: "Hôm nay" };
    }
    case "last_7_days":
    default: {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - 6);
      return { start, end, key: "last_7_days", label: "7 ngày qua" };
    }
  }
}

/**
 * Dựng khung ngày/tháng rỗng rồi đổ dailyRevenue từ Mongo vào.
 */
export function buildDashboardChart(dailyRevenue, range) {
  const buckets = new Map();

  if (range.key === "this_year" || range.key === "this_quarter") {
    const cursor = new Date(range.start.getFullYear(), range.start.getMonth(), 1);
    const endMonth = new Date(range.end.getFullYear(), range.end.getMonth(), 1);
    while (cursor <= endMonth) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
      buckets.set(key, {
        key,
        label: `T${cursor.getMonth() + 1}`,
        amount: 0,
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }
  } else {
    const cursor = new Date(range.start);
    cursor.setHours(0, 0, 0, 0);
    const endDay = new Date(range.end);
    endDay.setHours(0, 0, 0, 0);
    while (cursor <= endDay) {
      const key = toDateKey(cursor);
      buckets.set(key, {
        key,
        label: `${String(cursor.getDate()).padStart(2, "0")}/${String(cursor.getMonth() + 1).padStart(2, "0")}`,
        amount: 0,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  for (const row of dailyRevenue) {
    const dateStr = String(row?.date || "");
    let bucketKey = dateStr;
    if (range.key === "this_year" || range.key === "this_quarter") {
      bucketKey = dateStr.slice(0, 7);
    }
    const bucket = buckets.get(bucketKey);
    if (bucket) {
      bucket.amount += Number(row?.amount) || 0;
    }
  }

  return Array.from(buckets.values());
}
