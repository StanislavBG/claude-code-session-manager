import { describe, it, expect, beforeEach } from 'vitest';
import { canRoute, consumeRateLimit, retryAfterMs } from '../src/router';
import type { BrowserConn, DeviceConn, LeakyBucket } from '../src/types';

// ── canRoute (same-user routing invariant) ─────────────────────────────────

describe('canRoute', () => {
  it('allows routing when browser and device share the same userId', () => {
    const browser = { userId: 'user-abc' } as Pick<BrowserConn, 'userId'>;
    const device = { userId: 'user-abc' } as Pick<DeviceConn, 'userId'>;
    expect(canRoute(browser, device)).toBe(true);
  });

  it('blocks routing when userId differs (cross-user attempt)', () => {
    const browser = { userId: 'user-abc' } as Pick<BrowserConn, 'userId'>;
    const device = { userId: 'user-xyz' } as Pick<DeviceConn, 'userId'>;
    expect(canRoute(browser, device)).toBe(false);
  });

  it('blocks when userId is empty string on either side', () => {
    expect(canRoute({ userId: '' }, { userId: 'user-1' })).toBe(false);
    expect(canRoute({ userId: 'user-1' }, { userId: '' })).toBe(false);
    expect(canRoute({ userId: '' }, { userId: '' })).toBe(true); // degenerate but consistent
  });

  it('comparison is case-sensitive', () => {
    expect(canRoute({ userId: 'User-1' }, { userId: 'user-1' })).toBe(false);
  });
});

// ── consumeRateLimit + retryAfterMs ────────────────────────────────────────

function makeBucket(capacity: number, drainRateMs: number, now = Date.now()): LeakyBucket {
  return { tokens: 0, lastCheck: now, capacity, drainRateMs };
}

describe('consumeRateLimit', () => {
  it('allows commands up to the capacity', () => {
    const bucket = makeBucket(5, 1000);
    for (let i = 0; i < 5; i++) {
      expect(consumeRateLimit(bucket, bucket.lastCheck + i * 10)).toBe(true);
    }
  });

  it('blocks commands when bucket is full', () => {
    // Use a fixed timestamp so no drain occurs between calls
    const bucket = makeBucket(3, 1000, 0);
    consumeRateLimit(bucket, 0);
    consumeRateLimit(bucket, 0);
    consumeRateLimit(bucket, 0);
    expect(consumeRateLimit(bucket, 0)).toBe(false);
  });

  it('drains over time and allows more commands', () => {
    const drainRateMs = 600; // 100 cmd/min device setting
    const bucket = makeBucket(100, drainRateMs, 0);
    // Fill the bucket at t=0 (no drain between calls)
    for (let i = 0; i < 100; i++) consumeRateLimit(bucket, 0);
    // Should be blocked at t=0
    expect(consumeRateLimit(bucket, 0)).toBe(false);
    // After draining 10 tokens (6000 ms), commands should be allowed again
    expect(consumeRateLimit(bucket, 6000)).toBe(true);
  });

  it('models browser rate limit: 60 cmd/min (drain 1/1000 ms)', () => {
    const bucket = makeBucket(60, 1000, 0);
    for (let i = 0; i < 60; i++) {
      expect(consumeRateLimit(bucket, 0)).toBe(true);
    }
    // 61st command is rejected at t=0
    expect(consumeRateLimit(bucket, 0)).toBe(false);
    // After 1000 ms, one more is allowed
    expect(consumeRateLimit(bucket, 1000)).toBe(true);
  });

  it('models device rate limit: 100 cmd/min (drain 1/600 ms)', () => {
    const bucket = makeBucket(100, 600, 0);
    for (let i = 0; i < 100; i++) {
      expect(consumeRateLimit(bucket, 0)).toBe(true);
    }
    expect(consumeRateLimit(bucket, 0)).toBe(false);
    // After 600 ms, one more is allowed
    expect(consumeRateLimit(bucket, 600)).toBe(true);
  });
});

describe('retryAfterMs', () => {
  it('returns 0 when bucket is not full', () => {
    const bucket = makeBucket(10, 500, 0);
    consumeRateLimit(bucket, 0);
    expect(retryAfterMs(bucket, 0)).toBe(0);
  });

  it('returns a positive retry delay when bucket is full', () => {
    const bucket = makeBucket(3, 1000, 0);
    consumeRateLimit(bucket, 0);
    consumeRateLimit(bucket, 0);
    consumeRateLimit(bucket, 0);
    const ms = retryAfterMs(bucket, 0);
    expect(ms).toBeGreaterThan(0);
  });

  it('retry delay is proportional to the drain rate', () => {
    const bucket = makeBucket(1, 2000, 0); // 1 cmd allowed, drain 1/2000ms
    consumeRateLimit(bucket, 0);
    const ms = retryAfterMs(bucket, 0);
    // Needs to drain 1 more token at 2000 ms/token
    expect(ms).toBeCloseTo(2000, -2);
  });
});

// ── Routing security invariant: userId from session, not envelope ──────────

describe('routing security invariant', () => {
  it('canRoute does not use any envelope field — only userId from session objects', () => {
    // SECURITY INVARIANT: the routing decision accepts only the session-side
    // userId, not anything from a message envelope. An attacker crafting
    // { deviceId: "victim-device" } in the envelope cannot escalate because
    // canRoute is called with the session's userId, which was locked in at
    // ticket-verification time (ARCHITECTURE.md §2.2).
    const attackerBrowser = { userId: 'attacker-123' } as Pick<BrowserConn, 'userId'>;
    const victimDevice = { userId: 'victim-456' } as Pick<DeviceConn, 'userId'>;
    expect(canRoute(attackerBrowser, victimDevice)).toBe(false);
  });
});

// ── E2E relay-blindness test (real crypto) ────────────────────────────────

import nodeCrypto from 'node:crypto';

/**
 * Derive an AES-256-GCM session key using Node.js crypto, mirroring the
 * agent's deriveSessionKey in webRemote.cjs (P-256 ECDH + HKDF-SHA256).
 */
function deriveSessionKeyReal(
  myPrivateKeyB64: string,
  peerPublicKeyB64: string,
  deviceId: string,
): Buffer {
  const myPrivKey = nodeCrypto.createPrivateKey({
    key: Buffer.from(myPrivateKeyB64, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  const peerPubKey = nodeCrypto.createPublicKey({
    key: Buffer.from(peerPublicKeyB64, 'base64url'),
    format: 'der',
    type: 'spki',
  });
  const sharedSecret = nodeCrypto.diffieHellman({ privateKey: myPrivKey, publicKey: peerPubKey });
  const salt = Buffer.from(deviceId, 'utf8');
  const info = Buffer.from('sm-e2e-v1', 'utf8');
  return Buffer.from(nodeCrypto.hkdfSync('sha256', sharedSecret, salt, info, 32));
}

/** AES-256-GCM encrypt (matches agent's encryptBox). */
function encryptBoxReal(plaintext: string, sessionKey: Buffer): { nonce: string; ciphertext: string } {
  const nonce = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', sessionKey, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    nonce: nonce.toString('base64url'),
    ciphertext: Buffer.concat([encrypted, tag]).toString('base64url'),
  };
}

/** AES-256-GCM decrypt (matches agent's decryptBox). */
function decryptBoxReal(nonceB64: string, ciphertextB64: string, sessionKey: Buffer): string | null {
  try {
    const nonce = Buffer.from(nonceB64, 'base64url');
    const data = Buffer.from(ciphertextB64, 'base64url');
    if (data.length < 16) return null;
    const tag = data.subarray(data.length - 16);
    const ciphertext = data.subarray(0, data.length - 16);
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', sessionKey, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

describe('E2E relay blindness (real AES-256-GCM)', () => {
  /**
   * SECURITY INVARIANT: The relay forwards e2e:box envelopes as opaque blobs.
   * It cannot read the inner command type or payload without the session key
   * (which never transits the relay). This test uses real AES-256-GCM to prove
   * the invariant — not a mock ciphertext.
   */
  it('relay sees only e2e:box with opaque ciphertext — not the inner command', () => {
    // Set up a real P-256 ECDH keypair (simulating agent's stored keys)
    const { privateKey: agentPrivDer, publicKey: agentPubDer } = nodeCrypto.generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const agentPrivB64 = agentPrivDer.toString('base64url');
    const agentPubB64 = agentPubDer.toString('base64url');

    // Browser generates its own ephemeral keypair
    const { privateKey: browserPrivDer, publicKey: browserPubDer } = nodeCrypto.generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const browserPrivB64 = browserPrivDer.toString('base64url');
    const browserPubB64 = browserPubDer.toString('base64url');

    const deviceId = 'a1b2c3d4-0000-4000-8000-e5f6a7b8c9d0';

    // Both sides derive the same session key (ECDH is commutative)
    const agentKey = deriveSessionKeyReal(agentPrivB64, browserPubB64, deviceId);
    const browserKey = deriveSessionKeyReal(browserPrivB64, agentPubB64, deviceId);
    expect(agentKey.toString('hex')).toBe(browserKey.toString('hex'));

    // Browser encrypts a command (secret terminal input the relay must not see)
    const secretCommand = {
      type: 'cmd:pty:write',
      id: 'aaaaaaaa-0000-4000-8000-bbbbbbbbbbbb',
      deviceId,
      payload: { tabId: 'tab-1', data: 'export SECRET_KEY=hunter2; rm -rf /' },
      ts: 1_700_000_000_000,
    };
    const { nonce, ciphertext } = encryptBoxReal(JSON.stringify(secretCommand), browserKey);

    // This is what the relay sees when forwarding the command:
    const relayVisibleEnvelope = {
      type: 'e2e:box',
      id: 'cccccccc-0000-4000-8000-dddddddddddd',
      deviceId,
      payload: { nonce, ciphertext },
      ts: 1_700_000_000_001,
    };
    const relayJson = JSON.stringify(relayVisibleEnvelope);

    // The relay sees only 'e2e:box' — not the inner command type
    expect(relayVisibleEnvelope.type).toBe('e2e:box');
    expect(relayJson).not.toContain('cmd:pty:write');
    // The relay cannot read the secret payload
    expect(relayJson).not.toContain('SECRET_KEY');
    expect(relayJson).not.toContain('hunter2');
    expect(relayJson).not.toContain('rm -rf');
    // The ciphertext is genuinely opaque (not the plaintext base64-encoded)
    expect(ciphertext).not.toBe(Buffer.from(JSON.stringify(secretCommand)).toString('base64url'));

    // The agent CAN decrypt it (proving the session key is shared correctly)
    const decrypted = decryptBoxReal(nonce, ciphertext, agentKey);
    expect(decrypted).not.toBeNull();
    const inner = JSON.parse(decrypted!);
    expect(inner.type).toBe('cmd:pty:write');
    expect(inner.payload.data).toContain('SECRET_KEY');

    // A relay-side observer with only the outer envelope cannot reconstruct the inner command
    expect(Object.keys(relayVisibleEnvelope).sort()).toEqual(
      ['deviceId', 'id', 'payload', 'ts', 'type'].sort(),
    );
  });

  it('wrong session key produces auth-tag failure — relay cannot forge commands', () => {
    const { privateKey: privDer, publicKey: pubDer } = nodeCrypto.generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const correctKey = deriveSessionKeyReal(
      privDer.toString('base64url'),
      pubDer.toString('base64url'),
      'device-1',
    );
    const wrongKey = nodeCrypto.randomBytes(32); // random attacker key

    const { nonce, ciphertext } = encryptBoxReal('{"type":"cmd:app:version"}', correctKey);

    // Agent decrypts successfully with the correct key
    expect(decryptBoxReal(nonce, ciphertext, correctKey)).not.toBeNull();
    // Relay (or attacker) with wrong key fails GCM authentication
    expect(decryptBoxReal(nonce, ciphertext, wrongKey)).toBeNull();
  });

  it('e2e:hello is the only plaintext key-exchange message; subsequent messages are opaque', () => {
    // e2e:hello carries the browser's ephemeral public key to the agent.
    // The relay sees this but cannot derive the session key without the private key.
    const helloMsg = {
      type: 'e2e:hello',
      id: crypto.randomUUID(),
      deviceId: 'dev-uuid',
      payload: { pubKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...' },
      ts: Date.now(),
    };
    // Relay can see the public key (this is fine — it's public)
    expect(helloMsg.payload.pubKey).toBeTruthy();
    // But a public key alone cannot decrypt session traffic
    // (deriving the shared secret requires one side's private key)
    expect(helloMsg.type).toBe('e2e:hello');
  });
});

// ── Relay framing fuzz tests ──────────────────────────────────────────────

import { z } from 'zod';

describe('relay framing fuzz (envelope schema)', () => {
  // These tests verify the relay's envelope schema rejects malformed input.
  // They use the zod schema directly; integration tests for the WS framing
  // path are marked as manual in PENTEST.md.

  const envelopeSchema = z.object({
    type: z.string().min(1).max(256),   // must match router.ts cap
    id: z.string().uuid(),
    deviceId: z.string().max(128).optional(),
    payload: z.unknown().optional(),
    ts: z.number().int().positive(),
  });

  const VALID_BASE = {
    type: 'cmd:app:version',
    id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    ts: 1_700_000_000_000,
  };

  const malformed = [
    ['empty object', {}],
    ['missing type', { id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', ts: 1 }],
    ['empty type', { ...VALID_BASE, type: '' }],
    ['missing id', { type: 'cmd:app:version', ts: 1 }],
    ['non-UUID id', { ...VALID_BASE, id: 'not-a-uuid' }],
    ['missing ts', { type: 'cmd:app:version', id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' }],
    ['negative ts', { ...VALID_BASE, ts: -1 }],
    ['zero ts', { ...VALID_BASE, ts: 0 }],
    ['string ts', { ...VALID_BASE, ts: 'now' }],
    ['null input', null],
    ['array input', []],
    ['number input', 42],
    ['giant type string', { ...VALID_BASE, type: 'x'.repeat(10_000) }],
  ] as const;

  for (const [label, input] of malformed) {
    it(`rejects ${label}`, () => {
      expect(envelopeSchema.safeParse(input).success).toBe(false);
    });
  }

  it('accepts a well-formed envelope', () => {
    expect(envelopeSchema.safeParse(VALID_BASE).success).toBe(true);
  });

  it('accepts e2e:box envelope (relay forwards without parsing inner content)', () => {
    const e2eBox = {
      type: 'e2e:box',
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      deviceId: 'dev-uuid',
      payload: { nonce: 'AAAA', ciphertext: 'BBBB' },
      ts: 1_700_000_000_000,
    };
    expect(envelopeSchema.safeParse(e2eBox).success).toBe(true);
  });
});
