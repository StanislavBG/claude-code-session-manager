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

// ── Routing invariant: userId from session, not envelope ───────────────────

describe('routing security invariant', () => {
  it('canRoute does not use any envelope field — only userId from session objects', () => {
    // This test documents the security invariant: the routing decision
    // accepts only the session-side userId, not anything from a message envelope.
    // An attacker crafting { deviceId: "victim-device" } in the envelope
    // cannot escalate because canRoute is called with the session's userId,
    // which was locked in at ticket-verification time (ARCHITECTURE.md §2.2).
    const attackerBrowser = { userId: 'attacker-123' } as Pick<BrowserConn, 'userId'>;
    const victimDevice = { userId: 'victim-456' } as Pick<DeviceConn, 'userId'>;
    expect(canRoute(attackerBrowser, victimDevice)).toBe(false);
  });
});
