import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, RefreshCw, Square, X } from 'lucide-react';

export type SyncStatusPayload = {
  success?: boolean;
  isRunning?: boolean;
  syncing?: boolean;
  progress?: string;
  message?: string;
  pulled?: number;
  target?: number | null;
  mode?: 'incremental' | 'full' | string;
  error?: string | null;
  finishedAt?: number | null;
};

type Phase = 'hidden' | 'running' | 'success' | 'error';

type Props = {
  /** Bật widget ngay khi user vừa gửi yêu cầu sync (kể cả khi đã có job đang chạy). */
  active?: boolean;
  onDismiss?: () => void;
  onFinished?: (status: SyncStatusPayload) => void;
  pollIntervalMs?: number;
};

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('admin_token');
  return {
    Authorization: token ? `Bearer ${token}` : '',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };
}

export default function FloatingSyncStatus({
  active = false,
  onDismiss,
  onFinished,
  pollIntervalMs = 2000,
}: Props) {
  const [phase, setPhase] = useState<Phase>('hidden');
  const [status, setStatus] = useState<SyncStatusPayload | null>(null);
  const [stopping, setStopping] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const seenRunningRef = useRef(false);
  const finishedNotifiedRef = useRef(false);

  const clearHideTimer = () => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  const clearPollTimer = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const scheduleHide = useCallback(
    (delayMs: number) => {
      clearHideTimer();
      hideTimerRef.current = setTimeout(() => {
        setPhase('hidden');
        setStatus(null);
        seenRunningRef.current = false;
        finishedNotifiedRef.current = false;
        onDismiss?.();
      }, delayMs);
    },
    [onDismiss],
  );

  const markFinished = useCallback(
    (data: SyncStatusPayload, kind: 'success' | 'error') => {
      if (finishedNotifiedRef.current) return;
      finishedNotifiedRef.current = true;
      clearPollTimer();
      setStatus(data);
      setPhase(kind);
      onFinished?.(data);
      scheduleHide(kind === 'success' ? 1200 : 4500);
    },
    [onFinished, scheduleHide],
  );

  const applyStatus = useCallback(
    (data: SyncStatusPayload) => {
      setStatus(data);
      const running = Boolean(data.isRunning ?? data.syncing);

      if (running) {
        seenRunningRef.current = true;
        finishedNotifiedRef.current = false;
        clearHideTimer();
        setPhase('running');
        return;
      }

      // isRunning: false → LẬP TỨC dừng poll + hiện "Đã đồng bộ xong"
      if (!seenRunningRef.current && !active) {
        clearPollTimer();
        setPhase('hidden');
        return;
      }

      if (data.error) {
        markFinished(
          {
            ...data,
            isRunning: false,
            syncing: false,
            message: data.message || data.error || 'Đồng bộ gặp lỗi',
          },
          'error',
        );
        return;
      }

      markFinished(
        {
          ...data,
          isRunning: false,
          syncing: false,
          message: data.message || 'Đã đồng bộ xong',
        },
        'success',
      );
    },
    [active, markFinished],
  );

  const fetchStatus = useCallback(async () => {
    const token = localStorage.getItem('admin_token');
    if (!token) return;
    try {
      const res = await fetch(`/api/sync/status?t=${Date.now()}`, {
        cache: 'no-store',
        headers: authHeaders(),
      });
      if (!res.ok) return;
      const data = (await res.json()) as SyncStatusPayload;
      applyStatus(data);
    } catch {
      /* bỏ qua lỗi poll tạm thời */
    }
  }, [applyStatus]);

  const handleForceStop = async () => {
    if (stopping) return;
    setStopping(true);
    clearPollTimer();
    try {
      const res = await fetch('/api/sync/force-stop', {
        method: 'POST',
        cache: 'no-store',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      const data = (await res.json().catch(() => ({}))) as SyncStatusPayload;
      markFinished(
        {
          ...data,
          isRunning: false,
          syncing: false,
          message: data.message || 'Đã dừng sync thủ công',
          error: data.message || 'Đã dừng sync thủ công',
        },
        'error',
      );
    } catch (err: any) {
      markFinished(
        {
          isRunning: false,
          message: err?.message || 'Không dừng được sync',
          error: err?.message || 'Không dừng được sync',
        },
        'error',
      );
    } finally {
      setStopping(false);
    }
  };

  useEffect(() => {
    if (active) {
      seenRunningRef.current = true;
      finishedNotifiedRef.current = false;
      clearHideTimer();
      clearPollTimer();
      setPhase('running');
      setStatus((prev) => ({
        ...(prev || {}),
        isRunning: true,
        syncing: true,
        message: prev?.message || 'Tiến trình đồng bộ đang chạy ngầm...',
        progress: prev?.progress || 'Đang khởi tạo đồng bộ...',
      }));
      void fetchStatus();
    }
  }, [active, fetchStatus]);

  // Chỉ poll khi đang chạy — isRunning:false → clearInterval ngay trong markFinished.
  useEffect(() => {
    if (phase !== 'running') {
      clearPollTimer();
      return;
    }
    clearPollTimer();
    pollTimerRef.current = setInterval(() => {
      void fetchStatus();
    }, pollIntervalMs);
    return () => clearPollTimer();
  }, [phase, pollIntervalMs, fetchStatus]);

  useEffect(
    () => () => {
      clearHideTimer();
      clearPollTimer();
    },
    [],
  );

  if (phase === 'hidden') return null;

  const pulled = Number(status?.pulled) || 0;
  const progressText =
    status?.progress ||
    (phase === 'running'
      ? pulled > 0
        ? `Đang đồng bộ ngầm... (${pulled} đơn)`
        : 'Đang đồng bộ ngầm...'
      : '');
  const messageText =
    phase === 'success'
      ? status?.message || `Đã đồng bộ xong${pulled > 0 ? ` (${pulled} đơn)` : ''}`
      : phase === 'error'
        ? status?.error || status?.message || 'Đồng bộ gặp lỗi'
        : status?.message || progressText;

  return (
    <div
      className="pointer-events-auto fixed z-[9999] flex max-w-[min(380px,calc(100vw-2.5rem))] items-start gap-2.5 rounded-xl border border-slate-200/80 bg-white/95 px-3.5 py-2.5 shadow-lg shadow-slate-900/10 backdrop-blur-sm"
      style={{ top: 20, right: 20 }}
      role="status"
      aria-live="polite"
    >
      <div className="mt-0.5 shrink-0">
        {phase === 'running' && <RefreshCw className="h-4 w-4 animate-spin text-blue-600" />}
        {phase === 'success' && <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
        {phase === 'error' && <RefreshCw className="h-4 w-4 text-amber-600" />}
      </div>
      <div className="min-w-0 flex-1">
        <p
          className={`text-[12px] font-bold leading-snug ${
            phase === 'success'
              ? 'text-emerald-700'
              : phase === 'error'
                ? 'text-amber-800'
                : 'text-slate-800'
          }`}
        >
          {phase === 'running'
            ? progressText.startsWith('Đang') ||
              progressText.startsWith('Shop') ||
              progressText.startsWith('Full')
              ? progressText
              : `Đang đồng bộ ngầm... (${pulled} đơn)`
            : messageText}
        </p>
        {phase === 'running' && status?.message && status.message !== progressText && (
          <p className="mt-0.5 truncate text-[10px] font-medium text-slate-500">{status.message}</p>
        )}
        {phase === 'error' && status?.error && (
          <p className="mt-0.5 line-clamp-2 text-[10px] font-medium text-amber-700/90">{status.error}</p>
        )}
        {phase === 'running' && (
          <button
            type="button"
            onClick={() => void handleForceStop()}
            disabled={stopping}
            className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-bold text-rose-700 transition hover:bg-rose-100 disabled:opacity-60"
          >
            <Square className="h-2.5 w-2.5 fill-current" />
            {stopping ? 'Đang dừng...' : 'Dừng sync'}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => {
          clearHideTimer();
          clearPollTimer();
          setPhase('hidden');
          onDismiss?.();
        }}
        className="shrink-0 rounded-md p-0.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
        aria-label="Đóng"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
