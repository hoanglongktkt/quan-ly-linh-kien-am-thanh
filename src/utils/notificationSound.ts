/**
 * Phát âm thanh thông báo khi có đơn hàng mới.
 * File: public/tientien_1.mp3
 */

const NOTIFICATION_SOUND_URL = '/tientien_1.mp3';

let notificationAudio: HTMLAudioElement | null = null;
let isAudioUnlocked = false;

function getNotificationAudio(): HTMLAudioElement {
  if (!notificationAudio) {
    notificationAudio = new Audio(NOTIFICATION_SOUND_URL);
    notificationAudio.preload = 'auto';
  }
  return notificationAudio;
}

/** Gọi 1 lần đầu tiên (vd: khi user click "Bật âm thanh") để unlock autoplay. */
export function unlockAudio(): void {
  if (isAudioUnlocked) return;
  try {
    const audio = getNotificationAudio();
    const prevVolume = audio.volume;
    audio.volume = 0.01;
    void audio
      .play()
      .then(() => {
        audio.pause();
        audio.currentTime = 0;
        audio.volume = prevVolume || 0.85;
        isAudioUnlocked = true;
      })
      .catch((e) => {
        console.warn('[notificationSound] unlockAudio failed:', e);
      });
  } catch (e) {
    console.warn('[notificationSound] unlockAudio failed:', e);
  }
}

export function isAudioUnlockedState(): boolean {
  return isAudioUnlocked;
}

/** Phát file âm thanh thông báo. */
export function playNotificationSound(): void {
  try {
    const audio = getNotificationAudio();
    audio.currentTime = 0;
    audio.volume = 0.85;
    void audio.play().catch((e) => {
      console.warn('[notificationSound] playNotificationSound failed:', e);
    });
  } catch (e) {
    console.warn('[notificationSound] playNotificationSound failed:', e);
  }
}
