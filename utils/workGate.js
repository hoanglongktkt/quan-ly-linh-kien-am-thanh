/** Bounded, process-wide admission. A running task owns its slot until it settles. */
export function createWorkGate(limit, maxPending = 200) {
  let active = 0;
  const pending = [];
  const drain = () => {
    while (active < limit && pending.length) {
      const job = pending.shift();
      job.signal?.removeEventListener("abort", job.abort);
      if (job.signal?.aborted) { job.reject(job.signal.reason); continue; }
      active++;
      let released = false;
      job.resolve(() => {
        if (released) return;
        released = true;
        active--;
        drain();
      });
    }
  };
  const acquire = (signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    if (pending.length >= maxPending) {
      return reject(Object.assign(new Error("Hang doi dang day, vui long thu lai sau."), { code: "work_queue_full" }));
    }
    const job = { resolve, reject, signal, abort: null };
    job.abort = () => {
      const index = pending.indexOf(job);
      if (index >= 0) pending.splice(index, 1);
      signal.removeEventListener("abort", job.abort);
      reject(signal.reason);
    };
    signal?.addEventListener("abort", job.abort, { once: true });
    pending.push(job);
    drain();
  });
  return {
    acquire,
    async run(work, signal) {
      const release = await acquire(signal);
      try { return await work(); } finally { release(); }
    },
    snapshot: () => ({ active, pending: pending.length, limit, maxPending }),
  };
}

// Conservative defaults for the 3 GB cPanel account; shared by all import paths.
export const shopeeHttpGate = createWorkGate(3, 200);
export const confirmOrderGate = createWorkGate(2, 200);
export const labelBatchGate = createWorkGate(1, 40);
export const pdfMergeGate = createWorkGate(1, 2);

/** Share overlapping batches by key. Failed work is removed so a later call can retry. */
export function createKeyedBatchWork(gate, maxKeys = 1000) {
  const inFlight = new Map();
  return async (keys, worker, signal) => {
    const unique = [...new Set(keys)];
    const owned = unique.filter((key) => !inFlight.has(key));
    if (inFlight.size + owned.length > maxKeys) {
      throw Object.assign(new Error("Hang doi PDF dang day, vui long thu lai sau."), { code: "work_queue_full" });
    }
    if (owned.length) {
      // Reader cancellation must not cancel work shared by other readers.
      const batch = gate.run(() => worker(owned));
      for (const key of owned) {
        const task = batch.then((values) => {
          if (!values.has(key)) throw new Error(`Missing batch result: ${key}`);
          return values.get(key);
        });
        inFlight.set(key, task);
        // Attach both handlers immediately, including when every caller disconnects.
        void task.then(
          () => { if (inFlight.get(key) === task) inFlight.delete(key); },
          () => { if (inFlight.get(key) === task) inFlight.delete(key); },
        );
      }
    }
    const result = Promise.all(unique.map((key) => inFlight.get(key)));
    if (!signal) return result;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) { result.catch(() => {}); reject(signal.reason); return; }
      signal.addEventListener("abort", abort, { once: true });
      void result.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  };
}
