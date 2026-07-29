const VN_ADDRESS_API = "https://provinces.open-api.vn/api";

let vnProvincesCache = null;
const vnDistrictsCache = new Map();
const vnWardsCache = new Map();

async function fetchVnJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`VN address API ${res.status}`);
  return res.json();
}

/**
 * GET /api/vietnam-address/provinces
 */
export async function getProvinces(_req, res) {
  try {
    if (!vnProvincesCache) {
      vnProvincesCache = await fetchVnJson(`${VN_ADDRESS_API}/p/`);
    }
    const list = (vnProvincesCache || []).map((p) => ({
      name: p.name,
      code: p.code,
    }));
    return res.json(list);
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
    const provinceCode = Number(req.params.provinceCode);
    if (!provinceCode) return res.json([]);

    if (!vnDistrictsCache.has(provinceCode)) {
      const data = await fetchVnJson(`${VN_ADDRESS_API}/p/${provinceCode}?depth=2`);
      const districts = Array.isArray(data?.districts) ? data.districts : [];
      vnDistrictsCache.set(
        provinceCode,
        districts.map((d) => ({ name: d.name, code: d.code })),
      );
    }
    return res.json(vnDistrictsCache.get(provinceCode) || []);
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
    const districtCode = Number(req.params.districtCode);
    if (!districtCode) return res.json([]);

    if (!vnWardsCache.has(districtCode)) {
      const data = await fetchVnJson(`${VN_ADDRESS_API}/d/${districtCode}?depth=2`);
      const wards = Array.isArray(data?.wards) ? data.wards : [];
      vnWardsCache.set(
        districtCode,
        wards.map((w) => ({ name: w.name, code: w.code })),
      );
    }
    return res.json(vnWardsCache.get(districtCode) || []);
  } catch (error) {
    console.error("[VN Address] wards:", error);
    return res.status(502).json({ error: "Không tải được danh sách Phường/Xã" });
  }
}
