import fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import fastifyCors from '@fastify/cors';
import { registerAuthRoutes, purgeAuthRateLimits } from './auth';
import { createWsServer, handleUpgrade } from './router';
import { purgeExpired } from './tokens';
import { safeParseJsonBody } from './bodyParser';

const PORT = parseInt(process.env.PORT ?? '3010', 10);
const HOST = '0.0.0.0';

async function main(): Promise<void> {
  // Validate required env vars at startup
  const required = ['RELAY_SECRET', 'ALLOWED_EMAIL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
  }
  // RELAY_SECRET signs session cookies — enforce minimum entropy (32 bytes)
  if (Buffer.from(process.env.RELAY_SECRET!).length < 32) {
    throw new Error('RELAY_SECRET must be at least 32 bytes');
  }

  const app = fastify({
    logger: {
      level: 'info',
      // Redact auth headers to prevent device tokens and session cookies
      // from appearing in Render access logs.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    // Render terminates TLS at a single proxy hop in front of this process.
    // trustProxy=1 makes req.ip the real client (the leftmost XFF entry added
    // by Render), so per-IP rate limits cannot be defeated by a client-supplied
    // X-Forwarded-For. Without this the manual XFF parse was spoofable, which
    // was the only network throttle on OTP brute force.
    trustProxy: 1,
    // Legitimate bodies are tiny (OTP code + UUID + ~124-char pubkey). Cap at
    // 16 KiB so unauthenticated /pair, /api/otp, /api/ws-ticket cannot be used
    // for memory-amplification DoS via large JSON parsed on the single thread.
    bodyLimit: 16 * 1024,
  });

  await app.register(fastifyCookie);

  await app.register(fastifySession, {
    secret: process.env.RELAY_SECRET!,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      // 'lax' is required for the OAuth callback (cross-site top-level GET redirect)
      // to carry the session cookie containing oauthState. 'strict' would break OAuth.
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60, // 7 days in seconds
    },
    saveUninitialized: false,
  });

  const allowedOrigin = process.env.ALLOWED_ORIGIN ?? 'https://session-manager.bilko.run';
  // Override the default JSON parser so an empty body with Content-Type: application/json
  // yields {} rather than FST_ERR_CTP_EMPTY_JSON_BODY. Routes that don't use the body
  // (e.g. /api/otp, /api/ws-ticket) proceed to their auth checks and return 401, not 500.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, safeParseJsonBody(body as string));
    } catch (err) {
      done(err as Error);
    }
  });

  await app.register(fastifyCors, {
    origin: allowedOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  });

  await registerAuthRoutes(app);

  const wss = createWsServer();

  await app.listen({ port: PORT, host: HOST });

  // Attach WS server AFTER Fastify has bound the HTTP server
  app.server.on('upgrade', handleUpgrade);

  // Periodic housekeeping: purge expired OTPs, WS tickets, and rate-limit stores
  setInterval(() => { purgeExpired(); purgeAuthRateLimits(); }, 5 * 60 * 1000);

  app.log.info(`relay listening on ${HOST}:${PORT}`);
  // Log the ws server reference to satisfy the no-unused-variable check
  void wss;
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
