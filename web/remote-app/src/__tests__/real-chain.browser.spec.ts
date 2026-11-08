// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { build } from 'esbuild';
import { WebSocketServer, type WebSocket as WsSocket, type RawData } from 'ws';
import { createRequire } from 'node:module';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ipcDefaults } from './fixtures/ipc-defaults';

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
let electronStub: { app: unknown; ipcMain: { handle: (c: string, f: unknown) => void; on: (c: string, f: unknown) => void } };
let bundle = '';
let distDir = '';

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-real-chain-home-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager', 'logs'), { recursive: true });
  const electronPath = req.resolve('electron');
  electronStub = {
    ipcMain: { handle: () => {}, on: () => {} },
    app: { getPath: () => tmpHome, getVersion: () => '0.0.0-test' },
  } as never;
  req.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: electronStub,
  } as never;
  for (const mod of ['src/main/webRemote.cjs', 'src/main/config.cjs', 'src/main/logs.cjs', 'src/main/promptSessionsIpc.cjs', 'src/main/lib/epic/activeIndexMerge.cjs']) {
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
  projectCwd: string;
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
  const h: Harness = { calls, hellos: 0, browserSent, delivered: 0, warnings: [], projectCwd: '', rejected: [], page: null as never, stop: async () => {} };

  const surface = req(path.join(repoRoot, 'src/preload/apiSurface.cjs'));
  // Register exactly as production does: invoke rows via ipcMain.handle, send rows via ipcMain.on,
  // both captured by captureIpcHandlers (index.cjs wraps the real ipcMain the same way).
  const fakeIpc = { handle: (_c: string, _f: unknown) => {}, on: (_c: string, _f: unknown) => {} };
  const handlers = dispatchLib.captureIpcHandlers(fakeIpc);
  const record = (channel: string, value: unknown, kind = 'invoke') => {
    const fn = async () => { calls.push({ channel, at: Date.now() }); return value; };
    if (kind === 'send') fakeIpc.on(channel, fn); else fakeIpc.handle(channel, fn);
  };
  // Temp project (git-free) holding a real active-index.json: a plain proposed draft (opens in the
  // NewEpicCard draft editor), an inbound cross-project proposal (opens on EpicApprovalBar) and an active Epic.
  const projectCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-real-chain-proj-')));
  const psDir = path.join(projectCwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(psDir, { recursive: true });
  const mkEpic = (id: string, title: string, status: 'proposed' | 'active') => ({
    id, cwd: projectCwd, goalText: title, claudeSessionId: `claude-${id}`, status,
    createdAt: new Date(1_700_000_000_000).toISOString(), completedAt: null, tag: 'feature',
  });
  // inboundFeedbackOrigin (src/renderer/lib/epicOrigin.ts) is non-null for exactly this source shape;
  // no autoApprove stamp, so nothing approves it before the test does.
  const inbound = {
    ...mkEpic('epic-inbound', 'Chain Inbound Proposal', 'proposed'),
    source: { producer: 'cross-project-feedback', fromCwd: path.join(path.dirname(projectCwd), 'sm-real-chain-sender') },
  };
  fs.writeFileSync(path.join(psDir, 'active-index.json'), JSON.stringify({
    sessions: {
      'epic-proposed': mkEpic('epic-proposed', 'Chain Proposed Epic', 'proposed'),
      'epic-inbound': inbound,
      'epic-active': mkEpic('epic-active', 'Chain Active Epic', 'active'),
    },
    events: { 'epic-proposed': [], 'epic-inbound': [], 'epic-active': [] },
    tombstones: {},
  }));
  // Registered-project source of the real handlers (promptSessionsIpc defaultProjectRoots): the persisted tabs store.
  fs.writeFileSync(path.join(tmpHome, '.claude', 'session-manager', 'tabs.json'), JSON.stringify({
    tabs: [{ id: 'tab-chain', sessionId: 'chain-claude-session', cwd: projectCwd, label: 'chain-proj', presetId: null }],
    activeTabId: 'tab-chain', savedAt: Date.now(),
  }));
  const projectRoots = () => [projectCwd];
  h.projectCwd = projectCwd;

  const defaults = ipcDefaults({ projectCwd, homeDir: tmpHome });
  const known = new Set(Object.keys(defaults));
  for (const row of surface as Array<{ channel: string; kind: string }>) {
    if ((row.kind === 'invoke' || row.kind === 'send') && !known.has(row.channel)) record(row.channel, null, row.kind);
  }
  for (const [channel, value] of Object.entries(defaults)) record(channel, value);
  // Real promptSessions read handlers + real merge handler, over the capturing fakeIpc (replaces the defaults above).
  electronStub.ipcMain.handle = (c: string, f: unknown) => {
    fakeIpc.handle(c, async (...a: unknown[]) => { calls.push({ channel: c, at: Date.now() }); return (f as (...x: unknown[]) => unknown)(...a); });
  };
  const psIpc = req(path.join(repoRoot, 'src/main/promptSessionsIpc.cjs'));
  const merge = req(path.join(repoRoot, 'src/main/lib/epic/activeIndexMerge.cjs'));
  psIpc.registerPromptSessionsReadHandlers();
  merge.registerActiveIndexMergeHandlers();
  webRemote.setIpcDispatcher(dispatchLib.createRemoteIpcDispatcher({
    surface, handlers, getConfig: () => webRemote.loadConfig(),
    fenceCtx: { homeDir: tmpHome, realpath: (p: string) => p, projectRoots },
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
  wss.on('connection', (sock: WsSocket) => {
    const connId = `conn-${++n}`;
    conns.set(connId, sock);
    sock.send(JSON.stringify({ type: 'auth:ok', id: '', ts: Date.now() }));
    sock.on('message', (data: RawData) => {
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
  // The WAN is not part of this chain: answer Monaco's schema fetch (App.tsx) with CORS headers so the sandboxed frame stays quiet.
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

  it('Sessions list renders from real handlers', async () => {
    const h = await start({ control: true });
    const frameErrors: string[] = [];
    try {
      h.page.on('pageerror', (e) => frameErrors.push(`pageerror: ${e.message} ${e.stack ?? ""}`));
      h.page.on('console', (m) => {
        if (m.type() === 'error' && m.location().url && !m.location().url.startsWith('ws:')) frameErrors.push(`console: ${m.text()}`);
      });
      // The harness page has no host CSS; give the frame the whole viewport like bilko.run does.
      await h.page.addStyleTag({ content: 'iframe[data-testid=remote-renderer]{position:fixed;inset:0;width:100vw;height:100vh;border:0}' });
      const frame = h.page.frameLocator('iframe[data-testid=remote-renderer]');
      // Open the Epics destination the way a user does: the project's Sessions nav.
      const titles = ['Chain Proposed Epic', 'Chain Active Epic'].map((t) => frame.getByTestId('epic-queue-row').filter({ hasText: t }).first());
      const deadline = Date.now() + 30_000;
      let ok = false;
      let opened = false;
      while (Date.now() < deadline && !ok) {
        // The first-run welcome tour covers the app; a user skips it.
        const skip = frame.getByTestId('tour-skip');
        if (await skip.isVisible().catch(() => false)) await skip.click({ timeout: 2_000 }).catch(() => {});
        if (!opened) {
          // Project tab first (Sessions is a PROJECT-face nav row), then the Sessions row.
          const tab = frame.getByText('chain-proj', { exact: true }).first();
          if (await tab.isVisible().catch(() => false)) {
            await tab.click({ timeout: 2_000 }).catch(() => {});
            const nav = frame.getByText('Sessions', { exact: true }).first();
            if (await nav.isVisible().catch(() => false)) opened = await nav.click({ timeout: 2_000 }).then(() => true, () => false);
          }
        }
        ok = (await Promise.all(titles.map((t) => t.isVisible().catch(() => false)))).every(Boolean);
        if (!ok) await new Promise((r) => setTimeout(r, 250));
      }
      const dumped = ok ? '' : await frame.locator('body').innerText({ timeout: 2_000 }).catch(() => '<no frame body>');
      expect(ok, `${await diag(h)}\nframe text: ${dumped.slice(0, 800)}\nerrors: ${frameErrors.join(' | ')}`).toBe(true);
      expect(h.calls.some((c) => c.channel === 'promptSessions:load-active-index')).toBe(true);
      expect(frameErrors).toEqual([]);
    } finally {
      await h.stop();
    }
  }, 120_000);

  /** Open the project's Sessions list inside the frame (skips the tour), then return the frame + error log. */
  async function openSessions(h: Harness) {
    const frameErrors: string[] = [];
    h.page.on('pageerror', (e) => frameErrors.push(`pageerror: ${e.message}`));
    h.page.on('console', (m) => {
      if (m.type() === 'error' && m.location().url && !m.location().url.startsWith('ws:')) frameErrors.push(`console: ${m.text()}`);
    });
    await h.page.addStyleTag({ content: 'iframe[data-testid=remote-renderer]{position:fixed;inset:0;width:100vw;height:100vh;border:0}' });
    const frame = h.page.frameLocator('iframe[data-testid=remote-renderer]');
    const row = (t: string) => frame.getByTestId('epic-queue-row').filter({ hasText: t }).first();
    const deadline = Date.now() + 30_000;
    let opened = false;
    while (Date.now() < deadline) {
      const skip = frame.getByTestId('tour-skip');
      if (await skip.isVisible().catch(() => false)) await skip.click({ timeout: 2_000 }).catch(() => {});
      if (!opened) {
        const tab = frame.getByText('chain-proj', { exact: true }).first();
        if (await tab.isVisible().catch(() => false)) {
          await tab.click({ timeout: 2_000 }).catch(() => {});
          const nav = frame.getByText('Sessions', { exact: true }).first();
          if (await nav.isVisible().catch(() => false)) opened = await nav.click({ timeout: 2_000 }).then(() => true, () => false);
        }
      }
      const seeded = ['Chain Proposed Epic', 'Chain Inbound Proposal', 'Chain Active Epic'];
      if ((await Promise.all(seeded.map((t) => row(t).isVisible().catch(() => false)))).every(Boolean)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    return { frame, row, frameErrors };
  }
  const indexPath = (h: Harness) => path.join(h.projectCwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json');
  const readIndex = (h: Harness) => JSON.parse(fs.readFileSync(indexPath(h), 'utf8')) as { sessions: Record<string, { status: string; goalText?: string }> };

  it('approve on the proposed Epic round-trips to active-index.json', async () => {
    const h = await start({ control: true });
    try {
      const { frame, row, frameErrors } = await openSessions(h);
      // EpicApprovalBar (epic-approve) is for inbound proposals only; a plain draft opens in NewEpicCard.
      await row('Chain Inbound Proposal').click({ timeout: 10_000 });
      await frame.getByTestId('epic-approve').click({ timeout: 15_000 });
      const active = await waitFor(() => {
        try { return readIndex(h).sessions['epic-inbound']?.status === 'active'; } catch { return false; }
      }, 15_000);
      expect(active, await diag(h)).toBe(true);
      expect(readIndex(h).sessions['epic-proposed'].status).toBe('proposed');
      expect(readIndex(h).sessions['epic-active'].status).toBe('active');
      expect(h.calls.some((c) => c.channel === 'promptSessions:merge-active-index'), await diag(h)).toBe(true);
      expect(frameErrors).toEqual([]);
    } finally {
      await h.stop();
    }
  }, 120_000);

  it('Start Session on a plain proposed draft round-trips to active-index.json', async () => {
    const h = await start({ control: true });
    try {
      const { frame, row, frameErrors } = await openSessions(h);
      await row('Chain Proposed Epic').click({ timeout: 10_000 });
      // A human-saved draft reopens in the NewEpicCard editor, prefilled from the Epic.
      await frame.getByTestId('new-epic-card').waitFor({ state: 'visible', timeout: 15_000 });
      expect(await frame.getByTestId('new-epic-title').inputValue({ timeout: 5_000 })).toBe('Chain Proposed Epic');
      // The seeded draft is title-only and Start needs an objective, so type one as a user would.
      const goal = 'Start this draft from the browser.';
      await frame.getByTestId('new-epic-goal').fill(goal, { timeout: 5_000 });
      await frame.getByTestId('new-epic-create').click({ timeout: 15_000 });
      const active = await waitFor(() => {
        try { return readIndex(h).sessions['epic-proposed']?.status === 'active'; } catch { return false; }
      }, 20_000);
      expect(active, `${await diag(h)}\nerrors: ${frameErrors.join(' | ')}`).toBe(true);
      // The started Epic replaces the editor; let it render before the error check.
      await frame.getByTestId('new-epic-card').waitFor({ state: 'detached', timeout: 15_000 });
      const index = readIndex(h);
      expect(index.sessions['epic-proposed'].goalText).toContain(goal);
      expect(index.sessions['epic-inbound'].status).toBe('proposed');
      expect(index.sessions['epic-active'].status).toBe('active');
      expect(h.calls.some((c) => c.channel === 'promptSessions:merge-active-index'), await diag(h)).toBe(true);
      expect(frameErrors).toEqual([]);
    } finally {
      await h.stop();
    }
  }, 120_000);

  it('Mark completed on the active Epic writes its archive and drops it from the index', async () => {
    const h = await start({ control: true });
    try {
      const { frame, row, frameErrors } = await openSessions(h);
      await row('Chain Active Epic').click({ timeout: 10_000 });
      await frame.getByTestId('epic-mark-completed').click({ timeout: 15_000 });
      const archive = path.join(h.projectCwd, 'session-manager-operations', 'prompt-sessions', 'epic-active.json');
      const done = await waitFor(() => {
        try { return fs.existsSync(archive) && !('epic-active' in readIndex(h).sessions); } catch { return false; }
      }, 40_000);
      expect(done, `${await diag(h)}
errors: ${frameErrors.join(' | ')}`).toBe(true);
      expect(JSON.parse(fs.readFileSync(archive, 'utf8')).session.id).toBe('epic-active');
      expect(h.calls.some((c) => c.channel === 'promptSessions:write-archive'), await diag(h)).toBe(true);
      expect(readIndex(h).sessions['epic-proposed'].status).toBe('proposed');
      expect(frameErrors).toEqual([]);
    } finally {
      await h.stop();
    }
  }, 120_000);

  it('approve with remote control off shows a refusal toast and writes nothing', async () => {
    const h = await start({ control: false });
    try {
      const { frame, row } = await openSessions(h);
      const before = fs.readFileSync(indexPath(h));
      await row('Chain Inbound Proposal').click({ timeout: 10_000 });
      await frame.getByTestId('epic-approve').click({ timeout: 15_000 });
      // approveProposed retries the refused persist (~1 s, then ~3 s) before its one toast (b098fd12).
      const refusal = frame.getByTestId('toast').filter({ hasText: 'approval was not saved' }).first();
      await refusal.waitFor({ state: 'visible', timeout: 20_000 });
      expect(await refusal.innerText()).toMatch(/"Chain Inbound Proposal" is running but its approval was not saved/);
      expect(Buffer.compare(fs.readFileSync(indexPath(h)), before)).toBe(0);
      expect(h.calls.some((c) => c.channel === 'promptSessions:merge-active-index')).toBe(false);
    } finally {
      await h.stop();
    }
  }, 120_000);

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
