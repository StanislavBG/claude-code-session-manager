// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import type { Config as TailwindConfig } from 'tailwindcss';
import { WebSocketServer, type WebSocket as WsSocket, type RawData } from 'ws';
import { createRequire } from 'node:module';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// One phone image send over the real chain (same harness as phone-drilldown-chain.browser.spec.ts):
//   real Cockpit + MicPane (phone view at 390x844) -> real prepareImage -> real ws.ts RelaySocket framed e2e:box send
//   -> in-process fake relay enforcing the live relay's 256 KiB message cap (close 1009 above it)
//   -> real src/main/webRemote.cjs frame reassembly + cmd:chat:send -> real epicAttachments save under a temp HOME
//   -> stubbed chatRunner.enqueueExternalPrompt.
const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '../..');
const repoRoot = path.resolve(here, '../../../..');
const req = createRequire(import.meta.url);

const VIEWPORT = { width: 390, height: 844 };
const DEVICE_ID = 'device-phone-image-chain';
const PROJECT_LABEL = 'phone-image-proj';
const MAIN_TAB = { id: 'tab-phone-image-chain', sessionId: 'a1b2c3d4-0819-4a2b-9c3d-4e5f60718293' };
const ACTIVE = { id: 'epic-phone-image-active', title: 'Phone Image Epic', claudeSessionId: 'e1a1c3d4-5b6e-4f70-8a91-b2c3d4e5f607' };
const USER_TEXT = 'Here is the thread so far.';
const ASSISTANT_TEXT = 'Send me the screenshot from the phone.';
const CAPTION = 'Forwarded screenshot from the phone';
const IMAGE_NAME = 'forwarded.png';
/** The live relay's MAX_MSG_BYTES (~/Projects/Bilko/server/sm-relay): bigger messages are closed with 1009. */
const RELAY_MAX_MSG_BYTES = 256 * 1024;

let tmpHome = '';
let origHome: string | undefined;
let projectCwd = '';
let chatRunnerPath = '';
let webRemote: any;
let browser: Browser;
let bundle = '';
let shellCss = '';
let viewportMeta = '';
let png: Buffer = Buffer.alloc(0);
/** Arguments of every chatRunner.enqueueExternalPrompt call the real cmd:chat:send handler made. */
const chatCalls: unknown[][] = [];

// ── PNG encoder (in-spec, node:zlib) ────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A valid width x height 8-bit RGB PNG of random pixels (random data barely deflates, so it stays big). */
function randomPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const row = width * 3;
  const raw = Buffer.alloc((row + 1) * height);
  const pixels = crypto.randomBytes(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * (row + 1)] = 0; // filter: none
    pixels.copy(raw, y * (row + 1) + 1, y * row, (y + 1) * row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

beforeAll(async () => {
  png = randomPng(600, 600);
  if (png.length < 300 * 1024 || png.length > 1400 * 1024) throw new Error(`generated PNG is ${png.length} bytes, outside 300-1400 KB`);

  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-phone-image-chain-home-')));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  const smDir = path.join(tmpHome, '.claude', 'session-manager');
  fs.mkdirSync(path.join(smDir, 'logs'), { recursive: true });

  const electronPath = req.resolve('electron');
  req.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { ipcMain: { handle: () => {}, on: () => {} }, app: { getPath: () => tmpHome, getVersion: () => '0.0.0-test' } },
  } as never;
  for (const mod of ['src/main/webRemote.cjs', 'src/main/config.cjs', 'src/main/logs.cjs', 'src/main/sessionsStore.cjs']) {
    try { delete req.cache[req.resolve(path.join(repoRoot, mod))]; } catch { /* not loaded */ }
  }
  chatRunnerPath = req.resolve(path.join(repoRoot, 'src/main/chatRunner.cjs'));
  req.cache[chatRunnerPath] = {
    id: chatRunnerPath, filename: chatRunnerPath, loaded: true,
    exports: {
      enqueueExternalPrompt: async (...args: unknown[]) => {
        chatCalls.push(args);
        return { disposition: 'sent' };
      },
    },
  } as never;
  webRemote = req(path.join(repoRoot, 'src/main/webRemote.cjs'));

  // One open tab for a git-free project under the temp HOME, with one active Epic.
  projectCwd = path.join(tmpHome, 'Projects', PROJECT_LABEL);
  const psDir = path.join(projectCwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(psDir, { recursive: true });
  fs.writeFileSync(path.join(psDir, 'active-index.json'), JSON.stringify({
    sessions: {
      [ACTIVE.id]: {
        id: ACTIVE.id, cwd: projectCwd, goalText: ACTIVE.title, claudeSessionId: ACTIVE.claudeSessionId, status: 'active',
        createdAt: new Date(1_700_000_000_000).toISOString(), completedAt: null, tag: 'feature',
      },
    },
    events: { [ACTIVE.id]: [] },
    tombstones: {},
  }));
  fs.writeFileSync(path.join(smDir, 'tabs.json'), JSON.stringify({
    tabs: [{ ...MAIN_TAB, cwd: projectCwd, label: PROJECT_LABEL, presetId: null }],
    activeTabId: MAIN_TAB.id, savedAt: Date.now(),
  }));
  const { resolveEpicTranscriptPath } = req(path.join(repoRoot, 'src/main/lib/epic/epicTranscriptPath.cjs'));
  const transcriptFile: string | null = resolveEpicTranscriptPath({ cwd: projectCwd, claudeSessionId: ACTIVE.claudeSessionId }).path;
  if (!transcriptFile || !transcriptFile.startsWith(path.join(tmpHome, '.claude', 'projects') + path.sep)) {
    throw new Error(`resolveEpicTranscriptPath left the temp HOME: ${transcriptFile}`);
  }
  fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
  const t0 = Date.now() - 60_000;
  fs.writeFileSync(transcriptFile, [
    { type: 'user', message: { role: 'user', content: USER_TEXT }, uuid: crypto.randomUUID(), timestamp: new Date(t0).toISOString(), sessionId: ACTIVE.claudeSessionId },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ASSISTANT_TEXT }] }, uuid: crypto.randomUUID(), timestamp: new Date(t0 + 3_000).toISOString(), sessionId: ACTIVE.claudeSessionId },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');

  viewportMeta = fs.readFileSync(path.join(appDir, 'index.html'), 'utf8').match(/<meta\s+name="viewport"[^>]*>/i)?.[0] ?? '';
  if (!viewportMeta.includes('width=device-width')) throw new Error(`index.html has no width=device-width viewport meta: ${viewportMeta || '<none>'}`);
  const twConfigPath = path.join(appDir, 'tailwind.config.js');
  const twConfig = (await import(/* @vite-ignore */ twConfigPath)).default as TailwindConfig;
  const cssFrom = path.join(appDir, 'src/index.css');
  const css = await postcss([tailwindcss({ ...twConfig, content: [path.join(appDir, 'index.html'), path.join(appDir, 'src/**/*.{ts,tsx}')] })])
    .process(fs.readFileSync(cssFrom, 'utf8'), { from: cssFrom });
  shellCss = css.css;

  // The shared phone-chain entry, plus App.tsx's capability wiring (event:remote:ready -> setDeviceCapabilities),
  // which the shared fixture does not carry. Registered synchronously after the fixture runs, so before any frame.
  const out = await build({
    stdin: {
      contents: `
        import './fixtures/phone-chain-entry';
        import { useStore } from '../store';
        // App.tsx readyCapabilities (App.tsx itself pulls in Clerk, so it is not bundled here).
        const caps = (p: any): string[] => (Array.isArray(p?.capabilities) ? p.capabilities : [])
          .filter((c: unknown) => typeof c === 'string' && c.length >= 1 && c.length <= 64).slice(0, 32);
        const w = window as unknown as { __socket: { on(t: string, cb: (m: any) => void): unknown }; __cfg: { deviceId: string } };
        w.__socket.on('event:remote:ready', (m: any) => {
          useStore.getState().setDeviceCapabilities(m.deviceId ?? w.__cfg.deviceId, caps(m.payload));
        });
      `,
      resolveDir: here,
      sourcefile: 'phone-image-chain-entry.tsx',
      loader: 'tsx',
    },
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
}, 180_000);

afterAll(async () => {
  webRemote?.__test.stopAllSessionWatches();
  webRemote?.destroy();
  if (chatRunnerPath) delete req.cache[chatRunnerPath];
  await browser?.close();
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
});

// Mirrors envelopeSchema in the live relay; it DROPS any frame that fails it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function relayAccepts(env: Record<string, unknown>): boolean {
  return typeof env.type === 'string' && env.type.length >= 1 && env.type.length <= 256 &&
    typeof env.id === 'string' && UUID_RE.test(env.id) &&
    (env.deviceId === undefined || (typeof env.deviceId === 'string' && env.deviceId.length <= 128)) &&
    typeof env.ts === 'number' && Number.isInteger(env.ts) && env.ts > 0 &&
    (env.toConn === undefined || (typeof env.toConn === 'string' && env.toConn.length <= 64));
}

interface Harness {
  page: Page;
  /** Every browser->desktop message: envelope type + raw wire byte size. */
  browserSent: { type: string; bytes: number }[];
  /** Close codes the relay used on browser sockets (1009 = over the size cap). */
  closeCodes: number[];
  rejected: string[];
  warnings: string[];
  pageErrors: string[];
  stop(): Promise<void>;
}

function harnessHtml(relayUrl: string, cfg: { deviceId: string; devicePubKey: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    ${viewportMeta}
    <title>Session Manager</title>
    <style>${shellCss}</style>
  </head>
  <body>
    <div id="root"></div>
    <script>window.__relayUrl = ${JSON.stringify(relayUrl)}; window.__cfg = ${JSON.stringify(cfg)};</script>
    <script src="/phone-chain.js"></script>
  </body>
</html>`;
}

async function start(): Promise<Harness> {
  const dk = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const device = {
    deviceId: DEVICE_ID, deviceToken: 'tok', deviceName: 'Phone image chain',
    e2ePrivateKey: dk.privateKey.toString('base64url'), e2ePublicKey: dk.publicKey.toString('base64url'),
    issuedAt: new Date(0).toISOString(), lastConnectedAt: null, verifiedPeerPubKey: null,
  };
  const configPath = path.join(tmpHome, '.claude', 'session-manager', 'web-remote.json');
  const writeConfig = (pins: string[]) => {
    fs.writeFileSync(configPath, JSON.stringify({
      remoteEnabled: true, remoteControlEnabled: true,
      devices: [{ ...device, verifiedPeerPubKeys: pins.map((pubKey) => ({ pubKey, pinnedAt: new Date().toISOString() })) }],
    }));
    webRemote.__test.invalidateConfigCache();
  };
  writeConfig([]);

  const h: Harness = {
    page: null as never,
    browserSent: [], closeCodes: [], rejected: [], warnings: [], pageErrors: [], stop: async () => {},
  };

  const conns = new Map<string, WsSocket>();
  let n = 0;
  let relayUrl = '';
  const httpServer = http.createServer((q, res) => {
    if (q.method === 'GET' && q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(harnessHtml(relayUrl, { deviceId: device.deviceId, devicePubKey: device.e2ePublicKey }));
    } else if (q.method === 'GET' && q.url === '/phone-chain.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(bundle);
    } else {
      res.writeHead(q.method === 'POST' ? 204 : 404);
      res.end();
    }
  });
  const wss = new WebSocketServer({ server: httpServer });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()));
  const port = (httpServer.address() as { port: number }).port;
  relayUrl = `ws://127.0.0.1:${port}`;
  const toBrowser = (raw: string) => {
    const env = JSON.parse(raw);
    if (!relayAccepts(env)) { h.rejected.push(`desktop ${env.type}`); return; }
    const targets = env.toConn ? [conns.get(env.toConn)] : [...conns.values()];
    delete env.toConn;
    env.deviceId = device.deviceId;
    for (const t of targets) if (t && t.readyState === 1) t.send(JSON.stringify(env));
  };
  webRemote.__test.setWs({ readyState: 1, send: toBrowser, terminate: () => {} });
  let hellos = 0;
  // Desktop handling is serialized in arrival order, as the live relay's single desktop socket delivers it.
  let chain: Promise<void> = Promise.resolve();
  wss.on('connection', (sock: WsSocket) => {
    const connId = `conn-${++n}`;
    conns.set(connId, sock);
    // ws's close()/'close' event, which the shared ws-package.d.ts slice does not declare.
    const closable = sock as unknown as { close(code: number, reason?: string): void; on(event: 'close', l: (code: number) => void): unknown };
    closable.on('close', (code: number) => { h.closeCodes.push(code); conns.delete(connId); });
    sock.send(JSON.stringify({ type: 'auth:ok', id: '', ts: Date.now() }));
    sock.on('message', (data: RawData) => {
      const bytes = Array.isArray(data) ? data.reduce((s, b) => s + b.length, 0) : (data as Buffer).byteLength;
      const text = String(data);
      let env: Record<string, any>;
      try { env = JSON.parse(text); } catch { env = { type: '<unparsable>' }; }
      h.browserSent.push({ type: String(env.type), bytes });
      if (bytes > RELAY_MAX_MSG_BYTES) { closable.close(1009, 'message too big'); return; }
      if (!relayAccepts(env)) { h.rejected.push(`browser ${env.type}`); return; }
      if (env.type === 'ping') return;
      if (env.type === 'e2e:hello' && hellos++ === 0) writeConfig([env.payload.pubKey]);
      env.fromConn = connId;
      const msg = JSON.stringify(env);
      chain = chain.then(() => webRemote._internal.handleMessage(msg, device)).catch((e: unknown) => { h.warnings.push(String(e)); });
    });
  });

  const context = await browser.newContext({ viewport: VIEWPORT, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') h.warnings.push(m.text()); });
  page.on('pageerror', (e) => h.pageErrors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  h.page = page;
  h.stop = async () => {
    await context.close();
    for (const c of conns.values()) c.terminate();
    await new Promise<void>((r) => wss.close(() => httpServer.close(() => r())));
    webRemote.__test.stopAllSessionWatches();
    webRemote._internal.resetE2e();
  };
  return h;
}

function attachmentsDir(): string {
  return path.join(projectCwd, 'session-manager-operations', 'prompt-sessions', 'attachments');
}

async function diag(h: Harness): Promise<string> {
  const rx = await h.page.evaluate(() => (window as unknown as { __rx?: string[] }).__rx ?? []).catch(() => ['<page gone>']);
  const text = await h.page.locator('body').innerText({ timeout: 2_000 }).catch(() => '<no body>');
  let saved: string[] = [];
  try { saved = fs.readdirSync(attachmentsDir()); } catch { /* none */ }
  return [
    `page received: ${rx.join(',')}`,
    `browser sent: ${h.browserSent.map((m) => `${m.type}(${m.bytes})`).join(',')}`,
    `close codes: ${h.closeCodes.join(',')}`,
    `relay rejected: ${h.rejected.join(' ')}`,
    `saved attachments: ${saved.join(',')}`,
    `chat queue calls: ${JSON.stringify(chatCalls).slice(0, 600)}`,
    `page errors: ${h.pageErrors.join(' | ')}`,
    `warnings: ${h.warnings.join(' | ')}`,
    `page text: ${text.replace(/\s+/g, ' ').slice(0, 600)}`,
  ].join('\n  ');
}

async function shows(h: Harness, loc: Locator, what: string, ms = 30_000): Promise<void> {
  const ok = await loc.first().waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
  expect(ok, `${what} never showed.\n  ${await diag(h)}`).toBe(true);
}

describe('phone image send over the real chain: MicPane -> ws.ts frames -> 256 KiB relay -> webRemote.cjs', () => {
  it('a >256 KB PNG picked in the phone composer is saved byte-identical and enqueued with its Attached line', async () => {
    const h = await start();
    const { page } = h;
    try {
      // Drill down: projects -> the project -> the active Epic.
      const projectRow = page.getByTestId('project-row').filter({ hasText: PROJECT_LABEL });
      await shows(h, projectRow, 'The project row');
      await projectRow.first().tap();
      const sessionRow = page.getByTestId('session-row').filter({ hasText: ACTIVE.title });
      await shows(h, sessionRow, 'The active Epic row');
      await sessionRow.first().tap();
      await shows(h, page.locator('[data-testid=chat-message][data-role=assistant]').filter({ hasText: ASSISTANT_TEXT }), 'The seeded assistant reply');

      // The desktop advertised 'chat-images' in its boxed event:remote:ready, and the store recorded it.
      await expect.poll(
        () => page.evaluate(() => (window as unknown as { __socket: { hasCapability(d: string, c: string): boolean } }).__socket.hasCapability(
          (window as unknown as { __cfg: { deviceId: string } }).__cfg.deviceId, 'chat-images')),
        { timeout: 20_000 },
      ).toBe(true);

      // Pick the PNG, wait for it in the tray, type a caption.
      await page.getByTestId('mic-attach-input').setInputFiles({ name: IMAGE_NAME, mimeType: 'image/png', buffer: png });
      await shows(h, page.getByTestId('mic-attach-thumb'), 'The tray thumbnail', 20_000);
      expect(await page.getByTestId('mic-pane').getByRole('alert').count(), await diag(h)).toBe(0);
      await page.getByTestId('mic-pane').getByRole('textbox').fill(CAPTION);

      const sendStart = h.browserSent.length;
      const callsBefore = chatCalls.length;
      await page.getByRole('button', { name: 'Send message' }).tap();

      const pendingLabel = page.getByTestId('pending-label');
      await shows(h, pendingLabel, 'The pending bubble label', 30_000);
      expect(await pendingLabel.textContent(), await diag(h)).toBe('Sent');
      expect(await page.getByTestId('pending-message').innerText()).toContain(CAPTION);
      // The pending bubble shows the picked image as a rendered thumbnail.
      const thumb = page.getByTestId('pending-images').locator('img');
      await shows(h, thumb, 'The pending bubble thumbnail', 10_000);
      await expect.poll(() => thumb.first().evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth), { timeout: 10_000 }).toBe(600);

      // Wire: the send went out as ≥2 boxed frames, none over the relay cap, and the relay never closed with 1009.
      const sent = h.browserSent.slice(sendStart);
      const boxes = sent.filter((m) => m.type === 'e2e:box');
      expect(boxes.length, await diag(h)).toBeGreaterThanOrEqual(2);
      expect(sent.filter((m) => m.bytes > RELAY_MAX_MSG_BYTES), await diag(h)).toEqual([]);
      expect(h.browserSent.every((m) => m.bytes <= RELAY_MAX_MSG_BYTES)).toBe(true);
      expect(h.closeCodes).not.toContain(1009);

      // Desktop: exactly one enqueue; the saved file is byte-identical to the PNG.
      expect(chatCalls.length, await diag(h)).toBe(callsBefore + 1);
      const [epicId, prompt, opts] = chatCalls[callsBefore] as [string, string, unknown];
      expect(epicId).toBe(ACTIVE.id);
      expect(opts).toMatchObject({ sessionId: ACTIVE.claudeSessionId, cwd: projectCwd });
      const saved = fs.readdirSync(attachmentsDir());
      expect(saved.length, await diag(h)).toBe(1);
      const savedPath = path.join(attachmentsDir(), saved[0]);
      expect(saved[0]).toMatch(/forwarded\.png$/);
      expect(fs.readFileSync(savedPath).equals(png), 'saved attachment bytes differ from the picked PNG').toBe(true);
      expect(prompt.startsWith(CAPTION)).toBe(true);
      expect(prompt.endsWith(`Attached: ${savedPath}`), `prompt: ${prompt}`).toBe(true);
      expect(prompt).toBe(`${CAPTION}\n\nAttached: ${savedPath}`);

      expect(h.rejected).toEqual([]);
      expect(h.pageErrors).toEqual([]);
    } finally {
      await h.stop();
    }
  }, 120_000);
});
