import React, { useEffect, useState } from 'react';
import { MessageSquare, X } from 'lucide-react';

export interface ChatNotification {
  id: string;
  shopId: number;
  conversationId: string;
  customerName: string;
  snippet: string;
  timestamp: number;
}

interface ChatNotificationPopupProps {
  notification: ChatNotification;
  onClose: (id: string) => void;
  onClick: (conversationId: string) => void;
}

export function ChatNotificationPopup({ notification, onClose, onClick }: ChatNotificationPopupProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);

  useEffect(() => {
    // Slide in animation
    const showTimer = window.setTimeout(() => setIsVisible(true), 10);

    // Auto close sau 8 giây
    const closeTimer = window.setTimeout(() => {
      setIsLeaving(true);
      window.setTimeout(() => onClose(notification.id), 300);
    }, 8000);

    return () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(closeTimer);
    };
  }, [notification.id, onClose]);

  const handleClick = () => {
    onClick(notification.conversationId);
    setIsLeaving(true);
    window.setTimeout(() => onClose(notification.id), 200);
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsLeaving(true);
    window.setTimeout(() => onClose(notification.id), 300);
  };

  return (
    <div
      onClick={handleClick}
      className={`
        group relative mb-3 w-80 cursor-pointer overflow-hidden rounded-xl
        border border-blue-200 bg-white shadow-lg
        transition-all duration-300 ease-out
        hover:scale-105 hover:shadow-xl
        ${isVisible && !isLeaving ? 'translate-x-0 opacity-100' : 'translate-x-[120%] opacity-0'}
      `}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') handleClick();
        if (e.key === 'Escape') handleClose(e as unknown as React.MouseEvent);
      }}
    >
      {/* Progress bar */}
      <div className="absolute left-0 top-0 h-1 w-full overflow-hidden bg-blue-100">
        <div
          className="h-full bg-gradient-to-r from-blue-500 to-blue-600"
          style={{
            animation: 'progressShrink 8s linear forwards',
          }}
        />
      </div>

      <div className="flex items-start gap-3 p-4">
        {/* Icon */}
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-600 shadow-md">
          <MessageSquare className="h-5 w-5 text-white" />
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center justify-between gap-2">
            <h4 className="truncate text-sm font-extrabold text-slate-900">
              {notification.customerName || 'Khách hàng'}
            </h4>
            <button
              onClick={handleClose}
              className="shrink-0 rounded-lg p-1 text-slate-400 opacity-0 transition-all hover:bg-slate-100 hover:text-slate-600 group-hover:opacity-100"
              aria-label="Đóng"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="line-clamp-2 text-xs leading-relaxed text-slate-600">
            {notification.snippet || 'Tin nhắn mới'}
          </p>
          <p className="mt-1 text-[10px] font-semibold text-blue-600">
            Nhấn để xem tin nhắn →
          </p>
        </div>
      </div>

      {/* Hover gradient border effect */}
      <div className="pointer-events-none absolute inset-0 rounded-xl opacity-0 transition-opacity group-hover:opacity-100">
        <div className="absolute inset-0 rounded-xl bg-gradient-to-br from-blue-400/20 to-purple-400/20" />
      </div>

      <style>{`
        @keyframes progressShrink {
          from { width: 100%; }
          to { width: 0%; }
        }
      `}</style>
    </div>
  );
}

interface ChatNotificationContainerProps {
  notifications: ChatNotification[];
  onClose: (id: string) => void;
  onClick: (conversationId: string) => void;
}

export function ChatNotificationContainer({
  notifications,
  onClose,
  onClick,
}: ChatNotificationContainerProps) {
  if (notifications.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-[100] flex items-end justify-end p-4 md:p-6">
      <div className="pointer-events-auto flex max-h-[80vh] w-80 flex-col-reverse overflow-y-auto">
        {notifications.slice(0, 3).map((notification) => (
          <ChatNotificationPopup
            key={notification.id}
            notification={notification}
            onClose={onClose}
            onClick={onClick}
          />
        ))}
      </div>
    </div>
  );
}
