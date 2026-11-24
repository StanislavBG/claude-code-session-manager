// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { keyFingerprint, sealEnvelope } from '../seal';

interface Vector {
  name: string;
  boxId: string;
  contentType: string;
  boxPublicKey: string;
  boxPrivateKeyJwk: JsonWebKey;
  boxKeyFingerprint: string;
  ephemeralPrivateKeyJwk: JsonWebKey;
  iv: string;
  plaintext: string;
  envelope: string;
}

const vectors = (
  JSON.parse(
    readFileSync(new URL('../../schema/seal-vectors.v1.json', import.meta.url), 'utf8'),
  ) as { vectors: Vector[] }
).vectors;

const subtle = globalThis.crypto.subtle;

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** WebCrypto mirror of feedbackSeal.cjs openEnvelope (test-only). */
async function openEnvelope(
  buf: Uint8Array,
  privateKeyJwk: JsonWebKey,
  boxId: string,
): Promise<{ contentType: string; body: Uint8Array }> {
  const magic = new TextDecoder().decode(buf.subarray(0, 4));
  if (magic !== 'SMF1') throw new Error('bad_envelope');
  const hlen = (buf[4] << 8) | buf[5];
  if (hlen === 0 || hlen > 1024 || buf.length < 6 + hlen + 16) throw new Error('bad_envelope');
  const aad = buf.slice(0, 6 + hlen);
  const h = JSON.parse(new TextDecoder().decode(buf.subarray(6, 6 + hlen))) as {
    v: number;
    kid: string;
    epk: string;
    iv: string;
    ct: string;
  };
  if (h.v !== 1) throw new Error('bad_envelope');
  const { d: _d, ...pubJwk } = privateKeyJwk;
  void _d;
  const boxRaw = concat(new Uint8Array([4]), fromB64(String(pubJwk.x)), fromB64(String(pubJwk.y)));
  expect(h.kid).toBe(await keyFingerprint(toB64(boxRaw).replace(/=+$/, '')));
  const epkRaw = fromB64(h.epk);
  const priv = await subtle.importKey(
    'jwk',
    { ...privateKeyJwk, key_ops: ['deriveBits'] },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const epk = await subtle.importKey('raw', epkRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: epk }, priv, 256);
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const keyBits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: concat(epkRaw, boxRaw),
      info: new TextEncoder().encode('sm-feedback/1|' + boxId),
    },
    ikm,
    256,
  );
  const key = await subtle.importKey('raw', keyBits, 'AES-GCM', false, ['decrypt']);
  const body = new Uint8Array(
    await subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(h.iv), additionalData: aad, tagLength: 128 },
      key,
      buf.slice(6 + hlen),
    ),
  );
  return { contentType: h.ct, body };
}

describe('seal (envelope v1, WebCrypto)', () => {
  for (const v of vectors) {
    it(`${v.name}: fingerprint matches`, async () => {
      expect(await keyFingerprint(v.boxPublicKey)).toBe(v.boxKeyFingerprint);
    });

    it(`${v.name}: reproduces the envelope byte for byte`, async () => {
      const env = await sealEnvelope(fromB64(v.plaintext), v.contentType, v.boxPublicKey, v.boxId, {
        ephemeralPrivateKeyJwk: v.ephemeralPrivateKeyJwk,
        iv: v.iv,
      });
      expect(toB64(env)).toBe(v.envelope);
    });

    it(`${v.name}: vector envelope opens with the box key`, async () => {
      const out = await openEnvelope(fromB64(v.envelope), v.boxPrivateKeyJwk, v.boxId);
      expect(out.contentType).toBe(v.contentType);
      expect(toB64(out.body)).toBe(v.plaintext);
    });
  }

  it('round-trips random plaintext with fresh ephemeral key + iv', async () => {
    const v = vectors[0];
    for (const size of [0, 1, 37, 4096]) {
      const pt = globalThis.crypto.getRandomValues(new Uint8Array(size));
      const a = await sealEnvelope(pt, 'application/octet-stream', v.boxPublicKey, v.boxId);
      const b = await sealEnvelope(pt, 'application/octet-stream', v.boxPublicKey, v.boxId);
      expect(toB64(a)).not.toBe(toB64(b));
      const out = await openEnvelope(a, v.boxPrivateKeyJwk, v.boxId);
      expect(out.contentType).toBe('application/octet-stream');
      expect(toB64(out.body)).toBe(toB64(pt));
    }
  });

  it('wrong boxId fails to open', async () => {
    const v = vectors[0];
    await expect(openEnvelope(fromB64(v.envelope), v.boxPrivateKeyJwk, 'other')).rejects.toThrow();
  });

  it('rejects bad inputs', async () => {
    const v = vectors[0];
    await expect(sealEnvelope(new Uint8Array(1), '', v.boxPublicKey, v.boxId)).rejects.toThrow();
    await expect(sealEnvelope(new Uint8Array(1), 'x', v.boxPublicKey, '')).rejects.toThrow();
    await expect(
      sealEnvelope(new Uint8Array(1), 'x', v.boxPublicKey, v.boxId, { iv: 'AAAA' }),
    ).rejects.toThrow();
    await expect(sealEnvelope(new Uint8Array(1), 'x', 'AAAA', v.boxId)).rejects.toThrow();
  });
});
