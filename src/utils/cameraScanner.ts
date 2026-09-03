/**
 * Live QR scanner — Continuous Frame Processing.
 * Primary: BarcodeDetector (Chrome/Android = Google ML Kit / Play Services).
 * Fallback: @zxing/browser continuous decode.
 *
 * Flagship phone tuning: continuous AF + digital zoom (default 2x) + multi-lens switch.
 */
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

export const HTTPS_CAMERA_MESSAGE = 'Vui lòng truy cập qua HTTPS để sử dụng camera';

export const CAMERA_TAP_LAYER_ID = 'camera-tap-focus';
export const PICKING_CAMERA_TAP_LAYER_ID = 'picking-camera-tap-focus';

/** Độ phân giải capture — đủ rộng để đọc barcode 1D trên phiếu gửi. */
const CAPTURE_WIDTH = 1280;
const CAPTURE_HEIGHT = 720;
/** Canvas decode — ≥720 cạnh dài để barcode Code128/ITF còn đọc được. */
const DECODE_MAX_EDGE = 720;
/** Khoảng cách tối thiểu giữa 2 lần decode BarcodeDetector (ms). */
const DETECTOR_INTERVAL_MS = 50;
/** ZXing poll khi chạy song song với detector (nhẹ hơn một chút). */
const ZXING_INTERVAL_MS = 80;
/** Zoom kỹ thuật số mặc định — máy cảm biến lớn đứng xa ~20cm vẫn đọc được. */
const DEFAULT_SCAN_ZOOM = 2.0;

export type ScannerZoomCaps = {
  supported: boolean;
  min: number;
  max: number;
  step: number;
  current: number;
};

export type LiveQrScannerHandle = {
  stop: () => Promise<void>;
  clear: () => Promise<void>;
  destroy: () => Promise<void>;
  /** Áp dụng zoom kỹ thuật số (clamp theo capability). */
  setZoom: (zoom: number) => Promise<boolean>;
  getZoomCaps: () => ScannerZoomCaps;
  /** Đổi ống kính sau (wide / ultrawide / main…). */
  switchCamera: () => Promise<boolean>;
  getCameraLabel: () => string;
  getCameraCount: () => number;
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
const FRONT_LABEL = /front|user|facetime|selfie|trước|avant|frontal/i;
const WIDE_LABEL = /wide|ultra|0\.5|góc rộng|ultrawide|macro/i;
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

/** QR + barcode 1D thường gặp trên phiếu gửi / vận đơn Shopee. */
const DETECTOR_FORMATS = [
  'qr_code',
  'code_128',
  'code_39',
  'code_93',
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'itf',
  'codabar',
] as const;

function createBarcodeDetector(): { detector: BarcodeDetectorLike; qrOnly: boolean } | null {
  try {
    if (typeof window === 'undefined' || !window.BarcodeDetector) return null;
    try {
      return {
        detector: new window.BarcodeDetector({ formats: [...DETECTOR_FORMATS] }),
        qrOnly: false,
      };
    } catch {
      // Một số trình duyệt chỉ hỗ trợ qr_code — vẫn dùng + ZXing bù barcode 1D.
      try {
        return {
          detector: new window.BarcodeDetector({ formats: ['qr_code'] }),
          qrOnly: true,
        };
      } catch {
        return null;
      }
    }
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

/** Ưu tiên ống kính sau; loại selfie. Ultrawide/macro trước (quét gần tốt trên flagship). */
function listRearCameras(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
  if (!devices.length) return [];
  const rear = devices.filter((d) => {
    const label = d.label || '';
    if (FRONT_LABEL.test(label)) return false;
    return REAR_LABEL.test(label) || !label;
  });
  const pool = rear.length ? rear : devices.filter((d) => !FRONT_LABEL.test(d.label || ''));
  const list = pool.length ? pool : devices;

  const score = (d: MediaDeviceInfo) => {
    const label = d.label || '';
    if (WIDE_LABEL.test(label)) return 0;
    if (TELE_LABEL.test(label)) return 3;
    if (REAR_LABEL.test(label)) return 1;
    return 2;
  };
  return [...list].sort((a, b) => score(a) - score(b));
}

function pickRearDeviceId(devices: MediaDeviceInfo[]): string | undefined {
  return listRearCameras(devices)[0]?.deviceId;
}

function readZoomCaps(track: MediaStreamTrack | null | undefined): ScannerZoomCaps {
  const empty: ScannerZoomCaps = {
    supported: false,
    min: 1,
    max: 1,
    step: 0.1,
    current: 1,
  };
  if (!track) return empty;
  try {
    const caps = (
      typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}
    ) as ExtendedCaps;
    const settings =
      typeof track.getSettings === 'function' ? (track.getSettings() as { zoom?: number }) : {};
    if (!caps.zoom || !(caps.zoom.max > caps.zoom.min)) return empty;
    return {
      supported: true,
      min: Number(caps.zoom.min) || 1,
      max: Number(caps.zoom.max) || 1,
      step: Number(caps.zoom.step) || 0.1,
      current: Number(settings.zoom ?? caps.zoom.min) || caps.zoom.min,
    };
  } catch {
    return empty;
  }
}

function clampZoom(value: number, caps: ScannerZoomCaps): number {
  if (!caps.supported) return value;
  const stepped =
    caps.step > 0
      ? Math.round((value - caps.min) / caps.step) * caps.step + caps.min
      : value;
  return Math.min(caps.max, Math.max(caps.min, stepped));
}

/** Constraints: camera sau + AF continuous (nếu browser nhận trong getUserMedia). */
function buildStreamConstraints(deviceId?: string): MediaStreamConstraints {
  const video: MediaTrackConstraints & Record<string, unknown> = {
    width: { ideal: CAPTURE_WIDTH },
    height: { ideal: CAPTURE_HEIGHT },
    frameRate: { ideal: 30, max: 30 },
    ...(deviceId
      ? { deviceId: { exact: deviceId } }
      : { facingMode: { ideal: 'environment' } }),
    // Non-standard — Chromium có thể nhận; Safari cũ bỏ qua.
    focusMode: 'continuous',
    zoom: DEFAULT_SCAN_ZOOM,
  };
  return { audio: false, video: video as MediaTrackConstraints };
}

async function openCameraStream(preferredDeviceId?: string): Promise<MediaStream> {
  const devices = await listVideoInputDevices();
  const rearId = preferredDeviceId || pickRearDeviceId(devices);
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

async function openRearCameraStream(): Promise<MediaStream> {
  return openCameraStream();
}

async function applyTrackConstraintSafe(
  track: MediaStreamTrack,
  constraint: Record<string, unknown>,
): Promise<boolean> {
  if (!track?.applyConstraints) return false;
  try {
    await track.applyConstraints({ advanced: [constraint] } as unknown as MediaTrackConstraints);
    return true;
  } catch {
    try {
      await track.applyConstraints(constraint as unknown as MediaTrackConstraints);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Continuous AF + exposure + zoom mặc định 2x (clamp theo capability).
 * Mọi API zoom/ImageCapture-related đều bọc try/catch — không crash iOS Safari cũ.
 */
async function applyContinuousFocusAndExposure(
  track: MediaStreamTrack,
  preferredZoom: number = DEFAULT_SCAN_ZOOM,
): Promise<void> {
  if (!track?.applyConstraints) return;

  let caps: ExtendedCaps = {};
  try {
    caps = (
      typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}
    ) as ExtendedCaps;
  } catch {
    caps = {};
  }

  // focusMode: continuous (ưu tiên) → auto
  if (caps.focusMode?.includes('continuous')) {
    await applyTrackConstraintSafe(track, { focusMode: 'continuous' });
  } else if (caps.focusMode?.includes('auto')) {
    await applyTrackConstraintSafe(track, { focusMode: 'auto' });
  }

  // Zoom kỹ thuật số — default 2.0 giúp flagship đứng xa vẫn đọc barcode.
  try {
    if (caps.zoom && caps.zoom.max > caps.zoom.min) {
      const zoomCaps: ScannerZoomCaps = {
        supported: true,
        min: caps.zoom.min,
        max: caps.zoom.max,
        step: caps.zoom.step || 0.1,
        current: caps.zoom.min,
      };
      const target = clampZoom(preferredZoom, zoomCaps);
      await applyTrackConstraintSafe(track, { zoom: target });
    }
  } catch {
    /* Zoom không support — bỏ qua */
  }

  if (caps.exposureMode?.includes('continuous')) {
    await applyTrackConstraintSafe(track, { exposureMode: 'continuous' });
  } else if (caps.exposureMode?.includes('auto')) {
    await applyTrackConstraintSafe(track, { exposureMode: 'auto' });
  }

  // Bù sáng nhẹ nếu tối (QR trên phiếu in).
  if (caps.exposureCompensation) {
    const { min, max } = caps.exposureCompensation;
    const bias = Math.min(max, Math.max(min, 0.3));
    await applyTrackConstraintSafe(track, { exposureCompensation: bias });
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

  const zoomCaps = readZoomCaps(track);
  await applyContinuousFocusAndExposure(track, zoomCaps.current || DEFAULT_SCAN_ZOOM);
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
  if (track) {
    const zoomCaps = readZoomCaps(track);
    await applyContinuousFocusAndExposure(track, zoomCaps.current || DEFAULT_SCAN_ZOOM);
  }
}

/** Áp zoom lên track đang active của scanner container (safe). */
export async function applyScannerZoom(
  scannerElementId: string,
  zoom: number,
): Promise<boolean> {
  try {
    const video = document.querySelector(`#${scannerElementId} video`) as HTMLVideoElement | null;
    const track = (video?.srcObject as MediaStream | null)?.getVideoTracks()?.[0];
    if (!track) return false;
    const caps = readZoomCaps(track);
    if (!caps.supported) return false;
    const target = clampZoom(zoom, caps);
    return applyTrackConstraintSafe(track, { zoom: target });
  } catch {
    return false;
  }
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
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.QR_CODE,
    BarcodeFormat.CODE_128,
    BarcodeFormat.CODE_39,
    BarcodeFormat.CODE_93,
    BarcodeFormat.EAN_13,
    BarcodeFormat.EAN_8,
    BarcodeFormat.UPC_A,
    BarcodeFormat.UPC_E,
    BarcodeFormat.ITF,
    BarcodeFormat.CODABAR,
  ]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  return new BrowserMultiFormatReader(hints, {
    delayBetweenScanAttempts: ZXING_INTERVAL_MS,
    delayBetweenScanSuccess: 400,
  });
}

/**
 * Khởi động quét QR + barcode 1D realtime (song song).
 * Engine: BarcodeDetector (ML Kit) + ZXing chạy cùng lúc — không chỉ QR.
 */
export async function startLiveQrScanner(opts: {
  containerId: string;
  tapLayerId?: string;
  onSuccess: (decodedText: string) => void;
  onError?: (error: Error) => void;
  /** Gọi khi stream sẵn sàng / đổi camera / đổi zoom capability. */
  onCapabilities?: (info: {
    zoom: ScannerZoomCaps;
    cameraCount: number;
    cameraLabel: string;
  }) => void;
  preferredDeviceId?: string;
  preferredZoom?: number;
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

  let stream = await openCameraStream(opts.preferredDeviceId);
  video.srcObject = stream;
  await video.play().catch(() => undefined);

  const devices = await listVideoInputDevices();
  const rearCameras = listRearCameras(devices);
  let cameraIndex = 0;
  const activeDeviceId = stream.getVideoTracks()[0]?.getSettings?.()?.deviceId;
  if (activeDeviceId) {
    const idx = rearCameras.findIndex((d) => d.deviceId === activeDeviceId);
    if (idx >= 0) cameraIndex = idx;
  }

  let currentZoom = opts.preferredZoom ?? DEFAULT_SCAN_ZOOM;

  const notifyCaps = () => {
    try {
      const track = stream.getVideoTracks()[0];
      opts.onCapabilities?.({
        zoom: readZoomCaps(track),
        cameraCount: Math.max(rearCameras.length, 1),
        cameraLabel: rearCameras[cameraIndex]?.label || track?.label || 'Camera',
      });
    } catch {
      /* ignore */
    }
  };

  const warmUpFocus = (track: MediaStreamTrack | undefined) => {
    if (!track) return;
    void applyContinuousFocusAndExposure(track, currentZoom);
    window.setTimeout(() => {
      void applyContinuousFocusAndExposure(track, currentZoom);
    }, 400);
    window.setTimeout(() => {
      void applyContinuousFocusAndExposure(track, currentZoom);
    }, 1200);
  };

  warmUpFocus(stream.getVideoTracks()[0]);
  notifyCaps();

  if (opts.tapLayerId) {
    startTapToFocusAssist(opts.containerId, opts.tapLayerId);
  }

  const detectorInfo = createBarcodeDetector();
  const detector = detectorInfo?.detector ?? null;
  const canvas = document.createElement('canvas');
  let stopped = false;
  let detectorBusy = false;
  let zxingBusy = false;
  let lastDetectorAt = 0;
  let lastZxingAt = 0;
  let lastEmittedKey = '';
  let lastEmittedAt = 0;
  let rafId = 0;
  let zxingRafId = 0;
  let zxingReader: BrowserMultiFormatReader | null = null;
  let zxingControls: { stop: () => void } | null = null;

  const emitSuccess = (text: string) => {
    const trimmed = String(text || '').trim();
    if (!trimmed || stopped) return;
    const key = trimmed.toUpperCase().replace(/[\s\-_]+/g, '');
    const now = Date.now();
    // Debounce cùng mã từ 2 engine (QR + barcode) trong 900ms.
    if (key === lastEmittedKey && now - lastEmittedAt < 900) return;
    lastEmittedKey = key;
    lastEmittedAt = now;
    opts.onSuccess(trimmed);
  };

  const loopDetect = async () => {
    if (stopped) return;
    rafId = requestAnimationFrame(() => {
      void loopDetect();
    });

    const now = performance.now();
    if (detectorBusy || now - lastDetectorAt < DETECTOR_INTERVAL_MS) return;
    if (video.readyState < 2) return;

    detectorBusy = true;
    lastDetectorAt = now;
    try {
      if (!detector) return;
      // Ưu tiên detect trực tiếp trên video (độ phân giải gốc) — barcode 1D cần độ rộng.
      let codes: Array<{ rawValue?: string }> = [];
      try {
        codes = await detector.detect(video);
      } catch {
        const ctx = drawDownscaledFrame(video, canvas);
        if (ctx) codes = await detector.detect(canvas);
      }
      const value = codes?.[0]?.rawValue;
      if (value) emitSuccess(value);
    } catch {
      /* frame skip */
    } finally {
      detectorBusy = false;
    }
  };

  const startZxingCanvasPoll = (reader: BrowserMultiFormatReader) => {
    const canvasLoop = async () => {
      if (stopped) return;
      zxingRafId = requestAnimationFrame(() => {
        void canvasLoop();
      });
      const now = performance.now();
      if (zxingBusy || now - lastZxingAt < ZXING_INTERVAL_MS) return;
      if (video.readyState < 2) return;
      zxingBusy = true;
      lastZxingAt = now;
      try {
        drawDownscaledFrame(video, canvas);
        const result = reader.decodeFromCanvas(canvas);
        if (result) emitSuccess(result.getText());
      } catch {
        /* NotFoundException mỗi frame — bình thường */
      } finally {
        zxingBusy = false;
      }
    };
    void canvasLoop();
  };

  const startZxingParallel = async () => {
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
      console.warn('[QR Scanner] ZXing video element failed, using canvas poll', err);
      if (zxingReader) startZxingCanvasPoll(zxingReader);
    }
  };

  // Luôn chạy ZXing (barcode 1D + QR). BarcodeDetector chạy song song nếu có.
  if (detector) {
    console.log(
      `[QR Scanner] Engine: BarcodeDetector${detectorInfo?.qrOnly ? ' (qr-only)' : ' (QR+1D)'} + ZXing parallel`,
    );
    void loopDetect();
    void startZxingParallel();
  } else {
    console.log('[QR Scanner] Engine: ZXing continuous (QR + barcode 1D)');
    void startZxingParallel();
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
      cancelAnimationFrame(zxingRafId);
      if (opts.tapLayerId) stopTapToFocusAssist(opts.tapLayerId);
      await teardownDom();
    },
    clear: async () => {
      await handle.stop();
    },
    destroy: async () => {
      await handle.stop();
    },
    setZoom: async (zoom: number) => {
      try {
        if (stopped) return false;
        const track = stream.getVideoTracks()[0];
        if (!track) return false;
        const caps = readZoomCaps(track);
        if (!caps.supported) return false;
        const target = clampZoom(zoom, caps);
        const ok = await applyTrackConstraintSafe(track, { zoom: target });
        if (ok) currentZoom = target;
        notifyCaps();
        return ok;
      } catch {
        return false;
      }
    },
    getZoomCaps: () => {
      try {
        return readZoomCaps(stream.getVideoTracks()[0]);
      } catch {
        return {
          supported: false,
          min: 1,
          max: 1,
          step: 0.1,
          current: 1,
        };
      }
    },
    switchCamera: async () => {
      try {
        if (stopped) return false;
        const cams = rearCameras.length
          ? rearCameras
          : listRearCameras(await listVideoInputDevices());
        if (cams.length < 2) return false;
        cameraIndex = (cameraIndex + 1) % cams.length;
        const nextId = cams[cameraIndex]?.deviceId;
        if (!nextId) return false;

        const nextStream = await openCameraStream(nextId);
        const oldTracks = stream.getTracks();
        stream = nextStream;
        video.srcObject = nextStream;
        await video.play().catch(() => undefined);
        oldTracks.forEach((t) => {
          try {
            t.stop();
          } catch {
            /* ignore */
          }
        });
        warmUpFocus(stream.getVideoTracks()[0]);
        notifyCaps();
        return true;
      } catch (err) {
        console.warn('[QR Scanner] switchCamera failed:', err);
        return false;
      }
    },
    getCameraLabel: () => {
      try {
        return (
          rearCameras[cameraIndex]?.label ||
          stream.getVideoTracks()[0]?.label ||
          'Camera'
        );
      } catch {
        return 'Camera';
      }
    },
    getCameraCount: () => Math.max(rearCameras.length, 1),
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
