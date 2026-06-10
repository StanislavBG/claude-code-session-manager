import crypto from 'node:crypto';
import type { OtpEntry, DeviceTokenEntry, WsTicketEntry } from './types';

// ── Constants ──────────────────────────────────────────────────────────────

const OTP_TTL_MS = 5 * 60 * 1000;              // 5 minutes
const OTP_MAX_ATTEMPTS = 3;                     // OTP invalidated after 3 failed verifications
const OTP_RATE_LIMIT_COUNT = 10;                // per user per hour
const OTP_RATE_WINDOW_MS = 60 * 60 * 1000;     // 1 hour
const WS_TICKET_TTL_MS = 30 * 1000;            // 30 seconds
const DEVICE_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90-day hard TTL (§4.1)

// Unambiguous alphanumeric charset (excludes 0/O, 1/I, 8/B look-alikes)
const OTP_CHARSET = 'ACDEFGHJKLMNPQRTUVWXY234679';

// ── In-process stores (lost on redeploy — acceptable for v1) ──────────────

export const otpStore = new Map<string, OtpEntry>();                    // code → entry
export const deviceTokenStore = new Map<string, DeviceTokenEntry>();    // token → entry
export const deviceByIdStore = new Map<string, DeviceTokenEntry>();     // deviceId → entry
export const wsTicketStore = new Map<string, WsTicketEntry>();          // ticket → entry
export const otpRateStore = new Map<string, { count: number; resetAt: number }>(); // userId → window

// ── OTP ───────────────────────────────────────────────────────────────────

export function generateOtpCode(): string {
  // Rejection sampling: only accept bytes below the largest multiple of
  // charset length that fits in 0-255, ensuring uniform distribution.
  const maxAccept = Math.floor(256 / OTP_CHARSET.length) * OTP_CHARSET.length;
  const chars: string[] = [];
  while (chars.length < 8) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < maxAccept) chars.push(OTP_CHARSET[byte % OTP_CHARSET.length]);
  }
  return chars.join('');
}

export function issueOtp(
  userId: string,
  email: string,
  now = Date.now(),
): { code: string } | { error: string; retryAfterMs?: number } {
  const rate = otpRateStore.get(userId);
  if (rate && now < rate.resetAt) {
    if (rate.count >= OTP_RATE_LIMIT_COUNT) {
      return { error: 'rate_limited', retryAfterMs: rate.resetAt - now };
    }
    rate.count++;
  } else {
    otpRateStore.set(userId, { count: 1, resetAt: now + OTP_RATE_WINDOW_MS });
  }

  // Invalidate any previous OTP for this user (one active OTP per user)
  for (const [code, entry] of otpStore) {
    if (entry.userId === userId) otpStore.delete(code);
  }

  const code = generateOtpCode();
  otpStore.set(code, { code, userId, email, expiresAt: now + OTP_TTL_MS, attempts: 0 });
  return { code };
}

// Global brute-force budget for /pair. verifyOtp() is a global lookup keyed
// only by the 8-char code, and /pair is unauthenticated, so on a wrong guess
// there is no userId to attribute a per-OTP strike to (recordOtpFailure can
// only be driven once a user is known). This relay-wide counter bounds the
// TOTAL number of failed guesses per window regardless of source IP, which is
// the control that actually defeats IP-rotation brute force. Legitimate users
// paste the code and effectively never fail, so the ceiling is generous.
const OTP_GLOBAL_FAIL_MAX = 100;
const OTP_GLOBAL_FAIL_WINDOW_MS = 5 * 60 * 1000;
const otpGlobalFail = { count: 0, resetAt: 0 };

/** Test-only: reset the global brute-force budget between specs. */
export function _resetOtpGlobalFail(): void {
  otpGlobalFail.count = 0;
  otpGlobalFail.resetAt = 0;
}

export function verifyOtp(
  code: string,
  now = Date.now(),
): { userId: string; email: string } | { error: string; status: number } {
  // Roll the global failure window.
  if (now >= otpGlobalFail.resetAt) {
    otpGlobalFail.count = 0;
    otpGlobalFail.resetAt = now + OTP_GLOBAL_FAIL_WINDOW_MS;
  }
  if (otpGlobalFail.count >= OTP_GLOBAL_FAIL_MAX) {
    return { error: 'rate_limited', status: 429 };
  }

  const normalized = code.toUpperCase().trim();
  const entry = otpStore.get(normalized);
  if (!entry) {
    otpGlobalFail.count++;
    return { error: 'invalid_code', status: 400 };
  }
  if (now > entry.expiresAt) {
    otpStore.delete(normalized);
    otpGlobalFail.count++;
    return { error: 'code_expired', status: 400 };
  }
  // Single-use: delete on first successful verification
  otpStore.delete(normalized);
  return { userId: entry.userId, email: entry.email };
}

/**
 * Record a failed pairing attempt against an OTP code.
 * Returns true if the OTP was found and invalidated (3 strikes), false otherwise.
 * Called by the /pair endpoint when it can't locate a matching OTP (wrong code)
 * to protect against brute force across the entire OTP space.
 */
export function recordOtpFailure(userId: string, now = Date.now()): boolean {
  // Find any live OTP for this user and increment its attempt counter.
  // Invalidate if it hits OTP_MAX_ATTEMPTS.
  for (const [code, entry] of otpStore) {
    if (entry.userId === userId && now <= entry.expiresAt) {
      entry.attempts++;
      if (entry.attempts >= OTP_MAX_ATTEMPTS) {
        otpStore.delete(code);
        return true; // OTP invalidated due to too many failures
      }
      return false;
    }
  }
  return false;
}

// ── Device tokens ──────────────────────────────────────────────────────────

export function issueDeviceToken(
  deviceId: string,
  userId: string,
  email: string,
  devicePubKey: string,
  now = Date.now(),
): string {
  // Revoke any existing token for this device (one token per device)
  const existing = deviceByIdStore.get(deviceId);
  if (existing) deviceTokenStore.delete(existing.token);

  // 256-bit random token (ARCHITECTURE.md §3.3)
  const token = crypto.randomBytes(32).toString('base64url');
  const entry: DeviceTokenEntry = {
    token, deviceId, userId, email, issuedAt: now,
    expiresAt: now + DEVICE_TOKEN_TTL_MS,
    revoked: false,
    devicePubKey,
  };
  deviceTokenStore.set(token, entry);
  deviceByIdStore.set(deviceId, entry);
  return token;
}

export function verifyDeviceToken(token: string, now = Date.now()): DeviceTokenEntry | null {
  const entry = deviceTokenStore.get(token);
  if (!entry || entry.revoked) return null;
  if (now > entry.expiresAt) {
    // Token expired — remove and treat as invalid
    deviceTokenStore.delete(token);
    deviceByIdStore.delete(entry.deviceId);
    return null;
  }
  return entry;
}

export function revokeDevice(deviceId: string): boolean {
  const entry = deviceByIdStore.get(deviceId);
  if (!entry) return false;
  entry.revoked = true;
  deviceTokenStore.delete(entry.token);
  deviceByIdStore.delete(deviceId);
  return true;
}

export function getDevicesForUser(userId: string, now = Date.now()): Array<{ deviceId: string; email: string; issuedAt: number; expiresAt: number; devicePubKey: string }> {
  const result: Array<{ deviceId: string; email: string; issuedAt: number; expiresAt: number; devicePubKey: string }> = [];
  for (const entry of deviceByIdStore.values()) {
    if (entry.userId === userId && !entry.revoked && now <= entry.expiresAt) {
      result.push({
        deviceId: entry.deviceId,
        email: entry.email,
        issuedAt: entry.issuedAt,
        expiresAt: entry.expiresAt,
        devicePubKey: entry.devicePubKey,
      });
    }
  }
  return result;
}

/**
 * Revoke all device tokens for a given userId.
 * Returns the list of revoked deviceIds.
 */
export function revokeAllDevicesForUser(userId: string): string[] {
  const revoked: string[] = [];
  for (const entry of Array.from(deviceByIdStore.values())) {
    if (entry.userId === userId && !entry.revoked) {
      entry.revoked = true;
      deviceTokenStore.delete(entry.token);
      deviceByIdStore.delete(entry.deviceId);
      revoked.push(entry.deviceId);
    }
  }
  return revoked;
}

// ── WS tickets (128-bit, 30 s TTL, single-use) ────────────────────────────

export function issueWsTicket(
  data: Omit<WsTicketEntry, 'expiresAt'>,
  now = Date.now(),
): string {
  const ticket = crypto.randomBytes(16).toString('base64url');
  wsTicketStore.set(ticket, { ...data, expiresAt: now + WS_TICKET_TTL_MS });
  return ticket;
}

export function consumeWsTicket(ticket: string, now = Date.now()): WsTicketEntry | null {
  const entry = wsTicketStore.get(ticket);
  if (!entry) return null;
  wsTicketStore.delete(ticket); // single-use: invalidate immediately
  if (now > entry.expiresAt) return null;
  return entry;
}

// ── Housekeeping ───────────────────────────────────────────────────────────

export function purgeExpired(now = Date.now()): void {
  for (const [code, entry] of otpStore) {
    if (now > entry.expiresAt) otpStore.delete(code);
  }
  for (const [ticket, entry] of wsTicketStore) {
    if (now > entry.expiresAt) wsTicketStore.delete(ticket);
  }
  for (const [userId, rate] of otpRateStore) {
    if (now > rate.resetAt) otpRateStore.delete(userId);
  }
  // Purge expired device tokens
  for (const [token, entry] of deviceTokenStore) {
    if (now > entry.expiresAt) {
      deviceTokenStore.delete(token);
      deviceByIdStore.delete(entry.deviceId);
    }
  }
}
