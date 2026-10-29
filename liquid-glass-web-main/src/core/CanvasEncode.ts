type EncodableCanvas = HTMLCanvasElement | OffscreenCanvas;

const ENCODE_TYPE = 'image/webp';
const ENCODE_QUALITY = 1.0;

export async function encodeCanvas(canvas: EncodableCanvas): Promise<string> {
  const blob = await canvasToBlob(canvas);
  return blobToUrl(blob);
}

async function canvasToBlob(canvas: EncodableCanvas): Promise<Blob> {
  if (canvas instanceof HTMLCanvasElement) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('[liquid-glass] failed to encode canvas'));
        },
        ENCODE_TYPE,
        ENCODE_QUALITY
      );
    });
  }
  return canvas.convertToBlob({ type: ENCODE_TYPE, quality: ENCODE_QUALITY });
}

function blobToUrl(blob: Blob): Promise<string> {
  if (typeof FileReader === 'undefined') return Promise.resolve(URL.createObjectURL(blob));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('[liquid-glass] failed to read encoded canvas'));
    reader.readAsDataURL(blob);
  });
}
