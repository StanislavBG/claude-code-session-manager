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
import { fileURLToPath } from 'node:url';
import { PHONE_QUERY, VIEW_MODE_KEY } from '../viewMode';

// The phone user's whole flow over the real chain, nothing mocked but the relay's WAN hop and the chat queue:
//   real Cockpit + useStore (phone view picked by real matchMedia at 390x844) -> real ws.ts RelaySocket + E2E boxes
//   -> in-process fake relay (stamps fromConn + deviceId, honours toConn) -> real src/main/webRemote.cjs
//   handleMessage + cmd:* dispatch over a temp HOME -> stubbed chatRunner.enqueueExternalPrompt.
// Phone mode never mounts the desktop renderer, so no dist-web build and no remoteAssets root here.
const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '../..');
const repoRoot = path.resolve(here, '../../../..');
const req = createRequire(import.meta.url);

const VIEWPORT = { width: 390, height: 844 };
const DEVICE_ID = 'device-phone-chain';
const PROJECT_LABEL = 'phone-proj';
const MAIN_TAB = { id: 'tab-phone-chain', sessionId: 'c4d5e6f7-0819-4a2b-9c3d-4e5f60718293' };
const ACTIVE = { id: 'epic-phone-active', title: 'Phone Active Epic', claudeSessionId: 'f2a1c3d4-5b6e-4f70-8a91-b2c3d4e5f607' };
const PROPOSED = { id: 'epic-phone-proposed', title: 'Phone Proposed Epic', claudeSessionId: '0b1c2d3e-4f50-4617-a829-3a4b5c6d7e8f' };
const USER_TEXT = 'Is the phone chain wired end to end?';
const ASSISTANT_TEXT = 'Yes: the projects, the sessions and this reply all came over the relay.';
const PROMPT = 'Ship it from the phone';
const AUDITED_OK = ['cmd:projects:list', 'cmd:project:sessions', 'cmd:session:transcript', 'cmd:chat:send'];
const RENDERER_IFRAME = 'iframe[data-testid=remote-renderer]';

let tmpHome = '';
let origHome: string | undefined;
let projectCwd = '';
let shotDir = '';
let chatRunnerPath = '';
let webRemote: any;
let browser: Browser;
let bundle = '';
let shellCss = '';
let viewportMeta = '';
/** Arguments of every chatRunner.enqueueExternalPrompt call the real cmd:chat:send handler made. */
const chatCalls: unknown[][] = [];

beforeAll(async () => {
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-phone-chain-home-')));
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
  // The desktop's chat queue. webRemote.cjs requires ./chatRunner.cjs when its dispatch map first loads (the first
  // cmd:* dispatch), so this cache entry, set before webRemote.cjs is even required, is what cmd:chat:send calls.
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

  // One open tab (the registered-project source of cmd:projects:list) for a git-free project under the temp HOME,
  // holding a real active-index.json: one active Epic with a claudeSessionId, one proposed Epic.
  projectCwd = path.join(tmpHome, 'Projects', PROJECT_LABEL);
  const psDir = path.join(projectCwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(psDir, { recursive: true });
  const mkEpic = (e: typeof ACTIVE, status: 'active' | 'proposed') => ({
    id: e.id, cwd: projectCwd, goalText: e.title, claudeSessionId: e.claudeSessionId, status,
    createdAt: new Date(1_700_000_000_000).toISOString(), completedAt: null, tag: 'feature',
  });
  fs.writeFileSync(path.join(psDir, 'active-index.json'), JSON.stringify({
    sessions: { [ACTIVE.id]: mkEpic(ACTIVE, 'active'), [PROPOSED.id]: mkEpic(PROPOSED, 'proposed') },
    events: { [ACTIVE.id]: [], [PROPOSED.id]: [] },
    tombstones: {},
  }));
  fs.writeFileSync(path.join(smDir, 'tabs.json'), JSON.stringify({
    tabs: [{ ...MAIN_TAB, cwd: projectCwd, label: PROJECT_LABEL, presetId: null }],
    activeTabId: MAIN_TAB.id, savedAt: Date.now(),
  }));
  // The active Epic's Claude JSONL transcript, written where the desktop's own resolver looks for it.
  const { resolveEpicTranscriptPath } = req(path.join(repoRoot, 'src/main/lib/epic/epicTranscriptPath.cjs'));
  const transcriptFile: string | null = resolveEpicTranscriptPath({ cwd: projectCwd, claudeSessionId: ACTIVE.claudeSessionId }).path;
  if (!transcriptFile || !transcriptFile.startsWith(path.join(tmpHome, '.claude', 'projects') + path.sep)) {
    throw new Error(`resolveEpicTranscriptPath left the temp HOME: ${transcriptFile}`);
  }
  fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
  const t0 = Date.now() - 60_000;
  const lines = [
    { type: 'user', message: { role: 'user', content: USER_TEXT }, uuid: crypto.randomUUID(), timestamp: new Date(t0).toISOString(), sessionId: ACTIVE.claudeSessionId },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ASSISTANT_TEXT }] }, uuid: crypto.randomUUID(), timestamp: new Date(t0 + 5_000).toISOString(), sessionId: ACTIVE.claudeSessionId },
  ];
  fs.writeFileSync(transcriptFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  // The harness page carries the real shell's viewport meta and its compiled Tailwind CSS, so the 390px layout
  // and the screenshots are the shell's own.
  viewportMeta = fs.readFileSync(path.join(appDir, 'index.html'), 'utf8').match(/<meta\s+name="viewport"[^>]*>/i)?.[0] ?? '';
  if (!viewportMeta.includes('width=device-width')) throw new Error(`index.html has no width=device-width viewport meta: ${viewportMeta || '<none>'}`);
  const twConfigPath = path.join(appDir, 'tailwind.config.js');
  const twConfig = (await import(/* @vite-ignore */ twConfigPath)).default as TailwindConfig;
  const cssFrom = path.join(appDir, 'src/index.css');
  const css = await postcss([tailwindcss({ ...twConfig, content: [path.join(appDir, 'index.html'), path.join(appDir, 'src/**/*.{ts,tsx}')] })])
    .process(fs.readFileSync(cssFrom, 'utf8'), { from: cssFrom });
  shellCss = css.css;
  if (!shellCss.includes('.h-dvh') || !shellCss.includes('.bg-accent')) throw new Error('Tailwind compiled none of the shell utilities');

  const out = await build({
    entryPoints: [path.join(here, 'fixtures/phone-chain-entry.tsx')],
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{
      name: 'fake-api',
      setup(b) {
        // ws.ts's ticket + relay URL point at the in-process fake relay.
        b.onResolve({ filter: /^\.\/api$/ }, () => ({ path: path.join(here, 'fixtures/api-stub.ts') }));
      },
    }],
  });
  bundle = out.outputFiles[0].text;
  shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-phone-chain-shots-'));
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
  page: Page;
  /** Envelope types the browser sent to the relay (commands travel inside e2e:box). */
  browserSent: string[];
  /** Frames the fake relay dropped for failing its envelope schema. */
  rejected: string[];
  warnings: string[];
  pageErrors: string[];
  /** Every HTTP request the harness page made. */
  http: string[];
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
    deviceId: DEVICE_ID, deviceToken: 'tok', deviceName: 'Phone chain',
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
    browserSent: [], rejected: [], warnings: [], pageErrors: [], http: [], stop: async () => {},
  };

  // Fake relay: the browser side is a real WebSocketServer; the desktop side is webRemote's _ws. It also serves
  // the harness page (same origin, so Chromium's local-network checks stay quiet).
  const conns = new Map<string, WsSocket>();
  let n = 0;
  let relayUrl = '';
  const httpServer = http.createServer((q, res) => {
    h.http.push(`${q.method} ${q.url}`);
    if (q.method === 'GET' && q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(harnessHtml(relayUrl, { deviceId: device.deviceId, devicePubKey: device.e2ePublicKey }));
    } else if (q.method === 'GET' && q.url === '/phone-chain.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(bundle);
    } else {
      // Telemetry beacons (POST /api/telemetry/event) are accepted and dropped; nothing else exists.
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
    if (!relayAccepts(env)) { h.rejected.push(`desktop ${env.type}:${String(env.id).slice(0, 48)}`); return; }
    const targets = env.toConn ? [conns.get(env.toConn)] : [...conns.values()];
    delete env.toConn;
    env.deviceId = device.deviceId; // the live relay stamps the sending device on every frame
    for (const t of targets) if (t && t.readyState === 1) t.send(JSON.stringify(env));
  };
  webRemote.__test.setWs({ readyState: 1, send: toBrowser, terminate: () => {} });
  let hellos = 0;
  wss.on('connection', (sock: WsSocket) => {
    const connId = `conn-${++n}`;
    conns.set(connId, sock);
    sock.send(JSON.stringify({ type: 'auth:ok', id: '', ts: Date.now() }));
    sock.on('message', (data: RawData) => {
      const env = JSON.parse(String(data));
      if (!relayAccepts(env)) { h.rejected.push(`browser ${env.type}`); return; }
      h.browserSent.push(env.type);
      if (env.type === 'ping') return;
      if (env.type === 'e2e:hello' && hellos++ === 0) writeConfig([env.payload.pubKey]); // the owner pinned this browser earlier
      env.fromConn = connId;
      void webRemote._internal.handleMessage(JSON.stringify(env), device).catch((e: unknown) => h.warnings.push(String(e)));
    });
  });

  const context = await browser.newContext({ viewport: VIEWPORT, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  // Records the desktop renderer's iframe if it is ever inserted, even for a moment.
  await context.addInitScript((sel: string) => {
    const w = window as unknown as { __rendererSeen: boolean };
    w.__rendererSeen = false;
    new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (node instanceof Element && (node.matches(sel) || node.querySelector(sel))) w.__rendererSeen = true;
        }
      }
    }).observe(document, { childList: true, subtree: true });
  }, RENDERER_IFRAME);
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

/** Every remote audit log in the temp HOME (one file per UTC day), concatenated. */
function auditText(): string {
  const dir = path.join(tmpHome, '.claude', 'session-manager', 'logs');
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /^remote-audit-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
  } catch { /* no log yet */ }
  return names.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
}

/** State dump for assertion messages. */
async function diag(h: Harness): Promise<string> {
  const rx = await h.page.evaluate(() => (window as unknown as { __rx?: string[] }).__rx ?? []).catch(() => ['<page gone>']);
  const text = await h.page.locator('body').innerText({ timeout: 2_000 }).catch(() => '<no body>');
  const audit = auditText().trim().split('\n').filter(Boolean).slice(-15)
    .map((l) => { const f = l.split(/\s{2,}/); return `${f[1]} ${f[f.length - 1]}`; });
  return [
    `page received: ${rx.join(',')}`,
    `browser sent: ${h.browserSent.join(',')}`,
    `relay rejected: ${h.rejected.join(' ')}`,
    `audit: ${audit.join(' | ')}`,
    `chat queue calls: ${JSON.stringify(chatCalls)}`,
    `http: ${h.http.join(', ')}`,
    `page errors: ${h.pageErrors.join(' | ')}`,
    `warnings: ${h.warnings.join(' | ')}`,
    `page text: ${text.replace(/\s+/g, ' ').slice(0, 600)}`,
  ].join('\n  ');
}

async function shows(h: Harness, loc: Locator, what: string, ms = 30_000): Promise<void> {
  const ok = await loc.first().waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
  expect(ok, `${what} never showed.\n  ${await diag(h)}`).toBe(true);
}

/** Screenshot the current screen under os.tmpdir() and check nothing is wider than the phone. */
async function checkScreen(h: Harness, name: string): Promise<void> {
  const file = path.join(shotDir, `${name}.png`);
  await h.page.screenshot({ path: file, animations: 'disabled' });
  console.log(`[phone-drilldown-chain] ${name}: ${file}`);
  const w = await h.page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(w.doc, `${name}: document scrollWidth ${w.doc} (body ${w.body}) is wider than the ${VIEWPORT.width}px phone`)
    .toBeLessThanOrEqual(VIEWPORT.width);
}

describe('phone drill-down over the real chain: Cockpit -> ws.ts -> relay -> webRemote.cjs', () => {
  it('390x844: project list, the project\'s sessions, the transcript with the agent\'s reply, and a send that reaches the chat queue', async () => {
    const h = await start();
    const { page } = h;
    try {
      // The phone view comes from the real matchMedia under the shell's viewport meta, not a stored choice.
      expect(await page.evaluate(() => window.innerWidth)).toBe(VIEWPORT.width);
      expect(await page.evaluate(() => /\[native code\]/.test(String(window.matchMedia)))).toBe(true);
      expect(await page.evaluate((q) => window.matchMedia(q).matches, PHONE_QUERY)).toBe(true);
      expect(await page.evaluate((k) => localStorage.getItem(k), VIEW_MODE_KEY)).toBeNull();

      // Screen 1: projects.
      const projectRow = page.getByTestId('project-row').filter({ hasText: PROJECT_LABEL });
      await shows(h, projectRow, 'The project row');
      // The header toggle offers the Full UI only while the Cockpit is in phone view.
      const toggle = await page.getByTestId('view-mode-toggle').textContent({ timeout: 5_000 }).catch(() => null);
      expect(toggle, `the Cockpit is not in phone view.\n  ${await diag(h)}`).toBe('Full UI');
      await checkScreen(h, '1-projects');

      // Screen 2: the project's sessions.
      await projectRow.first().tap();
      const sessionRow = (title: string) => page.getByTestId('session-row').filter({ hasText: title });
      await shows(h, sessionRow(ACTIVE.title), 'The active Epic row');
      await shows(h, sessionRow(PROPOSED.title), 'The proposed Epic row');
      await checkScreen(h, '2-sessions');

      // Screen 3: the active Epic's transcript, then a send from the composer.
      await sessionRow(ACTIVE.title).first().tap();
      const bubble = (role: string, text: string) =>
        page.locator(`[data-testid=chat-message][data-role=${role}]`).filter({ hasText: text });
      await shows(h, bubble('user', USER_TEXT), 'The seeded user message');
      await shows(h, bubble('assistant', ASSISTANT_TEXT), 'The seeded assistant reply');

      await page.getByTestId('mic-pane').locator('input').fill(PROMPT);
      await page.getByRole('button', { name: 'Send command' }).tap();
      const pendingLabel = page.getByTestId('pending-label');
      await shows(h, pendingLabel, 'The pending bubble label', 20_000);
      expect(await pendingLabel.textContent()).toBe('Sent');
      expect(await page.getByTestId('pending-message').textContent()).toContain(PROMPT);
      await checkScreen(h, '3-session-after-send');

      // The real cmd:chat:send handler resolved the active Epic and queued the prompt exactly once.
      expect(chatCalls.length, await diag(h)).toBe(1);
      const [epicId, prompt, opts] = chatCalls[0];
      expect(epicId).toBe(ACTIVE.id);
      expect(prompt).toBe(PROMPT);
      expect(opts).toMatchObject({ sessionId: ACTIVE.claudeSessionId, cwd: projectCwd });

      // The desktop served every step itself, and nothing ever asked it for the desktop renderer.
      const audit = auditText();
      for (const type of AUDITED_OK) {
        expect(audit, `no result=ok audit line for ${type}.\n  ${await diag(h)}`).toMatch(new RegExp(`^\\S+ {2}${type} {2}.* {2}result=ok$`, 'm'));
      }
      expect(audit).not.toMatch(/asset:(manifest|get)/);
      expect(await page.evaluate(() => (window as unknown as { __rendererSeen: boolean }).__rendererSeen)).toBe(false);
      expect(await page.locator(RENDERER_IFRAME).count()).toBe(0);
      expect(h.pageErrors).toEqual([]);
      expect(chatCalls.length).toBe(1);
    } finally {
      await h.stop();
    }
  }, 120_000);
});
