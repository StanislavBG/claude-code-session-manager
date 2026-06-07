import crypto from 'node:crypto';
import type { OtpEntry, DeviceTokenEntry, WsTicketEntry } from './types';

// ── Constants ──────────────────────────────────────────────────────────────

const OTP_TTL_MS = 5 * 60 * 1000;           // 5 minutes
const OTP_RATE_LIMIT_COUNT = 10;             // per user per hour
const OTP_RATE_WINDOW_MS = 60 * 60 * 1000;  // 1 hour
const WS_TICKET_TTL_MS = 30 * 1000;         // 30 seconds

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
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += OTP_CHARSET[bytes[i] % OTP_CHARSET.length];
  }
  return code;
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
  otpStore.set(code, { code, userId, email, expiresAt: now + OTP_TTL_MS });
  return { code };
}

export function verifyOtp(
  code: string,
  now = Date.now(),
): { userId: string; email: string } | { error: string; status: number } {
  const normalized = code.toUpperCase().trim();
  const entry = otpStore.get(normalized);
  if (!entry) return { error: 'invalid_code', status: 400 };
  if (now > entry.expiresAt) {
    otpStore.delete(normalized);
    return { error: 'code_expired', status: 400 };
  }
  // Single-use: delete on first successful verification
  otpStore.delete(normalized);
  return { userId: entry.userId, email: entry.email };
}

// ── Device tokens ──────────────────────────────────────────────────────────

export function issueDeviceToken(
  deviceId: string,
  userId: string,
  email: string,
  now = Date.now(),
): string {
  // Revoke any existing token for this device (one token per device)
  const existing = deviceByIdStore.get(deviceId);
  if (existing) deviceTokenStore.delete(existing.token);

  // 256-bit random token (ARCHITECTURE.md §3.3)
  const token = crypto.randomBytes(32).toString('base64url');
  const entry: DeviceTokenEntry = { token, deviceId, userId, email, issuedAt: now, revoked: false };
  deviceTokenStore.set(token, entry);
  deviceByIdStore.set(deviceId, entry);
  return token;
}

export function verifyDeviceToken(token: string): DeviceTokenEntry | null {
  const entry = deviceTokenStore.get(token);
  if (!entry || entry.revoked) return null;
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

export function getDevicesForUser(userId: string): Array<{ deviceId: string; email: string; issuedAt: number }> {
  const result: Array<{ deviceId: string; email: string; issuedAt: number }> = [];
  for (const entry of deviceByIdStore.values()) {
    if (entry.userId === userId && !entry.revoked) {
      result.push({ deviceId: entry.deviceId, email: entry.email, issuedAt: entry.issuedAt });
    }
  }
  return result;
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
}
