import fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import fastifyCors from '@fastify/cors';
import { registerAuthRoutes } from './auth';
import { createWsServer, handleUpgrade } from './router';
import { purgeExpired } from './tokens';

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

  // Periodic housekeeping: purge expired OTPs and WS tickets
  setInterval(() => purgeExpired(), 5 * 60 * 1000);

  app.log.info(`relay listening on ${HOST}:${PORT}`);
  // Log the ws server reference to satisfy the no-unused-variable check
  void wss;
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
