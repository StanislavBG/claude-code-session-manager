import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateOtpCode,
  issueOtp,
  verifyOtp,
  issueDeviceToken,
  verifyDeviceToken,
  revokeDevice,
  issueWsTicket,
  consumeWsTicket,
  otpStore,
  deviceTokenStore,
  deviceByIdStore,
  wsTicketStore,
  otpRateStore,
} from '../src/tokens';

// Reset all in-process stores before each test for isolation
beforeEach(() => {
  otpStore.clear();
  deviceTokenStore.clear();
  deviceByIdStore.clear();
  wsTicketStore.clear();
  otpRateStore.clear();
});

// ── generateOtpCode ───────────────────────────────────────────────────────

describe('generateOtpCode', () => {
  it('returns exactly 8 characters', () => {
    expect(generateOtpCode()).toHaveLength(8);
  });

  it('only contains uppercase alphanumeric characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateOtpCode()).toMatch(/^[A-Z0-9]+$/);
    }
  });

  it('produces different codes across calls (entropy check)', () => {
    const codes = new Set(Array.from({ length: 100 }, () => generateOtpCode()));
    // With ~41 bits of entropy, zero collision in 100 draws is almost certain
    expect(codes.size).toBe(100);
  });
});

// ── issueOtp ─────────────────────────────────────────────────────────────

describe('issueOtp', () => {
  it('returns a code on success', () => {
    const result = issueOtp('user-1', 'user1@example.com');
    expect('code' in result).toBe(true);
    if ('code' in result) expect(result.code).toHaveLength(8);
  });

  it('stores the OTP in the otpStore', () => {
    const result = issueOtp('user-1', 'user1@example.com');
    if ('code' in result) {
      expect(otpStore.has(result.code)).toBe(true);
    }
  });

  it('only keeps one active OTP per user (invalidates previous)', () => {
    const r1 = issueOtp('user-1', 'user1@example.com');
    const r2 = issueOtp('user-1', 'user1@example.com');
    if ('code' in r1 && 'code' in r2) {
      expect(otpStore.has(r1.code)).toBe(false); // previous is gone
      expect(otpStore.has(r2.code)).toBe(true);  // new one exists
    }
  });

  it('rate-limits at 10 OTPs per hour per user', () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      const r = issueOtp('user-rl', 'rl@example.com', now);
      expect('code' in r).toBe(true);
    }
    const blocked = issueOtp('user-rl', 'rl@example.com', now);
    expect('error' in blocked).toBe(true);
    if ('error' in blocked) expect(blocked.error).toBe('rate_limited');
  });

  it('rate limit resets after the hour window', () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) issueOtp('user-rl2', 'rl2@example.com', now);

    const future = now + 61 * 60 * 1000; // 61 minutes later
    const r = issueOtp('user-rl2', 'rl2@example.com', future);
    expect('code' in r).toBe(true);
  });

  it('rate limits are per-user (different users do not interfere)', () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) issueOtp('user-a', 'a@example.com', now);
    const r = issueOtp('user-b', 'b@example.com', now);
    expect('code' in r).toBe(true);
  });
});

// ── verifyOtp ─────────────────────────────────────────────────────────────

describe('verifyOtp', () => {
  it('returns userId and email for a valid code', () => {
    const now = Date.now();
    const r = issueOtp('user-1', 'user1@example.com', now);
    if (!('code' in r)) throw new Error('expected code');
    const verify = verifyOtp(r.code, now + 1000);
    expect('userId' in verify).toBe(true);
    if ('userId' in verify) {
      expect(verify.userId).toBe('user-1');
      expect(verify.email).toBe('user1@example.com');
    }
  });

  it('is single-use: second call with the same code fails', () => {
    const now = Date.now();
    const r = issueOtp('user-1', 'user1@example.com', now);
    if (!('code' in r)) throw new Error('expected code');
    verifyOtp(r.code, now + 100);
    const second = verifyOtp(r.code, now + 200);
    expect('error' in second).toBe(true);
  });

  it('rejects an expired OTP', () => {
    const now = Date.now();
    const r = issueOtp('user-1', 'user1@example.com', now);
    if (!('code' in r)) throw new Error('expected code');
    // 6 minutes after issue (TTL is 5 minutes)
    const result = verifyOtp(r.code, now + 6 * 60 * 1000);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toBe('code_expired');
  });

  it('rejects an unknown code', () => {
    const result = verifyOtp('ZZZZZZZZ');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toBe('invalid_code');
  });

  it('accepts codes case-insensitively', () => {
    const now = Date.now();
    const r = issueOtp('user-1', 'user1@example.com', now);
    if (!('code' in r)) throw new Error('expected code');
    const lower = r.code.toLowerCase();
    const result = verifyOtp(lower, now + 100);
    expect('userId' in result).toBe(true);
  });

  it('removes the OTP from the store after successful verification', () => {
    const now = Date.now();
    const r = issueOtp('user-1', 'user1@example.com', now);
    if (!('code' in r)) throw new Error('expected code');
    verifyOtp(r.code, now + 100);
    expect(otpStore.size).toBe(0);
  });
});

// ── issueDeviceToken ──────────────────────────────────────────────────────

describe('issueDeviceToken', () => {
  it('returns a 256-bit base64url token (43 chars)', () => {
    const token = issueDeviceToken('device-1', 'user-1', 'user1@example.com');
    // base64url of 32 bytes = 43 chars
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('stores the token in deviceTokenStore and deviceByIdStore', () => {
    const token = issueDeviceToken('device-1', 'user-1', 'user1@example.com');
    expect(deviceTokenStore.has(token)).toBe(true);
    expect(deviceByIdStore.has('device-1')).toBe(true);
  });

  it('replaces the old token when re-issuing for the same deviceId', () => {
    const t1 = issueDeviceToken('device-1', 'user-1', 'u@e.com');
    const t2 = issueDeviceToken('device-1', 'user-1', 'u@e.com');
    expect(deviceTokenStore.has(t1)).toBe(false);
    expect(deviceTokenStore.has(t2)).toBe(true);
  });

  it('generates unique tokens', () => {
    const tokens = new Set(
      Array.from({ length: 50 }, (_, i) => issueDeviceToken(`device-${i}`, 'user-1', 'u@e.com')),
    );
    expect(tokens.size).toBe(50);
  });
});

// ── verifyDeviceToken ─────────────────────────────────────────────────────

describe('verifyDeviceToken', () => {
  it('returns entry for a valid token', () => {
    const token = issueDeviceToken('device-1', 'user-1', 'u@e.com');
    const entry = verifyDeviceToken(token);
    expect(entry).not.toBeNull();
    expect(entry?.deviceId).toBe('device-1');
    expect(entry?.userId).toBe('user-1');
  });

  it('returns null for an unknown token', () => {
    expect(verifyDeviceToken('this-is-not-a-real-token')).toBeNull();
  });

  it('returns null after revocation', () => {
    const token = issueDeviceToken('device-1', 'user-1', 'u@e.com');
    revokeDevice('device-1');
    expect(verifyDeviceToken(token)).toBeNull();
  });
});

// ── revokeDevice ──────────────────────────────────────────────────────────

describe('revokeDevice', () => {
  it('returns true when the device existed', () => {
    issueDeviceToken('device-1', 'user-1', 'u@e.com');
    expect(revokeDevice('device-1')).toBe(true);
  });

  it('returns false when the device does not exist', () => {
    expect(revokeDevice('nonexistent')).toBe(false);
  });

  it('removes the token from both stores', () => {
    const token = issueDeviceToken('device-1', 'user-1', 'u@e.com');
    revokeDevice('device-1');
    expect(deviceTokenStore.has(token)).toBe(false);
    expect(deviceByIdStore.has('device-1')).toBe(false);
  });
});

// ── issueWsTicket / consumeWsTicket ──────────────────────────────────────

describe('WS tickets', () => {
  it('issueWsTicket returns a base64url string', () => {
    const t = issueWsTicket({ userId: 'u', email: 'u@e.com', role: 'browser' });
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('ticket has ~128 bits of entropy (≥21 base64url chars)', () => {
    const t = issueWsTicket({ userId: 'u', email: 'u@e.com', role: 'browser' });
    // 16 bytes base64url = 22 chars
    expect(t.length).toBeGreaterThanOrEqual(21);
  });

  it('consumeWsTicket returns the stored data', () => {
    const now = Date.now();
    const t = issueWsTicket({ userId: 'u', email: 'u@e.com', role: 'browser' }, now);
    const data = consumeWsTicket(t, now + 1000);
    expect(data).not.toBeNull();
    expect(data?.userId).toBe('u');
    expect(data?.role).toBe('browser');
  });

  it('ticket is single-use: second consume returns null', () => {
    const now = Date.now();
    const t = issueWsTicket({ userId: 'u', email: 'u@e.com', role: 'browser' }, now);
    consumeWsTicket(t, now + 100);
    expect(consumeWsTicket(t, now + 200)).toBeNull();
  });

  it('ticket expires after 30 seconds', () => {
    const now = Date.now();
    const t = issueWsTicket({ userId: 'u', email: 'u@e.com', role: 'browser' }, now);
    const data = consumeWsTicket(t, now + 31_000); // 31 s later
    expect(data).toBeNull();
  });

  it('returns null for an unknown ticket', () => {
    expect(consumeWsTicket('not-a-real-ticket')).toBeNull();
  });

  it('preserves deviceId for agent tickets', () => {
    const now = Date.now();
    const t = issueWsTicket({ userId: 'u', email: 'u@e.com', role: 'agent', deviceId: 'dev-1' }, now);
    const data = consumeWsTicket(t, now + 1000);
    expect(data?.deviceId).toBe('dev-1');
  });
});
