/**
 * feedbackSeal.test.cjs — sealed feedback envelope v1: round trip, published vectors, tamper rejection.
 *
 * Run: timeout 300 npx vitest run src/main/lib/feedback-remote/__tests__/feedbackSeal.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const seal = require('../feedbackSeal.cjs');

const VECTORS_PATH = path.resolve(__dirname, '../../../../../web/feedback-widget/schema/seal-vectors.v1.json');

/** @param {() => unknown} fn */
function errCode(fn) {
  try {
    fn();
  } catch (e) {
    return /** @type {Error} */ (e).message;
  }
  return 'no_error';
}

test('generateBoxKeypair returns a 65-byte uncompressed point and a private JWK', () => {
  const kp = seal.generateBoxKeypair();
  const raw = Buffer.from(kp.publicKey, 'base64url');
  expect(raw.length).toBe(65);
  expect(raw[0]).toBe(0x04);
  expect(kp.privateKeyJwk.kty).toBe('EC');
  expect(kp.privateKeyJwk.crv).toBe('P-256');
  expect(typeof kp.privateKeyJwk.d).toBe('string');
});

test('keyFingerprint is the first 22 chars of base64url(sha256(raw point))', () => {
  const kp = seal.generateBoxKeypair();
  const want = crypto.createHash('sha256').update(Buffer.from(kp.publicKey, 'base64url')).digest('base64url').slice(0, 22);
  expect(seal.keyFingerprint(kp.publicKey)).toBe(want);
  expect(want.length).toBe(22);
});

test('round-trips random plaintext', () => {
  const kp = seal.generateBoxKeypair();
  for (const n of [0, 1, 17, 4096]) {
    const pt = crypto.randomBytes(n);
    const env = seal.sealEnvelope(pt, 'application/json', kp.publicKey, 'box_abc');
    expect(env.subarray(0, 4).toString('ascii')).toBe('SMF1');
    const out = seal.openEnvelope(env, kp.privateKeyJwk, 'box_abc');
    expect(out.contentType).toBe('application/json');
    expect(Buffer.compare(out.body, pt)).toBe(0);
  }
});

test('envelope layout: magic, uint16 BE header length, header JSON fields, ciphertext + tag', () => {
  const kp = seal.generateBoxKeypair();
  const env = seal.sealEnvelope(Buffer.from('hello'), 'text/plain', kp.publicKey, 'b1');
  const hlen = env.readUInt16BE(4);
  const header = JSON.parse(env.subarray(6, 6 + hlen).toString('utf8'));
  expect(Object.keys(header)).toEqual(['v', 'kid', 'epk', 'iv', 'ct']);
  expect(header.v).toBe(1);
  expect(header.kid).toBe(seal.keyFingerprint(kp.publicKey));
  expect(Buffer.from(header.epk, 'base64url').length).toBe(65);
  expect(Buffer.from(header.iv, 'base64url').length).toBe(12);
  expect(header.ct).toBe('text/plain');
  expect(env.length - 6 - hlen).toBe(5 + 16);
});

test('reproduces every published vector byte for byte', () => {
  const file = JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf8'));
  expect(Array.isArray(file.vectors)).toBe(true);
  expect(file.vectors.length).toBeGreaterThanOrEqual(2);
  for (const v of file.vectors) {
    const env = seal.sealEnvelope(
      Buffer.from(v.plaintext, 'base64'),
      v.contentType,
      v.boxPublicKey,
      v.boxId,
      { ephemeralPrivateKeyJwk: v.ephemeralPrivateKeyJwk, iv: Buffer.from(v.iv, 'base64url') },
    );
    expect(env.toString('base64')).toBe(v.envelope);
    const out = seal.openEnvelope(Buffer.from(v.envelope, 'base64'), v.boxPrivateKeyJwk, v.boxId);
    expect(out.contentType).toBe(v.contentType);
    expect(out.body.toString('base64')).toBe(v.plaintext);
  }
});

test('rejects tampering, wrong boxId and wrong key with decrypt_failed', () => {
  const kp = seal.generateBoxKeypair();
  const other = seal.generateBoxKeypair();
  const env = seal.sealEnvelope(Buffer.from('secret feedback'), 'text/plain', kp.publicKey, 'box_1');
  const hlen = env.readUInt16BE(4);

  const ctFlip = Buffer.from(env);
  ctFlip[6 + hlen + 2] ^= 0x01;
  expect(errCode(() => seal.openEnvelope(ctFlip, kp.privateKeyJwk, 'box_1'))).toBe('decrypt_failed');

  const tagFlip = Buffer.from(env);
  tagFlip[tagFlip.length - 1] ^= 0x80;
  expect(errCode(() => seal.openEnvelope(tagFlip, kp.privateKeyJwk, 'box_1'))).toBe('decrypt_failed');

  // Flip a header byte that keeps the JSON valid: the case of a letter in the ct value.
  const headerFlip = Buffer.from(env);
  const ctAt = env.subarray(0, 6 + hlen).indexOf('text/plain');
  expect(ctAt).toBeGreaterThan(6);
  headerFlip[ctAt] ^= 0x20;
  expect(errCode(() => seal.openEnvelope(headerFlip, kp.privateKeyJwk, 'box_1'))).toBe('decrypt_failed');

  expect(errCode(() => seal.openEnvelope(env, kp.privateKeyJwk, 'box_2'))).toBe('decrypt_failed');
  expect(errCode(() => seal.openEnvelope(env, other.privateKeyJwk, 'box_1'))).toBe('decrypt_failed');
});

test('rejects bad magic and oversized header with bad_envelope', () => {
  const kp = seal.generateBoxKeypair();
  const env = seal.sealEnvelope(Buffer.from('x'), 'text/plain', kp.publicKey, 'box_1');

  const badMagic = Buffer.from(env);
  badMagic[3] = 0x32; // 'SMF2'
  expect(errCode(() => seal.openEnvelope(badMagic, kp.privateKeyJwk, 'box_1'))).toBe('bad_envelope');

  const big = Buffer.from(env);
  big.writeUInt16BE(1025, 4);
  expect(errCode(() => seal.openEnvelope(big, kp.privateKeyJwk, 'box_1'))).toBe('bad_envelope');

  const huge = Buffer.concat([Buffer.from('SMF1'), Buffer.from([0x08, 0x00]), Buffer.alloc(3000, 0x20)]);
  expect(errCode(() => seal.openEnvelope(huge, kp.privateKeyJwk, 'box_1'))).toBe('bad_envelope');

  expect(errCode(() => seal.openEnvelope(Buffer.from('SM'), kp.privateKeyJwk, 'box_1'))).toBe('bad_envelope');
});
