import { AsyncResource } from "node:async_hooks";

// Caller deadlines never release a running task: its DB operations can still
// finish. Only tasks that have NOT started may be removed after a wait timeout.
export function createSerialWriteQueue() {
  const pending = [];
  const idleWaiters = [];
  let running = false;
  let sequence = 0;
  const timeoutError = (code) => Object.assign(new Error(code), { code });

  async function drain() {
    if (running || !pending.length) return;
    pending.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
    const entry = pending.shift();
    running = true;
    clearTimeout(entry.waitTimer);
    const executionTimer = setTimeout(() => entry.reject(timeoutError("mongo_write_execution_timeout")), entry.executionTimeoutMs);
    try { entry.resolve(await entry.work()); }
    catch (error) { entry.reject(error); }
    finally {
      clearTimeout(executionTimer);
      running = false;
      if (!pending.length) for (const resolve of idleWaiters.splice(0)) resolve();
      queueMicrotask(drain);
    }
  }

  return {
    whenIdle() {
      if (!running && !pending.length) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    enqueue(work, { priority = 0, waitTimeoutMs = 0, executionTimeoutMs = 60000 } = {}) {
      return new Promise((resolve, reject) => {
        const entry = { work: AsyncResource.bind(work), priority, sequence: sequence++, resolve, reject,
          executionTimeoutMs, waitTimer: null };
        if (waitTimeoutMs > 0) entry.waitTimer = setTimeout(() => {
          const position = pending.indexOf(entry);
          if (position < 0) return;
          pending.splice(position, 1);
          reject(timeoutError("mongo_write_queue_wait_timeout"));
        }, waitTimeoutMs);
        pending.push(entry);
        queueMicrotask(drain);
      });
    },
  };
}
