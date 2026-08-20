/**
 * Cache + đối chiếu tên địa chỉ với Master Data VN / GHN / SPX.
 * - VN: provinces.open-api.vn (cùng nguồn dropdown Frontend)
 * - GHN: master-data API (nếu có GHN_TOKEN)
 * - SPX: map theo mã hành chính VN (fallback khi chưa có token SPX)
 */
import {
  listVnDistricts,
  listVnProvinces,
  listVnWards,
} from "../controllers/vietnamAddressController.js";

export type NamedId = {
  id: string;
  name: string;
};

export type CarrierAddressIds = {
  provinceId: string;
  provinceName: string;
  districtId: string;
  districtName: string;
  wardId: string;
  wardName: string;
};

export type MasterMatchResult = {
  vn: {
    province: NamedId | null;
    district: NamedId | null;
    ward: NamedId | null;
  };
  ghn: CarrierAddressIds | null;
  spx: CarrierAddressIds | null;
};

type NamedUnit = { name: string; code?: string | number; id?: string | number };

const GHN_BASE =
  String(process.env.GHN_API_URL || "").trim() ||
  "https://online-gateway.ghn.vn/shiip/public-api";
const GHN_TIMEOUT_MS = 10_000;
const GHN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const ALIASES: Record<string, string> = {
  hcm: "ho chi minh",
  tphcm: "ho chi minh",
  "tp hcm": "ho chi minh",
  "tp ho chi minh": "ho chi minh",
  "sai gon": "ho chi minh",
  hn: "ha noi",
  "tp ha noi": "ha noi",
  dn: "da nang",
  "tp da nang": "da nang",
};

type GhnCache = {
  at: number;
  provinces: NamedUnit[];
  districts: Map<string, NamedUnit[]>;
  wards: Map<string, NamedUnit[]>;
};

let ghnCache: GhnCache | null = null;

function normalizeVnName(s: string): string {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchNamedUnit<T extends NamedUnit>(list: T[], query: string): T | undefined {
  if (!query?.trim() || !list.length) return undefined;

  const raw = normalizeVnName(query);
  const expanded = ALIASES[raw] || raw;

  const score = (name: string): number => {
    const n = normalizeVnName(name);
    if (n === expanded || n === raw) return 100;
    if (n.includes(expanded) || expanded.includes(n)) return 80;
    const stripped = n.replace(
      /^(tinh|thanh pho|tp|quan|huyen|thi xa|phuong|xa|thi tran)\s+/,
      "",
    );
    const qStripped = expanded.replace(
      /^(tinh|thanh pho|tp|quan|huyen|thi xa|phuong|xa|thi tran)\s+/,
      "",
    );
    if (stripped === qStripped || stripped === expanded || qStripped === n) return 70;
    if (stripped.includes(qStripped) || qStripped.includes(stripped)) return 60;
    return 0;
  };

  let best: T | undefined;
  let bestScore = 0;
  for (const item of list) {
    const s = score(item.name);
    if (s > bestScore) {
      bestScore = s;
      best = item;
    }
  }
  return bestScore >= 60 ? best : undefined;
}

function toNamedId(unit: NamedUnit | undefined | null): NamedId | null {
  if (!unit) return null;
  const id = String(unit.code ?? unit.id ?? "").trim();
  const name = String(unit.name || "").trim();
  if (!id || !name) return null;
  return { id, name };
}

function readGhnToken(): string {
  return String(process.env.GHN_TOKEN || process.env.GHN_API_TOKEN || "").trim();
}

function getGhnCache(): GhnCache {
  const now = Date.now();
  if (!ghnCache || now - ghnCache.at > GHN_CACHE_TTL_MS) {
    ghnCache = { at: now, provinces: [], districts: new Map(), wards: new Map() };
  }
  return ghnCache;
}

async function ghnFetch(path: string, query?: Record<string, string | number>): Promise<any[] | null> {
  const token = readGhnToken();
  if (!token) return null;

  const url = new URL(`${GHN_BASE}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GHN_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Token: token,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[GHN Master] ${path} HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    const data = json?.data;
    return Array.isArray(data) ? data : null;
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.warn(`[GHN Master] ${path} timeout`);
    } else {
      console.warn(`[GHN Master] ${path}:`, err?.message || err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadGhnProvinces(): Promise<NamedUnit[]> {
  const cache = getGhnCache();
  if (cache.provinces.length) return cache.provinces;
  const rows = await ghnFetch("/master-data/province");
  cache.provinces = (rows || []).map((p) => ({
    name: String(p.ProvinceName || p.province_name || ""),
    id: p.ProvinceID ?? p.province_id,
    code: p.ProvinceID ?? p.province_id,
  }));
  return cache.provinces;
}

async function loadGhnDistricts(provinceId: string): Promise<NamedUnit[]> {
  if (!provinceId) return [];
  const cache = getGhnCache();
  if (cache.districts.has(provinceId)) return cache.districts.get(provinceId) || [];
  const rows = await ghnFetch("/master-data/district", { province_id: Number(provinceId) || provinceId });
  const list = (rows || [])
    .filter((d) => String(d.ProvinceID ?? d.province_id ?? "") === String(provinceId))
    .map((d) => ({
      name: String(d.DistrictName || d.district_name || ""),
      id: d.DistrictID ?? d.district_id,
      code: d.DistrictID ?? d.district_id,
    }));
  cache.districts.set(provinceId, list);
  return list;
}

async function loadGhnWards(districtId: string): Promise<NamedUnit[]> {
  if (!districtId) return [];
  const cache = getGhnCache();
  if (cache.wards.has(districtId)) return cache.wards.get(districtId) || [];
  const rows = await ghnFetch("/master-data/ward", { district_id: Number(districtId) || districtId });
  const list = (rows || []).map((w) => ({
    name: String(w.WardName || w.ward_name || ""),
    id: w.WardCode ?? w.ward_code ?? w.WardID ?? w.ward_id,
    code: w.WardCode ?? w.ward_code ?? w.WardID ?? w.ward_id,
  }));
  cache.wards.set(districtId, list);
  return list;
}

function toCarrierIds(
  province: NamedId | null,
  district: NamedId | null,
  ward: NamedId | null,
): CarrierAddressIds | null {
  if (!province) return null;
  return {
    provinceId: province.id,
    provinceName: province.name,
    districtId: district?.id || "",
    districtName: district?.name || "",
    wardId: ward?.id || "",
    wardName: ward?.name || "",
  };
}

async function matchGhn(
  provinceName: string,
  districtName: string,
  wardName: string,
): Promise<CarrierAddressIds | null> {
  if (!readGhnToken()) return null;
  try {
    const provinces = await loadGhnProvinces();
    const province = toNamedId(matchNamedUnit(provinces, provinceName));
    if (!province) return null;

    const districts = await loadGhnDistricts(province.id);
    const district = toNamedId(matchNamedUnit(districts, districtName));

    let ward: NamedId | null = null;
    if (district) {
      const wards = await loadGhnWards(district.id);
      ward = toNamedId(matchNamedUnit(wards, wardName));
    }
    return toCarrierIds(province, district, ward);
  } catch (err: any) {
    console.warn("[GHN Master] match failed:", err?.message || err);
    return null;
  }
}

/**
 * Đối chiếu JSON Gemini với master data (cache in-memory).
 */
export async function matchParsedAddressToMaster(parsed: {
  province?: string;
  district?: string;
  ward?: string;
}): Promise<MasterMatchResult> {
  const provinceName = String(parsed?.province || "").trim();
  const districtName = String(parsed?.district || "").trim();
  const wardName = String(parsed?.ward || "").trim();

  const empty: MasterMatchResult = {
    vn: { province: null, district: null, ward: null },
    ghn: null,
    spx: null,
  };

  try {
    const provinces = await listVnProvinces();
    const province = toNamedId(matchNamedUnit(provinces, provinceName));
    let district: NamedId | null = null;
    let ward: NamedId | null = null;

    if (province) {
      const districts = await listVnDistricts(province.id);
      district = toNamedId(matchNamedUnit(districts, districtName));
      if (district) {
        const wards = await listVnWards(district.id);
        ward = toNamedId(matchNamedUnit(wards, wardName));
      }
    }

    const vn = { province, district, ward };
    const spx = toCarrierIds(province, district, ward);
    const ghn = await matchGhn(provinceName, districtName, wardName);

    return { vn, ghn, spx };
  } catch (err: any) {
    console.warn("[Address Master] match failed:", err?.message || err);
    return empty;
  }
}
