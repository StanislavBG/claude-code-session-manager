/**
 * Turns a File the user picked or pasted on the phone (forwarded iMessage photo, screenshot,
 * possibly HEIC or multi-MB) into a small, Claude-readable image payload.
 *
 * Small PNG/JPEG/GIF/WebP files pass through byte-for-byte; anything else is downscaled to a
 * MAX_LONG_EDGE long edge and re-encoded as JPEG. The preview is a data: URL because the
 * bilko.run CSP allows img-src data:, not reliably blob:.
 */

export const MAX_IMAGES_PER_SEND = 6;
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
export const MAX_LONG_EDGE = 2048;
export const ACCEPTED_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const JPEG_QUALITIES = [0.85, 0.72, 0.6] as const;
const BASE64_CHUNK = 0x8000; // 32 KB

export type ImageAttachErrorCode = 'unsupported' | 'too-large' | 'decode-failed';

export class ImageAttachError extends Error {
  readonly code: ImageAttachErrorCode;
  constructor(code: ImageAttachErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ImageAttachError';
    this.code = code;
  }
}

export interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

export interface ImageCodec {
  decode(blob: Blob): Promise<DecodedImage>;
  encodeJpeg(source: CanvasImageSource, width: number, height: number, quality: number): Promise<Blob>;
}

export interface PreparedImage {
  name: string;
  mime: string;
  /** Base64, no data: prefix. */
  data: string;
  bytes: number;
  previewUrl: string;
}

export const browserCodec: ImageCodec = {
  async decode(blob) {
    const bitmap = await createImageBitmap(blob);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  },
  encodeJpeg(source, width, height, quality) {
    return new Promise<Blob>((resolve, reject) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('canvas 2d context unavailable'));
        return;
      }
      ctx.drawImage(source, 0, 0, width, height);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('canvas toBlob returned null'))),
        'image/jpeg',
        quality,
      );
    });
  },
};

/** Chunked so String.fromCharCode.apply never blows the call stack on multi-MB input. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    const chunk = bytes.subarray(i, i + BASE64_CHUNK);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

const HEIC_EXT = /\.(heic|heif)$/i;

/** iOS sometimes hands over HEIC files with an empty type; infer it from the extension. */
function effectiveMime(file: File): string {
  const type = (file.type || '').toLowerCase();
  if (type) return type;
  return HEIC_EXT.test(file.name) ? 'image/heic' : '';
}

function jpegName(name: string): string {
  const base = name.replace(/\.[^./\\]*$/, '');
  return `${base || 'image'}.jpg`;
}

/** Blob.arrayBuffer() everywhere it exists; FileReader for older engines (and jsdom). */
function readBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('failed to read image bytes'));
    reader.readAsArrayBuffer(blob);
  });
}

async function toPrepared(blob: Blob, name: string, mime: string): Promise<PreparedImage> {
  const bytes = new Uint8Array(await readBytes(blob));
  const data = bytesToBase64(bytes);
  return { name, mime, data, bytes: bytes.length, previewUrl: `data:${mime};base64,${data}` };
}

export async function prepareImage(file: File, codec: ImageCodec = browserCodec): Promise<PreparedImage> {
  const mime = effectiveMime(file);
  if (!mime.startsWith('image/')) {
    throw new ImageAttachError('unsupported', `not an image: ${file.type || file.name || 'unknown type'}`);
  }
  const accepted = ACCEPTED_MIMES.includes(mime);
  const smallEnough = file.size <= MAX_IMAGE_BYTES;

  let decoded: DecodedImage;
  try {
    decoded = await codec.decode(file);
  } catch (e) {
    if (accepted && smallEnough) return toPrepared(file, file.name || 'image', mime);
    throw new ImageAttachError('decode-failed', `could not decode image: ${(e as Error)?.message ?? e}`);
  }

  try {
    const longEdge = Math.max(decoded.width, decoded.height);
    if (accepted && smallEnough && longEdge <= MAX_LONG_EDGE) {
      return await toPrepared(file, file.name || 'image', mime);
    }
    const scale = longEdge > 0 ? Math.min(1, MAX_LONG_EDGE / longEdge) : 1;
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    for (const quality of JPEG_QUALITIES) {
      const blob = await codec.encodeJpeg(decoded.source, width, height, quality);
      if (blob.size <= MAX_IMAGE_BYTES) return await toPrepared(blob, jpegName(file.name), 'image/jpeg');
    }
    throw new ImageAttachError('too-large', 'image is still over the size limit after compression');
  } finally {
    decoded.close();
  }
}
