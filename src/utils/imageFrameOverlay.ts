/** Đè khung PNG trong suốt lên ảnh bìa — tạo ảnh mới (pixel/MD5 khác) */
export async function composeImageWithFrame(
  productImageSrc: string,
  framePngSrc: string,
  outputSize = 800
): Promise<string> {
  const loadImage = (src: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Không tải được ảnh'));
      img.src = src;
    });

  const [productImg, frameImg] = await Promise.all([
    loadImage(productImageSrc),
    loadImage(framePngSrc),
  ]);

  const canvas = document.createElement('canvas');
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas không khả dụng');

  const scale = Math.max(outputSize / productImg.width, outputSize / productImg.height);
  const pw = productImg.width * scale;
  const ph = productImg.height * scale;
  ctx.drawImage(productImg, (outputSize - pw) / 2, (outputSize - ph) / 2, pw, ph);
  ctx.drawImage(frameImg, 0, 0, outputSize, outputSize);

  return canvas.toDataURL('image/jpeg', 0.92);
}

export async function hashDataUrl(dataUrl: string): Promise<string> {
  const base64 = dataUrl.split(',')[1] || dataUrl;
  const buf = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  if (crypto.subtle) {
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16);
  }
  return `fp-${buf.length}-${base64.slice(-12)}`;
}
