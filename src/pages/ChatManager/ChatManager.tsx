import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, MessageSquare, Plus, Send, X, Zap } from 'lucide-react';
import { apiFetch, parseJsonResponse } from '../../utils/apiClient';

type ChatFilter = 'all' | 'unread';

interface ShopOption {
  platform: string;
  shopId: string;
  shopName: string;
}

interface ConversationRow {
  shop_id: number;
  conversation_id: string;
  customer_id?: string | number;
  customer_name?: string;
  customer_avatar?: string;
  unread_count?: number;
  latest_message_snippet?: string;
  last_updated_at?: string;
}

interface MessageRow {
  conversation_id?: string;
  message_id?: string;
  sender_type?: string;
  content?: unknown;
  created_at?: string;
}

interface QuickReplyRow {
  _id?: string;
  shortcut: string;
  content: string;
}

interface ChatManagerProps {
  shops?: ShopOption[];
}

const POLL_MS = 20_000;

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('admin_token');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function messageText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'object') {
    const row = content as Record<string, unknown>;
    const text = row.text || row.content || row.caption;
    if (text) return String(text);
    if (row.image_url || row.imageUrl || row.url || row.image) return '[Hình ảnh]';
    if (row.sticker || row.sticker_id) return '[Sticker]';
    if (row.order_sn || row.ordersn) return '[Đơn hàng]';
  }
  return '';
}

function formatTime(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return `${parts[0].slice(0, 1)}${parts[parts.length - 1].slice(0, 1)}`.toUpperCase();
}

export default function ChatManager({ shops = [] }: ChatManagerProps) {
  const shopeeShops = useMemo(
    () => shops.filter((shop) => shop.platform === 'shopee' && String(shop.shopId || '').trim()),
    [shops],
  );
  const [shopId, setShopId] = useState('');
  const [filter, setFilter] = useState<ChatFilter>('all');
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [quickReplies, setQuickReplies] = useState<QuickReplyRow[]>([]);
  const [draft, setDraft] = useState('');
  const [listLoading, setListLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [quickOpen, setQuickOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [newShortcut, setNewShortcut] = useState('');
  const [newContent, setNewContent] = useState('');
  const [savingReply, setSavingReply] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listFlight = useRef(false);

  const shopNameOf = useCallback(
    (id: number) => shopeeShops.find((shop) => String(shop.shopId) === String(id))?.shopName || `Shop ${id}`,
    [shopeeShops],
  );

  const unreadTotal = useMemo(
    () => conversations.reduce((sum, row) => sum + Math.max(0, Number(row.unread_count) || 0), 0),
    [conversations],
  );

  const active = conversations.find((row) => row.conversation_id === selectedId) ?? null;

  const loadConversations = useCallback(async () => {
    if (listFlight.current) return;
    listFlight.current = true;
    setListLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('filter', filter);
      if (shopId) params.set('shop_id', shopId);
      const response = await apiFetch(`/api/chat/conversations?${params.toString()}`, {
        headers: authHeaders(),
      });
      const data = await parseJsonResponse<{ success?: boolean; conversations?: ConversationRow[]; error?: string }>(response);
      if (!response.ok || data.success === false) {
        throw new Error(data.error || 'Không tải được hội thoại');
      }
      const rows = Array.isArray(data.conversations) ? data.conversations : [];
      setConversations(rows);
      setSelectedId((current) => {
        if (current && rows.some((row) => row.conversation_id === current)) return current;
        return rows[0]?.conversation_id || '';
      });
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không tải được hội thoại');
      setConversations([]);
    } finally {
      listFlight.current = false;
      setListLoading(false);
    }
  }, [filter, shopId]);

  const loadMessages = useCallback(async (conversationId: string) => {
    if (!conversationId) {
      setMessages([]);
      return;
    }
    setMessagesLoading(true);
    try {
      const response = await apiFetch(`/api/chat/messages/${encodeURIComponent(conversationId)}`, {
        headers: authHeaders(),
      });
      const data = await parseJsonResponse<{ success?: boolean; messages?: MessageRow[]; error?: string }>(response);
      if (!response.ok || data.success === false) {
        throw new Error(data.error || 'Không tải được tin nhắn');
      }
      setMessages(Array.isArray(data.messages) ? data.messages : []);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không tải được tin nhắn');
      setMessages([]);
    } finally {
      setMessagesLoading(false);
    }
  }, []);

  const loadQuickReplies = useCallback(async () => {
    try {
      const response = await apiFetch('/api/chat/quick-replies', { headers: authHeaders() });
      const data = await parseJsonResponse<{ success?: boolean; quickReplies?: QuickReplyRow[]; error?: string }>(response);
      if (!response.ok || data.success === false) {
        throw new Error(data.error || 'Không tải được tin nhắn nhanh');
      }
      setQuickReplies(Array.isArray(data.quickReplies) ? data.quickReplies : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không tải được tin nhắn nhanh');
    }
  }, []);

  useEffect(() => {
    void loadConversations();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void loadConversations();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadConversations]);

  useEffect(() => {
    void loadMessages(selectedId);
    if (!selectedId) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void loadMessages(selectedId);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [selectedId, loadMessages]);

  useEffect(() => {
    void loadQuickReplies();
  }, [loadQuickReplies]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, selectedId]);

  const sendText = async (raw: string) => {
    const text = raw.trim();
    if (!text || !active || sending) return;
    setSending(true);
    setError('');
    try {
      const response = await apiFetch('/api/chat/send', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          conversation_id: active.conversation_id,
          shop_id: active.shop_id,
          content: text,
          sender_type: 'shop',
        }),
      });
      const data = await parseJsonResponse<{ success?: boolean; error?: string; message?: MessageRow }>(response);
      if (!response.ok || data.success === false) {
        throw new Error(data.error || 'Không gửi được tin nhắn');
      }
      setDraft('');
      setQuickOpen(false);
      setConversations((prev) =>
        prev.map((row) =>
          row.conversation_id === active.conversation_id
            ? {
                ...row,
                unread_count: 0,
                latest_message_snippet: text,
                last_updated_at: new Date().toISOString(),
              }
            : row,
        ),
      );
      if (data.message) {
        setMessages((prev) => [...prev, data.message as MessageRow]);
      } else {
        await loadMessages(active.conversation_id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không gửi được tin nhắn');
    } finally {
      setSending(false);
    }
  };

  const saveQuickReply = async () => {
    const shortcut = newShortcut.trim();
    const content = newContent.trim();
    if (!shortcut || !content || savingReply) return;
    setSavingReply(true);
    setError('');
    try {
      const response = await apiFetch('/api/chat/quick-replies', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ shortcut, content }),
      });
      const data = await parseJsonResponse<{ success?: boolean; error?: string; quickReply?: QuickReplyRow }>(response);
      if (!response.ok || data.success === false) {
        throw new Error(data.error || 'Không lưu được tin nhắn nhanh');
      }
      setNewShortcut('');
      setNewContent('');
      setComposerOpen(false);
      await loadQuickReplies();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không lưu được tin nhắn nhanh');
    } finally {
      setSavingReply(false);
    }
  };

  const customerLabel = active?.customer_name?.trim() || 'Khách hàng';

  return (
    <div className="flex h-[calc(100dvh-13.5rem)] min-h-[520px] md:h-[calc(100dvh-11rem)] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      <aside className="flex w-[30%] min-w-0 flex-col border-r border-gray-200 bg-slate-50/80">
        <div className="shrink-0 border-b border-gray-200 bg-white p-3">
          <div className="mb-2 flex items-center gap-2 text-slate-800">
            <MessageSquare className="h-4 w-4 shrink-0 text-blue-600" />
            <p className="text-xs font-extrabold tracking-wide">Hội thoại</p>
            <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-black text-white tabular-nums">
              {unreadTotal}
            </span>
          </div>
          {shopeeShops.length > 0 && (
            <select
              value={shopId}
              onChange={(event) => setShopId(event.target.value)}
              className="mb-2 w-full rounded-lg border border-gray-200 bg-slate-50 px-2 py-2 text-[11px] font-semibold text-slate-700 outline-none focus:border-blue-400"
            >
              <option value="">Tất cả shop</option>
              {shopeeShops.map((shop) => (
                <option key={shop.shopId} value={shop.shopId}>
                  {shop.shopName || shop.shopId}
                </option>
              ))}
            </select>
          )}
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setFilter('all')}
              className={`rounded-lg px-2 py-2 text-[11px] font-bold leading-tight transition-all ${
                filter === 'all' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              Tất cả tin nhắn
            </button>
            <button
              type="button"
              onClick={() => setFilter('unread')}
              className={`rounded-lg px-2 py-2 text-[11px] font-bold leading-tight transition-all ${
                filter === 'unread' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              Chưa trả lời
              {unreadTotal > 0 && (
                <span className="ml-1 inline-flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-black text-white">
                  {unreadTotal}
                </span>
              )}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {listLoading && conversations.length === 0 ? (
            <p className="flex items-center justify-center gap-2 px-4 py-8 text-xs font-semibold text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Đang tải hội thoại...
            </p>
          ) : conversations.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs font-semibold text-slate-400">
              {filter === 'unread' ? 'Không có tin chưa trả lời.' : 'Chưa có hội thoại.'}
            </p>
          ) : (
            conversations.map((item) => {
              const selected = active?.conversation_id === item.conversation_id;
              const name = item.customer_name?.trim() || 'Khách hàng';
              const unread = Number(item.unread_count) > 0;
              return (
                <button
                  key={`${item.shop_id}-${item.conversation_id}`}
                  type="button"
                  onClick={() => setSelectedId(item.conversation_id)}
                  className={`flex w-full items-start gap-2.5 border-b border-gray-100 px-3 py-3 text-left transition-colors ${
                    selected ? 'bg-blue-50' : 'bg-white hover:bg-slate-50'
                  }`}
                >
                  {item.customer_avatar ? (
                    <img src={item.customer_avatar} alt="" className="mt-0.5 h-9 w-9 shrink-0 rounded-full object-cover" />
                  ) : (
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-orange-500 text-[11px] font-extrabold text-white">
                      {initials(name)}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className={`truncate text-xs ${unread ? 'font-extrabold text-slate-900' : 'font-semibold text-slate-700'}`}>
                        {name}
                      </span>
                      {unread && (
                        <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-black text-white">
                          {item.unread_count}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                      {item.latest_message_snippet || 'Chưa có tin nhắn'}
                    </span>
                    <span className="mt-1 flex items-center gap-1.5 text-[10px] font-semibold text-slate-400">
                      <span className="text-orange-600">{shopNameOf(item.shop_id)}</span>
                      <span>·</span>
                      <span>{formatTime(item.last_updated_at)}</span>
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </aside>

      <section className="flex w-[70%] min-w-0 flex-col bg-white">
        {active ? (
          <>
            <header className="flex shrink-0 items-center gap-3 border-b border-gray-100 px-4 py-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-orange-500 text-xs font-extrabold text-white">
                {initials(customerLabel)}
              </span>
              <div className="min-w-0">
                <h3 className="truncate text-sm font-extrabold text-slate-900">{customerLabel}</h3>
                <p className="truncate text-[11px] font-semibold text-slate-400">
                  Shopee · {shopNameOf(active.shop_id)}
                </p>
              </div>
              {Number(active.unread_count) > 0 && (
                <span className="ml-auto rounded-full bg-red-500 px-2 py-1 text-[10px] font-black text-white">
                  {active.unread_count} chưa trả lời
                </span>
              )}
            </header>

            {error && (
              <p className="shrink-0 bg-rose-50 px-4 py-2 text-xs font-semibold text-rose-600">{error}</p>
            )}

            <div ref={bodyRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-slate-50/60 px-4 py-4">
              {messagesLoading && messages.length === 0 ? (
                <p className="flex items-center justify-center gap-2 py-8 text-xs font-semibold text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" /> Đang tải tin nhắn...
                </p>
              ) : (
                messages.map((msg, index) => {
                  const mine = msg.sender_type === 'shop';
                  const text = messageText(msg.content) || '…';
                  return (
                    <div key={msg.message_id || `${msg.created_at}-${index}`} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm leading-relaxed shadow-sm ${
                          mine
                            ? 'rounded-br-md bg-blue-600 text-white'
                            : 'rounded-bl-md border border-gray-100 bg-white text-slate-800'
                        }`}
                      >
                        <p className="whitespace-pre-wrap">{text}</p>
                        <p className={`mt-1 text-[10px] font-semibold ${mine ? 'text-blue-100' : 'text-slate-400'}`}>
                          {formatTime(msg.created_at)}
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <footer className="relative shrink-0 border-t border-gray-100 bg-white p-3">
              <div className="mb-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setQuickOpen((open) => !open)}
                  className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-bold ${
                    quickOpen ? 'border-amber-300 bg-amber-50 text-amber-700' : 'border-gray-200 bg-white text-slate-600'
                  }`}
                >
                  <Zap className="h-3.5 w-3.5" />
                  Tin nhắn nhanh
                </button>
                <button
                  type="button"
                  onClick={() => setComposerOpen(true)}
                  className="inline-flex items-center gap-1 rounded-xl border border-gray-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Thêm mẫu
                </button>
              </div>
              {quickOpen && (
                <div className="mb-2 max-h-40 overflow-y-auto rounded-xl border border-gray-200 bg-slate-50 p-2">
                  {quickReplies.length === 0 ? (
                    <p className="px-2 py-2 text-xs font-semibold text-slate-400">Chưa có mẫu tin nhắn nhanh.</p>
                  ) : (
                    quickReplies.map((reply) => (
                      <div key={reply._id || reply.shortcut} className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-white">
                        <button
                          type="button"
                          onClick={() => {
                            setDraft(reply.content);
                            inputRef.current?.focus();
                          }}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="block text-[11px] font-extrabold text-slate-800">{reply.shortcut}</span>
                          <span className="block truncate text-xs text-slate-500">{reply.content}</span>
                        </button>
                        <button
                          type="button"
                          disabled={sending}
                          onClick={() => void sendText(reply.content)}
                          className="shrink-0 rounded-lg bg-blue-600 px-2 py-1 text-[10px] font-extrabold text-white disabled:bg-slate-300"
                        >
                          Gửi ngay
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
              <textarea
                ref={inputRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void sendText(draft);
                  }
                }}
                rows={2}
                placeholder="Nhập tin nhắn..."
                className="w-full resize-none rounded-xl border border-gray-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-400 focus:bg-white"
              />
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => void sendText(draft)}
                  disabled={!draft.trim() || sending}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-extrabold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  Gửi
                </button>
              </div>
            </footer>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-slate-400">
            <MessageSquare className="h-8 w-8" />
            <p className="text-sm font-semibold">
              {error || 'Chọn một hội thoại để xem nội dung.'}
            </p>
          </div>
        )}
      </section>

      {composerOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-extrabold text-slate-900">Thêm tin nhắn nhanh</h3>
              <button type="button" onClick={() => setComposerOpen(false)} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100" aria-label="Đóng">
                <X className="h-4 w-4" />
              </button>
            </div>
            <label className="mb-2 block text-[11px] font-bold text-slate-500">
              Tên gợi nhớ
              <input
                value={newShortcut}
                onChange={(event) => setNewShortcut(event.target.value)}
                className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm font-semibold text-slate-800 outline-none focus:border-blue-400"
                placeholder="VD: Xin mã đơn"
              />
            </label>
            <label className="mb-3 block text-[11px] font-bold text-slate-500">
              Nội dung
              <textarea
                value={newContent}
                onChange={(event) => setNewContent(event.target.value)}
                rows={3}
                className="mt-1 w-full resize-none rounded-xl border border-gray-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-400"
                placeholder="Nội dung gửi cho khách..."
              />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setComposerOpen(false)} className="rounded-xl px-3 py-2 text-xs font-bold text-slate-500">
                Hủy
              </button>
              <button
                type="button"
                disabled={savingReply || !newShortcut.trim() || !newContent.trim()}
                onClick={() => void saveQuickReply()}
                className="rounded-xl bg-blue-600 px-4 py-2 text-xs font-extrabold text-white disabled:bg-slate-300"
              >
                {savingReply ? 'Đang lưu...' : 'Lưu mẫu'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
