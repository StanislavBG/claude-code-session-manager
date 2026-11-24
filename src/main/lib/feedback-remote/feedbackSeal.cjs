// @ts-check
/**
 * feedbackSeal — desktop half of the sealed feedback envelope (v1).
 *
 * A feedback box owns a P-256 key pair. A sender seals a payload to the box's
 * public key with an ephemeral P-256 key; only the box's private key opens it.
 *
 * Envelope v1:
 *   'SMF1' | uint16 BE header length (<= 1024) | UTF-8 header JSON
 *   { v:1, kid, epk, iv, ct } | AES-256-GCM ciphertext || 16-byte tag
 *   key  = HKDF-SHA256(ECDH(ephemeral, box), salt = epk raw || box pub raw,
 *          info = 'sm-feedback/1|' + boxId, 32 bytes)
 *   AAD  = magic || length || header bytes
 *
 * Test vectors: web/feedback-widget/schema/seal-vectors.v1.json (the browser
 * implementation proves byte compatibility against the same file).
 */
'use strict';

const crypto = require('node:crypto');

const MAGIC = Buffer.from('SMF1', 'ascii');
const MAX_HEADER_LEN = 1024;
const IV_LEN = 12;
const TAG_LEN = 16;
const POINT_LEN = 65;
const INFO_PREFIX = 'sm-feedback/1|';

/** @param {string} code */
function fail(code) {
  return new Error(code);
}

/**
 * @param {crypto.KeyObject} keyObj public or private EC key
 * @returns {Buffer} 65-byte uncompressed point 0x04||x||y
 */
function rawPointOf(keyObj) {
  const pub = keyObj.type === 'private' ? crypto.createPublicKey(keyObj) : keyObj;
  const jwk = pub.export({ format: 'jwk' });
  return pointFromXY(String(jwk.x), String(jwk.y));
}

/** @param {string} x @param {string} y */
function pointFromXY(x, y) {
  const bx = Buffer.from(x, 'base64url');
  const by = Buffer.from(y, 'base64url');
  if (bx.length !== 32 || by.length !== 32) throw fail('bad_key');
  return Buffer.concat([Buffer.from([0x04]), bx, by]);
}

/** @param {Buffer} raw 65-byte uncompressed point */
function publicKeyFromRaw(raw) {
  if (raw.length !== POINT_LEN || raw[0] !== 0x04) throw fail('bad_key');
  return crypto.createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: raw.subarray(1, 33).toString('base64url'),
      y: raw.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
}

/** @param {crypto.JsonWebKey} jwk */
function privateKeyFromJwk(jwk) {
  return crypto.createPrivateKey({ key: jwk, format: 'jwk' });
}

/**
 * @returns {{ publicKey: string, privateKeyJwk: crypto.JsonWebKey }}
 */
function generateBoxKeypair() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    publicKey: rawPointOf(privateKey).toString('base64url'),
    privateKeyJwk: privateKey.export({ format: 'jwk' }),
  };
}

/**
 * @param {string} publicKey base64url raw point
 * @returns {string} first 22 chars of base64url(sha256(raw point))
 */
function keyFingerprint(publicKey) {
  const raw = Buffer.from(publicKey, 'base64url');
  return crypto.createHash('sha256').update(raw).digest('base64url').slice(0, 22);
}

/**
 * @param {crypto.KeyObject} priv
 * @param {crypto.KeyObject} pub
 * @param {Buffer} epkRaw
 * @param {Buffer} boxRaw
 * @param {string} boxId
 */
function deriveKey(priv, pub, epkRaw, boxRaw, boxId) {
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
  const salt = Buffer.concat([epkRaw, boxRaw]);
  const info = Buffer.from(INFO_PREFIX + boxId, 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', shared, salt, info, 32));
}

/** @param {number} len */
function prefix(len) {
  const b = Buffer.alloc(6);
  MAGIC.copy(b, 0);
  b.writeUInt16BE(len, 4);
  return b;
}

/**
 * @param {Buffer|Uint8Array|string} plaintext
 * @param {string} contentType
 * @param {string} publicKey base64url raw box point
 * @param {string} boxId
 * @param {{ ephemeralPrivateKeyJwk?: crypto.JsonWebKey, iv?: Buffer|Uint8Array|string }} [opts]
 *   test-vector-only overrides; production passes none.
 * @returns {Buffer}
 */
function sealEnvelope(plaintext, contentType, publicKey, boxId, opts) {
  if (typeof contentType !== 'string' || !contentType) throw new TypeError('contentType required');
  if (typeof boxId !== 'string' || !boxId) throw new TypeError('boxId required');
  const boxRaw = Buffer.from(publicKey, 'base64url');
  const boxPub = publicKeyFromRaw(boxRaw);
  const ephPriv = opts && opts.ephemeralPrivateKeyJwk
    ? privateKeyFromJwk(opts.ephemeralPrivateKeyJwk)
    : crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  const epkRaw = rawPointOf(ephPriv);
  let iv;
  if (opts && opts.iv != null) {
    iv = typeof opts.iv === 'string' ? Buffer.from(opts.iv, 'base64url') : Buffer.from(opts.iv);
  } else {
    iv = crypto.randomBytes(IV_LEN);
  }
  if (iv.length !== IV_LEN) throw new TypeError('iv must be 12 bytes');

  const header = Buffer.from(JSON.stringify({
    v: 1,
    kid: keyFingerprint(publicKey),
    epk: epkRaw.toString('base64url'),
    iv: iv.toString('base64url'),
    ct: contentType,
  }), 'utf8');
  if (header.length > MAX_HEADER_LEN) throw new TypeError('header too large');
  const aad = Buffer.concat([prefix(header.length), header]);

  const key = deriveKey(ephPriv, boxPub, epkRaw, boxRaw, boxId);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const body = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
  const ct = Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([aad, ct]);
}

/**
 * @param {Buffer|Uint8Array} buf
 * @param {crypto.JsonWebKey} privateKeyJwk
 * @param {string} boxId
 * @returns {{ contentType: string, body: Buffer }}
 * @throws {Error} message 'bad_envelope' | 'decrypt_failed'
 */
function openEnvelope(buf, privateKeyJwk, boxId) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length < 6 || !b.subarray(0, 4).equals(MAGIC)) throw fail('bad_envelope');
  const hlen = b.readUInt16BE(4);
  if (hlen === 0 || hlen > MAX_HEADER_LEN || b.length < 6 + hlen + TAG_LEN) throw fail('bad_envelope');
  const aad = b.subarray(0, 6 + hlen);
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(b.subarray(6, 6 + hlen).toString('utf8'));
  } catch {
    throw fail('bad_envelope');
  }
  const h = /** @type {Record<string, unknown>} */ (parsed && typeof parsed === 'object' ? parsed : {});
  if (h.v !== 1 || typeof h.kid !== 'string' || typeof h.epk !== 'string'
    || typeof h.iv !== 'string' || typeof h.ct !== 'string') {
    throw fail('bad_envelope');
  }
  const kid = h.kid;
  const contentType = h.ct;
  const iv = Buffer.from(h.iv, 'base64url');
  const epkRaw = Buffer.from(h.epk, 'base64url');
  if (iv.length !== IV_LEN) throw fail('bad_envelope');
  /** @type {crypto.KeyObject} */
  let epk;
  try {
    epk = publicKeyFromRaw(epkRaw);
  } catch {
    throw fail('bad_envelope');
  }

  try {
    const priv = privateKeyFromJwk(privateKeyJwk);
    const boxRaw = rawPointOf(priv);
    if (keyFingerprint(boxRaw.toString('base64url')) !== kid) throw fail('decrypt_failed');
    const key = deriveKey(priv, epk, epkRaw, boxRaw, String(boxId));
    const data = b.subarray(6 + hlen);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(data.subarray(data.length - TAG_LEN));
    const body = Buffer.concat([decipher.update(data.subarray(0, data.length - TAG_LEN)), decipher.final()]);
    return { contentType, body };
  } catch {
    throw fail('decrypt_failed');
  }
}

module.exports = {
  generateBoxKeypair,
  keyFingerprint,
  sealEnvelope,
  openEnvelope,
  MAX_HEADER_LEN,
};
