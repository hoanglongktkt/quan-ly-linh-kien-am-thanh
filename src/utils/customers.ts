export type CustomerOrderItem = {
  name: string;
  quantity: number;
  price: number;
  lineTotal: number;
};

export type CustomerOrderRow = {
  orderSn: string;
  date: string | null;
  items: CustomerOrderItem[];
  total: number;
  status: string;
};

const FETCH_TIMEOUT_MS = 12_000;

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

export async function updateCustomerProfile(
  id: string,
  payload: { name: string; phone: string; address: string; currentPhone: string },
  authHeaders: () => Record<string, string>,
): Promise<{ success: boolean; error?: string }> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/customers/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await readJson(res);
    if (!res.ok || data.success === false) {
      return { success: false, error: String(data.error || "Lưu khách hàng thất bại") };
    }
    return { success: true };
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Lưu khách hàng thất bại",
    };
  } finally {
    window.clearTimeout(timer);
  }
}

export async function deleteCustomer(
  id: string,
  phone: string,
  authHeaders: () => Record<string, string>,
): Promise<{ success: boolean; error?: string }> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const qs = phone ? `?phone=${encodeURIComponent(phone)}` : "";
    const res = await fetch(`/api/customers/${encodeURIComponent(id)}${qs}`, {
      method: "DELETE",
      headers: authHeaders(),
      signal: controller.signal,
    });
    const data = await readJson(res);
    if (!res.ok || data.success === false) {
      return { success: false, error: String(data.error || "Xóa khách hàng thất bại") };
    }
    return { success: true };
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Xóa khách hàng thất bại",
    };
  } finally {
    window.clearTimeout(timer);
  }
}

export async function getCustomerOrderHistory(
  phone: string,
  authHeaders: () => Record<string, string>,
): Promise<CustomerOrderRow[]> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/customers/${encodeURIComponent(phone)}/orders`, {
      headers: authHeaders(),
      signal: controller.signal,
    });
    const data = await readJson(res);
    if (!res.ok || data.success === false) {
      throw new Error(String(data.error || "Không tải được lịch sử đơn"));
    }
    const raw = Array.isArray(data.orders) ? data.orders : [];
    return raw.map((row) => {
      const rec = row as Record<string, unknown>;
      const itemsRaw = Array.isArray(rec.items) ? rec.items : [];
      const items: CustomerOrderItem[] = itemsRaw.map((item) => {
        const line = item as Record<string, unknown>;
        const quantity = Math.max(1, Math.round(Number(line.quantity) || 1));
        const price = Math.max(0, Math.round(Number(line.price) || 0));
        const lineTotal = Math.max(0, Math.round(Number(line.lineTotal) || price * quantity));
        return {
          name: String(line.name || "Sản phẩm"),
          quantity,
          price,
          lineTotal,
        };
      });
      return {
        orderSn: String(rec.orderSn || "—"),
        date: rec.date ? String(rec.date) : null,
        items: items.length ? items : [{ name: "—", quantity: 1, price: 0, lineTotal: 0 }],
        total: Math.max(0, Math.round(Number(rec.total) || 0)),
        status: String(rec.status || "—"),
      };
    });
  } finally {
    window.clearTimeout(timer);
  }
}
