import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';

export const HTTPS_CAMERA_MESSAGE = 'Vui lòng truy cập qua HTTPS để sử dụng camera';

export const REAR_CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { ideal: 'environment' },
};

export const QR_ONLY_FORMATS = [Html5QrcodeSupportedFormats.QR_CODE];

export const QR_SCANNER_CONFIG = {
  fps: 15,
  qrbox: (width: number, height: number) => {
    const minEdge = Math.min(width, height);
    const size = Math.floor(minEdge * 0.72);
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

const REAR_LABEL = /back|rear|environment|后置|後鏡|sau|arrière|trás/i;

function pickRearCameraId(cameras: { id: string; label: string }[]): string | null {
  if (!cameras.length) return null;
  const byLabel = cameras.find((c) => REAR_LABEL.test(c.label));
  if (byLabel) return byLabel.id;
  if (cameras.length === 1) return cameras[0].id;
  // Android: camera sau thường là thiết bị cuối trong danh sách
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
    /* chưa có quyền hoặc trình duyệt không hỗ trợ liệt kê — fallback facingMode */
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

async function enhanceScannerTrack(scannerElementId: string): Promise<void> {
  const video = await waitForScannerVideo(scannerElementId);
  const track = (video?.srcObject as MediaStream | null)?.getVideoTracks()?.[0];
  if (!track?.applyConstraints) return;

  type FocusCaps = MediaTrackCapabilities & { focusMode?: string[]; zoom?: { min: number; max: number } };
  const caps = (typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}) as FocusCaps;

  try {
    await track.applyConstraints({
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    });
  } catch {
    /* ignore */
  }

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
}

export async function applyScannerAutofocus(scannerElementId: string): Promise<void> {
  await enhanceScannerTrack(scannerElementId);
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

  if (html5Qrcode.isScanning) {
    await html5Qrcode.stop().catch(() => undefined);
  }

  const fallbacks = await buildCameraStartConfigs();
  let lastError: unknown;

  for (let i = 0; i < fallbacks.length; i++) {
    const cameraConfig = fallbacks[i];
    try {
      // #region agent log
      fetch('http://127.0.0.1:7554/ingest/bc993c61-1b63-4f42-8c97-c42133e3ec03', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '809c09' },
        body: JSON.stringify({
          sessionId: '809c09',
          hypothesisId: 'H2',
          location: 'cameraScanner.ts:start',
          message: 'try camera config',
          data: {
            index: i,
            type: typeof cameraConfig === 'string' ? 'deviceId' : 'facingMode',
            value: typeof cameraConfig === 'string' ? cameraConfig.slice(0, 12) : cameraConfig.facingMode,
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion

      await html5Qrcode.start(cameraConfig, config, onSuccess, onScanFailure);

      // #region agent log
      fetch('http://127.0.0.1:7554/ingest/bc993c61-1b63-4f42-8c97-c42133e3ec03', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '809c09' },
        body: JSON.stringify({
          sessionId: '809c09',
          hypothesisId: 'H2',
          location: 'cameraScanner.ts:start',
          message: 'camera started ok',
          data: { index: i },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion

      if (scannerElementId) void enhanceScannerTrack(scannerElementId);
      return;
    } catch (err) {
      lastError = err;
      // #region agent log
      fetch('http://127.0.0.1:7554/ingest/bc993c61-1b63-4f42-8c97-c42133e3ec03', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '809c09' },
        body: JSON.stringify({
          sessionId: '809c09',
          hypothesisId: 'H2',
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
