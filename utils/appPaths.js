import path from "path";
import fs from "fs";

/** Thư mục gốc app — Passenger/cPanel có thể khác process.cwd(). */
export function resolveAppRoot() {
  const candidates = [
    process.env.PASSENGER_APP_ROOT,
    typeof __dirname !== "undefined" ? __dirname : "",
    process.cwd(),
  ]
    .map((c) => String(c || "").trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    const abs = path.resolve(candidate);
    if (
      fs.existsSync(path.join(abs, "server.cjs")) ||
      fs.existsSync(path.join(abs, "data")) ||
      fs.existsSync(path.join(abs, ".htaccess")) ||
      fs.existsSync(path.join(abs, ".env"))
    ) {
      return abs;
    }
  }
  return path.resolve(candidates[0] || process.cwd());
}

const PRODUCTION_APP_URL = "https://quanly.linhkienamthanh.net";

export function resolveAppBaseUrl() {
  const fromEnv = String(process.env.APP_URL || process.env.API_BASE_URL || "").trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production") return PRODUCTION_APP_URL;
  return PRODUCTION_APP_URL;
}
