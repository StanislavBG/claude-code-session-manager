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

  // ── Google OAuth redirect ────────────────────────────────────────────────
  fastify.get('/auth/google', async (req, reply) => {
    const oauth2Client = getOAuth2Client();
    const state = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
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
        return reply.status(400).send({ error: 'oauth_error', detail: error });
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

      const appOrigin = process.env.ALLOWED_ORIGIN ?? 'https://session-manager.bilko.run';
      reply.redirect(appOrigin + '/');
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
  fastify.post<{ Body: { code?: string; deviceId?: string } }>(
    '/pair',
    { schema: { body: { type: 'object', required: ['code', 'deviceId'] } } },
    async (req, reply) => {
      const { code, deviceId } = req.body;
      if (!code || !deviceId) {
        return reply.status(400).send({ error: 'missing_fields' });
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
        return reply.status(400).send({ error: 'invalid_device_id' });
      }

      const { verifyOtp, issueDeviceToken } = await import('./tokens');
      const result = verifyOtp(code);
      if ('error' in result) {
        return reply.status(result.status).send({ error: result.error });
      }

      const deviceToken = issueDeviceToken(deviceId, result.userId, result.email);
      // Token returned to agent; NEVER logged
      reply.send({ deviceToken, deviceId });
    },
  );

  // ── GET /api/devices — list paired devices for the signed-in user ────────
  fastify.get('/api/devices', async (req, reply) => {
    const auth = requireBrowserSession(req, reply);
    if (!auth) return;

    reply.send({ devices: getDevicesForUser(auth.userId) });
  });

  // ── DELETE /api/devices/:deviceId — revoke a device token ───────────────
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
}
