/**
 * seal — browser half of the sealed feedback envelope (v1), WebCrypto only.
 *
 * Mirrors src/main/lib/feedback-remote/feedbackSeal.cjs byte for byte (proven against
 * schema/seal-vectors.v1.json):
 *   'SMF1' | uint16 BE header length (<= 1024) | UTF-8 header JSON
 *   { v:1, kid, epk, iv, ct } | AES-256-GCM ciphertext || 16-byte tag
 *   key = HKDF-SHA256(ECDH(ephemeral, box), salt = epk raw || box pub raw,
 *         info = 'sm-feedback/1|' + boxId, 32 bytes)
 *   AAD = magic || length || header bytes
 */

const MAX_HEADER_LEN = 1024;
const IV_LEN = 12;
const POINT_LEN = 65;
const INFO_PREFIX = 'sm-feedback/1|';
const EC = { name: 'ECDH', namedCurve: 'P-256' } as const;

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('webcrypto_unavailable');
  return s;
}

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

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** First 22 chars of base64url(sha256(raw point)). */
export async function keyFingerprint(publicKeyB64u: string): Promise<string> {
  const raw = b64uDecode(publicKeyB64u);
  const digest = new Uint8Array(await subtle().digest('SHA-256', raw));
  return b64uEncode(digest).slice(0, 22);
}

export interface SealOptions {
  /** Test-vector-only override; production passes none. */
  ephemeralPrivateKeyJwk?: JsonWebKey;
  /** Test-vector-only override: base64url string or 12 raw bytes. */
  iv?: string | Uint8Array;
}

async function ephemeralKey(
  jwk: JsonWebKey | undefined,
): Promise<{ priv: CryptoKey; epkRaw: Uint8Array<ArrayBuffer> }> {
  const s = subtle();
  if (jwk) {
    if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new TypeError('bad_key');
    const x = b64uDecode(jwk.x);
    const y = b64uDecode(jwk.y);
    if (x.length !== 32 || y.length !== 32) throw new TypeError('bad_key');
    const priv = await s.importKey('jwk', { ...jwk, key_ops: ['deriveBits'] }, EC, false, [
      'deriveBits',
    ]);
    return { priv, epkRaw: concat(new Uint8Array([4]), x, y) };
  }
  const pair = (await s.generateKey(EC, false, ['deriveBits'])) as CryptoKeyPair;
  const epkRaw = new Uint8Array(await s.exportKey('raw', pair.publicKey));
  return { priv: pair.privateKey, epkRaw };
}

/** Seal `plaintext` to a box's public key; returns the Envelope v1 bytes. */
export async function sealEnvelope(
  plaintext: Uint8Array,
  contentType: string,
  publicKeyB64u: string,
  boxId: string,
  opts?: SealOptions,
): Promise<Uint8Array> {
  if (typeof contentType !== 'string' || !contentType) throw new TypeError('contentType required');
  if (typeof boxId !== 'string' || !boxId) throw new TypeError('boxId required');
  const s = subtle();

  const boxRaw = b64uDecode(publicKeyB64u);
  if (boxRaw.length !== POINT_LEN || boxRaw[0] !== 0x04) throw new TypeError('bad_key');
  const boxPub = await s.importKey('raw', boxRaw, EC, false, []);

  const { priv, epkRaw } = await ephemeralKey(opts?.ephemeralPrivateKeyJwk);

  let iv: Uint8Array<ArrayBuffer>;
  if (opts?.iv != null) {
    iv = typeof opts.iv === 'string' ? b64uDecode(opts.iv) : new Uint8Array(opts.iv);
  } else {
    iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LEN));
  }
  if (iv.length !== IV_LEN) throw new TypeError('iv must be 12 bytes');

  // Key order must match the desktop's JSON.stringify exactly.
  const header = new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      kid: await keyFingerprint(publicKeyB64u),
      epk: b64uEncode(epkRaw),
      iv: b64uEncode(iv),
      ct: contentType,
    }),
  );
  if (header.length > MAX_HEADER_LEN) throw new TypeError('header too large');
  const prefix = new Uint8Array([0x53, 0x4d, 0x46, 0x31, header.length >> 8, header.length & 0xff]);
  const aad = concat(prefix, header);

  const shared = await s.deriveBits({ name: 'ECDH', public: boxPub }, priv, 256);
  const ikm = await s.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await s.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: concat(epkRaw, boxRaw),
      info: new TextEncoder().encode(INFO_PREFIX + boxId),
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const ct = new Uint8Array(
    await s.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
      key,
      new Uint8Array(plaintext),
    ),
  );
  return concat(aad, ct);
}
