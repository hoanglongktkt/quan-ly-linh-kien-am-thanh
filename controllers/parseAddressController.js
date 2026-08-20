import { isGeminiConfigured, parseAddressWithGemini } from "../services/geminiService.ts";
import { matchParsedAddressToMaster } from "../services/addressMasterData.ts";

const HANDLER_TIMEOUT_MS = 5_000;
const MATCH_TIMEOUT_MS = 2_000;

function emptyParsed(detail = "") {
  return { name: "", phone: "", province: "", district: "", ward: "", detail };
}

const AI_OVERLOAD_MESSAGE = "AI quá tải, vui lòng nhập thủ công";

function errorPayload(rawAddress, message) {
  const raw = String(rawAddress || "").trim();
  return {
    success: false,
    fallback: true,
    message: message || AI_OVERLOAD_MESSAGE,
    raw_address: raw,
    parsed: emptyParsed(raw),
    matched: null,
    ghn: null,
    spx: null,
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function sendJson(res, status, body) {
  if (res.headersSent) return;
  return res.status(status).json(body);
}

/**
 * POST /api/orders/parse-address
 * Body: { raw_address }
 * Gemini lỗi / timeout → 500 JSON (không để request treo).
 */
export async function parseOrderAddress(req, res) {
  const raw = String(
    req.body?.raw_address || req.body?.rawAddress || req.body?.address || "",
  ).trim();

  if (!raw) {
    return sendJson(res, 400, errorPayload("", "Thiếu raw_address"));
  }

  try {
    if (!isGeminiConfigured()) {
      console.error("=== GEMINI ERROR === GEMINI_API_KEY missing");
      return sendJson(res, 500, errorPayload(raw, AI_OVERLOAD_MESSAGE));
    }

    const { parsed, master } = await withTimeout(
      (async () => {
        const parsedInner = await parseAddressWithGemini(raw);
        let masterInner = {
          vn: { province: null, district: null, ward: null },
          ghn: null,
          spx: null,
        };
        try {
          masterInner = await withTimeout(
            matchParsedAddressToMaster(parsedInner),
            MATCH_TIMEOUT_MS,
            "ADDRESS_MATCH_TIMEOUT",
          );
        } catch (matchErr) {
          console.warn("[parse-address] master match:", matchErr?.message || matchErr);
        }
        return { parsed: parsedInner, master: masterInner };
      })(),
      HANDLER_TIMEOUT_MS,
      "PARSE_ADDRESS_TIMEOUT",
    );

    return sendJson(res, 200, {
      success: true,
      fallback: false,
      raw_address: raw,
      parsed,
      matched: {
        province: master.vn.province,
        district: master.vn.district,
        ward: master.vn.ward,
      },
      ghn: master.ghn,
      spx: master.spx,
    });
  } catch (error) {
    console.error("=== GEMINI ERROR ===", error?.response?.data || error?.message || error);
    return sendJson(res, 500, errorPayload(raw, AI_OVERLOAD_MESSAGE));
  }
}
