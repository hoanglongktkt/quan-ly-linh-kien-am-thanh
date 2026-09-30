import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Loader2, MessageSquare, Plus, Send, X, Zap } from 'lucide-react';
import { apiFetch, parseJsonResponse } from '../../utils/apiClient';
import { useChatUnread } from '../../context/ChatUnreadContext';

type ChatFilter = 'all' | 'unread';

interface ShopOption {
  platform: string;
  shopId: string;
  shopName: string;
}

interface ConversationRow {
  shop_id: number | string;
  conversation_id: string;
  customer_id?: unknown;
  to_id?: unknown;
  customer_name?: unknown;
  customerName?: unknown;
  customer_avatar?: string;
  unread_count?: number;
  latest_message_snippet?: unknown;
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

function readableString(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === '[object Object]') return '';
  return trimmed;
}

function scalarId(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return '';
    return String(Math.trunc(value));
  }
  const asText = readableString(value);
  if (asText && asText !== '0') return asText;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return (
      scalarId(row.id) ||
      scalarId(row.user_id) ||
      scalarId(row.buyer_id) ||
      scalarId(row.to_id) ||
      scalarId(row.customer_id) ||
      scalarId(row.shop_id) ||
      scalarId(row.shopId) ||
      ''
    );
  }
  return '';
}

function customerNameOf(row?: { customer_name?: unknown; customerName?: unknown } | null): string {
  const raw = row?.customer_name ?? row?.customerName;
  const direct = readableString(raw);
  if (direct) return direct;
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    const nested =
      record.name ??
      record.username ??
      record.user_name ??
      record.buyer_name ??
      record.display_name ??
      record.nickname;
    const extracted = readableString(nested) || (nested && typeof nested === 'object' ? customerNameOf({ customer_name: nested }) : '');
    if (extracted && extracted !== 'Khách hàng') return extracted;
  }
  return 'Khách hàng';
}

type ParsedChat = {
  kind: 'text' | 'order' | 'product' | 'image' | 'sticker' | 'empty';
  text: string;
  orderSn?: string;
  itemName?: string;
  imageUrl?: string;
};

function safeHttpUrl(value: unknown): string {
  const text = readableString(value);
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString();
  } catch {
    return '';
  }
  return '';
}

function collectNodes(raw: unknown, depth: number, out: unknown[]): void {
  if (raw == null || depth > 4) return;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length <= 8000) {
      try {
        collectNodes(JSON.parse(trimmed) as unknown, depth + 1, out);
        return;
      } catch {
        /* chuỗi thường */
      }
    }
    out.push(raw);
    return;
  }
  if (typeof raw !== 'object') return;
  out.push(raw);
  const record = raw as Record<string, unknown>;
  const keys = ['content', 'text', 'data', 'order', 'order_info', 'source_content', 'message'] as const;
  for (let i = 0; i < keys.length; i += 1) {
    const nested = record[keys[i]];
    if (nested && typeof nested === 'object') collectNodes(nested, depth + 1, out);
  }
}

function parseMessageContent(content: unknown): ParsedChat {
  try {
    const nodes: unknown[] = [];
    collectNodes(content, 0, nodes);
    let orderSn = '';
    let itemName = '';
    let hasItem = false;
    let imageUrl = '';
    let hasImage = false;
    let hasSticker = false;
    let text = '';
    let type = '';
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (typeof node === 'string') {
        const plain = readableString(node);
        if (plain && !text) text = plain;
        continue;
      }
      if (!node || typeof node !== 'object') continue;
      const row = node as Record<string, unknown>;
      const nodeType = readableString(row.message_type || row.type).toLowerCase();
      if (nodeType && !type) type = nodeType;
      const sn = readableString(row.order_sn) || readableString(row.ordersn) || readableString(row.orderSn);
      if (sn && !orderSn) orderSn = sn;
      const name = readableString(row.item_name) || readableString(row.itemName);
      if (name && !itemName) itemName = name;
      if (row.item_id || row.itemId || name) hasItem = true;
      const picture =
        safeHttpUrl(row.image_url) ||
        safeHttpUrl(row.imageUrl) ||
        safeHttpUrl(row.thumb_url) ||
        (nodeType === 'image' ? safeHttpUrl(row.url) : '') ||
        safeHttpUrl(row.image);
      if (picture && !imageUrl) imageUrl = picture;
      if (nodeType === 'image' || row.image_url || row.imageUrl || row.thumb_url || row.image) hasImage = true;
      if (row.sticker || row.sticker_id || row.sticker_package_id) hasSticker = true;
      const nodeText = readableString(row.text) || readableString(row.caption);
      if (nodeText && !text) text = nodeText;
    }
    if (orderSn) return { kind: 'order', text: `📦 [Đơn hàng] ${orderSn}`, orderSn };
    if (type === 'order' || type === 'order_card') return { kind: 'order', text: '📦 [Đơn hàng]' };
    if (hasItem || type === 'item' || type === 'product') {
      return { kind: 'product', text: '🛍️ [Sản phẩm]', itemName };
    }
    if (hasImage || type === 'image') return { kind: 'image', text: '🖼️ [Hình ảnh]', imageUrl };
    if (text) return { kind: 'text', text };
    if (hasSticker || type === 'sticker') return { kind: 'sticker', text: '[Sticker]' };
    return { kind: 'empty', text: '' };
  } catch {
    return { kind: 'empty', text: '' };
  }
}

function previewSnippet(value: unknown): string {
  try {
    if (value && typeof value === 'object') {
      const parsed = parseMessageContent(value).text;
      if (parsed) return parsed;
      return JSON.stringify(value);
    }
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text || text === '[object Object]') return '';
    return text;
  } catch {
    return '';
  }
}

function ChatBubble({ mine, content, createdAt }: { mine: boolean; content: unknown; createdAt?: string }) {
  const parsed = parseMessageContent(content);
  const shell = mine
    ? 'rounded-br-md bg-blue-600 text-white'
    : 'rounded-bl-md border border-gray-100 bg-white text-slate-800';
  return (
    <div className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm leading-relaxed shadow-sm ${shell}`}>
      {parsed.kind === 'order' ? (
        <div className={`rounded-xl px-2.5 py-2 ${mine ? 'bg-white/15' : 'bg-orange-50'}`}>
          <p className={`text-[11px] font-extrabold ${mine ? 'text-white' : 'text-orange-700'}`}>📦 Đơn hàng</p>
          <p className="mt-1 break-all font-mono text-[13px] font-bold">{parsed.orderSn || 'Không có mã đơn'}</p>
        </div>
      ) : parsed.kind === 'product' ? (
        <div>
          <p className="text-[11px] font-extrabold">🛍️ Sản phẩm</p>
          {parsed.itemName ? <p className="mt-1 whitespace-pre-wrap">{parsed.itemName}</p> : null}
        </div>
      ) : parsed.kind === 'image' && parsed.imageUrl ? (
        <img src={parsed.imageUrl} alt="Hình ảnh" className="max-h-48 rounded-lg object-cover" />
      ) : (
        <p className="whitespace-pre-wrap">{parsed.text || '…'}</p>
      )}
      <p className={`mt-1 text-[10px] font-semibold ${mine ? 'text-blue-100' : 'text-slate-400'}`}>
        {formatTime(createdAt)}
      </p>
    </div>
  );
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
  const [activeConversation, setActiveConversation] = useState<string | null>(null);
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
  const readClearUntil = useRef<Map<string, number>>(new Map());

  const shopNameOf = useCallback(
    (id: number | string) => shopeeShops.find((shop) => String(shop.shopId) === String(id))?.shopName || `Shop ${id}`,
    [shopeeShops],
  );

  const { setTotalUnreadCount } = useChatUnread();
  const unreadTotal = useMemo(
    () => conversations.reduce((sum, row) => sum + Math.max(0, Number(row.unread_count) || 0), 0),
    [conversations],
  );

  useEffect(() => {
    setTotalUnreadCount(unreadTotal);
  }, [unreadTotal, setTotalUnreadCount]);

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
      const now = Date.now();
      const rows = (Array.isArray(data.conversations) ? data.conversations : []).map((row) => {
        const key = `${String(row.shop_id ?? '')}:${String(row.conversation_id || '')}`;
        const until = readClearUntil.current.get(key) || 0;
        if (until > now) return { ...row, unread_count: 0 };
        if (until) readClearUntil.current.delete(key);
        return row;
      });
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
    const conversationId = String(active.conversation_id || selectedId || '').trim();
    const resolvedShopId = scalarId(active.shop_id) || scalarId(shopId);
    const toId = scalarId(active.customer_id) || scalarId(active.to_id);
    if (!resolvedShopId || !conversationId || !toId) {
      setError('Thiếu shop_id, người nhận hoặc nội dung.');
      return;
    }
    setSending(true);
    setError('');
    try {
      const response = await apiFetch('/api/chat/send', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          shop_id: Number(resolvedShopId),
          conversation_id: conversationId,
          to_id: toId,
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

  const handleSelectConversation = (item: ConversationRow) => {
    setSelectedId(item.conversation_id);
    setActiveConversation(item.conversation_id);
    readClearUntil.current.set(`${String(item.shop_id ?? '')}:${item.conversation_id}`, Date.now() + 25_000);
    setConversations((prev) =>
      prev.map((row) =>
        row.conversation_id === item.conversation_id && String(row.shop_id) === String(item.shop_id)
          ? { ...row, unread_count: 0 }
          : row,
      ),
    );
    void (async () => {
      try {
        const response = await apiFetch(
          `/api/chat/conversations/${encodeURIComponent(item.conversation_id)}/read`,
          {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ shop_id: item.shop_id, conversation_id: item.conversation_id }),
          },
        );
        if (!response.ok) {
          console.log('[chat] POST /read', response.status);
        }
      } catch (err) {
        console.log('[chat] POST /read', err);
      }
    })();
  };

  const customerLabel = customerNameOf(active);

  return (
    <div className="flex h-[calc(100dvh-13.5rem)] min-h-[520px] w-full min-w-0 max-w-full md:h-[calc(100dvh-11rem)] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      <aside className={`${activeConversation ? 'hidden' : 'flex'} w-full min-w-0 flex-col bg-slate-50/80 md:flex md:w-[35%] md:border-r md:border-gray-200`}>
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
          <div className="flex gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setFilter('all')}
              className={`min-w-0 flex-1 basis-0 whitespace-normal break-words rounded-lg px-2 py-2 text-center text-[11px] font-bold leading-snug transition-all ${
                filter === 'all' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              Tất cả tin nhắn
            </button>
            <button
              type="button"
              onClick={() => setFilter('unread')}
              className={`inline-flex min-w-0 flex-1 basis-0 flex-wrap items-center justify-center gap-1 whitespace-normal break-words rounded-lg px-2 py-2 text-center text-[11px] font-bold leading-snug transition-all ${
                filter === 'unread' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <span>Chưa trả lời</span>
              {unreadTotal > 0 && (
                <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-black text-white">
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
              const name = customerNameOf(item);
              const unread = Number(item.unread_count) > 0;
              return (
                <button
                  key={`${item.shop_id}-${item.conversation_id}`}
                  type="button"
                  onClick={() => handleSelectConversation(item)}
                  className={`flex w-full min-w-0 items-start gap-2.5 overflow-hidden border-b border-gray-100 px-3 py-3 text-left transition-colors ${
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
                  <span className="min-w-0 flex-1 overflow-hidden">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className={`min-w-0 flex-1 truncate text-xs ${unread ? 'font-extrabold text-slate-900' : 'font-semibold text-slate-700'}`}>
                        {name}
                      </span>
                      {unread && (
                        <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-black text-white">
                          {item.unread_count}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                      {previewSnippet(item.latest_message_snippet) || 'Chưa có tin nhắn'}
                    </span>
                    <span className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden text-[10px] font-semibold text-slate-400">
                      <span className="min-w-0 truncate text-orange-600">{shopNameOf(item.shop_id)}</span>
                      <span className="shrink-0">·</span>
                      <span className="shrink-0">{formatTime(item.last_updated_at)}</span>
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </aside>

      <section className={`${activeConversation ? 'flex' : 'hidden'} w-full min-w-0 flex-col bg-white md:flex md:w-[65%]`}>
        {active ? (
          <>
            <header className="flex shrink-0 items-center gap-2 overflow-hidden border-b border-gray-100 px-3 py-3 md:gap-3 md:px-4">
              <button
                type="button"
                onClick={() => setActiveConversation(null)}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg px-1 py-1 text-xs font-bold text-slate-700 hover:bg-slate-100 md:hidden"
              >
                <ArrowLeft className="h-4 w-4" />
                Quay lại
              </button>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-orange-500 text-xs font-extrabold text-white">
                {initials(customerLabel)}
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-extrabold text-slate-900">{customerLabel}</h3>
                <p className="truncate text-[11px] font-semibold text-slate-400">
                  Shopee · {shopNameOf(active.shop_id)}
                </p>
              </div>
              {Number(active.unread_count) > 0 && (
                <span className="ml-auto shrink-0 rounded-full bg-red-500 px-2 py-1 text-[10px] font-black text-white">
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
                  return (
                    <div key={msg.message_id || `${msg.created_at}-${index}`} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                      <ChatBubble mine={mine} content={msg.content} createdAt={msg.created_at} />
                    </div>
                  );
                })
              )}
            </div>

            <footer className="relative shrink-0 border-t border-gray-100 bg-white p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
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
            <button
              type="button"
              onClick={() => setActiveConversation(null)}
              className="mb-2 inline-flex items-center gap-1 self-start rounded-lg px-1 py-1 text-xs font-bold text-slate-700 hover:bg-slate-100 md:hidden"
            >
              <ArrowLeft className="h-4 w-4" />
              Quay lại
            </button>
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
