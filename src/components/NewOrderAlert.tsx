import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, BellOff, Loader2 } from 'lucide-react';

const POLL_INTERVAL_MS = 60_000;
const STORAGE_KEY = 'new_order_alert_last_checked';

type CheckNewOrdersResponse = {
  hasNew: boolean;
  count: number;
  latestOrderSn?: string;
  checkedAt: string;
};

interface NewOrderAlertProps {
  enabled: boolean;
  authHeaders: () => Record<string, string>;
  onNewOrders?: (count: number) => void;
}

export function useNewOrderAlert({ enabled, authHeaders, onNewOrders }: NewOrderAlertProps) {
  const lastCheckedRef = useRef<string>(
    localStorage.getItem(STORAGE_KEY) || new Date().toISOString()
  );
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio('/alert.mp3');
      audioRef.current.preload = 'auto';
    }
    return audioRef.current;
  }, []);

  const unlockAudio = useCallback(() => {
    const audio = ensureAudio();
    const prevVolume = audio.volume;
    audio.volume = 0.01;
    const p = audio.play();
    if (p) {
      p.then(() => {
        audio.pause();
        audio.currentTime = 0;
        audio.volume = prevVolume;
      }).catch(() => {
        audio.volume = prevVolume;
      });
    }
  }, [ensureAudio]);

  const playAlert = useCallback(() => {
    const audio = ensureAudio();
    audio.currentTime = 0;
    audio.volume = 1;
    void audio.play().catch(() => {});
  }, [ensureAudio]);

  const showBrowserNotification = useCallback((count: number, orderSn?: string) => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const body =
      count > 1
        ? `Có ${count} đơn hàng mới vừa phát sinh.`
        : orderSn
          ? `Đơn mới: #${orderSn}`
          : 'Có đơn hàng mới vừa phát sinh.';
    try {
      new Notification('Có đơn hàng mới!', {
        body,
        icon: '/logo.png',
        tag: 'new-order-alert',
      });
    } catch {
      /* ignore */
    }
  }, []);

  const checkNewOrders = useCallback(async () => {
    try {
      const since = encodeURIComponent(lastCheckedRef.current);
      const res = await fetch(`/api/check-new-orders?since=${since}`, {
        headers: authHeaders(),
      });
      if (!res.ok) return;
      const data: CheckNewOrdersResponse = await res.json();
      if (data.hasNew) {
        playAlert();
        showBrowserNotification(data.count, data.latestOrderSn);
        onNewOrders?.(data.count);
      }
      if (data.checkedAt) {
        lastCheckedRef.current = data.checkedAt;
        localStorage.setItem(STORAGE_KEY, data.checkedAt);
      }
    } catch {
      /* ignore polling errors */
    }
  }, [authHeaders, onNewOrders, playAlert, showBrowserNotification]);

  useEffect(() => {
    if (!enabled) {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      return;
    }

    void checkNewOrders();
    pollingRef.current = setInterval(() => void checkNewOrders(), POLL_INTERVAL_MS);
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [enabled, checkNewOrders]);

  return { unlockAudio, resetBaseline: () => {
    const now = new Date().toISOString();
    lastCheckedRef.current = now;
    localStorage.setItem(STORAGE_KEY, now);
  } };
}

export default function NewOrderAlertButton({
  authHeaders,
  onNewOrders,
}: {
  authHeaders: () => Record<string, string>;
  onNewOrders?: (count: number) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [activating, setActivating] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied'
  );

  const { unlockAudio, resetBaseline } = useNewOrderAlert({
    enabled,
    authHeaders,
    onNewOrders,
  });

  const handleEnable = async () => {
    setActivating(true);
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        const result = await Notification.requestPermission();
        setPermission(result);
      } else if (typeof Notification !== 'undefined') {
        setPermission(Notification.permission);
      }

      if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
        const ok = window.confirm(
          'Thông báo trình duyệt đang bị chặn. Bạn vẫn muốn bật cảnh báo âm thanh khi có đơn mới?'
        );
        if (!ok) return;
      }

      unlockAudio();
      resetBaseline();
      setEnabled(true);
    } finally {
      setActivating(false);
    }
  };

  if (enabled) {
    return (
      <div className="flex items-center gap-1.5 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-xl text-xs font-bold text-emerald-700">
        <Bell className="w-3.5 h-3.5" />
        <span className="max-md:hidden">Đang theo dõi đơn mới</span>
        <span className="md:hidden">Đang bật</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={handleEnable}
      disabled={activating}
      className="flex items-center gap-1.5 bg-amber-50 hover:bg-amber-100 border border-amber-200 px-3 py-1.5 rounded-xl text-xs font-bold text-amber-800 transition-colors"
    >
      {activating ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : permission === 'denied' ? (
        <BellOff className="w-3.5 h-3.5" />
      ) : (
        <Bell className="w-3.5 h-3.5" />
      )}
      <span>Bật thông báo</span>
    </button>
  );
}
