import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const JOURNAL = ".import-batch-journal.json";
const TARGETS = new Set(["products.json", "imports.json", "suppliers.json"]);
const POS_TARGETS = new Set(["products.json", "pos-stock-edits.json"]);
const digest = (text) => crypto.createHash("sha256").update(text).digest("hex");

export function withImportBatchFileLock(dataDir, work) {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, ".import-batch.lock");
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
        // Another worker may have just created the file, before writing its PID.
        alive = Date.now() - fs.statSync(lockPath).mtimeMs < 30_000;
      }
      if (!alive && attempt === 0) {
        try { fs.unlinkSync(lockPath); } catch (remove) { if (remove.code !== "ENOENT") throw remove; }
        continue;
      }
      throw Object.assign(new Error("import_batch_busy_retry_same_batch"), { code: "IMPORT_COMMIT_PENDING" });
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

// A durable journal lets the next request finish a commit interrupted by a restart.
// Synchronous work plus a file lock serialize imports across Node workers.
export function recoverImportBatchFiles(dataDir) {
  const journalPath = path.join(dataDir, JOURNAL);
  if (!fs.existsSync(journalPath)) return false;
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const targets = journal.version === 2 ? POS_TARGETS : TARGETS;
  if (![1, 2].includes(journal.version) || !Array.isArray(journal.files) || journal.files.length !== targets.size) {
    throw new Error("invalid_import_commit_journal");
  }
  const seen = new Set();
  for (const file of journal.files) {
    if (!targets.has(file.target) || seen.has(file.target) ||
        !new RegExp(`^\\.import-[a-f0-9-]+-${file.target.replace(".", "\\.")}\\.tmp$`).test(file.staged) ||
        !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error("invalid_import_commit_path");
    }
    seen.add(file.target);
  }
  for (const file of journal.files) {
    const staged = path.join(dataDir, file.staged);
    const target = path.join(dataDir, file.target);
    if (fs.existsSync(staged)) {
      if (digest(fs.readFileSync(staged)) !== file.sha256) throw new Error("import_stage_corrupted");
      try { fs.renameSync(staged, target); } catch (error) {
        // A reader in another worker may have finished the same recovery.
        if (error.code !== "ENOENT" || !fs.existsSync(target) || digest(fs.readFileSync(target)) !== file.sha256) throw error;
      }
    } else if (!fs.existsSync(target) || digest(fs.readFileSync(target)) !== file.sha256) {
      throw new Error("import_stage_missing");
    }
  }
  try { fs.unlinkSync(journalPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  return true;
}

export function commitImportBatchFiles(dataDir, values) {
  commitInventoryFiles(dataDir, values, TARGETS, 1);
}

export function commitPosStockEditFiles(dataDir, values) {
  commitInventoryFiles(dataDir, values, POS_TARGETS, 2);
}

function commitInventoryFiles(dataDir, values, targets, version) {
  fs.mkdirSync(dataDir, { recursive: true });
  recoverImportBatchFiles(dataDir);
  const id = crypto.randomUUID();
  const journalPath = path.join(dataDir, JOURNAL);
  const journalTemp = path.join(dataDir, `.import-${id}-journal.tmp`);
  const files = [];
  let journalWritten = false;
  try {
    for (const target of targets) {
      if (!Array.isArray(values[target])) throw new Error("invalid_import_commit_data");
      const text = JSON.stringify(values[target]);
      const staged = `.import-${id}-${target}.tmp`;
      files.push({ target, staged, sha256: digest(text) });
      fs.writeFileSync(path.join(dataDir, staged), text, { encoding: "utf8", flush: true });
    }
    fs.writeFileSync(journalTemp, JSON.stringify({ version, files }), { encoding: "utf8", flush: true });
    fs.renameSync(journalTemp, journalPath);
    journalWritten = true;
    recoverImportBatchFiles(dataDir);
  } catch (error) {
    if (journalWritten) {
      try {
        recoverImportBatchFiles(dataDir);
        return;
      } catch (recoveryError) {
        const pending = new Error("import_commit_pending_retry_same_batch", { cause: recoveryError });
        pending.code = "IMPORT_COMMIT_PENDING";
        throw pending;
      }
    }
    for (const file of [...files.map((f) => path.join(dataDir, f.staged)), journalTemp]) {
      try { fs.unlinkSync(file); } catch { /* uncommitted scratch file */ }
    }
    throw error;
  }
}
