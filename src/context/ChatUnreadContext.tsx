import React, { createContext, useContext, useMemo, useState } from 'react';

type ChatUnreadContextValue = {
  totalUnreadCount: number;
  setTotalUnreadCount: (count: number) => void;
};

const ChatUnreadContext = createContext<ChatUnreadContextValue | null>(null);

export function ChatUnreadProvider({ children }: { children: React.ReactNode }) {
  const [totalUnreadCount, setTotalUnreadCount] = useState(0);
  const value = useMemo(
    () => ({ totalUnreadCount, setTotalUnreadCount }),
    [totalUnreadCount],
  );
  return <ChatUnreadContext.Provider value={value}>{children}</ChatUnreadContext.Provider>;
}

export function useChatUnread(): ChatUnreadContextValue {
  const value = useContext(ChatUnreadContext);
  if (value) return value;
  return { totalUnreadCount: 0, setTotalUnreadCount: () => {} };
}
