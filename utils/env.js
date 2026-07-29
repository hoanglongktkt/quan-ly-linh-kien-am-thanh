import fs from "fs";
import path from "path";
import { resolveAppRoot } from "./appPaths.js";

const APP_ROOT = resolveAppRoot();
const ENV_PATH = path.join(APP_ROOT, ".env");

/** Ghi/cập nhật biến trong .env và process.env. */
export function updateEnvVar(key, value) {
  let content = "";
  if (fs.existsSync(ENV_PATH)) {
    content = fs.readFileSync(ENV_PATH, "utf-8");
  }
  const regex = new RegExp(`^${key}\\s*=.*$`, "m");
  const line = `${key}=${value}`;
  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    content = (content.trimEnd() ? content.trimEnd() + "\n" : "") + line + "\n";
  }
  fs.writeFileSync(ENV_PATH, content, "utf-8");
  process.env[key] = value;
}

/** Che API key khi trả về client. */
export function maskApiKey(key) {
  if (!key || key.length < 8) return "••••••••";
  return key.slice(0, 4) + "••••" + key.slice(-4);
}

export { ENV_PATH };
