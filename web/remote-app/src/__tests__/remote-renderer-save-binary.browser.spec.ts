// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Frame } from 'playwright-core';
import { build } from 'esbuild';
import { WebSocketServer, type WebSocket as WsSocket, type RawData } from 'ws';
import { createRequire } from 'node:module';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ipcDefaults } from './fixtures/ipc-defaults';

// The Epic composer's attachment save (window.api.files.saveBinary(path, base64, 'epics')) from the
// wide-browser full UI, over the same chain as real-chain.browser.spec.ts:
//   real built dist-web -> real RemoteRenderer + IpcBridge -> real ws.ts RelaySocket (boxed, framed)
//   -> fake relay enforcing the live 256 KiB message cap -> real webRemote.cjs (frame reassembly)
//   -> real createRemoteIpcDispatcher -> real files.cjs files:save-binary handler -> disk.
// Before framing, the ~800 KB ipc:invoke went out as one frame and the relay closed the socket (1009).
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const req = createRequire(import.meta.url);

/** The live relay's MAX_MSG_BYTES; a bigger browser message closes the socket with 1009. */
const RELAY_MAX_MSG_BYTES = 262144;

let tmpHome = '';
let origHome: string | undefined;
let webRemote: any;
let assets: any;
let dispatchLib: any;
let configLib: any;
let e2eCrypto: any;
let browser: Browser;
let electronStub: { app: unknown; shell: unknown; ipcMain: { handle: (c: string, f: unknown) => void; on: (c: string, f: unknown) => void } };
let bundle = '';
let distDir = '';
let png: Buffer;

/** A real, valid ~600 KB PNG: random RGB pixels in stored (uncompressed) deflate blocks. */
function makePng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  crypto.randomFillSync(raw);
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0; // filter type None
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

beforeAll(async () => {
  png = makePng(400, 500);
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-save-binary-home-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager', 'logs'), { recursive: true });
  const electronPath = req.resolve('electron');
  electronStub = {
    ipcMain: { handle: () => {}, on: () => {} },
    shell: { openPath: async () => '', showItemInFolder: () => {} },
    app: { getPath: () => tmpHome, getVersion: () => '0.0.0-test' },
  } as never;
  req.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: electronStub,
  } as never;
  for (const mod of ['src/main/webRemote.cjs', 'src/main/config.cjs', 'src/main/logs.cjs', 'src/main/files.cjs', 'src/main/promptSessionsIpc.cjs', 'src/main/lib/epic/activeIndexMerge.cjs']) {
    try { delete req.cache[req.resolve(path.join(repoRoot, mod))]; } catch { /* not loaded */ }
  }
  webRemote = req(path.join(repoRoot, 'src/main/webRemote.cjs'));
  configLib = req(path.join(repoRoot, 'src/main/config.cjs'));
  assets = req(path.join(repoRoot, 'src/main/lib/feedback-remote/remoteAssets.cjs'));
  dispatchLib = req(path.join(repoRoot, 'src/main/lib/feedback-remote/remoteIpcDispatch.cjs'));
  e2eCrypto = req(path.join(repoRoot, 'src/main/lib/feedback-remote/remoteE2eCrypto.cjs'));

  distDir = process.env.SM_DIST_WEB_DIR || '';
  if (!distDir) {
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-save-binary-dist-'));
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
  if (distDir && !process.env.SM_DIST_WEB_DIR) fs.rmSync(distDir, { recursive: true, force: true });
});

// Mirrors envelopeSchema in the live relay (~/Projects/Bilko/server/sm-relay/router.ts).
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
  calls: Array<{ channel: string; at: number }>;
  /** Every browser->relay message: envelope type + wire byte length. */
  browserSent: Array<{ type: string; bytes: number }>;
  /** Close codes of browser sockets the relay saw close. */
  closes: number[];
  /** event:remote:ready envelopes whose capabilities the relay stripped. */
  stripped: number;
  page: import('playwright-core').Page;
  warnings: string[];
  projectCwd: string;
  rejected: string[];
}

async function start(opts: { stripCapabilities?: boolean } = {}): Promise<Harness> {
  const dk = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const device = {
    deviceId: 'device-save-binary', deviceToken: 'tok', deviceName: 'SaveBinary',
    e2ePrivateKey: dk.privateKey.toString('base64url'), e2ePublicKey: dk.publicKey.toString('base64url'),
    issuedAt: new Date(0).toISOString(), lastConnectedAt: null, verifiedPeerPubKey: null,
  };
  const configPath = path.join(tmpHome, '.claude', 'session-manager', 'web-remote.json');
  const writeConfig = (pins: string[]) => {
    // files:save-binary is a remote 'mutate' row: remote control must be on.
    fs.writeFileSync(configPath, JSON.stringify({
      remoteEnabled: true, remoteControlEnabled: true,
      devices: [{ ...device, verifiedPeerPubKeys: pins.map((pubKey) => ({ pubKey, pinnedAt: new Date().toISOString() })) }],
    }));
    webRemote.__test.invalidateConfigCache();
  };
  writeConfig([]);

  const h: Harness = { calls: [], browserSent: [], closes: [], stripped: 0, warnings: [], projectCwd: '', rejected: [], page: null as never, stop: async () => {} };

  const surface = req(path.join(repoRoot, 'src/preload/apiSurface.cjs'));
  const fakeIpc = { handle: (_c: string, _f: unknown) => {}, on: (_c: string, _f: unknown) => {} };
  const handlers = dispatchLib.captureIpcHandlers(fakeIpc);
  const record = (channel: string, value: unknown, kind = 'invoke') => {
    const fn = async () => { h.calls.push({ channel, at: Date.now() }); return value; };
    if (kind === 'send') fakeIpc.on(channel, fn); else fakeIpc.handle(channel, fn);
  };
  const projectCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-save-binary-proj-')));
  const psDir = path.join(projectCwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(psDir, { recursive: true });
  fs.writeFileSync(path.join(psDir, 'active-index.json'), JSON.stringify({ sessions: {}, events: {}, tombstones: {} }));
  fs.writeFileSync(path.join(tmpHome, '.claude', 'session-manager', 'tabs.json'), JSON.stringify({
    tabs: [{ id: 'tab-save', sessionId: 'save-claude-session', cwd: projectCwd, label: 'save-proj', presetId: null }],
    activeTabId: 'tab-save', savedAt: Date.now(),
  }));
  h.projectCwd = projectCwd;
  // The desktop registered this project as an allowed root when its tab's pty spawned.
  configLib.addAllowedRoot(projectCwd);

  const defaults = ipcDefaults({ projectCwd, homeDir: tmpHome });
  const known = new Set(Object.keys(defaults));
  for (const row of surface as Array<{ channel: string; kind: string }>) {
    if ((row.kind === 'invoke' || row.kind === 'send') && !known.has(row.channel)) record(row.channel, null, row.kind);
  }
  for (const [channel, value] of Object.entries(defaults)) record(channel, value);
  // Real handlers over the capturing fakeIpc (they replace the defaults above), including files:save-binary.
  electronStub.ipcMain.handle = (c: string, f: unknown) => {
    fakeIpc.handle(c, async (...a: unknown[]) => { h.calls.push({ channel: c, at: Date.now() }); return (f as (...x: unknown[]) => unknown)(...a); });
  };
  req(path.join(repoRoot, 'src/main/promptSessionsIpc.cjs')).registerPromptSessionsReadHandlers();
  req(path.join(repoRoot, 'src/main/lib/epic/activeIndexMerge.cjs')).registerActiveIndexMergeHandlers();
  req(path.join(repoRoot, 'src/main/files.cjs')).registerFilesHandlers();
  webRemote.setIpcDispatcher(dispatchLib.createRemoteIpcDispatcher({
    surface, handlers, getConfig: () => webRemote.loadConfig(),
    fenceCtx: { homeDir: tmpHome, realpath: (p: string) => p, projectRoots: () => [projectCwd] },
  }));

  const conns = new Map<string, WsSocket>();
  let n = 0;
  const httpServer = http.createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body></body></html>');
  });
  // maxPayload makes ws close an oversized browser message with 1009, as the live relay does.
  const wss = new WebSocketServer({ server: httpServer, maxPayload: RELAY_MAX_MSG_BYTES });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()));
  const port = (httpServer.address() as { port: number }).port;

  /** Simulate an older desktop: drop `capabilities` from its boxed event:remote:ready. */
  const stripCaps = (env: Record<string, any>): void => {
    if (!opts.stripCapabilities || env.type !== 'e2e:box' || typeof env.toConn !== 'string') return;
    const key = webRemote.__test.getClient(env.toConn)?.e2e?.sessionKey;
    if (!key) return;
    const inner = JSON.parse(e2eCrypto.decryptBox(env.payload.nonce, env.payload.ciphertext, key));
    if (inner.type !== 'event:remote:ready') return;
    delete inner.payload.capabilities;
    env.payload = e2eCrypto.encryptBox(JSON.stringify(inner), key);
    h.stripped++;
  };
  const toBrowser = (raw: string) => {
    const env = JSON.parse(raw);
    if (!relayAccepts(env)) { h.rejected.push(`${env.type}:${String(env.id).slice(0, 48)}`); return; }
    stripCaps(env);
    const targets = env.toConn ? [conns.get(env.toConn)] : [...conns.values()];
    delete env.toConn;
    env.deviceId = device.deviceId;
    for (const t of targets) if (t && t.readyState === 1) t.send(JSON.stringify(env));
  };
  webRemote.__test.setWs({ readyState: 1, send: toBrowser, terminate: () => {} });
  let helloSeen = 0;
  wss.on('connection', (sock: WsSocket) => {
    const connId = `conn-${++n}`;
    conns.set(connId, sock);
    sock.on('close', (code: number) => { h.closes.push(code); conns.delete(connId); });
    sock.send(JSON.stringify({ type: 'auth:ok', id: '', ts: Date.now() }));
    sock.on('message', (data: RawData) => {
      const text = String(data);
      const env = JSON.parse(text);
      if (!relayAccepts(env)) { h.rejected.push(`browser ${env.type}`); return; }
      h.browserSent.push({ type: env.type, bytes: Buffer.byteLength(text) });
      if (env.type === 'ping') return;
      if (env.type === 'e2e:hello' && helloSeen++ === 0) writeConfig([env.payload.pubKey]);
      env.fromConn = connId;
      void webRemote._internal.handleMessage(JSON.stringify(env), device).catch((e: unknown) => h.warnings.push(String(e)));
    });
  });

  const page = await browser.newPage();
  await page.route('https://json.schemastore.org/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
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

async function waitFor(pred: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

function diag(h: Harness): string {
  const sizes = h.browserSent.filter((s) => s.bytes > 4096).map((s) => `${s.type}:${s.bytes}`);
  return `handlers hit: ${[...new Set(h.calls.map((c) => c.channel))].join(',')}; large browser sends: ${sizes.join(',')}; ` +
    `closes: ${h.closes.join(',')}; stripped: ${h.stripped}; relay rejected: ${h.rejected.length}; warnings: ${h.warnings.slice(-6).join(' | ')}`;
}

/** The RemoteRenderer iframe once the served app has installed its remote window.api and booted. */
async function bootedFrame(h: Harness): Promise<Frame> {
  let found: Frame | null = null;
  const ok = await waitFor(async () => {
    if (!h.calls.some((c) => c.channel === 'app:launch-mode')) return false;
    for (const f of h.page.frames()) {
      if (f === h.page.mainFrame()) continue;
      const has = await f.evaluate(() => typeof (window as unknown as { api?: { files?: { saveBinary?: unknown } } }).api?.files?.saveBinary === 'function').catch(() => false);
      if (has) { found = f; return true; }
    }
    return false;
  }, 30_000);
  expect(ok, diag(h)).toBe(true);
  return found!;
}

type SaveOutcome = { resolved: unknown } | { rejected: string };

/** Call window.api.files.saveBinary from inside the remote renderer, bounded at 30 s. */
async function saveFromFrame(frame: Frame, dest: string, base64: string): Promise<SaveOutcome> {
  return frame.evaluate(([p, b64]) => {
    const api = (window as unknown as { api: { files: { saveBinary(p: string, b: string, w: string): Promise<unknown> } } }).api;
    const call = api.files.saveBinary(p, b64, 'epics').then(
      (resolved) => ({ resolved }),
      (e: unknown) => ({ rejected: e instanceof Error ? e.message : String(e) }),
    );
    const cap = new Promise<{ rejected: string }>((r) => setTimeout(() => r({ rejected: 'TEST: no answer within 30 s' }), 30_000));
    return Promise.race([call, cap]);
  }, [dest, base64] as const);
}

const destFor = (h: Harness) => path.join(h.projectCwd, 'session-manager-operations', 'prompt-sessions', 'attachments', 'proof.png');

describe('remote renderer: files.saveBinary of a ~600 KB image crosses the relay as frames', () => {
  it('writes identical bytes via >=2 boxed frames, each under the relay cap, with no 1009 close', async () => {
    const h = await start();
    try {
      expect(png.length).toBeGreaterThan(550_000);
      expect(png.length).toBeLessThan(700_000);
      const frame = await bootedFrame(h);
      const before = h.browserSent.length;
      const out = await saveFromFrame(frame, destFor(h), png.toString('base64'));
      expect(out, diag(h)).toEqual({ resolved: { ok: true } });
      expect(fs.existsSync(destFor(h)), diag(h)).toBe(true);
      expect(Buffer.compare(fs.readFileSync(destFor(h)), png)).toBe(0);
      // Small envelopes (boot traffic, pings) stay far below 64 KiB; the upload's boxed e2e:frame slices
      // (~180 KB of data each, then encrypted + base64) are the only browser sends above it.
      const during = h.browserSent.slice(before);
      const frames = during.filter((s) => s.type === 'e2e:box' && s.bytes > 64 * 1024);
      expect(frames.length, diag(h)).toBeGreaterThanOrEqual(2);
      expect(Math.max(...h.browserSent.map((s) => s.bytes))).toBeLessThanOrEqual(RELAY_MAX_MSG_BYTES);
      expect(h.closes, diag(h)).not.toContain(1009);
      expect(h.closes, diag(h)).toEqual([]);
      expect(h.calls.some((c) => c.channel === 'files:save-binary'), diag(h)).toBe(true);
    } finally {
      await h.stop();
    }
  }, 120_000);

  it('an older desktop (no capabilities in event:remote:ready) gets a refusal, nothing written, socket open', async () => {
    const h = await start({ stripCapabilities: true });
    try {
      const frame = await bootedFrame(h);
      expect(h.stripped, diag(h)).toBeGreaterThanOrEqual(1);
      const before = h.browserSent.length;
      const out = await saveFromFrame(frame, destFor(h), png.toString('base64'));
      const notOk = 'rejected' in out
        ? !out.rejected.startsWith('TEST:')
        : (out.resolved as { ok?: unknown } | null)?.ok !== true;
      expect(notOk, `${JSON.stringify(out).slice(0, 300)}\n${diag(h)}`).toBe(true);
      if ('rejected' in out) expect(out.rejected).toMatch(/e2e-frames|too large/i);
      expect(fs.existsSync(destFor(h))).toBe(false);
      expect(h.browserSent.slice(before).some((s) => s.bytes > 64 * 1024), diag(h)).toBe(false);
      expect(h.calls.some((c) => c.channel === 'files:save-binary')).toBe(false);
      // Socket stays open: no close at the relay, the page still reports connected, and a small
      // remote call still round-trips afterwards.
      expect(h.closes, diag(h)).toEqual([]);
      expect(await h.page.evaluate(() => (window as unknown as { __socket: { isConnected: boolean } }).__socket.isConnected)).toBe(true);
      const home = await frame.evaluate(() => (window as unknown as { api: { app: { homeDir(): Promise<string> } } }).api.app.homeDir());
      expect(home, diag(h)).toBe(tmpHome);
    } finally {
      await h.stop();
    }
  }, 120_000);
});
