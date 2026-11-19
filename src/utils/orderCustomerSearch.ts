import { buildAccentFlexibleRegex, escapeRegexLiteral, normalizeProductSearchText } from "./productSearch";

export function orderCustomerMatchesSearch(values: unknown[], rawQuery: string): boolean {
  const q = normalizeProductSearchText(rawQuery);
  if (!q) return true;
  const phone = /^[+\d\s().-]+$/.test(rawQuery.trim()) ? rawQuery.replace(/\D/g, "") : "";
  const variants = phone.startsWith("84") ? [phone, "0" + phone.slice(2)] : [phone];
  return values.some((value) => {
    const text = String(value ?? "");
    return normalizeProductSearchText(text).includes(q) ||
      Boolean(phone && variants.some((part) => text.replace(/\D/g, "").includes(part)));
  });
}

/** Match both current customer fields and older/raw order payloads. */
export function buildOrderCustomerSearchClauses(rawQuery: string): Record<string, unknown>[] {
  const name = buildAccentFlexibleRegex(rawQuery);
  if (!name) return [];
  const names = [
    "customerName", "customer_name", "data.customerName", "data.customer_name",
    "buyer_username", "data.buyer_username",
    "recipient_address.name", "data.recipient_address.name", "data.raw.recipient_address.name",
    "billing.first_name", "billing.last_name", "data.billing.first_name", "data.billing.last_name",
    "shipping.first_name", "shipping.last_name", "data.shipping.first_name", "data.shipping.last_name",
  ];
  const clauses: Record<string, unknown>[] = names.map((field) => ({ [field]: name }));
  if (/^[+\d\s().-]+$/.test(rawQuery.trim())) {
    const digits = rawQuery.replace(/\D/g, "");
    if (digits) {
      const variants = digits.startsWith("84") ? [digits, "0" + digits.slice(2)] : [digits];
      const pattern = variants.map((part) => [...part].map(escapeRegexLiteral).join("[\\s().-]*")).join("|");
      const phone = new RegExp(pattern);
      for (const field of [
        "customerPhone", "customer_phone", "data.customerPhone", "data.customer_phone",
        "recipient_address.phone", "data.recipient_address.phone", "data.raw.recipient_address.phone",
        "billing.phone", "data.billing.phone", "shipping.phone", "data.shipping.phone",
      ]) clauses.push({ [field]: phone });
    }
  }
  return clauses;
}
