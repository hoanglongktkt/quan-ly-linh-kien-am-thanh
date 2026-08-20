/**
 * Gemini address parser — đọc GEMINI_API_KEY từ env (Vercel / cPanel / .env).
 * Model mặc định: gemini-1.5-flash (nhanh, chi phí thấp).
 */
import { GoogleGenerativeAI } from "@google/generative-ai";

export type ParsedAddress = {
  name: string;
  phone: string;
  province: string;
  district: string;
  ward: string;
  detail: string;
};

const GEMINI_TIMEOUT_MS = 4_000;
const DEFAULT_MODEL = "gemini-1.5-flash";
/** Không fallback sang gemini-3.5-flash (quota free tier rất chặt, dễ 429). */
const FALLBACK_MODELS: string[] = [];

const SYSTEM_PROMPT = `Bạn là chuyên gia bóc tách thông tin người nhận và địa chỉ giao hàng Việt Nam.
Nhiệm vụ: tách chuỗi dán thô thành JSON nghiêm ngặt, KHÔNG markdown, KHÔNG giải thích.

Cấu trúc bắt buộc:
{"name":"Họ tên người nhận","phone":"Số điện thoại 0xxxxxxxxx","province":"Tên Tỉnh/Thành phố chuẩn","district":"Tên Quận/Huyện/Thị xã chuẩn","ward":"Tên Phường/Xã/Thị trấn chuẩn","detail":"Số nhà, ngõ ngách, tên đường"}

Quy tắc:
- name: họ tên người nhận. Nếu không có thì "".
- phone: chỉ chữ số, dạng 0xxxxxxxxx (bỏ +84 / 84). Nếu không có thì "".
- province: tên đầy đủ. Viết tắt: HN → Hà Nội, HCM/TPHCM/SG → Thành phố Hồ Chí Minh, DN → Đà Nẵng.
- district: tên chuẩn có tiền tố. Q.1 / Q1 → Quận 1. Địa chỉ 2 cấp (không còn quận) thì district = "".
- ward: tên chuẩn có tiền tố. P. / P → Phường.
- detail: CHỈ số nhà, ngõ, hẻm, tên đường — KHÔNG lặp tỉnh/quận/xã, KHÔNG lặp tên/SĐT.
- Nếu thiếu một trường, để chuỗi rỗng "".
- Chỉ trả về đúng một object JSON.`;

let genAI: GoogleGenerativeAI | null = null;
let genAIKey = "";

function readGeminiApiKey(): string {
  return String(process.env.GEMINI_API_KEY || "").trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getClient(): GoogleGenerativeAI {
  const apiKey = readGeminiApiKey();
  if (!apiKey || apiKey === "chua_co_key_tam_thoi") {
    throw new Error("GEMINI_API_KEY_MISSING");
  }
  if (!genAI || genAIKey !== apiKey) {
    genAI = new GoogleGenerativeAI(apiKey);
    genAIKey = apiKey;
  }
  return genAI;
}

function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("GEMINI_INVALID_JSON");
  return JSON.parse(match[0]);
}

function normalizePhone(raw: unknown): string {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("840") && digits.length >= 12) return digits.slice(2);
  return digits;
}

function normalizeParsed(raw: Record<string, unknown>, fallbackDetail: string): ParsedAddress {
  const province = String(raw.province || "").trim();
  const district = String(raw.district || "").trim();
  const ward = String(raw.ward || "").trim();
  const detail = String(raw.detail || raw.street || "").trim() || fallbackDetail;
  const name = String(raw.name || raw.customerName || "").trim();
  const phone = normalizePhone(raw.phone || raw.tel || raw.mobile);
  return { name, phone, province, district, ward, detail };
}

function isModelUnavailable(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message || err || "").toLowerCase();
  return (
    msg.includes("not found") ||
    msg.includes("is not supported") ||
    msg.includes("unknown model") ||
    msg.includes("404")
  );
}

function wrapGeminiError(err: unknown): Error {
  const msg = String((err as { message?: string })?.message || err || "").toLowerCase();
  if (
    msg.includes("gemini_overload") ||
    msg.includes("429") ||
    msg.includes("quota") ||
    msg.includes("resource_exhausted") ||
    msg.includes("too many requests")
  ) {
    return new Error("GEMINI_OVERLOAD");
  }
  if (msg.includes("timeout")) {
    return new Error("GEMINI_TIMEOUT");
  }
  return new Error("GEMINI_PARSE_FAILED");
}

async function generateWithModel(modelName: string, rawAddress: string): Promise<string> {
  const model = getClient().getGenerativeModel({
    model: modelName,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
    },
  });

  const work = model.generateContent(
    `Tách thông tin người nhận và địa chỉ Việt Nam sau thành JSON:\n"${rawAddress}"`,
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("GEMINI_TIMEOUT")), GEMINI_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([work, timeout]);
    return result.response.text();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Bóc tách địa chỉ thô → { province, district, ward, detail }.
 * Ném lỗi nếu key thiếu / AI không trả JSON — caller bắt và trả chuỗi gốc.
 */
export async function parseAddressWithGemini(rawAddress: string): Promise<ParsedAddress> {
  const raw = String(rawAddress || "").trim();
  if (!raw) {
    return { name: "", phone: "", province: "", district: "", ward: "", detail: "" };
  }

  const envModel = String(process.env.GEMINI_ADDRESS_MODEL || "").trim();
  const primary =
    envModel && !envModel.includes("3.5") ? envModel : DEFAULT_MODEL;
  const models = [primary, ...FALLBACK_MODELS.filter((m) => m !== primary)].slice(0, 2);
  const startedAt = Date.now();

  let lastError: unknown = null;
  for (let i = 0; i < models.length; i += 1) {
    if (Date.now() - startedAt > GEMINI_TIMEOUT_MS + 2_000) break;
    const modelName = models[i];
    try {
      const text = await generateWithModel(modelName, raw);
      const parsed = normalizeParsed(extractJsonObject(text), raw);
      if (!parsed.province && !parsed.district && !parsed.ward && !parsed.detail && !parsed.name && !parsed.phone) {
        throw new Error("GEMINI_EMPTY_PARSE");
      }
      return parsed;
    } catch (err) {
      lastError = wrapGeminiError(err);
      if (!isModelUnavailable(err) || i >= models.length - 1) break;
      await sleep(200);
    }
  }

  throw wrapGeminiError(lastError);
}

export function isGeminiConfigured(): boolean {
  const key = readGeminiApiKey();
  return Boolean(key && key !== "chua_co_key_tam_thoi");
}
