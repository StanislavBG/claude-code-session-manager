// Accessibility e2e — axe-core scans of the BUILT bundle (dist/feedback.js, `npm run build` first)
// on the golden stand-in host page (tests/fixtures/golden-host.*), in every state a visitor reaches:
// idle, annotate, a mark popover, review panel, error banner, receipt and the discard dialog.
//
// Sites that embed the widget (Three Winds, …) gate on zero serious/critical axe violations, so:
//  - inside #feedback-widget-host: zero violations of ANY impact;
//  - page-wide: zero serious or critical violations.
// Reports go to https://bilko.run/api/sm-relay/…, routed to the relay drop-box mock as in golden.e2e.ts.
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const widgetRoot = resolve(here, '..');
const repoRoot = resolve(widgetRoot, '..', '..');
const fixturesDir = join(here, 'fixtures');
const distDir = join(widgetRoot, 'dist');
const bundlePath = join(distDir, 'feedback.js');
const requireFromRoot = createRequire(join(repoRoot, 'package.json'));
const requireFromWidget = createRequire(join(widgetRoot, 'package.json'));
const axePath: string = requireFromWidget.resolve('axe-core/axe.min.js');

const { startRelayBoxesMock } = requireFromRoot(
  './src/main/lib/feedback-remote/__tests__/helpers/relayBoxesMock.cjs',
);
const { generateBoxKeypair, keyFingerprint } = requireFromRoot('./src/main/lib/feedback-remote/feedbackSeal.cjs');

const DEVICE_TOKEN = 'dev-token-a11y-e2e';
const RELAY_URL = /^https:\/\/bilko\.run\/api\/sm-relay\//;
const VIEWPORT = { width: 1440, height: 900 };
const LAUNCHER_NAME = 'Send feedback (Shift+F)';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
};

let mock: { baseUrl: string; stop: () => Promise<void> };
let server: Server;
let hostOrigin: string;
let template: string;

test.use({ viewport: VIEWPORT, deviceScaleFactor: 1 });

test.beforeAll(async () => {
  if (!existsSync(bundlePath)) throw new Error(`${bundlePath} is missing — run \`npm run build\` first`);
  template = await readFile(join(fixturesDir, 'golden-host.html'), 'utf8');
  mock = await startRelayBoxesMock({ deviceToken: DEVICE_TOKEN });
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = decodeURIComponent(url.pathname);
    if (path === '/golden-host.html') {
      const key = url.searchParams.get('key') ?? '';
      const widget = `<script src="/dist/feedback.js" data-key="${key}" data-project="a11y"></script>`;
      res
        .writeHead(200, { 'content-type': TYPES['.html'] })
        .end(template.replace('<!--WIDGET-->', widget).replace('<!--HOST_EXTRA-->', ''));
      return;
    }
    if (path.startsWith('/api/')) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('nope');
    const file = path.startsWith('/dist/') ? normalize(join(distDir, path.slice(6))) : normalize(join(fixturesDir, path));
    if (!file.startsWith(distDir) && !file.startsWith(fixturesDir)) return void res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  hostOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((ok) => {
    if (!server) return ok();
    server.closeAllConnections?.();
    server.close(() => ok());
  });
  await mock?.stop();
});

async function createBoxKey(): Promise<string> {
  const pair = generateBoxKeypair();
  const res = await fetch(`${mock.baseUrl}/boxes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${DEVICE_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'a11y e2e', publicKey: pair.publicKey, allowedOrigins: [hostOrigin] }),
  });
  expect(res.status).toBe(201);
  const { boxId } = (await res.json()) as { boxId: string };
  return `fbk1_${boxId}.${keyFingerprint(pair.publicKey)}`;
}

/** Forwards relay traffic to the mock; envelope POSTs answer 503 while `fail503` is set. */
async function routeRelay(page: Page, opts: { fail503?: boolean } = {}): Promise<void> {
  await page.route(RELAY_URL, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.slice('/api/sm-relay'.length);
    if (opts.fail503 && req.method() === 'POST' && path.endsWith('/envelopes')) {
      await route.fulfill({
        status: 503,
        headers: { 'access-control-allow-origin': hostOrigin, 'content-type': 'application/json' },
        body: '{"error":"unavailable"}',
      });
      return;
    }
    const headers = await req.allHeaders();
    delete headers.host;
    const response = await route.fetch({
      url: mock.baseUrl + path + url.search,
      headers: { ...headers, origin: hostOrigin },
    });
    await route.fulfill({ response });
  });
}

// ── Page helpers ────────────────────────────────────────────────────────────

const widget = (page: Page): Locator => page.locator('#feedback-widget-host');
const launcher = (page: Page): Locator => widget(page).getByRole('button', { name: LAUNCHER_NAME });
const toolbar = (page: Page): Locator => widget(page).getByRole('toolbar', { name: 'Markup tools' });
const panel = (page: Page): Locator => widget(page).getByRole('region', { name: 'Describe your feedback' });
const discard = (page: Page): Locator => widget(page).getByRole('dialog', { name: 'Discard this feedback?' });
const popover = (page: Page): Locator => widget(page).locator('[data-part="popover"]');

async function gotoHost(page: Page, opts: { fail503?: boolean } = {}): Promise<void> {
  const key = await createBoxKey();
  await routeRelay(page, opts);
  await page.goto(`${hostOrigin}/golden-host.html?${new URLSearchParams({ key })}`, { waitUntil: 'networkidle' });
  await expect(launcher(page)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function open(page: Page): Promise<void> {
  await launcher(page).click();
  await expect(toolbar(page)).toBeVisible();
}

/** Drops one pin and closes its popover again. */
async function pin(page: Page): Promise<void> {
  await page.mouse.click(300, 360);
  await expect(popover(page)).toBeVisible();
  await popover(page).locator('[data-part="popover-text"]').fill('Price overlaps the photo');
  await page.keyboard.press('Enter');
  await expect(popover(page)).toHaveCount(0);
}

async function review(page: Page): Promise<void> {
  await open(page);
  await pin(page);
  await toolbar(page).locator('[data-part="describe"]').click();
  await expect(panel(page)).toBeVisible();
  await widget(page).locator('#fw-pn-title').fill('Price overlaps the photo');
}

/** Resolves once nothing inside the widget's shadow root is transitioning or animating. */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const root = document.getElementById('feedback-widget-host')?.shadowRoot as
      | (ShadowRoot & { getAnimations?: () => Animation[] })
      | null
      | undefined;
    return !!root?.getAnimations && root.getAnimations().length === 0;
  });
}

// ── axe ─────────────────────────────────────────────────────────────────────

interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: unknown[]; failureSummary?: string }[];
}

async function axe(page: Page, include: string | null): Promise<AxeViolation[]> {
  if (!(await page.evaluate(() => 'axe' in window))) await page.addScriptTag({ path: axePath });
  return page.evaluate(async (sel) => {
    const w = window as unknown as {
      axe: { run(ctx: unknown, opts: unknown): Promise<{ violations: AxeViolation[] }> };
    };
    const ctx = sel ? { include: [sel] } : document;
    const { violations } = await w.axe.run(ctx, { resultTypes: ['violations'] });
    return violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.map((n) => ({ target: n.target, failureSummary: n.failureSummary })),
    }));
  }, include);
}

/** Inside the widget: zero violations of any impact. Page-wide: zero serious or critical. */
async function expectClean(page: Page, state: string): Promise<void> {
  await settled(page);
  const inWidget = await axe(page, '#feedback-widget-host');
  expect(inWidget, `${state}: axe violations inside #feedback-widget-host`).toEqual([]);
  const pageWide = (await axe(page, null)).filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(pageWide, `${state}: serious/critical axe violations page-wide`).toEqual([]);
}

// ── States ──────────────────────────────────────────────────────────────────

test('idle: only the launcher shows, and it scans clean', async ({ page }) => {
  await gotoHost(page);
  await expect(toolbar(page)).toHaveCount(0);
  await expectClean(page, 'idle');
});

test('annotate: the open widget is one labelled modal dialog and scans clean', async ({ page }) => {
  await gotoHost(page);
  await open(page);
  const root = widget(page).getByRole('dialog', { name: 'Send feedback', exact: true });
  await expect(root).toHaveCount(1);
  await expect(root).toHaveAttribute('aria-modal', 'true');
  await expect(root.getByRole('toolbar', { name: 'Markup tools' })).toBeVisible();
  await pin(page);
  await expectClean(page, 'annotate');
});

test('a mark popover scans clean', async ({ page }) => {
  await gotoHost(page);
  await open(page);
  await page.mouse.click(300, 360);
  await expect(popover(page)).toBeVisible();
  await expect(popover(page).locator('[data-part="popover-text"]')).toBeFocused();
  await expectClean(page, 'popover');
});

test('review panel scans clean', async ({ page }) => {
  await gotoHost(page);
  await review(page);
  await expectClean(page, 'review');
});

test('error banner scans clean', async ({ page }) => {
  await gotoHost(page, { fail503: true });
  await review(page);
  await panel(page).locator('[data-part="send"]').click();
  await expect(panel(page).locator('[data-part="error-banner"]')).toBeVisible({ timeout: 20_000 });
  await expectClean(page, 'error');
});

test('receipt scans clean', async ({ page }) => {
  await gotoHost(page);
  await review(page);
  await panel(page).locator('[data-part="send"]').click();
  await expect(widget(page).locator('[data-part="receipt"]')).toBeVisible({ timeout: 20_000 });
  await expectClean(page, 'receipt');
});

test('discard dialog scans clean', async ({ page }) => {
  await gotoHost(page);
  await open(page);
  await pin(page);
  await page.keyboard.press('Escape');
  await expect(discard(page)).toBeVisible();
  await expectClean(page, 'discard');
});
