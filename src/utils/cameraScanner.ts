import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';

export const HTTPS_CAMERA_MESSAGE = 'Vui lòng truy cập qua HTTPS để sử dụng camera';

/** Khoảng cách quét mục tiêu: 15–20 cm */
const CLOSE_FOCUS_METERS = 0.17;

export const REAR_CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { ideal: 'environment' },
};

export const QR_ONLY_FORMATS = [Html5QrcodeSupportedFormats.QR_CODE];

export const QR_SCANNER_CONFIG = {
  fps: 18,
  qrbox: (width: number, height: number) => {
    const minEdge = Math.min(width, height);
    const size = Math.floor(minEdge * 0.58);
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
  focusDistance?: { min: number; max: number; step?: number };
  zoom?: { min: number; max: number; step?: number };
  torch?: boolean;
};

const REAR_LABEL = /back|rear|environment|后置|後鏡|sau|arrière|trás|wide/i;

const focusAssistStops = new Map<string, () => void>();

function pickRearCameraId(cameras: { id: string; label: string }[]): string | null {
  if (!cameras.length) return null;
  const byLabel = cameras.find((c) => REAR_LABEL.test(c.label));
  if (byLabel) return byLabel.id;
  if (cameras.length === 1) return cameras[0].id;
  return cameras[cameras.length - 1].id;
}

async function buildCameraStartConfigs(): Promise<CameraStartConfig[]> {
  const configs: CameraStartConfig[] = [];
  try {
    const cameras = await Html5Qrcode.getCameras();
    const rearId = pickRearCameraId(cameras);
    if (rearId) configs.push(rearId);
    for (const cam of cameras) {
      if (!configs.includes(cam.id)) configs.push(cam.id);
    }
  } catch {
    /* fallback facingMode */
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

function clampFocusDistance(caps: ExtendedCaps): number {
  const fd = caps.focusDistance;
  if (!fd) return CLOSE_FOCUS_METERS;
  return Math.min(fd.max, Math.max(fd.min, CLOSE_FOCUS_METERS));
}

function closeRangeZoom(caps: ExtendedCaps): number | null {
  const z = caps.zoom;
  if (!z || z.max <= z.min) return null;
  return Math.min(z.max, z.min + (z.max - z.min) * 0.32);
}

/** Lấy nét gần 15–20 cm: focusDistance + continuous AF + zoom nhẹ. */
async function applyCloseRangeFocus(scannerElementId: string): Promise<void> {
  const video = await waitForScannerVideo(scannerElementId);
  const track = (video?.srcObject as MediaStream | null)?.getVideoTracks()?.[0];
  if (!track?.applyConstraints) return;

  const caps = (typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}) as ExtendedCaps;
  const focusDistance = clampFocusDistance(caps);
  const zoom = closeRangeZoom(caps);

  const attempts: MediaTrackConstraints[] = [];

  if (caps.focusDistance) {
    attempts.push({
      advanced: [
        { focusMode: 'continuous' },
        { focusDistance },
        ...(zoom != null ? [{ zoom }] : []),
      ] as MediaTrackConstraintSet[],
    });
    attempts.push({ focusDistance } as MediaTrackConstraints);
  }

  if (caps.focusMode?.includes('continuous')) {
    attempts.push({
      advanced: [
        { focusMode: 'continuous' },
        ...(zoom != null ? [{ zoom }] : []),
      ] as MediaTrackConstraintSet[],
    });
  } else if (caps.focusMode?.includes('auto')) {
    attempts.push({ advanced: [{ focusMode: 'auto' }] } as MediaTrackConstraints);
  }

  if (zoom != null) {
    attempts.push({ advanced: [{ zoom }] } as MediaTrackConstraints);
  }

  try {
    await track.applyConstraints({ width: { ideal: 1920 }, height: { ideal: 1080 } });
  } catch {
    /* ignore */
  }

  for (const c of attempts) {
    try {
      await track.applyConstraints(c);
      return;
    } catch {
      /* thử cấu hình tiếp theo */
    }
  }
}

export function stopCloseRangeFocusAssist(scannerElementId: string): void {
  focusAssistStops.get(scannerElementId)?.();
  focusAssistStops.delete(scannerElementId);
}

/** Giữ lấy nét gần: chạm màn hình + nhắc AF định kỳ. */
export function startCloseRangeFocusAssist(scannerElementId: string): void {
  stopCloseRangeFocusAssist(scannerElementId);

  const onTap = () => {
    void applyCloseRangeFocus(scannerElementId);
  };

  const root = document.getElementById(scannerElementId);
  root?.addEventListener('click', onTap);
  root?.addEventListener('touchstart', onTap, { passive: true });

  void applyCloseRangeFocus(scannerElementId);

  const intervalId = window.setInterval(() => {
    void applyCloseRangeFocus(scannerElementId);
  }, 2000);

  focusAssistStops.set(scannerElementId, () => {
    clearInterval(intervalId);
    root?.removeEventListener('click', onTap);
    root?.removeEventListener('touchstart', onTap);
  });
}

export async function applyScannerAutofocus(scannerElementId: string): Promise<void> {
  await applyCloseRangeFocus(scannerElementId);
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
): Promise<void> {
  const blocked = getCameraBlockedReason();
  if (blocked) throw new Error(blocked);

  if (scannerElementId) stopCloseRangeFocusAssist(scannerElementId);

  if (html5Qrcode.isScanning) {
    await html5Qrcode.stop().catch(() => undefined);
  }

  const fallbacks = await buildCameraStartConfigs();
  let lastError: unknown;

  for (let i = 0; i < fallbacks.length; i++) {
    const cameraConfig = fallbacks[i];
    try {
      await html5Qrcode.start(cameraConfig, config, onSuccess, onScanFailure);
      if (scannerElementId) startCloseRangeFocusAssist(scannerElementId);
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
