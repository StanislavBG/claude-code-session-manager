import { describe, expect, it, vi } from 'vitest';
import {
  ACCEPTED_MIMES,
  ImageAttachError,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_SEND,
  MAX_LONG_EDGE,
  browserCodec,
  prepareImage,
  type DecodedImage,
  type ImageCodec,
} from '../imageAttach';

function bytesOf(n: number, seed = 7): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

function fileOf(bytes: Uint8Array<ArrayBuffer>, name: string, type: string): File {
  return new File([bytes], name, { type });
}

interface FakeOpts {
  width?: number;
  height?: number;
  failDecode?: boolean;
  /** Encoded size per quality; default 1000 bytes. */
  sizeForQuality?: (q: number) => number;
}

function fakeCodec(opts: FakeOpts = {}) {
  const closes: number[] = [];
  const encodes: Array<{ width: number; height: number; quality: number }> = [];
  const codec: ImageCodec = {
    async decode(): Promise<DecodedImage> {
      if (opts.failDecode) throw new Error('cannot decode');
      return {
        source: {} as CanvasImageSource,
        width: opts.width ?? 100,
        height: opts.height ?? 100,
        close: () => { closes.push(1); },
      };
    },
    async encodeJpeg(_source, width, height, quality) {
      encodes.push({ width, height, quality });
      const n = opts.sizeForQuality ? opts.sizeForQuality(quality) : 1000;
      return new Blob([bytesOf(n, 3)], { type: 'image/jpeg' });
    },
  };
  return { codec, closes, encodes };
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

describe('imageAttach constants', () => {
  it('exports the limits and accepted mimes', () => {
    expect(MAX_IMAGES_PER_SEND).toBe(6);
    expect(MAX_IMAGE_BYTES).toBe(1.5 * 1024 * 1024);
    expect(MAX_LONG_EDGE).toBe(2048);
    expect([...ACCEPTED_MIMES].sort()).toEqual(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
    expect(typeof browserCodec.decode).toBe('function');
    expect(typeof browserCodec.encodeJpeg).toBe('function');
  });
});

describe('prepareImage', () => {
  it('passes a small PNG through with bytes unchanged', async () => {
    const raw = bytesOf(5000);
    const { codec, encodes, closes } = fakeCodec({ width: 800, height: 600 });
    const out = await prepareImage(fileOf(raw, 'shot.png', 'image/png'), codec);
    expect(out.mime).toBe('image/png');
    expect(out.name).toBe('shot.png');
    expect(out.bytes).toBe(5000);
    expect(b64decode(out.data)).toEqual(raw);
    expect(out.data.startsWith('data:')).toBe(false);
    expect(out.previewUrl).toBe(`data:image/png;base64,${out.data}`);
    expect(encodes).toHaveLength(0);
    expect(closes).toHaveLength(1);
  });

  it('passes through an accepted small file even when decode fails', async () => {
    const raw = bytesOf(2000);
    const { codec } = fakeCodec({ failDecode: true });
    const out = await prepareImage(fileOf(raw, 'a.gif', 'image/gif'), codec);
    expect(out.mime).toBe('image/gif');
    expect(b64decode(out.data)).toEqual(raw);
  });

  it('downscales a 4032x3024 HEIC to a 2048x1536 JPEG', async () => {
    const { codec, encodes, closes } = fakeCodec({ width: 4032, height: 3024 });
    const out = await prepareImage(fileOf(bytesOf(3_000_000), 'IMG_0001.HEIC', 'image/heic'), codec);
    expect(encodes).toEqual([{ width: 2048, height: 1536, quality: 0.85 }]);
    expect(out.mime).toBe('image/jpeg');
    expect(out.name).toBe('IMG_0001.jpg');
    expect(out.bytes).toBe(1000);
    expect(out.previewUrl).toBe(`data:image/jpeg;base64,${out.data}`);
    expect(closes).toHaveLength(1);
  });

  it('re-encodes an accepted-but-oversized-dimension PNG without upscaling small dims', async () => {
    const { codec, encodes } = fakeCodec({ width: 1000, height: 5000 });
    const out = await prepareImage(fileOf(bytesOf(100), '', 'image/png'), codec);
    expect(encodes[0]).toMatchObject({ width: 410, height: 2048 });
    expect(out.name).toBe('image.jpg');
  });

  it('steps quality down until the result fits', async () => {
    const big = MAX_IMAGE_BYTES + 10;
    const { codec, encodes } = fakeCodec({
      width: 3000,
      height: 2000,
      sizeForQuality: (q) => (q >= 0.72 ? big : 1234),
    });
    const out = await prepareImage(fileOf(bytesOf(100), 'p.heif', 'image/heif'), codec);
    expect(encodes.map((e) => e.quality)).toEqual([0.85, 0.72, 0.6]);
    expect(out.bytes).toBe(1234);
  });

  it('throws too-large when even the lowest quality is over the cap', async () => {
    const { codec, encodes, closes } = fakeCodec({
      width: 3000,
      height: 2000,
      sizeForQuality: () => MAX_IMAGE_BYTES + 1,
    });
    const err = await prepareImage(fileOf(bytesOf(100), 'x.heic', 'image/heic'), codec).catch((e) => e);
    expect(err).toBeInstanceOf(ImageAttachError);
    expect(err.code).toBe('too-large');
    expect(encodes).toHaveLength(3);
    expect(closes).toHaveLength(1);
  });

  it('throws unsupported for a non-image file', async () => {
    const { codec } = fakeCodec();
    const decode = vi.spyOn(codec, 'decode');
    const err = await prepareImage(fileOf(bytesOf(10), 'notes.txt', 'text/plain'), codec).catch((e) => e);
    expect(err).toBeInstanceOf(ImageAttachError);
    expect(err.code).toBe('unsupported');
    expect(decode).not.toHaveBeenCalled();
  });

  it('throws decode-failed for an undecodable non-accepted image', async () => {
    const { codec } = fakeCodec({ failDecode: true });
    const err = await prepareImage(fileOf(bytesOf(10), 'x.heic', 'image/heic'), codec).catch((e) => e);
    expect(err).toBeInstanceOf(ImageAttachError);
    expect(err.code).toBe('decode-failed');
  });

  it('throws decode-failed for an undecodable accepted image over the byte cap', async () => {
    const { codec } = fakeCodec({ failDecode: true });
    const err = await prepareImage(fileOf(bytesOf(MAX_IMAGE_BYTES + 1), 'x.png', 'image/png'), codec).catch((e) => e);
    expect(err.code).toBe('decode-failed');
  });

  it('reads a 2 MB input file and base64-encodes the fitted result exactly', async () => {
    const raw = bytesOf(2 * 1024 * 1024, 11);
    const fits = fakeCodec({ width: 4000, height: 3000 });
    const mid = raw.subarray(0, MAX_IMAGE_BYTES);
    fits.codec.encodeJpeg = async () => new Blob([mid], { type: 'image/jpeg' });
    const out = await prepareImage(fileOf(raw, 'big.heic', 'image/heic'), fits.codec);
    expect(out.bytes).toBe(MAX_IMAGE_BYTES);
    expect(out.data).toBe(Buffer.from(mid).toString("base64"));
  });

  it('base64-encodes a 2 MB buffer exactly', async () => {
    const { bytesToBase64 } = await import('../imageAttach');
    const raw = bytesOf(2 * 1024 * 1024, 13);
    const s = bytesToBase64(raw);
    expect(s).toBe(Buffer.from(raw).toString('base64'));
  });
});
