import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Send, Zap } from 'lucide-react';

type ChatFilter = 'all' | 'unread';
type Speaker = 'customer' | 'shop';

interface ChatMessage {
  id: string;
  from: Speaker;
  text: string;
  time: string;
}

interface Conversation {
  id: string;
  customerName: string;
  shopName: string;
  platform: 'Shopee' | 'TikTok';
  preview: string;
  time: string;
  unread: boolean;
  messages: ChatMessage[];
}

const QUICK_REPLIES = [
  'Dạ shop đã nhận tin, em kiểm tra và phản hồi ngay ạ.',
  'Anh/chị cho em xin mã đơn để shop đối chiếu giúp ạ.',
  'Đơn đang được đóng gói, shop giao trong hôm nay ạ.',
  'Sản phẩm còn hàng, anh/chị đặt giúp shop nhé ạ.',
];

const INITIAL_CONVERSATIONS: Conversation[] = [
  {
    id: 'c1',
    customerName: 'Nguyễn Văn An',
    shopName: 'Linh Kiện Âm Thanh',
    platform: 'Shopee',
    preview: 'Shop ơi loa JBL còn hàng không ạ?',
    time: '09:12',
    unread: true,
    messages: [
      { id: 'c1-m1', from: 'customer', text: 'Shop ơi loa JBL còn hàng không ạ?', time: '09:10' },
      { id: 'c1-m2', from: 'customer', text: 'Mình cần bản có dây, giao nội thành.', time: '09:12' },
    ],
  },
  {
    id: 'c2',
    customerName: 'Trần Thị Bích',
    shopName: 'LKAT TikTok',
    platform: 'TikTok',
    preview: 'Cho mình xin mã vận đơn với ạ.',
    time: '08:41',
    unread: true,
    messages: [
      { id: 'c2-m1', from: 'customer', text: 'Đơn hôm qua shop gửi chưa ạ?', time: '08:38' },
      { id: 'c2-m2', from: 'shop', text: 'Dạ em đang kiểm tra mã vận đơn, anh/chị chờ em một chút ạ.', time: '08:40' },
      { id: 'c2-m3', from: 'customer', text: 'Cho mình xin mã vận đơn với ạ.', time: '08:41' },
    ],
  },
  {
    id: 'c3',
    customerName: 'Lê Minh Khoa',
    shopName: 'Linh Kiện Âm Thanh',
    platform: 'Shopee',
    preview: 'Mình muốn đổi sang bản 8 inch.',
    time: 'Hôm qua',
    unread: true,
    messages: [
      { id: 'c3-m1', from: 'customer', text: 'Đơn 240928ABCDEF mình muốn đổi sang bản 8 inch được không shop?', time: 'Hôm qua' },
    ],
  },
  {
    id: 'c4',
    customerName: 'Phạm Thu Hà',
    shopName: 'Linh Kiện Âm Thanh',
    platform: 'Shopee',
    preview: 'Hàng nhận về bị trầy góc hộp.',
    time: 'Hôm qua',
    unread: true,
    messages: [
      { id: 'c4-m1', from: 'customer', text: 'Hàng nhận về bị trầy góc hộp, shop xem giúp mình.', time: 'Hôm qua' },
      { id: 'c4-m2', from: 'customer', text: 'Mình gửi ảnh sau ạ.', time: 'Hôm qua' },
    ],
  },
  {
    id: 'c5',
    customerName: 'Hoàng Đức Mạnh',
    shopName: 'LKAT TikTok',
    platform: 'TikTok',
    preview: 'Bảo hành loa bao lâu vậy shop?',
    time: '28/09',
    unread: true,
    messages: [
      { id: 'c5-m1', from: 'customer', text: 'Bảo hành loa bao lâu vậy shop?', time: '28/09' },
    ],
  },
  {
    id: 'c6',
    customerName: 'Võ Thanh Tùng',
    shopName: 'Linh Kiện Âm Thanh',
    platform: 'Shopee',
    preview: 'Cảm ơn shop, hàng dùng ổn.',
    time: '27/09',
    unread: false,
    messages: [
      { id: 'c6-m1', from: 'shop', text: 'Dạ shop đã giao đơn, anh kiểm tra giúp shop nhé.', time: '27/09' },
      { id: 'c6-m2', from: 'customer', text: 'Cảm ơn shop, hàng dùng ổn.', time: '27/09' },
    ],
  },
  {
    id: 'c7',
    customerName: 'Đặng Ngọc Lan',
    shopName: 'LKAT TikTok',
    platform: 'TikTok',
    preview: 'Mình đã nhận đủ phụ kiện.',
    time: '26/09',
    unread: false,
    messages: [
      { id: 'c7-m1', from: 'customer', text: 'Mình đã nhận đủ phụ kiện.', time: '26/09' },
      { id: 'c7-m2', from: 'shop', text: 'Dạ shop cảm ơn anh/chị. Cần hỗ trợ thêm cứ nhắn shop ạ.', time: '26/09' },
    ],
  },
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return `${parts[0].slice(0, 1)}${parts[parts.length - 1].slice(0, 1)}`.toUpperCase();
}

function nowLabel(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export default function ChatManager() {
  const [filter, setFilter] = useState<ChatFilter>('all');
  const [conversations, setConversations] = useState<Conversation[]>(INITIAL_CONVERSATIONS);
  const [selectedId, setSelectedId] = useState<string>(INITIAL_CONVERSATIONS[0].id);
  const [draft, setDraft] = useState('');
  const [quickOpen, setQuickOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const visible = useMemo(
    () => (filter === 'unread' ? conversations.filter((c) => c.unread) : conversations),
    [conversations, filter],
  );

  const active = visible.find((c) => c.id === selectedId) ?? visible[0] ?? null;
  const unreadTotal = conversations.filter((c) => c.unread).length;

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [active?.id, active?.messages.length]);

  const sendText = (raw: string) => {
    const text = raw.trim();
    if (!text || !active) return;
    const stamp = nowLabel();
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== active.id) return c;
        return {
          ...c,
          unread: false,
          preview: text,
          time: stamp,
          messages: [
            ...c.messages,
            { id: `local-${Date.now()}`, from: 'shop', text, time: stamp },
          ],
        };
      }),
    );
    setDraft('');
    setQuickOpen(false);
  };

  return (
    <div className="flex h-[calc(100dvh-13.5rem)] min-h-[520px] md:h-[calc(100dvh-11rem)] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      <aside className="flex w-[30%] min-w-0 flex-col border-r border-gray-200 bg-slate-50/80">
        <div className="shrink-0 border-b border-gray-200 bg-white p-3">
          <div className="mb-2 flex items-center gap-2 text-slate-800">
            <MessageSquare className="h-4 w-4 shrink-0 text-blue-600" />
            <p className="text-xs font-extrabold tracking-wide">Hội thoại</p>
          </div>
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
              Chưa đọc
              {unreadTotal > 0 && (
                <span className="ml-1 inline-flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-black text-white">
                  {unreadTotal}
                </span>
              )}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs font-semibold text-slate-400">Không có tin nhắn chưa đọc.</p>
          ) : (
            visible.map((item) => {
              const selected = active?.id === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={`flex w-full items-start gap-2.5 border-b border-gray-100 px-3 py-3 text-left transition-colors ${
                    selected ? 'bg-blue-50' : 'bg-white hover:bg-slate-50'
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-extrabold text-white ${
                      item.platform === 'Shopee' ? 'bg-orange-500' : 'bg-slate-900'
                    }`}
                  >
                    {initials(item.customerName)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className={`truncate text-xs ${item.unread ? 'font-extrabold text-slate-900' : 'font-semibold text-slate-700'}`}>
                        {item.customerName}
                      </span>
                      {item.unread && <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" />}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-slate-500">{item.preview}</span>
                    <span className="mt-1 flex items-center gap-1.5 text-[10px] font-semibold text-slate-400">
                      <span className={item.platform === 'Shopee' ? 'text-orange-600' : 'text-slate-600'}>{item.platform}</span>
                      <span>·</span>
                      <span>{item.time}</span>
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
              <span
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-extrabold text-white ${
                  active.platform === 'Shopee' ? 'bg-orange-500' : 'bg-slate-900'
                }`}
              >
                {initials(active.customerName)}
              </span>
              <div className="min-w-0">
                <h3 className="truncate text-sm font-extrabold text-slate-900">{active.customerName}</h3>
                <p className="truncate text-[11px] font-semibold text-slate-400">
                  {active.platform} · {active.shopName}
                </p>
              </div>
            </header>

            <div ref={bodyRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-slate-50/60 px-4 py-4">
              {active.messages.map((msg) => {
                const mine = msg.from === 'shop';
                return (
                  <div key={msg.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm leading-relaxed shadow-sm ${
                        mine
                          ? 'rounded-br-md bg-blue-600 text-white'
                          : 'rounded-bl-md border border-gray-100 bg-white text-slate-800'
                      }`}
                    >
                      <p className="whitespace-pre-wrap">{msg.text}</p>
                      <p className={`mt-1 text-[10px] font-semibold ${mine ? 'text-blue-100' : 'text-slate-400'}`}>{msg.time}</p>
                    </div>
                  </div>
                );
              })}
            </div>

            <footer className="relative shrink-0 border-t border-gray-100 bg-white p-3">
              {quickOpen && (
                <div className="absolute bottom-full left-3 right-3 z-10 mb-2 rounded-xl border border-gray-200 bg-white p-2 shadow-lg">
                  <p className="px-2 py-1 text-[10px] font-extrabold uppercase tracking-wide text-slate-400">Tin nhắn nhanh</p>
                  <div className="grid gap-1">
                    {QUICK_REPLIES.map((line) => (
                      <button
                        key={line}
                        type="button"
                        onClick={() => {
                          setDraft(line);
                          setQuickOpen(false);
                          inputRef.current?.focus();
                        }}
                        className="rounded-lg px-2 py-2 text-left text-xs font-semibold text-slate-700 hover:bg-blue-50 hover:text-blue-700"
                      >
                        {line}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <textarea
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendText(draft);
                  }
                }}
                rows={2}
                placeholder="Nhập tin nhắn..."
                className="w-full resize-none rounded-xl border border-gray-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-400 focus:bg-white"
              />
              <div className="mt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setQuickOpen((open) => !open)}
                  className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-bold transition-colors ${
                    quickOpen
                      ? 'border-amber-300 bg-amber-50 text-amber-700'
                      : 'border-gray-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <Zap className="h-3.5 w-3.5" />
                  Tin nhắn nhanh
                </button>
                <button
                  type="button"
                  onClick={() => sendText(draft)}
                  disabled={!draft.trim()}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-extrabold text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  <Send className="h-3.5 w-3.5" />
                  Gửi
                </button>
              </div>
            </footer>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-slate-400">
            <MessageSquare className="h-8 w-8" />
            <p className="text-sm font-semibold">Chọn một hội thoại để xem nội dung.</p>
          </div>
        )}
      </section>
    </div>
  );
}
