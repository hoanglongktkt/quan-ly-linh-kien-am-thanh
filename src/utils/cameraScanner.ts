import type { Html5Qrcode } from 'html5-qrcode';
import { Html5QrcodeSupportedFormats } from 'html5-qrcode';

export const HTTPS_CAMERA_MESSAGE = 'Vui lòng truy cập qua HTTPS để sử dụng camera';

export const REAR_CAMERA_CONSTRAINTS = { facingMode: { exact: 'environment' as const } };

export const QR_ONLY_FORMATS = [Html5QrcodeSupportedFormats.QR_CODE];

export const QR_SCANNER_CONFIG = {
  fps: 20,
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

/** Returns a user-facing block reason, or null if camera may be used. */
export function getCameraBlockedReason(): string | null {
  if (typeof window === 'undefined') return null;
  if (isMobileDevice() && !window.isSecureContext) {
    return HTTPS_CAMERA_MESSAGE;
  }
  return null;
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

const CAMERA_CONSTRAINTS_FALLBACK = [
  { facingMode: { exact: 'environment' as const } },
  { facingMode: 'environment' as const },
  { facingMode: 'user' as const },
];

export async function startRearCameraScanner(
  html5Qrcode: Html5Qrcode,
  config: {
    fps: number;
    qrbox: (w: number, h: number) => { width: number; height: number };
    aspectRatio?: number;
    disableFlip?: boolean;
  },
  onSuccess: (decodedText: string) => void,
  onScanFailure: (error: string) => void
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
  for (const constraints of CAMERA_CONSTRAINTS_FALLBACK) {
    try {
      await html5Qrcode.start(constraints, config, onSuccess, onScanFailure);
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
