/**
 * Âm thanh thông báo đơn mới — file tientien_1.mp3 + fallback Web Audio.
 */
import notificationMp3Url from '../assets/tientien_1.mp3?url';

let audioCtx: AudioContext | null = null;
let isAudioUnlocked = false;

function getAudioContext(): AudioContext | null {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      void audioCtx.resume();
    }
    return audioCtx;
  } catch {
    return null;
  }
}

/** Unlock autoplay — dùng Web Audio (ổn định trên mobile), không phụ thuộc file MP3. */
export function unlockAudio(): void {
  if (isAudioUnlocked) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
    isAudioUnlocked = true;
  } catch (e) {
    console.warn('[notificationSound] unlockAudio failed:', e);
  }
}

export function isAudioUnlockedState(): boolean {
  return isAudioUnlocked;
}

function playWebAudioTone(freq: number, start: number, duration: number, gain = 0.4): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gainNode = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, now + start);
  gainNode.gain.setValueAtTime(gain, now + start);
  gainNode.gain.exponentialRampToValueAtTime(0.001, now + start + duration);
  osc.connect(gainNode);
  gainNode.connect(ctx.destination);
  osc.start(now + start);
  osc.stop(now + start + duration);
}

/** Fallback tone "tinh tinh" khi MP3 không phát được. */
function playWebAudioFallback(): void {
  try {
    playWebAudioTone(880, 0, 0.15, 0.4);
    playWebAudioTone(1100, 0.18, 0.15, 0.4);
    playWebAudioTone(660, 0.36, 0.2, 0.3);
  } catch (e) {
    console.warn('[notificationSound] playWebAudioFallback failed:', e);
  }
}

/** Phát file MP3 — mỗi lần dùng instance mới để tránh xung đột pause/play. */
export function playNotificationSound(): void {
  try {
    const audio = new Audio(notificationMp3Url);
    audio.volume = 0.85;
    audio.preload = 'auto';
    void audio.play().catch((e) => {
      console.warn('[notificationSound] MP3 play failed, fallback Web Audio:', e);
      playWebAudioFallback();
    });
  } catch (e) {
    console.warn('[notificationSound] playNotificationSound failed:', e);
    playWebAudioFallback();
  }
}
