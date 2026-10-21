import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { parseProcStat, probeWorkerProcess } from "./worker-process-probe.mjs";
import { recordStallDiagnostic, resetStallDiagnosticsDedupeForTest, MAX_STALL_SNAPSHOTS } from "../modules/operations/stallDiagnostics.js";
import { evaluateAndHealWorkerWatchdog } from "./cpanel-worker-watchdog.mjs";

test("proc stat parser handles command names containing spaces and parentheses", () => {
  const fields = Array(50).fill("0");
  fields[0] = "S"; fields[11] = "150"; fields[12] = "25"; fields[19] = "12345";
  assert.deepEqual(parseProcStat(`123 (node (worker) app) ${fields.join(" ")}`),
    { state: "S", cpuTicks: 175, startTicks: 12345 });
  assert.equal(parseProcStat("invalid"), null);
});

test("probe does not inspect a PID belonging to another host", async () => {
  const result = await probeWorkerProcess({ owner: "test", hostname: `${os.hostname()}-other`, pid: process.pid });
  assert.equal(result.sameHost, false);
  assert.equal(result.exists, null);
});

test("probe recognizes its own live process without exposing command or environment", async () => {
  const result = await probeWorkerProcess({ owner: "test", hostname: os.hostname(), pid: process.pid }, { sampleMs: 0 });
  assert.equal(result.exists, true);
  assert.equal(result.probeStatus, "process_exists");
  assert.equal(result.command, undefined);
  assert.equal(result.environment, undefined);
});

test("released locks are not probed", async () => {
  const result = await probeWorkerProcess({ owner: null, hostname: os.hostname(), pid: process.pid });
  assert.equal(result.probeStatus, "no_lock_owner");
  assert.equal(result.exists, null);
});

test("stall diagnostics sanitize sensitive fields and cap stored snapshots", async () => {
  resetStallDiagnosticsDedupeForTest();
  const docs = [];
  let seq = 0;
  const db = {
    collection(name) {
      assert.equal(name, "ops_stall_diagnostics");
      return {
        insertOne: async (doc) => {
          docs.push({ _id: `id-${++seq}`, ...doc });
        },
        find: () => ({
          sort: () => ({
            limit: () => ({
              toArray: async () => [...docs].reverse(),
            }),
          }),
        }),
        deleteMany: async (filter) => {
          const toDelete = new Set(filter._id.$in);
          for (let i = docs.length - 1; i >= 0; i--) {
            if (toDelete.has(docs[i]._id)) docs.splice(i, 1);
          }
        },
      };
    },
  };

  for (let i = 0; i < MAX_STALL_SNAPSHOTS + 5; i++) {
    await recordStallDiagnostic(
      "lock_heartbeat_overdue",
      {
        stage: "starting",
        heartbeatGapMs: 184475,
        error: new Error("access_token=SECRET_TOKEN customer=PRIVATE"),
        lock: {
          owner: `${process.pid}:uuid`,
          pid: process.pid,
          hostname: os.hostname(),
          trigger: "shared_queue",
          acquiredAt: new Date(Date.now() - 200000),
          heartbeatAt: new Date(Date.now() - 184475),
          expiresAt: new Date(Date.now() + 500000),
          secret: "DO_NOT_SAVE",
        },
        runningJobs: [
          {
            kind: "sync",
            priority: 0,
            started_at: new Date(Date.now() - 184475),
            next_run_at: new Date(Date.now() - 1000),
            processing_stage: "starting",
            worker_revision: 5,
            payload: { mode: "task", task: "handed_over", access_token: "SECRET_TOKEN", buyer_name: "PRIVATE_BUYER" },
          },
        ],
        workerProcess: { sameHost: true, pid: process.pid, exists: true, probeStatus: "process_exists" },
      },
      { db, force: true },
    );
  }

  assert.equal(docs.length, MAX_STALL_SNAPSHOTS);
  const serialized = JSON.stringify(docs);
  assert.ok(!serialized.includes("SECRET_TOKEN"));
  assert.ok(!serialized.includes("PRIVATE"));
  assert.ok(!serialized.includes("DO_NOT_SAVE"));
  assert.equal(docs.at(-1).runningJobs[0].task, "handed_over");
  assert.equal(docs.at(-1).runningJobs[0].leaseExpired, true);
});

test("external watchdog records stall snapshot and wakes health endpoint when heartbeat is overdue", async () => {
  resetStallDiagnosticsDedupeForTest();
  const diagnostics = [];
  let wakeCalls = 0;
  const now = new Date("2026-10-21T13:19:55.000Z");
  const lock = {
    owner: "1234:uuid",
    pid: process.pid,
    hostname: os.hostname(),
    trigger: "shared_queue",
    acquiredAt: new Date("2026-10-21T13:13:53.332Z"),
    heartbeatAt: new Date("2026-10-21T13:13:53.332Z"),
    expiresAt: new Date("2026-10-21T13:25:53.332Z"),
  };
  const runningJob = {
    kind: "sync",
    priority: 0,
    started_at: new Date("2026-10-21T13:14:06.013Z"),
    next_run_at: new Date("2026-10-21T13:18:06.013Z"),
    processing_stage: "starting",
    stage_started_at: new Date("2026-10-21T13:14:06.013Z"),
    worker_revision: 5,
    retry_count: 0,
    payload: {},
  };
  const db = {
    collection(name) {
      if (name === "sync_orchestrator_locks") {
        return { findOne: async () => lock };
      }
      if (name === "webhook_jobs") {
        return {
          find: () => ({ limit: () => ({ toArray: async () => [runningJob] }) }),
          findOne: async () => ({ kind: "webhook", received_at: new Date("2026-10-21T13:15:22.055Z") }),
        };
      }
      if (name === "ops_stall_diagnostics") {
        return {
          insertOne: async (doc) => diagnostics.push(doc),
          find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => diagnostics }) }) }),
          deleteMany: async () => {},
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
  };

  const report = await evaluateAndHealWorkerWatchdog({
    db,
    now,
    wakeUrl: "https://quanly.linhkienamthanh.net/api/health/",
    probeFn: async () => ({ sameHost: true, pid: process.pid, exists: true, probeStatus: "process_exists", state: "S", cpuTicksDelta: 0 }),
    fetchFn: async () => {
      wakeCalls++;
      return { ok: true, status: 200 };
    },
  });

  assert.equal(report.runningJobOverdue, true);
  assert.equal(report.stallRecorded, true);
  assert.equal(report.shouldWake, true);
  assert.equal(wakeCalls, 1);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].event, "watchdog_job_overdue");
  assert.equal(diagnostics[0].workerProcess.state, "S");
});

