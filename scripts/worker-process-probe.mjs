// Read only process metadata. Never read command lines, environment or customer data.
import os from "node:os";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export function parseProcStat(raw) {
  // Linux comm may contain spaces and parentheses; fields after its last ')' are fixed.
  const end = raw.lastIndexOf(")");
  if (end < 0) return null;
  const fields = raw.slice(end + 1).trim().split(/\s+/);
  const cpuTicks = Number(fields[11]) + Number(fields[12]);
  const startTicks = Number(fields[19]);
  if (!/^[RSDZTtXxKWPIN]$/.test(fields[0]) || !Number.isFinite(cpuTicks) || !Number.isFinite(startTicks)) return null;
  return { state: fields[0], cpuTicks, startTicks };
}

async function readLinuxProcess(pid) {
  try {
    const stat = parseProcStat(await readFile(`/proc/${pid}/stat`, "utf8"));
    if (!stat) return null;
    let rssMb = null;
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      if (match) rssMb = Math.round(Number(match[1]) / 1024 * 10) / 10;
    } catch { /* /proc restrictions should not hide the liveness result. */ }
    return { ...stat, rssMb };
  } catch { return null; }
}

export async function probeWorkerProcess(lock, { sampleMs = 750 } = {}) {
  const sameHost = typeof lock?.hostname === "string" ? lock.hostname === os.hostname() : null;
  const pid = Number.isInteger(lock?.pid) && lock.pid > 0 ? lock.pid : null;
  const result = { sameHost, pid, exists: null, probeStatus: "not_checked" };
  if (!lock?.owner) return { ...result, probeStatus: "no_lock_owner" };
  if (sameHost !== true || pid === null) return { ...result, probeStatus: "host_or_pid_unavailable" };
  try { process.kill(pid, 0); result.exists = true; result.probeStatus = "process_exists"; }
  catch (error) {
    return { ...result, exists: error?.code === "ESRCH" ? false : null,
      probeStatus: error?.code === "ESRCH" ? "process_not_found" : "permission_or_probe_error" };
  }
  if (process.platform !== "linux") return result;
  const first = await readLinuxProcess(pid);
  if (!first) return { ...result, procMetadataAvailable: false };
  const began = performance.now();
  await delay(Math.max(0, Math.min(2000, sampleMs)));
  const second = await readLinuxProcess(pid);
  const sameProcessDuringSample = second ? second.startTicks === first.startTicks : null;
  return { ...result, procMetadataAvailable: true,
    state: second?.state ?? first.state, rssMb: second?.rssMb ?? first.rssMb,
    sampleElapsedMs: Math.round(performance.now() - began), sameProcessDuringSample,
    cpuTicksDelta: sameProcessDuringSample ? Math.max(0, second.cpuTicks - first.cpuTicks) : null,
    // A positive result is only PID existence, not proof the event loop is responsive.
    observedAt: new Date() };
}
