/**
 * Gemini address parser — đọc GEMINI_API_KEY từ env (Vercel / cPanel / .env).
 * Model mặc định: gemini-1.5-flash (nhanh, chi phí thấp).
 */
import { GoogleGenerativeAI } from "@google/generative-ai";

export type ParsedAddress = {
  province: string;
  district: string;
  ward: string;
  detail: string;
};

const GEMINI_TIMEOUT_MS = 15_000;
const DEFAULT_MODEL = "gemini-1.5-flash";
const FALLBACK_MODELS = ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-3.5-flash"];

const SYSTEM_PROMPT = `Bạn là chuyên gia bóc tách địa chỉ giao hàng Việt Nam.
Nhiệm vụ: tách chuỗi địa chỉ thô thành JSON nghiêm ngặt, KHÔNG markdown, KHÔNG giải thích.

Cấu trúc bắt buộc:
{"province":"Tên Tỉnh/Thành phố chuẩn","district":"Tên Quận/Huyện/Thị xã chuẩn","ward":"Tên Phường/Xã/Thị trấn chuẩn","detail":"Số nhà, ngõ ngách, tên đường"}

Quy tắc chuẩn hóa:
- province: tên đầy đủ (VD: "Hà Nội", "Thành phố Hồ Chí Minh", "Đà Nẵng"). Viết tắt: HN → Hà Nội, HCM/TPHCM/SG → Thành phố Hồ Chí Minh, DN → Đà Nẵng.
- district: tên chuẩn có tiền tố (VD: "Quận Thanh Xuân", "Huyện Đông Anh", "Thành phố Thủ Đức"). Q.1 / Q1 → Quận 1.
- ward: tên chuẩn có tiền tố (VD: "Phường Khương Trung", "Xã ..."). P. / P → Phường.
- detail: CHỈ số nhà, ngõ, hẻm, tên đường — KHÔNG lặp lại tỉnh/quận/xã.
- Nếu thiếu một cấp hành chính, để chuỗi rỗng "".
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

function normalizeParsed(raw: Record<string, unknown>, fallbackDetail: string): ParsedAddress {
  const province = String(raw.province || "").trim();
  const district = String(raw.district || "").trim();
  const ward = String(raw.ward || "").trim();
  const detail = String(raw.detail || raw.street || "").trim() || fallbackDetail;
  return { province, district, ward, detail };
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
    `Tách địa chỉ Việt Nam sau thành JSON:\n"${rawAddress}"`,
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
    return { province: "", district: "", ward: "", detail: "" };
  }

  const primary = String(process.env.GEMINI_ADDRESS_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const models = [primary, ...FALLBACK_MODELS.filter((m) => m !== primary)];

  let lastError: unknown = null;
  for (let i = 0; i < models.length; i += 1) {
    const modelName = models[i];
    try {
      const text = await generateWithModel(modelName, raw);
      const parsed = normalizeParsed(extractJsonObject(text), raw);
      if (!parsed.province && !parsed.district && !parsed.ward && !parsed.detail) {
        throw new Error("GEMINI_EMPTY_PARSE");
      }
      return parsed;
    } catch (err) {
      lastError = err;
      if (!isModelUnavailable(err) || i >= models.length - 1) break;
      await sleep(400);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("GEMINI_PARSE_FAILED");
}

export function isGeminiConfigured(): boolean {
  const key = readGeminiApiKey();
  return Boolean(key && key !== "chua_co_key_tam_thoi");
}
