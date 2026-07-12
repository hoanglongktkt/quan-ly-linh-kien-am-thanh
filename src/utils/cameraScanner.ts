import type { Html5Qrcode } from 'html5-qrcode';
import { Html5QrcodeSupportedFormats } from 'html5-qrcode';

export const HTTPS_CAMERA_MESSAGE = 'Vui lòng truy cập qua HTTPS để sử dụng camera';

/** Quyền camera — constraints mềm (không dùng advanced/min, tránh fail trước khi mở stream). */
export const REAR_CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { ideal: 'environment' },
  width: { ideal: 1920 },
  height: { ideal: 1080 },
};

export const QR_ONLY_FORMATS = [Html5QrcodeSupportedFormats.QR_CODE];

export const QR_SCANNER_CONFIG = {
  fps: 20,
  qrbox: (width: number, height: number) => {
    const minEdge = Math.min(width, height);
    const size = Math.floor(minEdge * 0.78);
    return { width: size, height: Math.floor(size * 0.6) };
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

/** html5-qrcode.start — không dùng advanced/focusMode ở đây (apply sau khi stream chạy). */
function buildCameraConstraintsFallback(): MediaTrackConstraints[] {
  return [
    { facingMode: { exact: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
    { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    { facingMode: 'environment' },
    { facingMode: 'user' },
  ];
}

async function waitForScannerVideo(scannerElementId: string): Promise<HTMLVideoElement | null> {
  for (let i = 0; i < 40; i++) {
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

/** Lấy nét liên tục sau khi camera đã mở (không chặn khởi động). */
export async function applyScannerAutofocus(scannerElementId: string): Promise<void> {
  const video = await waitForScannerVideo(scannerElementId);
  const track = (video?.srcObject as MediaStream | null)?.getVideoTracks()?.[0];
  if (!track?.applyConstraints) return;

  type FocusCaps = MediaTrackCapabilities & { focusMode?: string[]; zoom?: { min: number; max: number } };
  const caps = (typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}) as FocusCaps;

  if (caps.focusMode?.includes('continuous')) {
    try {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] } as MediaTrackConstraints);
    } catch {
      /* ignore */
    }
  } else if (caps.focusMode?.includes('auto')) {
    try {
      await track.applyConstraints({ advanced: [{ focusMode: 'auto' }] } as MediaTrackConstraints);
    } catch {
      /* ignore */
    }
  }

  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    try {
      const zoom = Math.min(caps.zoom.max, caps.zoom.min + (caps.zoom.max - caps.zoom.min) * 0.1);
      await track.applyConstraints({ advanced: [{ zoom }] } as MediaTrackConstraints);
    } catch {
      /* ignore */
    }
  }
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
  if (blocked) {
    throw new Error(blocked);
  }

  if (html5Qrcode.isScanning) {
    await html5Qrcode.stop().catch(() => undefined);
  }

  let lastError: unknown;
  const fallbacks = buildCameraConstraintsFallback();

  for (let i = 0; i < fallbacks.length; i++) {
    const constraints = fallbacks[i];
    try {
      // #region agent log
      fetch('http://127.0.0.1:7554/ingest/bc993c61-1b63-4f42-8c97-c42133e3ec03', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '809c09' },
        body: JSON.stringify({
          sessionId: '809c09',
          hypothesisId: 'H1',
          location: 'cameraScanner.ts:start',
          message: 'try camera constraints',
          data: { index: i, facingMode: constraints.facingMode },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion

      await html5Qrcode.start(constraints, config, onSuccess, onScanFailure);

      // #region agent log
      fetch('http://127.0.0.1:7554/ingest/bc993c61-1b63-4f42-8c97-c42133e3ec03', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '809c09' },
        body: JSON.stringify({
          sessionId: '809c09',
          hypothesisId: 'H1',
          location: 'cameraScanner.ts:start',
          message: 'camera started',
          data: { index: i },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion

      if (scannerElementId) {
        void applyScannerAutofocus(scannerElementId);
      }
      return;
    } catch (err) {
      lastError = err;
      // #region agent log
      fetch('http://127.0.0.1:7554/ingest/bc993c61-1b63-4f42-8c97-c42133e3ec03', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '809c09' },
        body: JSON.stringify({
          sessionId: '809c09',
          hypothesisId: 'H1',
          location: 'cameraScanner.ts:start',
          message: 'camera start failed',
          data: { index: i, err: err instanceof Error ? err.message : String(err) },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      if (html5Qrcode.isScanning) {
        await html5Qrcode.stop().catch(() => undefined);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Không thể khởi động camera.');
}
