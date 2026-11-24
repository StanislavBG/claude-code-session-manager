/**
 * feedbackSnippet — the one-line embed for a feedback box.
 *
 * keyFingerprint mirrors web/feedback-widget/src/seal.ts byte for byte: the first 22 chars of
 * base64url(sha256(raw P-256 point)). The widget checks the served key against this value.
 */

export const WIDGET_SRC = 'https://bilko.run/projects/session-manager/widget/v1/feedback.js';

function b64uDecode(s: string): Uint8Array<ArrayBuffer> {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64uEncode(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** First 22 chars of base64url(sha256(raw point)); `publicKey` is the base64url raw point. */
export async function keyFingerprint(publicKey: string): Promise<string> {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('webcrypto_unavailable');
  const digest = new Uint8Array(await s.digest('SHA-256', b64uDecode(publicKey)));
  return b64uEncode(digest).slice(0, 22);
}

export function snippetFor(boxId: string, fingerprint: string): string {
  return `<script src="${WIDGET_SRC}" data-key="fbk1_${boxId}.${fingerprint}" async></script>`;
}
