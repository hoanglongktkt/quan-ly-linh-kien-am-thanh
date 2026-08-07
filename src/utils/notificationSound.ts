/**
 * Phát âm thanh thông báo "tinh tinh" khi có đơn hàng mới.
 * Dùng Web Audio API (không cần file external) để tránh lỗi asset thiếu.
 */

let audioCtx: AudioContext | null = null;
let isAudioUnlocked = false;

/** Gọi 1 lần đầu tiên (vd: khi user click "Bật âm thanh") để unlock AudioContext. */
export function unlockAudio(): void {
  if (isAudioUnlocked) return;
  try {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    // Phát 1 âm thanh nhỏ để unlock
    const buf = audioCtx.createBuffer(1, 1, 22050);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start(0);
    isAudioUnlocked = true;
  } catch (e) {
    console.warn('[notificationSound] unlockAudio failed:', e);
  }
}

export function isAudioUnlockedState(): boolean {
  return isAudioUnlocked;
}

/** Phát tiếng "tinh tinh" 2 tone ngắt quãng. */
export function playNotificationSound(): void {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    const ctx = audioCtx;
    const now = ctx.currentTime;

    // Tone 1 – cao
    playTone(ctx, 880, now, 0.15, 0.4);
    // Tone 2 – cao hơn (delay nhẹ)
    playTone(ctx, 1100, now + 0.18, 0.15, 0.4);
    // Tone 3 – về thấp (kết thúc)
    playTone(ctx, 660, now + 0.36, 0.2, 0.3);
  } catch (e) {
    console.warn('[notificationSound] playNotificationSound failed:', e);
  }
}

function playTone(
  ctx: AudioContext,
  freq: number,
  startTime: number,
  duration: number,
  gain = 0.5,
): void {
  const osc = ctx.createOscillator();
  const gainNode = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, startTime);

  gainNode.gain.setValueAtTime(gain, startTime);
  gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  osc.connect(gainNode);
  gainNode.connect(ctx.destination);

  osc.start(startTime);
  osc.stop(startTime + duration);
}
