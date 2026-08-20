const VN_ADDRESS_API = "https://provinces.open-api.vn/api";
const VN_ADDRESS_TIMEOUT_MS = 10_000;

let vnProvincesCache = null;
const vnDistrictsCache = new Map();
const vnWardsCache = new Map();

async function fetchVnJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VN_ADDRESS_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`VN address API ${res.status}`);
    return await res.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`VN address API timeout sau ${VN_ADDRESS_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Cache Tỉnh/Thành — dùng chung dropdown + parse-address. */
export async function listVnProvinces() {
  if (!vnProvincesCache) {
    vnProvincesCache = await fetchVnJson(`${VN_ADDRESS_API}/p/`);
  }
  return (vnProvincesCache || []).map((p) => ({
    name: p.name,
    code: p.code,
  }));
}

/** Cache Quận/Huyện theo mã tỉnh. */
export async function listVnDistricts(provinceCode) {
  const code = Number(provinceCode);
  if (!code) return [];
  if (!vnDistrictsCache.has(code)) {
    const data = await fetchVnJson(`${VN_ADDRESS_API}/p/${code}?depth=2`);
    const districts = Array.isArray(data?.districts) ? data.districts : [];
    vnDistrictsCache.set(
      code,
      districts.map((d) => ({ name: d.name, code: d.code })),
    );
  }
  return vnDistrictsCache.get(code) || [];
}

/** Cache Phường/Xã theo mã quận. */
export async function listVnWards(districtCode) {
  const code = Number(districtCode);
  if (!code) return [];
  if (!vnWardsCache.has(code)) {
    const data = await fetchVnJson(`${VN_ADDRESS_API}/d/${code}?depth=2`);
    const wards = Array.isArray(data?.wards) ? data.wards : [];
    vnWardsCache.set(
      code,
      wards.map((w) => ({ name: w.name, code: w.code })),
    );
  }
  return vnWardsCache.get(code) || [];
}

/**
 * GET /api/vietnam-address/provinces
 */
export async function getProvinces(_req, res) {
  try {
    return res.json(await listVnProvinces());
  } catch (error) {
    console.error("[VN Address] provinces:", error);
    return res.status(502).json({ error: "Không tải được danh sách Tỉnh/Thành" });
  }
}

/**
 * GET /api/vietnam-address/districts/:provinceCode
 */
export async function getDistricts(req, res) {
  try {
    return res.json(await listVnDistricts(req.params.provinceCode));
  } catch (error) {
    console.error("[VN Address] districts:", error);
    return res.status(502).json({ error: "Không tải được danh sách Quận/Huyện" });
  }
}

/**
 * GET /api/vietnam-address/wards/:districtCode
 */
export async function getWards(req, res) {
  try {
    return res.json(await listVnWards(req.params.districtCode));
  } catch (error) {
    console.error("[VN Address] wards:", error);
    return res.status(502).json({ error: "Không tải được danh sách Phường/Xã" });
  }
}
