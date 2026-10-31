// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Real RemoteRenderer (bundled) <-> real desktop remoteAssets + chunkFrames, in real Chromium.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const req = createRequire(import.meta.url);
const assets = req(path.join(repoRoot, 'src/main/lib/feedback-remote/remoteAssets.cjs')) as {
  assetManifest(): unknown;
  readAsset(name: string): { ok: boolean };
  __test: { setRoot(p: string | null): void };
};
const { chunkFrames } = req(path.join(repoRoot, 'src/main/lib/feedback-remote/remoteIpcDispatch.cjs')) as {
  chunkFrames(v: unknown): { ok?: boolean; frames: Array<{ seq: number; total: number; data: string }> };
};

const PROBE = "parent.postMessage({ type: 'sm-ipc', id: 1, channel: 'probe', args: [] }, '*');";
const INDEX = '<!doctype html><html><head><link rel="stylesheet" href="./app.css"></head><body><script type="module" src="./app.js"></script></body></html>';

interface Sent { type: string; payload: unknown; id?: string }

let browser: Browser;
let bundle = '';
const tmpDirs: string[] = [];

beforeAll(async () => {
  const out = await build({
    entryPoints: [path.join(here, 'fixtures/remote-renderer-entry.tsx')],
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  bundle = out.outputFiles[0].text;
  browser = await chromium.launch(); // fail, never skip
}, 60_000);

afterAll(async () => {
  assets.__test.setRoot(null);
  await browser?.close();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function distWeb(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-dist-web-'));
  tmpDirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

async function mount(): Promise<{ page: Page; sent: Sent[] }> {
  const page = await browser.newPage(); // fresh context => fresh IndexedDB
  const sent: Sent[] = [];
  await page.route('https://sm-parent.test/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.goto('https://sm-parent.test/');
  await page.exposeFunction('__toNode', async (type: string, payload: unknown, id?: string) => {
    sent.push({ type, payload, id });
    let value: unknown;
    if (type === 'asset:manifest') value = { ok: true, result: assets.assetManifest() };
    else if (type === 'asset:get') {
      const r = assets.readAsset((payload as { name: string }).name);
      value = r.ok ? { ok: true, result: r } : { ok: false, error: 'rejected' };
    } else return; // ipc:invoke / ipc:subscribe: recorded, no reply
    const chunks = chunkFrames(value);
    for (const f of chunks.frames) {
      const env = { type: 'ipc:result', id, seq: f.seq, total: f.total, data: f.data };
      await page.evaluate((e) => (window as unknown as { __deliver(e: unknown): void }).__deliver(e), env);
    }
  });
  await page.evaluate(() => {
    const handlers = new Map<string, Array<(env: unknown) => void>>();
    const w = window as unknown as Record<string, unknown>;
    w.__socket = {
      on(type: string, h: (env: unknown) => void) {
        handlers.set(type, [...(handlers.get(type) ?? []), h]);
        return () => handlers.set(type, (handlers.get(type) ?? []).filter((x) => x !== h));
      },
      async sendEnvelope(type: string, _deviceId: string, payload: unknown, id?: string) {
        void (w.__toNode as (t: string, p: unknown, i?: string) => Promise<void>)(type, payload, id);
        return true;
      },
    };
    w.__deliver = (env: { type: string }) => { for (const h of handlers.get(env.type) ?? []) h(env); };
  });
  await page.addScriptTag({ content: bundle });
  return { page, sent };
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

describe('RemoteRenderer -> remoteAssets chain in real Chromium', () => {
  it('flat dist-web: the served app boots and its probe reaches Node as ipc:invoke', async () => {
    assets.__test.setRoot(distWeb({ 'index.html': INDEX, 'app.js': PROBE, 'app.css': 'body{margin:0}' }));
    const { page, sent } = await mount();
    const ok = await waitFor(() => sent.some((s) => s.type === 'ipc:invoke'), 10_000);
    await page.close();
    expect(ok).toBe(true);
    const inv = sent.find((s) => s.type === 'ipc:invoke')!;
    expect((inv.payload as { calls: Array<{ channel: string }> }).calls[0].channel).toBe('probe');
  }, 20_000);

  it('nested (released) layout renders the fallback and no iframe', async () => {
    assets.__test.setRoot(distWeb({
      'index.html': '<!doctype html><html><head><link rel="stylesheet" href="./assets/app.css"></head><body><script type="module" src="./assets/app.js"></script></body></html>',
      'assets/app.js': PROBE,
      'assets/app.css': 'body{margin:0}',
    }));
    const { page } = await mount();
    await page.waitForSelector('[data-testid="drill"]', { timeout: 10_000 });
    const iframes = await page.locator('iframe').count();
    await page.close();
    expect(iframes).toBe(0);
  }, 20_000);

  const real = process.env.SM_REAL_DIST_WEB === '1' ? it : it.skip;
  real('real built dist-web boots through the whole path', async () => {
    const dir = path.join(repoRoot, 'dist-web');
    expect(fs.existsSync(dir), `${dir} is missing (run npm run build:web)`).toBe(true);
    assets.__test.setRoot(dir);
    const { page, sent } = await mount();
    const ok = await waitFor(() => sent.some((s) => s.type === 'ipc:invoke'), 30_000);
    await page.close();
    expect(ok, `types seen: ${sent.map((s) => s.type).join(',')}`).toBe(true);
  }, 45_000);
});
