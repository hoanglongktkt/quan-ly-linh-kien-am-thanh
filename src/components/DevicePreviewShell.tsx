import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Smartphone, Monitor, RotateCcw } from 'lucide-react';

type DeviceMode = 'auto' | 'mobile' | 'desktop';

const STORAGE_KEY = 'omni_preview_device_mode';

const DEVICE_SIZE: Record<'mobile' | 'desktop', { width: number; height: number }> = {
  mobile: { width: 390, height: 844 },
  desktop: { width: 1440, height: 900 },
};

// The toggle re-renders the app inside an <iframe>, which has its own real
// viewport width/height, so all Tailwind `md:` responsive rules evaluate
// exactly as they would on an actual phone or desktop, no matter how small
// the browser/preview window currently is.
function isEmbeddedInIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export default function DevicePreviewShell({ children }: { children: React.ReactNode }) {
  const embedded = isEmbeddedInIframe();

  const [mode, setMode] = useState<DeviceMode>(() => {
    if (embedded) return 'auto';
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'mobile' || saved === 'desktop' ? (saved as DeviceMode) : 'auto';
  });

  useEffect(() => {
    if (!embedded) localStorage.setItem(STORAGE_KEY, mode);
  }, [mode, embedded]);

  // Content loaded inside the simulator iframe must render plainly,
  // without spawning its own nested toggle button.
  if (embedded) {
    return <>{children}</>;
  }

  return (
    <>
      {mode === 'auto' ? (
        children
      ) : (
        <DeviceStage mode={mode} src={window.location.href} />
      )}
      <DeviceToggle mode={mode} onChange={setMode} />
    </>
  );
}

function DeviceStage({ mode, src }: { mode: 'mobile' | 'desktop'; src: string }) {
  const size = DEVICE_SIZE[mode];
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const stage = containerRef.current;
    if (!stage) return;

    const compute = () => {
      const availableWidth = stage.clientWidth - 32;
      const availableHeight = stage.clientHeight - 32;
      const next = Math.min(1, availableWidth / size.width, availableHeight / size.height);
      setScale(next > 0 ? next : 1);
    };

    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [size.width, size.height]);

  const isMobile = mode === 'mobile';

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-9990 bg-slate-950 flex items-center justify-center p-4 overflow-auto"
    >
      <div
        style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}
        className={`relative shrink-0 bg-black shadow-2xl transition-transform ${
          isMobile ? 'rounded-[2.75rem] border-10 border-slate-800' : 'rounded-2xl border-8 border-slate-800'
        }`}
      >
        {isMobile && (
          <div className="absolute top-0 inset-x-0 h-7 flex items-center justify-center z-10 pointer-events-none">
            <div className="w-28 h-5 bg-black rounded-b-2xl" />
          </div>
        )}
        <iframe
          key={mode}
          src={src}
          title="Xem tr\u01B0\u1EDBc giao di\u1EC7n"
          className={`w-full h-full border-0 bg-white ${isMobile ? 'rounded-4xl' : 'rounded-lg'}`}
        />
      </div>

      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
        {isMobile ? `Đang mô phỏng điện thoại • ${size.width}×${size.height}px` : `Đang mô phỏng PC • ${size.width}×${size.height}px`}
      </div>
    </div>
  );
}

function DeviceToggle({ mode, onChange }: { mode: DeviceMode; onChange: (m: DeviceMode) => void }) {
  const items: { id: DeviceMode; label: string; icon: React.ReactNode }[] = [
    { id: 'auto', label: 'Tự động', icon: <RotateCcw className="w-3.5 h-3.5" /> },
    { id: 'mobile', label: 'Điện thoại', icon: <Smartphone className="w-3.5 h-3.5" /> },
    { id: 'desktop', label: 'PC', icon: <Monitor className="w-3.5 h-3.5" /> },
  ];

  return (
    <div className="fixed top-3 right-3 z-9999 flex items-center gap-1 bg-slate-900/95 border border-slate-700 rounded-full p-1 shadow-xl backdrop-blur-sm">
      {items.map((item) => {
        const isActive = mode === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            title={item.label}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all cursor-pointer ${
              isActive ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`}
          >
            {item.icon}
            <span className="max-sm:hidden sm:inline">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
