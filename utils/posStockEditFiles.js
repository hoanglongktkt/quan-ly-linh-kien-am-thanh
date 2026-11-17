import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const JOURNAL = ".pos-stock-edit-journal.json";
const TARGETS = new Set(["products.json", "pos-stock-edits.json"]);
const digest = (text) => crypto.createHash("sha256").update(text).digest("hex");

export function withPosStockFileLock(dataDir, work) {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, ".pos-stock-edit.lock");
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      descriptor = fs.openSync(lockPath, "wx");
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let alive = true;
      try {
        const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("invalid_lock_owner");
        try { process.kill(owner.pid, 0); } catch (check) { if (check.code === "ESRCH") alive = false; }
      } catch {
        alive = Date.now() - fs.statSync(lockPath).mtimeMs < 30_000;
      }
      if (!alive && attempt === 0) {
        try { fs.unlinkSync(lockPath); } catch (remove) { if (remove.code !== "ENOENT") throw remove; }
        continue;
      }
      throw Object.assign(new Error("pos_stock_edit_busy_retry_same_revision"), { code: "POS_STOCK_COMMIT_PENDING" });
    }
  }
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
    return work();
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(lockPath);
  }
}

// Journal bền vững để retry hoàn tất cả tồn kho và dấu phiên bản sau khi tiến trình dừng.
export function recoverPosStockEditFiles(dataDir) {
  const journalPath = path.join(dataDir, JOURNAL);
  if (!fs.existsSync(journalPath)) return false;
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  if (journal.version !== 1 || !Array.isArray(journal.files) || journal.files.length !== TARGETS.size) {
    throw new Error("invalid_pos_stock_journal");
  }
  const seen = new Set();
  for (const file of journal.files) {
    if (!TARGETS.has(file.target) || seen.has(file.target) ||
        !new RegExp(`^\\.pos-stock-[a-f0-9-]+-${file.target.replace(".", "\\.")}\\.tmp$`).test(file.staged) ||
        !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error("invalid_pos_stock_path");
    }
    seen.add(file.target);
  }
  for (const file of journal.files) {
    const staged = path.join(dataDir, file.staged);
    const target = path.join(dataDir, file.target);
    if (fs.existsSync(staged)) {
      if (digest(fs.readFileSync(staged)) !== file.sha256) throw new Error("pos_stock_stage_corrupted");
      try { fs.renameSync(staged, target); } catch (error) {
        if (error.code !== "ENOENT" || !fs.existsSync(target) || digest(fs.readFileSync(target)) !== file.sha256) throw error;
      }
    } else if (!fs.existsSync(target) || digest(fs.readFileSync(target)) !== file.sha256) {
      throw new Error("pos_stock_stage_missing");
    }
  }
  try { fs.unlinkSync(journalPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  return true;
}

export function commitPosStockEditFiles(dataDir, values) {
  fs.mkdirSync(dataDir, { recursive: true });
  recoverPosStockEditFiles(dataDir);
  const id = crypto.randomUUID();
  const journalPath = path.join(dataDir, JOURNAL);
  const journalTemp = path.join(dataDir, `.pos-stock-${id}-journal.tmp`);
  const files = [];
  let journalWritten = false;
  try {
    for (const target of TARGETS) {
      if (!Array.isArray(values[target])) throw new Error("invalid_pos_stock_data");
      const text = JSON.stringify(values[target]);
      const staged = `.pos-stock-${id}-${target}.tmp`;
      files.push({ target, staged, sha256: digest(text) });
      fs.writeFileSync(path.join(dataDir, staged), text, { encoding: "utf8", flush: true });
    }
    fs.writeFileSync(journalTemp, JSON.stringify({ version: 1, files }), { encoding: "utf8", flush: true });
    fs.renameSync(journalTemp, journalPath);
    journalWritten = true;
    recoverPosStockEditFiles(dataDir);
  } catch (error) {
    if (journalWritten) {
      try {
        recoverPosStockEditFiles(dataDir);
        return;
      } catch (recoveryError) {
        const pending = new Error("pos_stock_commit_pending_retry_same_revision", { cause: recoveryError });
        pending.code = "POS_STOCK_COMMIT_PENDING";
        throw pending;
      }
    }
    for (const file of [...files.map((f) => path.join(dataDir, f.staged)), journalTemp]) {
      try { fs.unlinkSync(file); } catch (cleanup) { if (cleanup.code !== "ENOENT") console.warn("[POS] Không xóa được file tạm", cleanup.code); }
    }
    throw error;
  }
}
