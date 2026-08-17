/**
 * Chạy trên cPanel (Application root):
 *   node where-am-i.cjs
 *
 * In ra đường dẫn tuyệt đối Node đang đứng + chỗ serve frontend.
 * Đồng thời ghi file DEPLOY_PATH_MARKER.txt để tìm trong File Manager.
 */
const fs = require("fs");
const path = require("path");

const cwd = process.cwd();
const dirname = __dirname;
const passengerRoot = String(process.env.PASSENGER_APP_ROOT || "").trim();

const candidates = [passengerRoot, dirname, cwd].filter(Boolean);
function looksLikeAppRoot(abs) {
  return (
    fs.existsSync(path.join(abs, "server.cjs")) ||
    fs.existsSync(path.join(abs, ".htaccess")) ||
    fs.existsSync(path.join(abs, "data")) ||
    fs.existsSync(path.join(abs, ".env"))
  );
}
const appRoot =
  candidates.map((c) => path.resolve(c)).find(looksLikeAppRoot) || path.resolve(cwd);

const distDir = path.join(appRoot, "dist");
const publicDir = path.join(appRoot, "public");

const indexCandidates = [
  path.join(distDir, "index.html"),
  path.join(appRoot, "index.html"),
  path.join(publicDir, "index.html"),
  path.join(cwd, "index.html"),
  path.join(cwd, "dist", "index.html"),
];

function peekIndex(file) {
  if (!fs.existsSync(file)) return { exists: false };
  const raw = fs.readFileSync(file, "utf8");
  const scripts = [...raw.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
  const css = [...raw.matchAll(/href="([^"]+\.css)"/g)].map((m) => m[1]);
  return {
    exists: true,
    bytes: raw.length,
    mtime: fs.statSync(file).mtime.toISOString(),
    scripts,
    css,
    hasV2: raw.includes("Bảng Điều Khiển Tổng Quan (V2)") || raw.includes("(V2)"),
  };
}

const report = {
  cwd,
  __dirname: dirname,
  PASSENGER_APP_ROOT: passengerRoot || "(empty)",
  NODE_ENV: process.env.NODE_ENV || "(empty)",
  appRoot_resolved: appRoot,
  frontend_static_dir: distDir,
  frontend_index_that_node_serves: path.join(distDir, "index.html"),
  dist_exists: fs.existsSync(distDir),
  server_cjs_at_app_root: fs.existsSync(path.join(appRoot, "server.cjs")),
  index_files: Object.fromEntries(indexCandidates.map((p) => [p, peekIndex(p)])),
  hint:
    "Up đè FILE FRONTEND vào dist/ (index.html + dist/assets/*). Sửa index.html ở root hoặc public/ sẽ KHÔNG đổi web.",
};

console.log("========== WHERE AM I ==========");
console.log(JSON.stringify(report, null, 2));
console.log("================================");

const marker = [
  "THU MUC THAT CUA FRONTEND (express.static):",
  distDir,
  "",
  "FILE HTML NODE DANG SEND:",
  path.join(distDir, "index.html"),
  "",
  JSON.stringify(report, null, 2),
].join("\n");

for (const dir of [cwd, dirname, appRoot, distDir]) {
  try {
    if (!fs.existsSync(dir)) continue;
    const out = path.join(dir, "DEPLOY_PATH_MARKER.txt");
    fs.writeFileSync(out, marker, "utf8");
    console.log("Wrote marker:", out);
  } catch (err) {
    console.warn("Cannot write marker in", dir, err.message);
  }
}
