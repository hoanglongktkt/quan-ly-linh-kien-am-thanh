export type CustomerOrderRow = {
  orderSn: string;
  date: string | null;
  products: string;
  total: number;
  status: string;
};

const FETCH_TIMEOUT_MS = 12_000;

export async function updateCustomerAddress(
  id: string,
  address: string,
  phone: string,
  authHeaders: () => Record<string, string>,
): Promise<{ success: boolean; error?: string }> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/customers/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ address, phone }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.success === false) {
      return { success: false, error: String(data?.error || "Lưu địa chỉ thất bại") };
    }
    return { success: true };
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Lưu địa chỉ thất bại",
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
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.success === false) {
      throw new Error(String(data?.error || "Không tải được lịch sử đơn"));
    }
    const raw = Array.isArray(data?.orders) ? data.orders : [];
    return raw.map((row: Record<string, unknown>) => ({
      orderSn: String(row?.orderSn || "—"),
      date: row?.date ? String(row.date) : null,
      products: String(row?.products || "—"),
      total: Math.max(0, Math.round(Number(row?.total) || 0)),
      status: String(row?.status || "—"),
    }));
  } finally {
    window.clearTimeout(timer);
  }
}
