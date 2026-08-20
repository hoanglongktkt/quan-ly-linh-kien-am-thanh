const VN_ADDRESS_API_V1 = "https://provinces.open-api.vn/api/v1";
const VN_ADDRESS_API_V2 = "https://provinces.open-api.vn/api/v2";
const VN_ADDRESS_API_LEGACY = "https://provinces.open-api.vn/api";
const VN_ADDRESS_TIMEOUT_MS = 10_000;
const FALLBACK_DELAY_MS = 200;
const MAX_FALLBACK_TRIES = 4;

const GHN_BASE =
  String(process.env.GHN_API_URL || "").trim() ||
  "https://online-gateway.ghn.vn/shiip/public-api";
const GHN_TIMEOUT_MS = 10_000;

let vnProvincesCacheV1 = null;
let vnProvincesCacheV2 = null;
const vnDistrictsCache = new Map();
const vnWardsCache = new Map();
const vnWardsByProvinceCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapUnit(item) {
  if (!item) return null;
  const id = item.id ?? item.code ?? item.ProvinceID ?? item.DistrictID ?? item.WardCode;
  const name = item.name || item.ProvinceName || item.DistrictName || item.WardName || "";
  if (id == null || id === "" || !name) return null;
  return {
    name: String(name),
    code: item.code ?? id,
    id,
    districtCode: item.districtCode ?? item.DistrictID,
    districtName: item.districtName || item.DistrictName || "",
  };
}

function mapUnits(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const unit = mapUnit(list[i]);
    if (unit) out.push(unit);
  }
  return out;
}

function unwrapList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  return null;
}

async function fetchJson(url, headers = {}, timeoutMs = VN_ADDRESS_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", ...headers },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`timeout sau ${timeoutMs / 1000}s: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFirstList(urls) {
  const limit = Math.min(urls.length, MAX_FALLBACK_TRIES);
  for (let i = 0; i < limit; i += 1) {
    const url = urls[i];
    try {
      const data = await fetchJson(url);
      const list = unwrapList(data);
      if (list?.length) return list;
    } catch (error) {
      console.warn("[VN Address] fetch fail:", url, error?.message || error);
    }
    if (i < limit - 1) await sleep(FALLBACK_DELAY_MS);
  }
  return null;
}

function readGhnToken() {
  return String(process.env.GHN_TOKEN || process.env.GHN_API_TOKEN || "").trim();
}

async function ghnFetch(path, query) {
  const token = readGhnToken();
  if (!token) return null;
  const url = new URL(`${GHN_BASE}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
  }
  try {
    const json = await fetchJson(
      url.toString(),
      { Token: token, "Content-Type": "application/json" },
      GHN_TIMEOUT_MS,
    );
    return unwrapList(json);
  } catch (error) {
    console.warn("[GHN Master]", path, error?.message || error);
    return null;
  }
}

async function listGhnProvinces() {
  const rows = await ghnFetch("/master-data/province");
  return mapUnits(rows || []);
}

async function listGhnDistricts(provinceId) {
  if (!provinceId) return [];
  const rows = await ghnFetch("/master-data/district", {
    province_id: Number(provinceId) || provinceId,
  });
  const filtered = (rows || []).filter(
    (d) => String(d.ProvinceID ?? d.province_id ?? "") === String(provinceId),
  );
  return mapUnits(filtered);
}

async function listGhnWards(districtId) {
  if (!districtId) return [];
  const rows = await ghnFetch("/master-data/ward", {
    district_id: Number(districtId) || districtId,
  });
  return mapUnits(rows || []);
}

/** Cache Tỉnh/Thành — địa chỉ CŨ 3 cấp (v1, trước sáp nhập 07/2025). */
export async function listVnProvinces() {
  if (vnProvincesCacheV1?.length) return vnProvincesCacheV1;
  const raw = await fetchFirstList([
    `${VN_ADDRESS_API_V1}/p/`,
    `${VN_ADDRESS_API_LEGACY}/p/`,
  ]);
  let mapped = mapUnits(raw || []);
  if (!mapped.length) {
    mapped = await listGhnProvinces();
  }
  if (mapped.length) vnProvincesCacheV1 = mapped;
  return mapped;
}

/** Cache Tỉnh/Thành — địa chỉ MỚI 2 cấp (v2, sau sáp nhập 07/2025). */
export async function listVnProvincesV2() {
  if (vnProvincesCacheV2?.length) return vnProvincesCacheV2;
  const raw = await fetchFirstList([`${VN_ADDRESS_API_V2}/p/`]);
  let mapped = mapUnits(raw || []);
  if (!mapped.length) {
    mapped = await listVnProvinces();
  }
  if (mapped.length) vnProvincesCacheV2 = mapped;
  return mapped;
}

/** Cache Quận/Huyện theo mã tỉnh (v1 + fallback GHN). */
export async function listVnDistricts(provinceCode) {
  const code = String(provinceCode || "").trim();
  if (!code) return [];
  if (vnDistrictsCache.has(code)) return vnDistrictsCache.get(code) || [];
  let mapped = [];
  try {
    const data = await fetchJson(`${VN_ADDRESS_API_V1}/p/${code}?depth=2`);
    mapped = mapUnits(Array.isArray(data?.districts) ? data.districts : []);
  } catch (error) {
    console.warn("[VN Address] districts v1:", error?.message || error);
  }
  if (!mapped.length) {
    try {
      await sleep(FALLBACK_DELAY_MS);
      const data = await fetchJson(`${VN_ADDRESS_API_LEGACY}/p/${code}?depth=2`);
      mapped = mapUnits(Array.isArray(data?.districts) ? data.districts : []);
    } catch (error) {
      console.warn("[VN Address] districts legacy:", error?.message || error);
    }
  }
  if (!mapped.length) {
    mapped = await listGhnDistricts(code);
  }
  if (mapped.length) vnDistrictsCache.set(code, mapped);
  return mapped;
}

/** Cache Phường/Xã theo mã tỉnh (địa chỉ 2 cấp). */
export async function listVnWardsByProvince(provinceCode) {
  const code = String(provinceCode || "").trim();
  if (!code) return [];
  const cacheKey = `v2:${code}`;
  if (vnWardsByProvinceCache.has(cacheKey)) return vnWardsByProvinceCache.get(cacheKey) || [];
  let wards = [];
  try {
    const data = await fetchJson(`${VN_ADDRESS_API_V2}/p/${code}?depth=2`);
    wards = mapUnits(Array.isArray(data?.wards) ? data.wards : []);
  } catch (error) {
    console.warn("[VN Address] wards-by-province v2:", error?.message || error);
  }
  if (!wards.length) {
    try {
      await sleep(FALLBACK_DELAY_MS);
      const data = await fetchJson(`${VN_ADDRESS_API_V1}/p/${code}?depth=3`);
      const districts = Array.isArray(data?.districts) ? data.districts : [];
      const flat = [];
      for (let di = 0; di < districts.length; di += 1) {
        const d = districts[di];
        const list = Array.isArray(d?.wards) ? d.wards : [];
        for (let wi = 0; wi < list.length; wi += 1) {
          const unit = mapUnit({
            ...list[wi],
            districtCode: d.code,
            districtName: d.name,
          });
          if (unit) flat.push(unit);
        }
      }
      wards = flat;
    } catch (error) {
      console.warn("[VN Address] wards-by-province v1:", error?.message || error);
    }
  }
  if (wards.length) vnWardsByProvinceCache.set(cacheKey, wards);
  return wards;
}

/** Cache Phường/Xã theo mã quận (v1 + fallback GHN). */
export async function listVnWards(districtCode) {
  const code = String(districtCode || "").trim();
  if (!code) return [];
  if (vnWardsCache.has(code)) return vnWardsCache.get(code) || [];
  let mapped = [];
  try {
    const data = await fetchJson(`${VN_ADDRESS_API_V1}/d/${code}?depth=2`);
    mapped = mapUnits(Array.isArray(data?.wards) ? data.wards : []);
  } catch (error) {
    console.warn("[VN Address] wards v1:", error?.message || error);
  }
  if (!mapped.length) {
    try {
      await sleep(FALLBACK_DELAY_MS);
      const data = await fetchJson(`${VN_ADDRESS_API_LEGACY}/d/${code}?depth=2`);
      mapped = mapUnits(Array.isArray(data?.wards) ? data.wards : []);
    } catch (error) {
      console.warn("[VN Address] wards legacy:", error?.message || error);
    }
  }
  if (!mapped.length) {
    mapped = await listGhnWards(code);
  }
  if (mapped.length) vnWardsCache.set(code, mapped);
  return mapped;
}

function isNew2Mode(req) {
  const raw = String(req.query?.mode || req.query?.version || "").toLowerCase();
  return raw === "new2" || raw === "v2";
}

/**
 * GET /api/vietnam-address/provinces
 * Query: ?mode=new2|old3
 */
export async function getProvinces(req, res) {
  try {
    const list = isNew2Mode(req) ? await listVnProvincesV2() : await listVnProvinces();
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

/**
 * GET /api/vietnam-address/wards-by-province/:provinceCode
 */
export async function getWardsByProvince(req, res) {
  try {
    return res.json(await listVnWardsByProvince(req.params.provinceCode));
  } catch (error) {
    console.error("[VN Address] wards-by-province:", error);
    return res.status(502).json({ error: "Không tải được danh sách Phường/Xã theo Tỉnh" });
  }
}
