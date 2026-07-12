import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';

export const HTTPS_CAMERA_MESSAGE = 'Vui lòng truy cập qua HTTPS để sử dụng camera';

export const CAMERA_TAP_LAYER_ID = 'camera-tap-focus';
export const PICKING_CAMERA_TAP_LAYER_ID = 'picking-camera-tap-focus';

export const REAR_CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { ideal: 'environment' },
};

export const QR_ONLY_FORMATS = [Html5QrcodeSupportedFormats.QR_CODE];

export const QR_SCANNER_CONFIG = {
  fps: 15,
  qrbox: (width: number, height: number) => {
    const minEdge = Math.min(width, height);
    const size = Math.floor(minEdge * 0.7);
    return { width: size, height: size };
  },
  aspectRatio: 1.0,
  disableFlip: false,
};

export function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

export function getCameraBlockedReason(): string | null {
  if (typeof window === 'undefined') return null;
  if (isMobileDevice() && !window.isSecureContext) {
    return HTTPS_CAMERA_MESSAGE;
  }
  return null;
}

type CameraStartConfig = string | { facingMode: 'environment' | 'user' };

type ExtendedCaps = MediaTrackCapabilities & {
  focusMode?: string[];
  zoom?: { min: number; max: number; step?: number };
};

const REAR_LABEL = /back|rear|environment|后置|後鏡|sau|arrière|trás/i;
const WIDE_LABEL = /wide|ultra|0\.5|góc rộng/i;
const TELE_LABEL = /tele|zoom|2x|3x|5x|periscope|telephoto/i;

const tapFocusStops = new Map<string, () => void>();

function pickRearCameraId(cameras: { id: string; label: string }[]): string | null {
  if (!cameras.length) return null;
  const label = (c: { label: string }) => c.label || '';
  const nonTele = cameras.filter((c) => !TELE_LABEL.test(label(c)));
  const list = nonTele.length ? nonTele : cameras;

  const wide = list.find((c) => WIDE_LABEL.test(label(c)));
  if (wide) return wide.id;

  const back = list.find((c) => REAR_LABEL.test(label(c)) && !TELE_LABEL.test(label(c)));
  if (back) return back.id;

  if (list.length === 1) return list[0].id;
  return list[list.length - 1].id;
}

async function buildCameraStartConfigs(): Promise<CameraStartConfig[]> {
  const configs: CameraStartConfig[] = [];
  try {
    const cameras = await Html5Qrcode.getCameras();
    const rearId = pickRearCameraId(cameras);
    if (rearId) configs.push(rearId);
    for (const cam of cameras) {
      if (!TELE_LABEL.test(cam.label || '') && !configs.includes(cam.id)) {
        configs.push(cam.id);
      }
    }
  } catch {
    /* fallback */
  }
  configs.push({ facingMode: 'environment' });
  configs.push({ facingMode: 'user' });
  return configs;
}

async function waitForScannerVideo(scannerElementId: string): Promise<HTMLVideoElement | null> {
  for (let i = 0; i < 60; i++) {
    const video = document.querySelector(`#${scannerElementId} video`) as HTMLVideoElement | null;
    if (video?.srcObject) {
      if (video.readyState < 2) {
        await new Promise<void>((resolve) => {
          video.addEventListener('loadedmetadata', () => resolve(), { once: true });
        });
      }
      return video;
    }
    await new Promise((r) => requestAnimationFrame(r));
  }
  return null;
}

async function getVideoTrack(scannerElementId: string): Promise<MediaStreamTrack | null> {
  const video = await waitForScannerVideo(scannerElementId);
  return (video?.srcObject as MediaStream | null)?.getVideoTracks()?.[0] ?? null;
}

/** Góc rộng tối đa + AF liên tục — không zoom (zoom gây phải để máy xa ~60cm). */
async function applyWideContinuousAutofocus(scannerElementId: string): Promise<void> {
  const track = await getVideoTrack(scannerElementId);
  if (!track?.applyConstraints) return;

  const caps = (typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}) as ExtendedCaps;

  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    try {
      await track.applyConstraints({ advanced: [{ zoom: caps.zoom.min }] } as MediaTrackConstraints);
    } catch {
      /* ignore */
    }
  }

  if (caps.focusMode?.includes('continuous')) {
    try {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] } as MediaTrackConstraints);
      return;
    } catch {
      /* ignore */
    }
  }

  if (caps.focusMode?.includes('auto')) {
    try {
      await track.applyConstraints({ advanced: [{ focusMode: 'auto' }] } as MediaTrackConstraints);
    } catch {
      /* ignore */
    }
  }
}

/** Chạm lấy nét: single-shot → continuous (hoạt động trên Chrome/Android & Safari mới). */
export async function triggerTapToFocus(scannerElementId: string): Promise<void> {
  const track = await getVideoTrack(scannerElementId);
  if (!track?.applyConstraints) return;

  const caps = (typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}) as ExtendedCaps;

  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    try {
      await track.applyConstraints({ advanced: [{ zoom: caps.zoom.min }] } as MediaTrackConstraints);
    } catch {
      /* ignore */
    }
  }

  if (caps.focusMode?.includes('single-shot')) {
    try {
      await track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] } as MediaTrackConstraints);
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] } as MediaTrackConstraints);
      return;
    } catch {
      /* fallback */
    }
  }

  if (caps.focusMode?.includes('continuous')) {
    try {
      await track.applyConstraints({ advanced: [{ focusMode: 'manual' }] } as MediaTrackConstraints);
    } catch {
      /* ignore */
    }
    try {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] } as MediaTrackConstraints);
    } catch {
      /* ignore */
    }
  }
}

export function stopTapToFocusAssist(tapLayerId: string): void {
  tapFocusStops.get(tapLayerId)?.();
  tapFocusStops.delete(tapLayerId);
}

/** Lớp chạm riêng (pointer-events) — gắn vào nút trong suốt phủ camera. */
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

  void applyWideContinuousAutofocus(scannerElementId);

  tapFocusStops.set(tapLayerId, () => {
    layer?.removeEventListener('click', onTap);
    layer?.removeEventListener('touchend', onTap);
  });
}

/** @deprecated dùng stopTapToFocusAssist */
export function stopCloseRangeFocusAssist(_scannerElementId: string): void {
  stopTapToFocusAssist(CAMERA_TAP_LAYER_ID);
  stopTapToFocusAssist(PICKING_CAMERA_TAP_LAYER_ID);
}

export async function applyScannerAutofocus(scannerElementId: string): Promise<void> {
  await applyWideContinuousAutofocus(scannerElementId);
}

export async function startRearCameraScanner(
  html5Qrcode: Html5Qrcode,
  config: {
    fps: number;
    qrbox: (w: number, h: number) => { width: number; height: number };
    aspectRatio?: number;
    disableFlip?: boolean;
  },
  onSuccess: (decodedText: string) => void,
  onScanFailure: (error: string) => void,
  scannerElementId?: string,
  tapLayerId?: string,
): Promise<void> {
  const blocked = getCameraBlockedReason();
  if (blocked) throw new Error(blocked);

  if (tapLayerId) stopTapToFocusAssist(tapLayerId);

  if (html5Qrcode.isScanning) {
    await html5Qrcode.stop().catch(() => undefined);
  }

  const fallbacks = await buildCameraStartConfigs();
  let lastError: unknown;

  for (let i = 0; i < fallbacks.length; i++) {
    try {
      await html5Qrcode.start(fallbacks[i], config, onSuccess, onScanFailure);
      if (scannerElementId) {
        void applyWideContinuousAutofocus(scannerElementId);
        if (tapLayerId) startTapToFocusAssist(scannerElementId, tapLayerId);
      }
      return;
    } catch (err) {
      lastError = err;
      if (html5Qrcode.isScanning) {
        await html5Qrcode.stop().catch(() => undefined);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Không thể khởi động camera.');
}
