// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { build } from 'esbuild';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { createRequire } from 'node:module';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The whole transport chain, nothing mocked but the relay's WAN hop and the ipcMain handlers:
//   real built dist-web (served by real remoteAssets) -> real RemoteRenderer + IpcBridge
//   -> real ws.ts RelaySocket + E2E boxes -> in-process fake relay (stamps fromConn, honours toConn)
//   -> real src/main/webRemote.cjs handleMessage / dispatchIpcInvoke -> real createRemoteIpcDispatcher.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const req = createRequire(import.meta.url);

let tmpHome = '';
let origHome: string | undefined;
let webRemote: any;
let assets: any;
let dispatchLib: any;
let browser: Browser;
let bundle = '';
let distDir = '';

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-real-chain-home-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager', 'logs'), { recursive: true });
  const electronPath = req.resolve('electron');
  req.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: {
      ipcMain: { handle: () => {}, on: () => {} },
      app: { getPath: () => tmpHome, getVersion: () => '0.0.0-test' },
    },
  } as never;
  for (const mod of ['src/main/webRemote.cjs', 'src/main/config.cjs', 'src/main/logs.cjs']) {
    try { delete req.cache[req.resolve(path.join(repoRoot, mod))]; } catch { /* not loaded */ }
  }
  webRemote = req(path.join(repoRoot, 'src/main/webRemote.cjs'));
  assets = req(path.join(repoRoot, 'src/main/lib/feedback-remote/remoteAssets.cjs'));
  dispatchLib = req(path.join(repoRoot, 'src/main/lib/feedback-remote/remoteIpcDispatch.cjs'));

  distDir = process.env.SM_DIST_WEB_DIR || '';
  if (!distDir) {
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-real-chain-dist-'));
    execFileSync(
      path.join(repoRoot, 'node_modules/.bin/vite'),
      ['build', '--config', 'vite.web.config.ts', '--outDir', distDir, '--emptyOutDir'],
      { cwd: repoRoot, stdio: 'pipe', timeout: 240_000 },
    );
  }
  assets.__test.setRoot(distDir);

  const out = await build({
    entryPoints: [path.join(here, 'fixtures/real-chain-entry.tsx')],
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{
      name: 'fake-api',
      setup(b) {
        b.onResolve({ filter: /^\.\/api$/ }, () => ({ path: path.join(here, 'fixtures/api-stub.ts') }));
      },
    }],
  });
  bundle = out.outputFiles[0].text;
  browser = await chromium.launch(); // fail, never skip
}, 300_000);

afterAll(async () => {
  assets?.__test.setRoot(null);
  webRemote?.destroy();
  await browser?.close();
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// Mirrors envelopeSchema in the live relay (~/Projects/Bilko/server/sm-relay/router.ts). The relay
// DROPS any frame that fails it, in both directions; `id` must be a UUID.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function relayAccepts(env: Record<string, unknown>): boolean {
  return typeof env.type === 'string' && env.type.length >= 1 && env.type.length <= 256 &&
    typeof env.id === 'string' && UUID_RE.test(env.id) &&
    (env.deviceId === undefined || (typeof env.deviceId === 'string' && env.deviceId.length <= 128)) &&
    typeof env.ts === 'number' && Number.isInteger(env.ts) && env.ts > 0 &&
    (env.toConn === undefined || (typeof env.toConn === 'string' && env.toConn.length <= 64));
}

interface Harness {
  stop(): Promise<void>;
  /** Handler invocations in arrival order. */
  calls: Array<{ channel: string; at: number }>;
  hellos: number;
  /** Envelope types the browser sent to the relay, in order. */
  browserSent: Array<{ type: string; at: number }>;
  /** Desktop frames the relay delivered to the browser. */
  delivered: number;
  page: import('playwright-core').Page;
  warnings: string[];
  /** Frames the fake relay dropped for failing its envelope schema. */
  rejected: string[];
}

const BOOT_CHANNELS = [
  'telemetry:get-config', 'app:prereqs', 'customerFeedback:list', 'layout:load', 'schedule:session-slots',
  'app:update-status', 'app:home-dir', 'app:launch-mode', 'billing:fetch', 'schedule:state',
];

async function start(opts: { rekeyAfterFirstResults?: boolean; control?: boolean } = {}): Promise<Harness> {
  const dk = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const device = {
    deviceId: 'device-real-chain', deviceToken: 'tok', deviceName: 'Chain',
    e2ePrivateKey: dk.privateKey.toString('base64url'), e2ePublicKey: dk.publicKey.toString('base64url'),
    issuedAt: new Date(0).toISOString(), lastConnectedAt: null, verifiedPeerPubKey: null,
  };
  const configPath = path.join(tmpHome, '.claude', 'session-manager', 'web-remote.json');
  const writeConfig = (pins: string[]) => {
    fs.writeFileSync(configPath, JSON.stringify({
      remoteEnabled: true, remoteControlEnabled: opts.control === true,
      devices: [{ ...device, verifiedPeerPubKeys: pins.map((pubKey) => ({ pubKey, pinnedAt: new Date().toISOString() })) }],
    }));
    webRemote.__test.invalidateConfigCache();
  };
  writeConfig([]);

  const calls: Harness['calls'] = [];
  const browserSent: Harness['browserSent'] = [];
  const h: Harness = { calls, hellos: 0, browserSent, delivered: 0, warnings: [], rejected: [], page: null as never, stop: async () => {} };

  const surface = req(path.join(repoRoot, 'src/preload/apiSurface.cjs'));
  // Register exactly as production does: invoke rows via ipcMain.handle, send rows via ipcMain.on,
  // both captured by captureIpcHandlers (index.cjs wraps the real ipcMain the same way).
  const fakeIpc = { handle: (_c: string, _f: unknown) => {}, on: (_c: string, _f: unknown) => {} };
  const handlers = dispatchLib.captureIpcHandlers(fakeIpc);
  const record = (channel: string, value: unknown, kind = 'invoke') => {
    const fn = async () => { calls.push({ channel, at: Date.now() }); return value; };
    if (kind === 'send') fakeIpc.on(channel, fn); else fakeIpc.handle(channel, fn);
  };
  for (const row of surface as Array<{ channel: string; kind: string }>) {
    if (row.kind === 'invoke' || row.kind === 'send') record(row.channel, null, row.kind);
  }
  record('app:launch-mode', { simple: false, cwd: '/home/chain/proj' });
  record('app:home-dir', '/home/chain');
  record('sessions:load', { tabs: [], epics: [] });
  webRemote.setIpcDispatcher(dispatchLib.createRemoteIpcDispatcher({
    surface, handlers, getConfig: () => webRemote.loadConfig(),
    fenceCtx: { homeDir: tmpHome, realpath: (p: string) => p, projectRoots: () => [] },
  }));

  // Fake relay: browser side is a real WebSocketServer; the desktop side is webRemote's _ws.
  const conns = new Map<string, WsSocket>();
  let n = 0;
  // The page is served by the relay itself (same origin) so Chromium's local-network checks stay quiet.
  const httpServer = http.createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body></body></html>');
  });
  const wss = new WebSocketServer({ server: httpServer });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()));
  const port = (httpServer.address() as { port: number }).port;
  const toBrowser = (raw: string) => {
    const env = JSON.parse(raw);
    if (!relayAccepts(env)) { h.rejected.push(`${env.type}:${String(env.id).slice(0, 48)}`); return; }
    const targets = env.toConn ? [conns.get(env.toConn)] : [...conns.values()];
    delete env.toConn;
    env.deviceId = device.deviceId; // the live relay stamps the sending device on every frame
    for (const t of targets) if (t && t.readyState === 1) { h.delivered++; t.send(JSON.stringify(env)); }
  };
  webRemote.__test.setWs({ readyState: 1, send: toBrowser, terminate: () => {} });
  let helloSeen = 0;
  wss.on('connection', (sock) => {
    const connId = `conn-${++n}`;
    conns.set(connId, sock);
    sock.send(JSON.stringify({ type: 'auth:ok', id: '', ts: Date.now() }));
    sock.on('message', (data) => {
      const env = JSON.parse(String(data));
      if (!relayAccepts(env)) { h.rejected.push(`browser ${env.type}`); return; }
      browserSent.push({ type: env.type, at: Date.now() });
      if (env.type === 'ping') return;
      if (env.type === 'e2e:hello') {
        h.hellos++;
        if (helloSeen++ === 0) writeConfig([env.payload.pubKey]); // the owner pinned this browser earlier
      }
      env.fromConn = connId;
      void webRemote._internal.handleMessage(JSON.stringify(env), device).catch((e: unknown) => h.warnings.push(String(e)));
      if (opts.rekeyAfterFirstResults && env.type === 'e2e:hello' && helloSeen === 2) {
        // A third handshake lands while boot results are in flight.
        setTimeout(() => sock.send(JSON.stringify({ type: 'e2e:rekey', id: crypto.randomUUID(), deviceId: device.deviceId, ts: Date.now() })), 400);
      }
    });
  });

  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') h.warnings.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.evaluate(([url, cfg]) => {
    const w = window as unknown as Record<string, unknown>;
    w.__relayUrl = url;
    w.__cfg = cfg;
  }, [`ws://127.0.0.1:${port}`, { deviceId: device.deviceId, devicePubKey: device.e2ePublicKey }] as const);
  await page.addScriptTag({ content: bundle });
  h.page = page;
  h.stop = async () => {
    await page.close();
    for (const c of conns.values()) c.terminate();
    await new Promise<void>((r) => wss.close(() => httpServer.close(() => r())));
    webRemote._internal.resetE2e();
  };
  return h;
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

/** One-line state dump for assertion messages. */
async function diag(h: Harness): Promise<string> {
  const rx = await h.page.evaluate(() => (window as unknown as { __rx: string[] }).__rx).catch(() => ['<page gone>']);
  return `handlers hit: ${h.calls.map((c) => c.channel).join(',')}; browser sent: ${h.browserSent.map((x) => x.type).join(',')}; ` +
    `page received: ${rx.join(',')}; delivered ${h.delivered}; relay rejected: ${h.rejected.slice(0, 3).join(' ')}(${h.rejected.length}); warnings: ${h.warnings.join(' | ')}`;
}

describe('real chain: dist-web -> RemoteRenderer -> ws.ts -> relay -> webRemote.cjs', () => {
  it('boot batch results reach the frame: sessions:load follows app:launch-mode within 5 s', async () => {
    const h = await start();
    try {
      const launched = await waitFor(() => h.calls.some((c) => c.channel === 'app:launch-mode'), 40_000);
      expect(launched, await diag(h)).toBe(true);
      const t0 = h.calls.find((c) => c.channel === 'app:launch-mode')!.at;
      const loaded = await waitFor(() => h.calls.some((c) => c.channel === 'sessions:load'), 5_000);
      const seen = h.calls.map((c) => c.channel).join(',');
      expect(loaded, await diag(h)).toBe(true);
      expect(h.calls.find((c) => c.channel === 'sessions:load')!.at - t0).toBeLessThan(5_000);
      expect(BOOT_CHANNELS.some((c) => seen.includes(c))).toBe(true);
      // Production symptom precondition: two e2e:hello handshakes per connect.
      expect(h.hellos).toBeGreaterThanOrEqual(2);
    } finally {
      await h.stop();
    }
  }, 90_000);

  it('a rekey while boot results are in flight does not strand them', async () => {
    const h = await start({ rekeyAfterFirstResults: true });
    try {
      const loaded = await waitFor(() => h.calls.some((c) => c.channel === 'sessions:load'), 45_000);
      expect(loaded, await diag(h)).toBe(true);
    } finally {
      await h.stop();
    }
  }, 90_000);

  it('log:write (a send-kind channel) reaches its ipcMain.on listener', async () => {
    const h = await start({ control: true }); // log:write is a MUTATE-tier row: tiering stays intact
    try {
      const up = await waitFor(() => h.calls.some((c) => c.channel === 'app:launch-mode'), 40_000);
      expect(up, await diag(h)).toBe(true);
      await h.page.evaluate(() => {
        const w = window as unknown as { __socket: { sendEnvelope(t: string, d: string, p: unknown, id: string): Promise<boolean> }; __cfg: { deviceId: string } };
        return w.__socket.sendEnvelope('ipc:invoke', w.__cfg.deviceId,
          { calls: [{ channel: 'log:write', args: [{ scope: 'web', level: 'warn', message: 'web-side warning' }] }] }, globalThis.crypto.randomUUID());
      });
      const seen = await waitFor(() => h.calls.some((c) => c.channel === 'log:write'), 10_000);
      expect(seen, await diag(h)).toBe(true);
    } finally {
      await h.stop();
    }
  }, 90_000);
});
