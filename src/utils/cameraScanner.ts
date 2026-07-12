import type { Html5Qrcode } from 'html5-qrcode';
import { Html5QrcodeSupportedFormats } from 'html5-qrcode';

export const HTTPS_CAMERA_MESSAGE = 'Vui lòng truy cập qua HTTPS để sử dụng camera';

/** Camera sau + độ phân giải cao + lấy nét liên tục (quét gần 10–15cm). */
export const REAR_CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { exact: 'environment' },
  width: { ideal: 1920, min: 1280 },
  height: { ideal: 1080, min: 720 },
  aspectRatio: { ideal: 16 / 9 },
  frameRate: { ideal: 30, min: 20 },
  advanced: [{ focusMode: 'continuous' }] as MediaTrackConstraintSet[],
};

export const QR_ONLY_FORMATS = [Html5QrcodeSupportedFormats.QR_CODE];

export const QR_SCANNER_CONFIG = {
  fps: 24,
  qrbox: (width: number, height: number) => {
    const minEdge = Math.min(width, height);
    const size = Math.floor(minEdge * 0.82);
    return { width: size, height: Math.floor(size * 0.55) };
  },
  aspectRatio: 1.777,
  disableFlip: false,
};

export function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

/** Returns a user-facing block reason, or null if camera may be used. */
export function getCameraBlockedReason(): string | null {
  if (typeof window === 'undefined') return null;
  if (isMobileDevice() && !window.isSecureContext) {
    return HTTPS_CAMERA_MESSAGE;
  }
  return null;
}

function buildCameraConstraintsFallback(): MediaTrackConstraints[] {
  const withFocus = (facing: MediaTrackConstraints['facingMode']) =>
    ({
      facingMode: facing,
      width: { ideal: 1920, min: 1280 },
      height: { ideal: 1080, min: 720 },
      aspectRatio: { ideal: 16 / 9 },
      frameRate: { ideal: 30, min: 20 },
      advanced: [{ focusMode: 'continuous' }] as MediaTrackConstraintSet[],
    }) satisfies MediaTrackConstraints;

  return [
    withFocus({ exact: 'environment' }),
    withFocus('environment'),
    {
      facingMode: 'environment',
      width: { ideal: 1280 },
      height: { ideal: 720 },
      advanced: [{ focusMode: 'continuous' }, { focusMode: 'auto' }] as MediaTrackConstraintSet[],
    },
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

/** Kích hoạt autofocus liên tục sau khi stream đã chạy. */
export async function applyScannerAutofocus(scannerElementId: string): Promise<void> {
  const video = await waitForScannerVideo(scannerElementId);
  const track = (video?.srcObject as MediaStream | null)?.getVideoTracks()?.[0];
  if (!track?.applyConstraints) return;

  type FocusCaps = MediaTrackCapabilities & { focusMode?: string[]; zoom?: { min: number; max: number } };
  const caps = (typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}) as FocusCaps;

  if (caps.focusMode?.includes('continuous')) {
    try {
      await track.applyConstraints({
        advanced: [{ focusMode: 'continuous' }],
      } as MediaTrackConstraints);
    } catch {
      /* trình duyệt không hỗ trợ */
    }
  } else if (caps.focusMode?.includes('auto')) {
    try {
      await track.applyConstraints({
        advanced: [{ focusMode: 'auto' }],
      } as MediaTrackConstraints);
    } catch {
      /* ignore */
    }
  }

  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    try {
      const zoom = Math.min(caps.zoom.max, caps.zoom.min + (caps.zoom.max - caps.zoom.min) * 0.12);
      await track.applyConstraints({
        advanced: [{ zoom }],
      } as MediaTrackConstraints);
    } catch {
      /* ignore */
    }
  }
}

export async function requestRearCameraPermission(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Trình duyệt không hỗ trợ truy cập camera.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: REAR_CAMERA_CONSTRAINTS,
  });
  stream.getTracks().forEach((track) => track.stop());
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

  await requestRearCameraPermission();

  if (html5Qrcode.isScanning) {
    await html5Qrcode.stop().catch(() => undefined);
  }

  let lastError: unknown;
  for (const constraints of buildCameraConstraintsFallback()) {
    try {
      await html5Qrcode.start(constraints, config, onSuccess, onScanFailure);
      if (scannerElementId) {
        await applyScannerAutofocus(scannerElementId);
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
