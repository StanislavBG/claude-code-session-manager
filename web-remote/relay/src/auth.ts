import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { OAuth2Client } from 'google-auth-library';

// Extend the fastify Session interface with our custom session fields
declare module 'fastify' {
  interface Session {
    userId?: string;
    email?: string;
    oauthState?: string;
  }
}
import {
  issueOtp,
  issueWsTicket,
  verifyDeviceToken,
  revokeDevice,
  revokeAllDevicesForUser,
  getDevicesForUser,
} from './tokens';

// ── Allowlist ──────────────────────────────────────────────────────────────

/**
 * Returns true if email is in the comma-separated ALLOWED_EMAIL env var.
 * Both the stored list and the supplied email are lowercased before comparison.
 */
export function checkAllowlist(email: string, allowlistEnv: string): boolean {
  const allowed = allowlistEnv
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.toLowerCase());
}

// ── /pair endpoint IP-based rate limiting ─────────────────────────────────

const PAIR_RATE_MAX = 5;                 // max pair attempts per IP per window
const PAIR_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

interface PairRateEntry { count: number; resetAt: number }
const pairIpRateStore = new Map<string, PairRateEntry>();

// ── /api/device-ticket per-token rate limiting ─────────────────────────────
// Prevents a compromised device token from hammering the ticket endpoint.
// A legitimate reconnect loop needs at most a few tickets per minute.

const DEVICE_TICKET_RATE_MAX = 10;          // max requests per token per window
const DEVICE_TICKET_RATE_WINDOW_MS = 60_000; // 1 minute

interface DeviceTicketRateEntry { count: number; resetAt: number }
const deviceTicketRateStore = new Map<string, DeviceTicketRateEntry>();

function checkDeviceTicketRateLimit(tokenPrefix: string, now = Date.now()): boolean {
  const entry = deviceTicketRateStore.get(tokenPrefix);
  if (!entry || now >= entry.resetAt) {
    deviceTicketRateStore.set(tokenPrefix, { count: 1, resetAt: now + DEVICE_TICKET_RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= DEVICE_TICKET_RATE_MAX) return false;
  entry.count++;
  return true;
}

function getClientIp(req: FastifyRequest): string {
  // Take the LAST element of X-Forwarded-For: Render's load balancer appends the
  // real client IP, so the rightmost value is infrastructure-controlled and cannot
  // be spoofed. The leftmost element is attacker-supplied and must not be trusted.
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',').at(-1)!.trim();
  }
  return (req.socket?.remoteAddress) ?? 'unknown';
}

function checkPairRateLimit(ip: string, now = Date.now()): boolean {
  const entry = pairIpRateStore.get(ip);
  if (!entry || now >= entry.resetAt) {
    pairIpRateStore.set(ip, { count: 1, resetAt: now + PAIR_RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= PAIR_RATE_MAX) return false;
  entry.count++;
  return true;
}

// ── OAuth2 client (module-level singleton) ─────────────────────────────────

let _oauth2Client: OAuth2Client | null = null;

function getOAuth2Client(): OAuth2Client {
  if (!_oauth2Client) {
    _oauth2Client = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI,
    );
  }
  return _oauth2Client;
}

// ── Session auth helper ────────────────────────────────────────────────────

function requireBrowserSession(
  req: FastifyRequest,
  reply: FastifyReply,
): { userId: string; email: string } | null {
  const { userId, email } = req.session;
  if (!userId || !email) {
    reply.status(401).send({ error: 'unauthenticated' });
    return null;
  }
  const allowlist = process.env.ALLOWED_EMAIL ?? '';
  if (!checkAllowlist(email, allowlist)) {
    reply.status(403).send({ error: 'not_allowed' });
    return null;
  }
  return { userId, email };
}

// ── Fastify plugin ─────────────────────────────────────────────────────────

export async function registerAuthRoutes(fastify: FastifyInstance): Promise<void> {
  // ── Health ───────────────────────────────────────────────────────────────
  fastify.get('/health', async (_req, reply) => {
    reply.status(200).send({ ok: true });
  });

  // ── GET /api/me — return session user or 401 ────────────────────────────
  fastify.get('/api/me', async (req, reply) => {
    const auth = requireBrowserSession(req, reply);
    if (!auth) return;
    reply.send({ userId: auth.userId, email: auth.email });
  });

  // ── POST /api/logout ─────────────────────────────────────────────────────
  fastify.post('/api/logout', async (req, reply) => {
    const userId = req.session.userId;
    req.session.destroy();
    // Close any active WS browser sessions so stale tabs stop receiving PTY events
    if (userId) {
      const { closeSessionsForUser } = await import('./router');
      closeSessionsForUser(userId);
    }
    reply.send({ ok: true });
  });

  // ── Google OAuth redirect ────────────────────────────────────────────────
  fastify.get('/auth/google', async (req, reply) => {
    const oauth2Client = getOAuth2Client();
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;

    const url = oauth2Client.generateAuthUrl({
      access_type: 'online',
      scope: ['openid', 'email', 'profile'],
      state,
    });
    reply.redirect(url);
  });

  // ── Google OAuth callback ────────────────────────────────────────────────
  fastify.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/google/callback',
    async (req, reply) => {
      const { code, state, error } = req.query;
      if (error) {
        // Do not reflect the raw OAuth error string — log it server-side only.
        req.log.warn({ oauthError: error }, 'OAuth callback error');
        return reply.status(400).send({ error: 'oauth_error' });
      }
      if (!code) {
        return reply.status(400).send({ error: 'missing_code' });
      }

      if (!state || state !== req.session.oauthState) {
        return reply.status(400).send({ error: 'invalid_state' });
      }
      req.session.oauthState = undefined;

      const oauth2Client = getOAuth2Client();
      let payload: { sub?: string; email?: string; email_verified?: boolean };
      try {
        const { tokens } = await oauth2Client.getToken(code);
        if (!tokens.id_token) throw new Error('no id_token');
        const ticket = await oauth2Client.verifyIdToken({
          idToken: tokens.id_token,
          audience: process.env.GOOGLE_CLIENT_ID,
        });
        payload = ticket.getPayload() ?? {};
      } catch {
        return reply.status(401).send({ error: 'token_verification_failed' });
      }

      if (!payload.email || !payload.email_verified) {
        return reply.status(401).send({ error: 'unverified_email' });
      }

      const allowlist = process.env.ALLOWED_EMAIL ?? '';
      if (!checkAllowlist(payload.email, allowlist)) {
        return reply.status(403).send({ error: 'not_allowed' });
      }

      req.session.userId = payload.sub;
      req.session.email = payload.email;

      // Redirect target is fixed — never read from a user-supplied parameter
      // to prevent open redirect. ALLOWED_ORIGIN is validated against an
      // explicit allowlist; any other value falls back to the canonical origin.
      const configuredOrigin = process.env.ALLOWED_ORIGIN ?? 'https://session-manager.bilko.run';
      const safeOrigins = new Set([
        'https://session-manager.bilko.run',
        ...(process.env.NODE_ENV !== 'production'
          ? ['http://localhost:4173', 'http://localhost:5173']
          : []),
      ]);
      const safeOrigin = safeOrigins.has(configuredOrigin)
        ? configuredOrigin
        : 'https://session-manager.bilko.run';
      reply.redirect(safeOrigin + '/');
    },
  );

  // ── POST /api/otp — browser generates pairing OTP ───────────────────────
  fastify.post('/api/otp', async (req, reply) => {
    const auth = requireBrowserSession(req, reply);
    if (!auth) return;

    const result = issueOtp(auth.userId, auth.email);
    if ('error' in result) {
      const status = result.error === 'rate_limited' ? 429 : 400;
      return reply.status(status).send(result);
    }
    // OTP code is shown to the browser user; they enter it in the local app
    reply.send({ code: result.code });
  });

  // ── POST /api/ws-ticket — browser gets a one-time WS upgrade ticket ──────
  fastify.post('/api/ws-ticket', async (req, reply) => {
    const auth = requireBrowserSession(req, reply);
    if (!auth) return;

    const ticket = issueWsTicket({ userId: auth.userId, email: auth.email, role: 'browser' });
    reply.send({ ticket });
  });

  // ── POST /api/device-ticket — agent gets a one-time WS upgrade ticket ────
  fastify.post('/api/device-ticket', async (req, reply) => {
    const authHeader = req.headers.authorization ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'missing_token' });
    }
    const rawToken = authHeader.slice(7);

    // Rate-limit by a non-secret prefix of the token (first 16 chars, base64url).
    // The prefix is meaningless without the rest of the token, so it's safe to
    // use as a rate-limit key without leaking auth material.
    const tokenPrefix = rawToken.slice(0, 16);
    if (!checkDeviceTicketRateLimit(tokenPrefix)) {
      return reply.status(429).send({ error: 'rate_limited' });
    }

    const device = verifyDeviceToken(rawToken);
    if (!device) {
      return reply.status(401).send({ error: 'invalid_token' });
    }

    const allowlist = process.env.ALLOWED_EMAIL ?? '';
    if (!checkAllowlist(device.email, allowlist)) {
      return reply.status(403).send({ error: 'not_allowed' });
    }

    const ticket = issueWsTicket({
      userId: device.userId,
      email: device.email,
      role: 'agent',
      deviceId: device.deviceId,
    });
    reply.send({ ticket });
  });

  // ── POST /pair — agent exchanges OTP for device token ───────────────────
  // Accepts devicePubKey (SPKI DER base64url) for E2E encryption (PRD 10).
  fastify.post<{ Body: { code?: string; deviceId?: string; devicePubKey?: string } }>(
    '/pair',
    { schema: { body: { type: 'object', required: ['code', 'deviceId'] } } },
    async (req, reply) => {
      // Per-IP rate limiting: max 10 /pair attempts per hour per source IP
      const clientIp = getClientIp(req);
      if (!checkPairRateLimit(clientIp)) {
        return reply.status(429).send({ error: 'rate_limited' });
      }

      const { code, deviceId, devicePubKey } = req.body;
      if (!code || !deviceId) {
        return reply.status(400).send({ error: 'missing_fields' });
      }
      // Reject any code that doesn't match the OTP format before touching the store.
      // This prevents oversized strings from being normalised and looked up.
      if (typeof code !== 'string' || !/^[A-Za-z0-9]{8}$/.test(code)) {
        return reply.status(400).send({ error: 'invalid_code_format' });
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
        return reply.status(400).send({ error: 'invalid_device_id' });
      }
      // devicePubKey is required for E2E (SPKI DER base64url, P-256, ~124 chars).
      // Character-set check rejects newlines/control chars before the value is
      // stored and returned to all browser sessions via GET /api/devices.
      const PUB_KEY_RE = /^[A-Za-z0-9+/=_-]+$/;
      if (!devicePubKey || typeof devicePubKey !== 'string' || devicePubKey.length > 512 || !PUB_KEY_RE.test(devicePubKey)) {
        return reply.status(400).send({ error: 'missing_device_pub_key' });
      }

      const { verifyOtp, issueDeviceToken } = await import('./tokens');
      const result = verifyOtp(code);
      if ('error' in result) {
        return reply.status(result.status).send({ error: result.error });
      }

      const deviceToken = issueDeviceToken(deviceId, result.userId, result.email, devicePubKey);
      // Token returned to agent; NEVER logged
      reply.send({ deviceToken, deviceId });
    },
  );

  // ── GET /api/devices — list paired devices for the signed-in user ────────
  fastify.get('/api/devices', async (req, reply) => {
    const auth = requireBrowserSession(req, reply);
    if (!auth) return;

    const { isDeviceOnline } = await import('./router');
    const devices = getDevicesForUser(auth.userId).map((d) => ({
      deviceId: d.deviceId,
      email: d.email,
      issuedAt: d.issuedAt,
      expiresAt: d.expiresAt,
      isOnline: isDeviceOnline(d.deviceId),
      // Expose the agent's E2E public key so the browser can do key agreement.
      // Public keys are not secret; the relay seeing them is acceptable.
      devicePubKey: d.devicePubKey,
    }));
    reply.send({ devices });
  });

  // ── DELETE /api/devices/:deviceId — revoke a single device token ─────────
  fastify.delete<{ Params: { deviceId: string } }>(
    '/api/devices/:deviceId',
    async (req, reply) => {
      const auth = requireBrowserSession(req, reply);
      if (!auth) return;

      const { deviceId } = req.params;
      const { deviceByIdStore } = await import('./tokens');
      const entry = deviceByIdStore.get(deviceId);
      if (!entry || entry.userId !== auth.userId) {
        return reply.status(404).send({ error: 'device_not_found' });
      }

      revokeDevice(deviceId);

      // The router module closes the WS connection with code 4001 when it sees
      // the token is revoked — imported lazily to avoid a circular dep at module load
      const { notifyDeviceRevoked } = await import('./router');
      notifyDeviceRevoked(deviceId);

      reply.send({ ok: true });
    },
  );

  // ── DELETE /api/devices — panic: revoke ALL device tokens for this user ──
  fastify.delete('/api/devices', async (req, reply) => {
    const auth = requireBrowserSession(req, reply);
    if (!auth) return;

    const revokedIds = revokeAllDevicesForUser(auth.userId);

    // Close all WS connections for revoked devices
    const { notifyDeviceRevoked, closeSessionsForUser } = await import('./router');
    for (const deviceId of revokedIds) {
      notifyDeviceRevoked(deviceId);
    }
    // Also tear down all browser WS sessions so no stale commands can arrive
    closeSessionsForUser(auth.userId);

    reply.send({ ok: true, revokedCount: revokedIds.length });
  });
}

/** Purge stale entries from the auth rate-limit stores. Call alongside purgeExpired(). */
export function purgeAuthRateLimits(now = Date.now()): void {
  for (const [ip, entry] of pairIpRateStore) {
    if (now >= entry.resetAt) pairIpRateStore.delete(ip);
  }
  for (const [prefix, entry] of deviceTicketRateStore) {
    if (now >= entry.resetAt) deviceTicketRateStore.delete(prefix);
  }
}

// Export for tests
export { checkPairRateLimit, pairIpRateStore };
