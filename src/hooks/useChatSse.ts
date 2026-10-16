import { useEffect, useRef, useCallback } from 'react';

type SseEventType = 'connected' | 'ping' | 'new_message' | 'conversation_read' | 'close';

interface SseEvent {
  type: SseEventType;
  data: Record<string, unknown>;
}

interface UseChatSseOptions {
  shopId?: string;
  enabled?: boolean;
  onNewMessage?: (data: {
    shop_id: number;
    conversation_id: string;
    message_id: string;
    sender_type: string;
    snippet: string;
  }) => void;
  onConversationRead?: (data: {
    shop_id: number;
    conversation_id: string;
    unread_count: number;
  }) => void;
  onConnected?: () => void;
  onError?: (error: Error) => void;
}

/**
 * Hook SSE để nhận tin nhắn chat real-time.
 * Tự động reconnect khi mất kết nối, giới hạn retry để tránh quá tải server.
 */
export function useChatSse(options: UseChatSseOptions) {
  const {
    shopId,
    enabled = true,
    onNewMessage,
    onConversationRead,
    onConnected,
    onError,
  } = options;

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const unmountedRef = useRef(false);

  // Dùng ref để tránh TDZ - callbacks luôn dùng giá trị mới nhất mà không cần dependencies
  const callbacksRef = useRef({ onNewMessage, onConversationRead, onConnected, onError });
  callbacksRef.current = { onNewMessage, onConversationRead, onConnected, onError };

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    reconnectAttemptsRef.current = 0;
  }, []);

  const connect = useCallback(() => {
    if (!enabled || unmountedRef.current) return;
    if (eventSourceRef.current) return;

    const token = localStorage.getItem('admin_token');
    if (!token) return;

    try {
      const params = new URLSearchParams();
      if (shopId) params.set('shop_id', shopId);
      const url = `/api/chat/sse?${params.toString()}`;

      // EventSource không hỗ trợ custom headers → dùng token trong URL (chỉ cho SSE)
      const urlWithAuth = `${url}&token=${encodeURIComponent(token)}`;
      const es = new EventSource(urlWithAuth);
      eventSourceRef.current = es;

      es.addEventListener('connected', () => {
        reconnectAttemptsRef.current = 0;
        callbacksRef.current.onConnected?.();
      });

      es.addEventListener('new_message', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          callbacksRef.current.onNewMessage?.(data);
        } catch (err) {
          console.warn('[Chat SSE] parse new_message error', err);
        }
      });

      es.addEventListener('conversation_read', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          callbacksRef.current.onConversationRead?.(data);
        } catch (err) {
          console.warn('[Chat SSE] parse conversation_read error', err);
        }
      });

      es.addEventListener('close', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          console.log('[Chat SSE] server closed', data.reason);
          disconnect();
        } catch {
          disconnect();
        }
      });

      es.onerror = () => {
        const attempts = reconnectAttemptsRef.current;
        // Giới hạn retry: tối đa 5 lần, backoff 2s → 4s → 8s → 16s → 30s
        if (attempts >= 5) {
          const err = new Error('SSE reconnect failed after 5 attempts');
          callbacksRef.current.onError?.(err);
          disconnect();
          return;
        }

        disconnect();

        const delayMs = Math.min(30_000, 2000 * 2 ** attempts);
        reconnectAttemptsRef.current = attempts + 1;
        reconnectTimerRef.current = window.setTimeout(() => {
          if (!unmountedRef.current && enabled) {
            connect();
          }
        }, delayMs);
      };
    } catch (err) {
      callbacksRef.current.onError?.(err instanceof Error ? err : new Error('SSE connect failed'));
      disconnect();
    }
  }, [enabled, shopId, disconnect]);

  useEffect(() => {
    unmountedRef.current = false;
    if (enabled) {
      connect();
    }
    return () => {
      unmountedRef.current = true;
      disconnect();
    };
  }, [enabled, connect, disconnect]);

  return { disconnect };
}
