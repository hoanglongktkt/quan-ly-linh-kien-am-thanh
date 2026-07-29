/**
 * Chuẩn hóa chuỗi tìm kiếm Kho Gốc: trim, gộp khoảng trắng, bỏ dấu tiếng Việt.
 */
export function normalizeProductSearchText(input: unknown): string {
  return String(input ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeRegexLiteral(input: string): string {
  return String(input || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parse search/keyword từ Express req.query (hỗ trợ array / khoảng trắng). */
export function parseProductSearchQuery(query: Record<string, unknown> | null | undefined): string {
  const raw = query?.search ?? query?.keyword ?? "";
  const value = Array.isArray(raw) ? raw[0] : raw;
  return normalizeProductSearchText(value).length > 0
    ? String(Array.isArray(raw) ? raw[0] : raw)
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

/**
 * Regex linh hoạt dấu tiếng Việt — user gõ "mach" vẫn khớp "Mạch".
 */
export function buildAccentFlexibleRegex(rawQuery: string): RegExp | null {
  const folded = normalizeProductSearchText(rawQuery);
  if (!folded) return null;

  const map: Record<string, string> = {
    a: "aáàảãạăắằẳẵặâấầẩẫậ",
    d: "dđ",
    e: "eéèẻẽẹêếềểễệ",
    i: "iíìỉĩị",
    o: "oóòỏõọôốồổỗộơớờởỡợ",
    u: "uúùủũụưứừửữự",
    y: "yýỳỷỹỵ",
  };

  let pattern = "";
  for (const ch of folded) {
    if (ch === " ") {
      pattern += "\\s+";
      continue;
    }
    const group = map[ch];
    if (group) {
      pattern += `[${group}${group.toUpperCase()}]`;
    } else {
      pattern += escapeRegexLiteral(ch);
    }
  }

  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(escapeRegexLiteral(folded), "i");
  }
}

export function productRowMatchesSearch(row: any, rawQuery: string): boolean {
  const q = normalizeProductSearchText(rawQuery);
  if (!q) return true;
  const parts = [
    row?.sku,
    row?.barcode,
    row?.title,
    row?.name,
    row?.modelName,
    ...(Array.isArray(row?.tierLabels) ? row.tierLabels : []),
  ];
  for (const key of ["children", "children_models"] as const) {
    const list = Array.isArray(row?.[key]) ? row[key] : [];
    for (const c of list) {
      parts.push(c?.sku, c?.title, c?.name, c?.modelName, c?.barcode);
    }
  }
  const hay = normalizeProductSearchText(parts.map((v) => String(v ?? "")).join(" "));
  return hay.includes(q);
}
