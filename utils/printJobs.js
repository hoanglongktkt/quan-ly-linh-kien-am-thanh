import { randomUUID } from 'node:crypto';

/** Short HTTP requests observe bounded background print jobs. PDF stays in label cache. */
export function createPrintJobs({ timeoutMs = 140_000, ttlMs = 10 * 60_000, maxActive = 3 } = {}) {
  const jobs = new Map();
  const prune = () => {
    for (const [id, job] of jobs) {
      if (!job.running && job.finishedAt && Date.now() - job.finishedAt > ttlMs) jobs.delete(id);
    }
  };
  return {
    start(owner, work) {
      prune();
      if ([...jobs.values()].filter((job) => job.running).length >= maxActive || jobs.size >= 100) {
        throw new Error('Hàng đợi in đang đầy. Vui lòng thử lại sau.');
      }
      const id = randomUUID();
      const controller = new AbortController();
      const job = { id, owner, status: 'running', message: 'Đang chờ Shopee tạo PDF vận đơn...', finishedAt: 0 };
      jobs.set(id, job);
      const timer = setTimeout(() => {
        controller.abort(new Error('print_job_timeout'));
        job.status = 'failed';
        job.message = 'Hết thời gian chờ file in. Đơn đã xác nhận được giữ nguyên; hãy bấm In lại.';
        job.finishedAt = Date.now();
      }, timeoutMs);
      timer.unref?.();
      // Do not release capacity while timed-out work is still unwinding.
      job.running = true;
      void Promise.resolve().then(() => work(controller.signal, (message) => {
        if (!job.finishedAt) job.message = message;
      })).then((result) => {
        if (job.finishedAt) return;
        job.status = 'done';
        job.result = result;
      }, (error) => {
        if (job.finishedAt) return;
        job.status = 'failed';
        job.message = String(error?.message || error);
      }).finally(() => {
        clearTimeout(timer);
        job.running = false;
        job.finishedAt ||= Date.now();
      });
      return id;
    },
    get(id, owner) {
      prune();
      const job = jobs.get(id);
      if (!job || job.owner !== owner) return null;
      return { id: job.id, status: job.status, message: job.message, result: job.result };
    },
  };
}
