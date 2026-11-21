// @ts-check
/**
 * feedbackImages — the single preparation point for images attached to a customer feedback item.
 *
 * Turns up to MAX_FEEDBACK_IMAGES inputs (an absolute file path, or a data URL) into validated,
 * size-capped `{ dataUrl, mime, bytes }` entries ready for the bilko.run feedback POST, which
 * checks each data URL against ^data:image/(png|jpeg|webp|gif);base64, and caps one at 2,000,000
 * chars. Oversize PNG/JPEG are downscaled to JPEG through Electron's nativeImage (injectable).
 *
 * Errors are plain sentences naming the 1-based image index (plus at most a file basename) —
 * never file contents.
 */
'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { sniffImageMime } = require('../epic/epicAttachments.cjs');

const MAX_FEEDBACK_IMAGES = 5;
const MAX_IMAGE_DATAURL_CHARS = 1900000;
const MAX_TOTAL_DATAURL_CHARS = 8000000;
const MAX_RAW_IMAGE_BYTES = 26214400;

const DATA_URL_RE = /^data:image\/(png|jpeg|webp|gif);base64,/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const DOWNSCALE_EDGES = [2000, 1600, 1280, 1024];
const DOWNSCALE_QUALITIES = [85, 70];

/**
 * @typedef {{ path?: string, dataUrl?: string }} FeedbackImageInput
 * @typedef {{ dataUrl: string, mime: string, bytes: number }} PreparedImage
 * @typedef {{ isEmpty: () => boolean, getSize: () => { width: number, height: number },
 *   resize: (opts: { width?: number, height?: number, quality?: string }) => NativeImageLike,
 *   toJPEG: (quality: number) => Buffer }} NativeImageLike
 * @typedef {{ createFromBuffer: (buf: Buffer) => NativeImageLike }} NativeImageModule
 * @typedef {{ stat?: (p: string) => Promise<{ isFile: () => boolean, size: number }>,
 *   readFile?: (p: string) => Promise<Buffer>, nativeImage?: NativeImageModule }} Deps
 * @typedef {{ ok: true, images: PreparedImage[] } | { ok: false, error: string }} PrepareResult
 */

/** @returns {NativeImageModule} */
function defaultNativeImage() {
  // Lazy: electron is only resolvable inside the app, and only needed for an oversize image.
  const electron = /** @type {{ nativeImage: NativeImageModule }} */ (/** @type {unknown} */ (require('electron')));
  return electron.nativeImage;
}

/** @param {string} mime @param {Buffer} buf */
function toDataUrl(mime, buf) {
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * Downscale a PNG/JPEG to a JPEG whose data URL fits MAX_IMAGE_DATAURL_CHARS.
 * @param {Buffer} buf @param {NativeImageModule} nativeImage
 * @returns {Buffer|null}
 */
function downscaleToJpeg(buf, nativeImage) {
  const img = nativeImage.createFromBuffer(buf);
  if (!img || img.isEmpty()) return null;
  const { width, height } = img.getSize();
  for (const edge of DOWNSCALE_EDGES) {
    let scaled = img;
    if (Math.max(width, height) > edge) {
      scaled = width >= height
        ? img.resize({ width: edge, quality: 'good' })
        : img.resize({ height: edge, quality: 'good' });
    }
    for (const quality of DOWNSCALE_QUALITIES) {
      const out = scaled.toJPEG(quality);
      if (Buffer.isBuffer(out) && out.length > 0
        && toDataUrl('image/jpeg', out).length <= MAX_IMAGE_DATAURL_CHARS) return out;
    }
  }
  return null;
}

/**
 * @param {FeedbackImageInput[]|undefined} inputs
 * @param {Deps} [deps]
 * @returns {Promise<PrepareResult>}
 */
async function prepareFeedbackImages(inputs, deps = {}) {
  if (inputs === undefined || inputs === null) return { ok: true, images: [] };
  if (!Array.isArray(inputs)) return { ok: false, error: 'Images must be a list.' };
  if (inputs.length === 0) return { ok: true, images: [] };
  if (inputs.length > MAX_FEEDBACK_IMAGES) {
    return { ok: false, error: `You can attach at most ${MAX_FEEDBACK_IMAGES} images to one feedback item.` };
  }
  const stat = deps.stat || ((/** @type {string} */ p) => fsp.stat(p));
  const readFile = deps.readFile || ((/** @type {string} */ p) => fsp.readFile(p));

  /** @type {PreparedImage[]} */
  const images = [];
  let total = 0;
  for (let i = 0; i < inputs.length; i++) {
    const n = i + 1;
    const input = inputs[i] || {};
    const hasPath = typeof input.path === 'string' && input.path.length > 0;
    const hasData = typeof input.dataUrl === 'string' && input.dataUrl.length > 0;
    if (hasPath === hasData) {
      return { ok: false, error: `Image ${n} must have exactly one of a file path or a data URL.` };
    }

    /** @type {Buffer} */
    let buf;
    /** @type {string} */
    let mime;
    if (hasPath) {
      const p = /** @type {string} */ (input.path);
      const name = path.basename(p);
      if (!path.isAbsolute(p)) return { ok: false, error: `Image ${n} (${name}) must be an absolute file path.` };
      let st;
      try { st = await stat(p); } catch {
        return { ok: false, error: `Image ${n} (${name}) could not be found.` };
      }
      if (!st.isFile()) return { ok: false, error: `Image ${n} (${name}) is not a regular file.` };
      if (st.size > MAX_RAW_IMAGE_BYTES) {
        return { ok: false, error: `Image ${n} (${name}) is larger than ${Math.round(MAX_RAW_IMAGE_BYTES / 1048576)} MB.` };
      }
      try { buf = await readFile(p); } catch {
        return { ok: false, error: `Image ${n} (${name}) could not be read.` };
      }
      const sniffed = sniffImageMime(buf);
      if (!sniffed) return { ok: false, error: `Image ${n} (${name}) is not a PNG, JPEG, WebP or GIF file.` };
      mime = sniffed;
    } else {
      const url = /** @type {string} */ (input.dataUrl);
      const m = DATA_URL_RE.exec(url);
      if (!m) return { ok: false, error: `Image ${n} is not a PNG, JPEG, WebP or GIF data URL.` };
      const b64 = url.slice(m[0].length);
      if (!b64 || !BASE64_RE.test(b64)) return { ok: false, error: `Image ${n} has invalid base64 data.` };
      if (b64.length > Math.ceil(MAX_RAW_IMAGE_BYTES / 3) * 4) {
        return { ok: false, error: `Image ${n} is larger than ${Math.round(MAX_RAW_IMAGE_BYTES / 1048576)} MB.` };
      }
      buf = Buffer.from(b64, 'base64');
      const declared = `image/${m[1]}`;
      if (sniffImageMime(buf) !== declared) {
        return { ok: false, error: `Image ${n} content does not match its declared type ${declared}.` };
      }
      mime = declared;
    }

    let dataUrl = toDataUrl(mime, buf);
    if (dataUrl.length > MAX_IMAGE_DATAURL_CHARS) {
      if (mime !== 'image/png' && mime !== 'image/jpeg') {
        return { ok: false, error: `Image ${n} is too large; WebP and GIF images cannot be shrunk automatically.` };
      }
      let out = null;
      try { out = downscaleToJpeg(buf, deps.nativeImage || defaultNativeImage()); } catch { out = null; }
      if (!out) return { ok: false, error: `Image ${n} is too large and could not be shrunk to fit.` };
      buf = out;
      mime = 'image/jpeg';
      dataUrl = toDataUrl(mime, buf);
    }
    total += dataUrl.length;
    if (total > MAX_TOTAL_DATAURL_CHARS) {
      return { ok: false, error: 'The attached images are too large in total; attach fewer or smaller images.' };
    }
    images.push({ dataUrl, mime, bytes: buf.length });
  }
  return { ok: true, images };
}

module.exports = {
  MAX_FEEDBACK_IMAGES,
  MAX_IMAGE_DATAURL_CHARS,
  MAX_TOTAL_DATAURL_CHARS,
  MAX_RAW_IMAGE_BYTES,
  prepareFeedbackImages,
};
