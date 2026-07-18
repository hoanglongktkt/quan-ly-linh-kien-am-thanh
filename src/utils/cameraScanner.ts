/**
 * Live QR scanner — Continuous Frame Processing.
 * Primary: BarcodeDetector (Chrome/Android = Google ML Kit / Play Services).
 * Fallback: @zxing/browser continuous decode.
 */
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

export const HTTPS_CAMERA_MESSAGE = 'Vui lòng truy cập qua HTTPS để sử dụng camera';

export const CAMERA_TAP_LAYER_ID = 'camera-tap-focus';
export const PICKING_CAMERA_TAP_LAYER_ID = 'picking-camera-tap-focus';

/** Độ phân giải capture thấp → CPU/RAM nhẹ, tần suất quét cao. */
const CAPTURE_WIDTH = 960;
const CAPTURE_HEIGHT = 720;
/** Canvas decode nhỏ hơn nữa để tăng FPS detect. */
const DECODE_MAX_EDGE = 480;
/** Khoảng cách tối thiểu giữa 2 lần decode (ms) — ~20–25 FPS. */
const DECODE_INTERVAL_MS = 40;

export type LiveQrScannerHandle = {
  stop: () => Promise<void>;
  clear: () => Promise<void>;
  destroy: () => Promise<void>;
};

type ExtendedCaps = MediaTrackCapabilities & {
  focusMode?: string[];
  exposureMode?: string[];
  exposureCompensation?: { min: number; max: number; step?: number };
  zoom?: { min: number; max: number; step?: number };
};

type BarcodeDetectorLike = {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>;
};

declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats?: string[] }) => BarcodeDetectorLike;
  }
}

const REAR_LABEL = /back|rear|environment|后置|後鏡|sau|arrière|trás/i;
const WIDE_LABEL = /wide|ultra|0\.5|góc rộng/i;
const TELE_LABEL = /tele|zoom|2x|3x|5x|periscope|telephoto/i;

const tapFocusStops = new Map<string, () => void>();
const activeScanners = new Map<string, LiveQrScannerHandle>();

export function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent,
  );
}

export function getCameraBlockedReason(): string | null {
  if (typeof window === 'undefined') return null;
  if (isMobileDevice() && !window.isSecureContext) {
    return HTTPS_CAMERA_MESSAGE;
  }
  return null;
}

function createBarcodeDetector(): BarcodeDetectorLike | null {
  try {
    if (typeof window === 'undefined' || !window.BarcodeDetector) return null;
    return new window.BarcodeDetector({ formats: ['qr_code'] });
  } catch {
    return null;
  }
}

async function listVideoInputDevices(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  } catch {
    return [];
  }
}

function pickRearDeviceId(devices: MediaDeviceInfo[]): string | undefined {
  if (!devices.length) return undefined;
  const label = (d: MediaDeviceInfo) => d.label || '';
  const nonTele = devices.filter((d) => !TELE_LABEL.test(label(d)));
  const list = nonTele.length ? nonTele : devices;
  const wide = list.find((d) => WIDE_LABEL.test(label(d)));
  if (wide) return wide.deviceId;
  const back = list.find((d) => REAR_LABEL.test(label(d)));
  if (back) return back.deviceId;
  if (list.length === 1) return list[0].deviceId;
  return list[list.length - 1]?.deviceId;
}

/** Constraints: camera sau, độ phân giải thấp (AF/exposure apply sau khi mở stream). */
function buildStreamConstraints(deviceId?: string): MediaStreamConstraints {
  const video: MediaTrackConstraints = {
    width: { ideal: CAPTURE_WIDTH },
    height: { ideal: CAPTURE_HEIGHT },
    frameRate: { ideal: 30, max: 30 },
    ...(deviceId
      ? { deviceId: { exact: deviceId } }
      : { facingMode: { ideal: 'environment' } }),
  };
  return { audio: false, video };
}

async function openRearCameraStream(): Promise<MediaStream> {
  const devices = await listVideoInputDevices();
  const rearId = pickRearDeviceId(devices);
  const attempts: MediaStreamConstraints[] = [
    buildStreamConstraints(rearId),
    buildStreamConstraints(undefined),
    {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
    },
  ];

  let lastError: unknown;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Không thể khởi động camera.');
}

async function applyContinuousFocusAndExposure(track: MediaStreamTrack): Promise<void> {
  if (!track?.applyConstraints) return;
  const caps = (
    typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}
  ) as ExtendedCaps;

  const applyAdvanced = async (constraint: Record<string, unknown>) => {
    try {
      await track.applyConstraints({ advanced: [constraint] } as unknown as MediaTrackConstraints);
    } catch {
      /* ignore unsupported constraint */
    }
  };

  // Zoom về minimum — quét gần dễ hơn, không phải đứng xa.
  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    await applyAdvanced({ zoom: caps.zoom.min });
  }

  if (caps.focusMode?.includes('continuous')) {
    await applyAdvanced({ focusMode: 'continuous' });
  } else if (caps.focusMode?.includes('auto')) {
    await applyAdvanced({ focusMode: 'auto' });
  }

  if (caps.exposureMode?.includes('continuous')) {
    await applyAdvanced({ exposureMode: 'continuous' });
  } else if (caps.exposureMode?.includes('auto')) {
    await applyAdvanced({ exposureMode: 'auto' });
  }

  // Bù sáng nhẹ nếu tối (QR trên phiếu in).
  if (caps.exposureCompensation) {
    const { min, max } = caps.exposureCompensation;
    const bias = Math.min(max, Math.max(min, 0.3));
    await applyAdvanced({ exposureCompensation: bias });
  }
}

/** Chạm lấy nét: single-shot rồi quay lại continuous. */
export async function triggerTapToFocus(scannerElementId: string): Promise<void> {
  const video = document.querySelector(`#${scannerElementId} video`) as HTMLVideoElement | null;
  const track = (video?.srcObject as MediaStream | null)?.getVideoTracks()?.[0];
  if (!track?.applyConstraints) return;

  const caps = (
    typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}
  ) as ExtendedCaps;

  if (caps.focusMode?.includes('single-shot')) {
    try {
      await track.applyConstraints({
        advanced: [{ focusMode: 'single-shot' }],
      } as unknown as MediaTrackConstraints);
      await new Promise((r) => setTimeout(r, 120));
      if (caps.focusMode.includes('continuous')) {
        await track.applyConstraints({
          advanced: [{ focusMode: 'continuous' }],
        } as unknown as MediaTrackConstraints);
      }
      return;
    } catch {
      /* fallthrough */
    }
  }

  await applyContinuousFocusAndExposure(track);
}

export function stopTapToFocusAssist(tapLayerId: string): void {
  tapFocusStops.get(tapLayerId)?.();
  tapFocusStops.delete(tapLayerId);
}

export function startTapToFocusAssist(scannerElementId: string, tapLayerId: string): void {
  stopTapToFocusAssist(tapLayerId);

  const onTap = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    void triggerTapToFocus(scannerElementId);
  };

  const layer = document.getElementById(tapLayerId);
  layer?.addEventListener('click', onTap);
  layer?.addEventListener('touchend', onTap, { passive: false });

  tapFocusStops.set(tapLayerId, () => {
    layer?.removeEventListener('click', onTap);
    layer?.removeEventListener('touchend', onTap);
  });
}

export async function applyScannerAutofocus(scannerElementId: string): Promise<void> {
  const video = document.querySelector(`#${scannerElementId} video`) as HTMLVideoElement | null;
  const track = (video?.srcObject as MediaStream | null)?.getVideoTracks()?.[0];
  if (track) await applyContinuousFocusAndExposure(track);
}

function drawDownscaledFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
): CanvasRenderingContext2D | null {
  const vw = video.videoWidth || 0;
  const vh = video.videoHeight || 0;
  if (vw < 2 || vh < 2) return null;

  const scale = Math.min(1, DECODE_MAX_EDGE / Math.max(vw, vh));
  const w = Math.max(1, Math.floor(vw * scale));
  const h = Math.max(1, Math.floor(vh * scale));

  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);
  return ctx;
}

function createZxingReader(): BrowserMultiFormatReader {
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  return new BrowserMultiFormatReader(hints, {
    delayBetweenScanAttempts: DECODE_INTERVAL_MS,
    delayBetweenScanSuccess: 600,
  });
}

/**
 * Khởi động quét QR realtime (continuous frames).
 * Engine: BarcodeDetector (ML Kit trên Android) → fallback ZXing.
 */
export async function startLiveQrScanner(opts: {
  containerId: string;
  tapLayerId?: string;
  onSuccess: (decodedText: string) => void;
  onError?: (error: Error) => void;
}): Promise<LiveQrScannerHandle> {
  const blocked = getCameraBlockedReason();
  if (blocked) throw new Error(blocked);

  const prev = activeScanners.get(opts.containerId);
  if (prev) await prev.stop().catch(() => undefined);

  const container = document.getElementById(opts.containerId);
  if (!container) throw new Error('Không tìm thấy vùng hiển thị camera.');

  container.innerHTML = '';
  const video = document.createElement('video');
  video.setAttribute('playsinline', 'true');
  video.setAttribute('muted', 'true');
  video.muted = true;
  video.autoplay = true;
  video.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;background:#000;';
  container.appendChild(video);

  const stream = await openRearCameraStream();
  video.srcObject = stream;
  await video.play().catch(() => undefined);

  const track = stream.getVideoTracks()[0];
  if (track) {
    await applyContinuousFocusAndExposure(track);
    // Re-apply sau khi camera warm-up (một số máy chỉ nhận AF sau vài trăm ms).
    window.setTimeout(() => {
      void applyContinuousFocusAndExposure(track);
    }, 400);
    window.setTimeout(() => {
      void applyContinuousFocusAndExposure(track);
    }, 1200);
  }

  if (opts.tapLayerId) {
    startTapToFocusAssist(opts.containerId, opts.tapLayerId);
  }

  const detector = createBarcodeDetector();
  const canvas = document.createElement('canvas');
  let stopped = false;
  let decoding = false;
  let lastDecodeAt = 0;
  let rafId = 0;
  let zxingReader: BrowserMultiFormatReader | null = null;
  let zxingControls: { stop: () => void } | null = null;

  const emitSuccess = (text: string) => {
    const trimmed = String(text || '').trim();
    if (!trimmed || stopped) return;
    opts.onSuccess(trimmed);
  };

  const loopDetect = async () => {
    if (stopped) return;
    rafId = requestAnimationFrame(() => {
      void loopDetect();
    });

    const now = performance.now();
    if (decoding || now - lastDecodeAt < DECODE_INTERVAL_MS) return;
    if (video.readyState < 2) return;

    decoding = true;
    lastDecodeAt = now;
    try {
      if (detector) {
        const ctx = drawDownscaledFrame(video, canvas);
        if (ctx) {
          const codes = await detector.detect(canvas);
          const value = codes?.[0]?.rawValue;
          if (value) emitSuccess(value);
        }
      }
    } catch {
      /* frame skip */
    } finally {
      decoding = false;
    }
  };

  if (detector) {
    console.log('[QR Scanner] Engine: BarcodeDetector (ML Kit / native)');
    void loopDetect();
  } else {
    console.log('[QR Scanner] Engine: ZXing continuous fallback');
    zxingReader = createZxingReader();
    try {
      zxingControls = await zxingReader.decodeFromVideoElement(video, (result, err) => {
        if (stopped) return;
        if (result) {
          emitSuccess(result.getText());
          return;
        }
        void err;
      });
    } catch (err) {
      // ZXing decodeFromVideoElement failed — try canvas poll with decodeFromCanvas
      console.warn('[QR Scanner] ZXing video element failed, using canvas poll', err);
      const reader = zxingReader;
      const canvasLoop = async () => {
        if (stopped) return;
        rafId = requestAnimationFrame(() => {
          void canvasLoop();
        });
        const now = performance.now();
        if (decoding || now - lastDecodeAt < DECODE_INTERVAL_MS) return;
        if (video.readyState < 2) return;
        decoding = true;
        lastDecodeAt = now;
        try {
          drawDownscaledFrame(video, canvas);
          const result = reader.decodeFromCanvas(canvas);
          if (result) emitSuccess(result.getText());
        } catch {
          /* NotFoundException mỗi frame — bình thường */
        } finally {
          decoding = false;
        }
      };
      void canvasLoop();
    }
  }

  const teardownDom = async () => {
    try {
      zxingControls?.stop();
    } catch {
      /* ignore */
    }
    zxingReader = null;
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    try {
      video.srcObject = null;
    } catch {
      /* ignore */
    }
    // Tránh removeChild race với React unmount: chỉ gỡ khi còn gắn DOM.
    try {
      if (video.isConnected && video.parentNode) {
        video.parentNode.removeChild(video);
      }
    } catch {
      /* ignore NotFoundError / removeChild */
    }
    try {
      canvas.width = 0;
      canvas.height = 0;
    } catch {
      /* ignore */
    }
    try {
      if (container.isConnected) {
        container.innerHTML = '';
      }
    } catch {
      /* ignore */
    }
    activeScanners.delete(opts.containerId);
  };

  const handle: LiveQrScannerHandle = {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(rafId);
      if (opts.tapLayerId) stopTapToFocusAssist(opts.tapLayerId);
      await teardownDom();
    },
    clear: async () => {
      await handle.stop();
    },
    destroy: async () => {
      await handle.stop();
    },
  };

  activeScanners.set(opts.containerId, handle);
  return handle;
}

/** Dừng scanner đang active theo container — dùng trước khi điều hướng/unmount. */
export async function stopLiveQrScanner(containerId: string): Promise<void> {
  const handle = activeScanners.get(containerId);
  if (!handle) return;
  await handle.stop().catch(() => undefined);
}

/** @deprecated giữ API cũ — chuyển sang startLiveQrScanner */
export const QR_ONLY_FORMATS = ['QR_CODE'] as const;

export const QR_SCANNER_CONFIG = {
  fps: 24,
  qrbox: (width: number, height: number) => {
    const minEdge = Math.min(width, height);
    const size = Math.floor(minEdge * 0.85);
    return { width: size, height: size };
  },
  aspectRatio: 1.0,
  disableFlip: false,
};

export const REAR_CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { ideal: 'environment' },
  width: { ideal: CAPTURE_WIDTH },
  height: { ideal: CAPTURE_HEIGHT },
};

/** @deprecated */
export function stopCloseRangeFocusAssist(_scannerElementId: string): void {
  stopTapToFocusAssist(CAMERA_TAP_LAYER_ID);
  stopTapToFocusAssist(PICKING_CAMERA_TAP_LAYER_ID);
}

/**
 * Wrapper tương thích Html5Qrcode callers cũ.
 * Bỏ qua instance html5 — dùng engine ML Kit / ZXing mới.
 */
export async function startRearCameraScanner(
  _html5Qrcode: unknown,
  _config: unknown,
  onSuccess: (decodedText: string) => void,
  _onScanFailure: (error: string) => void,
  scannerElementId = 'camera-reader',
  tapLayerId?: string,
): Promise<LiveQrScannerHandle> {
  return startLiveQrScanner({
    containerId: scannerElementId,
    tapLayerId,
    onSuccess,
  });
}
