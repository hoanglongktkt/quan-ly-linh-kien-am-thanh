import { isGeminiConfigured, parseAddressWithGemini } from "../services/geminiService.ts";
import { matchParsedAddressToMaster } from "../services/addressMasterData.ts";

function emptyParsed(detail = "") {
  return { province: "", district: "", ward: "", detail };
}

function fallbackPayload(rawAddress, message) {
  const raw = String(rawAddress || "").trim();
  return {
    success: false,
    fallback: true,
    raw_address: raw,
    parsed: emptyParsed(raw),
    matched: null,
    ghn: null,
    spx: null,
    message: message || "Không tách được địa chỉ. Vui lòng nhập thủ công.",
  };
}

/**
 * POST /api/orders/parse-address
 * Body: { raw_address }
 * Lỗi AI/master-data → 200 + chuỗi gốc để user nhập tay.
 */
export async function parseOrderAddress(req, res) {
  const raw = String(
    req.body?.raw_address || req.body?.rawAddress || req.body?.address || "",
  ).trim();

  if (!raw) {
    return res.status(400).json(fallbackPayload("", "Thiếu raw_address"));
  }

  try {
    if (!isGeminiConfigured()) {
      return res.json(
        fallbackPayload(raw, "Chưa cấu hình GEMINI_API_KEY. Vui lòng nhập địa chỉ thủ công."),
      );
    }

    const parsed = await parseAddressWithGemini(raw);
    const master = await matchParsedAddressToMaster(parsed);

    return res.json({
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
    console.error("[parse-address]", error?.message || error);
    return res.json(
      fallbackPayload(raw, "AI tạm thời không phản hồi. Vui lòng nhập địa chỉ thủ công."),
    );
  }
}
