// Design-vs-widget screenshot pairs at 1280x800 (tests/shots/README.md).
//
// design/<scene>.png — the Claude Design prototype ("Feedback Widget.dc.html") rendered through the
//   same <dc-import> pattern "Feedback Widget States.dc.html" uses: every scene in the default variant
//   (launcher corner · flow annotate · toolbar dock · success receipt), plus every non-default frame
//   on the States board (VARIANT_SHOTS: launchers, flows, toolbars, success styles).
// widget/<scene>.png — the built widget (src/index.ts) mounted on a stand-in host page configured
//   with the shot's variant, for every
//   scene the widget can reach today; the rest are skipped with a named reason.
//
// The design folder is copied to a temp dir and the scene wrappers are written there (never into
// session-manager-operations/design-mocks/), then served over http: the dc runtime fetches the
// sibling .dc.html, which file:// blocks.
//
// The two halves run apart. The default `e2e` run renders only the widget half, which needs no
// network. `npm run shots:design` (FW_SHOTS=design) renders only the design half, which fetches
// Google Fonts, unpkg and the prototype's demo-site images.
import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { FONT_FACES as WIDGET_FONT_FACES, FONTS_DIR } from '../src/ui/tokens';

const here = dirname(fileURLToPath(import.meta.url));
const widgetRoot = join(here, '..');
const designSrc = join(widgetRoot, '..', '..', 'session-manager-operations', 'design-mocks', 'feedback-widget');
const shotsDir = join(here, 'shots');

/** True when this run renders the design half (`npm run shots:design`); false for the default widget half. */
const DESIGN_RUN = process.env.FW_SHOTS === 'design';

const VIEWPORT = { width: 1280, height: 800 };
const DEFAULTS = { launcher: 'corner', flow: 'annotate', toolbar: 'dock', success: 'receipt' } as const;

/**
 * Every scene id "Feedback Widget States.dc.html" uses. `marker` is visible text the scene must show
 * once the runtime has rendered it, as a button's accessible name or plain text (the runtime
 * re-serializes inline styles, so we never match style strings). `readme` is the handoff README section the pair checks.
 */
export const SCENES = [
  { id: 'idle', marker: null, readme: '§5.1 Launcher' },
  { id: 'launcher-hover', marker: null, readme: '§5.1 Launcher' },
  { id: 'annotate-empty', marker: 'Describe ↵', readme: '§5.2 Capture feedback, §5.3 Toolbar' },
  { id: 'annotate', marker: 'Describe ↵', readme: '§5.3 Toolbar, §5.4 Marks' },
  { id: 'pick', marker: 'Describe ↵', readme: '§5.4 Marks (element pick)' },
  { id: 'tools', marker: 'Describe ↵', readme: '§5.3 Toolbar, §5.5 Mark comment popover' },
  { id: 'tools-pick', marker: 'Describe ↵', readme: '§5.3 Toolbar, §5.4 Marks (element pick)' },
  { id: 'describe', marker: 'Send feedback ⌘↵', readme: '§5.6 Panel' },
  { id: 'sending', marker: null, readme: '§5.6 Panel (sending)' },
  { id: 'error', marker: 'Retry now', readme: '§5.6 Panel (error), §2 State machine' },
  { id: 'discard', marker: 'Keep editing', readme: '§5.8 Discard dialog' },
  { id: 'sent', marker: 'Send another', readme: '§5.7 Success variants (receipt)' },
] as const;
type SceneId = (typeof SCENES)[number]['id'];

type Variant = Partial<{ -readonly [K in keyof typeof DEFAULTS]: string }>;

/** One design/widget pair: a scene id in one variant (all four axes; unset axes take DEFAULTS). */
interface Shot {
  /** File name of both PNGs. */
  id: string;
  scene: SceneId;
  variant: Variant;
  /** The States board option this frame belongs to (`1b`, `1f`, ...); null for the default set. */
  board: string | null;
  marker: string | null;
  readme: string;
}

/**
 * Every non-default frame on "Feedback Widget States.dc.html" (launchers, flows, toolbars, success
 * styles). Frames whose attributes are all defaults are the SCENES set above. Shot ids are
 * `<scene>--<axis>-<value>`.
 */
export const VARIANT_SHOTS: readonly Shot[] = [
  { id: 'idle--launcher-edge', scene: 'idle', variant: { launcher: 'edge' }, board: '1b', marker: null, readme: '§5.1 Launcher (edge)' },
  { id: 'launcher-hover--launcher-edge', scene: 'launcher-hover', variant: { launcher: 'edge' }, board: '1b', marker: null, readme: '§5.1 Launcher (edge)' },
  { id: 'idle--launcher-mini', scene: 'idle', variant: { launcher: 'mini' }, board: '1c', marker: null, readme: '§5.1 Launcher (mini)' },
  { id: 'launcher-hover--launcher-mini', scene: 'launcher-hover', variant: { launcher: 'mini' }, board: '1c', marker: null, readme: '§5.1 Launcher (mini)' },
  { id: 'idle--launcher-hidden', scene: 'idle', variant: { launcher: 'hidden' }, board: '1d', marker: 'Got it', readme: '§5.1 Launcher (hidden, coach)' },
  { id: 'annotate-empty--flow-docked', scene: 'annotate-empty', variant: { flow: 'docked' }, board: '1f', marker: null, readme: '§5.2 Capture feedback, §5.6 Panel (docked)' },
  { id: 'annotate--flow-docked', scene: 'annotate', variant: { flow: 'docked' }, board: '1f', marker: null, readme: '§5.4 Marks, §5.6 Panel (docked)' },
  { id: 'sent--flow-docked', scene: 'sent', variant: { flow: 'docked' }, board: '1f', marker: 'Send another', readme: '§5.6 Panel (docked), §5.7 Success variants (receipt)' },
  { id: 'pick--flow-note', scene: 'pick', variant: { flow: 'note' }, board: '1g', marker: null, readme: '§5.2 Capture feedback (note hint), §5.4 Marks (element pick)' },
  { id: 'annotate--flow-note', scene: 'annotate', variant: { flow: 'note' }, board: '1g', marker: null, readme: '§5.4 Marks, §5.6 Panel (note)' },
  { id: 'sent--flow-note', scene: 'sent', variant: { flow: 'note' }, board: '1g', marker: 'Send another', readme: '§5.6 Panel (note), §5.7 Success variants (receipt)' },
  { id: 'tools-pick--toolbar-rail', scene: 'tools-pick', variant: { toolbar: 'rail' }, board: '1i', marker: null, readme: '§5.3 Toolbar (rail), §5.4 Marks (element pick)' },
  { id: 'tools--toolbar-corner', scene: 'tools', variant: { toolbar: 'corner' }, board: '1j', marker: null, readme: '§5.3 Toolbar (corner), §5.5 Mark comment popover' },
  { id: 'sending--flow-docked', scene: 'sending', variant: { flow: 'docked' }, board: '1k', marker: null, readme: '§5.6 Panel (docked, sending)' },
  { id: 'sent--success-toast', scene: 'sent', variant: { success: 'toast' }, board: '1m', marker: 'Undo', readme: '§5.7 Success variants (toast)' },
  { id: 'sent--success-fold', scene: 'sent', variant: { success: 'fold' }, board: '1n', marker: null, readme: '§5.7 Success variants (fold)' },
  { id: 'error--flow-docked', scene: 'error', variant: { flow: 'docked' }, board: '1o', marker: 'Retry now', readme: '§5.6 Panel (docked, error), §2 State machine' },
];

/** Every pair the spec writes: the default-variant scenes, then the board's variant frames. */
export const SHOTS: readonly Shot[] = [
  ...SCENES.map((s) => ({ id: s.id, scene: s.id, variant: {}, board: null, marker: s.marker, readme: s.readme })),
  ...VARIANT_SHOTS,
];

const configOf = (shot: Shot) => ({ ...DEFAULTS, ...shot.variant });

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
};

// The States board's font stylesheet, and every face it uses.
const FONTS_CSS =
  'https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700&amp;family=JetBrains+Mono:wght@400;500;700&amp;family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&amp;display=swap';
const FONT_FACES = [
  ...[400, 500, 600, 700].map((w) => `${w} 16px "Inter Tight"`),
  ...[400, 500, 700].map((w) => `${w} 16px "JetBrains Mono"`),
  ...[400, 600].map((w) => `${w} 16px "Source Serif 4"`),
];

function sceneWrapper(shot: Shot): string {
  const scene = shot.scene;
  const attrs = Object.entries(configOf(shot))
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
  // Same head + helmet as the States board, one frame at 1:1.
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${FONTS_CSS}">
<script>
// Boot the dc runtime only after every web font face is loaded: the prototype measures the demo
// site to place its seeded marks, and a late font swap would shift them between runs.
Promise.all(${JSON.stringify(FONT_FACES)}.map(function (f) { return document.fonts.load(f); }))
  .then(function () { return document.fonts.ready; })
  .catch(function () {})
  .then(function () {
    var s = document.createElement('script');
    s.src = './support.js';
    document.head.appendChild(s);
  });
</script>
</head>
<body>
<x-dc>
<helmet data-dc-atomics>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="">
<link rel="stylesheet" href="${FONTS_CSS}">
<style>html,body{margin:0;overflow:hidden;background:#ede6d6;font-family:'Inter Tight',system-ui,sans-serif;color:#1a1612}</style>
</helmet>
<div id="frame" style="position:relative;width:1280px;height:800px;overflow:hidden;transform:translateZ(0)"><dc-import name="Feedback Widget" embedded="{{ true }}" scene="${scene}" ${attrs} hint-size="1280px,800px"></dc-import></div>
</x-dc>
</body>
</html>
`;
}

// Stand-in host page: an ordinary site the widget is embedded on.
const hostPage = (shot: Shot) => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Stand-in host</title>
<link rel="stylesheet" href="./host.css">
<script>window.FeedbackConfig = ${JSON.stringify({ ...configOf(shot), endpoint: '/host/submit', user: { id: 'u_1', name: 'Ada Reporter' } })};</script>
</head>
<body>
<header><b>Lumen Stays</b><nav><a>Stays</a><a>Trips</a><a>Help</a></nav><button id="search">Search</button></header>
<main>
<h1>Alfama loft</h1>
<p>Two rooms above the tram line, ten minutes from the river.</p>
<button id="book">Book</button>
<section class="grid"><div></div><div></div><div></div></section>
</main>
<script src="./feedback.js" data-project="lumen"></script>
</body>
</html>
`;
const HOST_CSS = `html,body{margin:0;background:#fff;color:#1a1612;font:15px/1.5 system-ui,sans-serif}
header{display:flex;align-items:center;gap:24px;padding:18px 32px;border-bottom:1px solid #d4ccb8}
nav{display:flex;gap:16px;flex:1}button{font:inherit;padding:8px 14px;border-radius:6px;border:1px solid #1a1612;background:#fff}
main{padding:32px}h1{margin:0 0 8px;font-size:32px}#book{background:#1a1612;color:#fff}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:32px}.grid div{height:220px;background:#ede6d6;border-radius:8px}
`;

let tmp = '';
let server: Server | undefined;
let base = '';

test.beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'fw-design-shots-'));
  if (DESIGN_RUN) {
    await cp(designSrc, join(tmp, 'design'), { recursive: true });
    for (const s of SHOTS) await writeFile(join(tmp, 'design', `scene-${s.id}.html`), sceneWrapper(s));
  } else {
    await writeHost(tmp);
  }

  server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const file = normalize(join(tmp, path));
    // Refuse anything outside tmp: a sibling such as `<tmp>-evil` passes a bare prefix check.
    const rel = relative(tmp, file);
    if (rel.startsWith('..') || isAbsolute(rel)) return void res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

/** The built widget, its fonts and the stand-in host page, under `<tmp>/host/`. */
async function writeHost(tmp: string): Promise<void> {
  const bundled = await build({
    entryPoints: [join(widgetRoot, 'src', 'index.ts')],
    bundle: true,
    format: 'iife',
    write: false,
    target: 'es2020',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    define: { __WIDGET_VERSION__: JSON.stringify('0.0.0-shots') },
  });
  await mkdir(join(tmp, 'host'));
  await writeFile(join(tmp, 'host', 'feedback.js'), bundled.outputFiles[0].text);
  // The same woff2 files the vite plugin `feedback-widget-copy-fonts` emits, next to feedback.js.
  await mkdir(join(tmp, 'host', FONTS_DIR));
  for (const f of WIDGET_FONT_FACES) {
    const src = join(widgetRoot, 'node_modules', f.pkg, 'files', f.file);
    await writeFile(join(tmp, 'host', FONTS_DIR, f.file), readFileSync(src));
  }
  for (const s of SHOTS) await writeFile(join(tmp, 'host', `${s.id}.html`), hostPage(s));
  await writeFile(join(tmp, 'host', 'host.css'), HOST_CSS);
}

test.afterAll(async () => {
  await new Promise<void>((ok) => (server ? server.close(() => ok()) : ok()));
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

test.use({ viewport: VIEWPORT, deviceScaleFactor: 1 });

/**
 * Screenshots until two consecutive frames match (timers and transitions settled), then saves.
 * `animations: 'disabled'` (the default) fast-forwards finite CSS animations to their end; a scene
 * that pins an animation mid-way itself (the toast countdown) passes 'allow'.
 */
async function settledShot(page: Page, out: string, animations: 'disabled' | 'allow' = 'disabled'): Promise<void> {
  let prev: Buffer | null = null;
  for (let i = 0; i < 20; i++) {
    const buf = await page.screenshot({ animations, caret: 'hide' });
    if (prev && prev.equals(buf)) {
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, buf);
      return;
    }
    prev = buf;
    await page.waitForTimeout(400);
  }
  throw new Error(`screen never settled for ${out}`);
}

async function waitForFonts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      ['400 13px "Inter Tight"', '600 13px "Inter Tight"', '500 11px "JetBrains Mono"'].map((f) =>
        document.fonts.load(f),
      ),
    );
    await document.fonts.ready;
  });
}

if (DESIGN_RUN) test.describe('design shots (prototype, every board variant)', () => {
  for (const scene of SHOTS) {
    test(scene.id, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      // The first paint in a fresh browser rasterises a few edge pixels differently; a warm-up load
      // in the same context makes the shot byte-identical run to run.
      for (let pass = 0; pass < 2; pass++) {
        await page.goto(`${base}/design/scene-${scene.id}.html`, { waitUntil: 'networkidle' });
        // The runtime has mounted the prototype once its demo site's text is on screen.
        await expect(page.locator('#frame').getByText('Alfama', { exact: false }).first()).toBeVisible({
          timeout: 30_000,
        });
      }
      if (scene.marker) {
        const frame = page.locator('#frame');
        await expect(
          frame.getByRole('button', { name: scene.marker, exact: true }).or(frame.getByText(scene.marker, { exact: true })).first(),
        ).toBeVisible();
      }
      await waitForFonts(page);
      await settledShot(page, join(shotsDir, 'design', `${scene.id}.png`));
      expect(errors).toEqual([]);
    });
  }
});

/** The widget's shadow root has something painted on screen. */
async function widgetPainted(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const root = document.getElementById('feedback-widget-host')?.shadowRoot;
    if (!root) return false;
    return Array.from(root.querySelectorAll('*')).some((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  });
}

const hostLocator = (page: Page) => page.locator('#feedback-widget-host');
const toolbarOf = (page: Page) => hostLocator(page).getByRole('toolbar', { name: 'Markup tools' });

async function openAnnotate(page: Page): Promise<string | null> {
  if (!(await widgetPainted(page))) return 'widget renders no launcher yet (no UI in shadow root)';
  await page.evaluate(() => window.Feedback?.open());
  await expect(toolbarOf(page)).toBeVisible();
  return null;
}

async function armTool(page: Page, name: string): Promise<void> {
  const b = toolbarOf(page).getByRole('button', { name, exact: true });
  await b.click();
  await expect(b).toHaveAttribute('aria-pressed', 'true');
}

/** Hovers inside `selector` at fraction `fx` of its width (vertically centred). */
async function hoverCentre(page: Page, selector: string, fx = 0.5): Promise<void> {
  const box = (await page.locator(selector).boundingBox())!;
  await page.mouse.move(box.x + box.width * fx, box.y + box.height / 2, { steps: 3 });
}

/**
 * Where the Element tool aims on the Book button: its right part, so the `rail` toolbar (x 20-72)
 * never sits under the pointer. The pick outline is the button's box either way.
 */
const BOOK_FX = 0.85;

type Cfg = ReturnType<typeof configOf>;

/**
 * Page x for a mark, laid out so no mark lands on the panel: flow `docked` squeezes the default
 * layout into the free area left of its side panel; flow `note` moves it right of the note, which
 * opens beside the Book button (x 116-456 at 1280x800).
 */
const markX = (cfg: Cfg, x: number) =>
  cfg.flow === 'docked' ? Math.round(x * 0.66) : cfg.flow === 'note' ? Math.round(480 + (x - 240) * 0.7) : x;

/**
 * A new pin, box or element opens its comment popover; close it again. In flow `note` the first
 * mark opens the note (Title focused) instead, which stays open.
 */
async function settleNewMark(page: Page, cfg: Cfg, first: boolean): Promise<void> {
  const popover = hostLocator(page).locator('[data-part="popover"]');
  if (cfg.flow === 'note' && first) {
    await expect(hostLocator(page).locator('#fw-pn-title')).toBeFocused();
    await expect(popover).toHaveCount(0);
    return;
  }
  await expect(popover).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
}

async function pickBook(page: Page, cfg: Cfg, first: boolean): Promise<void> {
  await armTool(page, 'Element');
  await hoverCentre(page, '#book', BOOK_FX);
  await expect(hostLocator(page).locator('[data-part="pick-outline"]')).toBeVisible();
  const book = (await page.locator('#book').boundingBox())!;
  await page.mouse.click(book.x + book.width * BOOK_FX, book.y + book.height / 2);
  await settleNewMark(page, cfg, first);
}

/**
 * One mark of every kind, with real mouse input; every popover closed again. Flow `note` starts
 * with the element on the Book button, so the note anchors there (the board's "Note on mark 1").
 */
async function seedMarks(page: Page, cfg: Cfg): Promise<void> {
  const w = hostLocator(page);
  const note = cfg.flow === 'note';
  if (note) await pickBook(page, cfg, true);

  await armTool(page, 'Pin');
  await page.mouse.click(markX(cfg, 240), 330);
  await settleNewMark(page, cfg, false);

  if (!note) await pickBook(page, cfg, false);

  await armTool(page, 'Box');
  await page.mouse.move(markX(cfg, 420), 430);
  await page.mouse.down();
  await page.mouse.move(markX(cfg, 600), 560, { steps: 8 });
  await page.mouse.up();
  await settleNewMark(page, cfg, false);

  await armTool(page, 'Arrow');
  await page.mouse.move(markX(cfg, 760), 380);
  await page.mouse.down();
  await page.mouse.move(markX(cfg, 900), 480, { steps: 8 });
  await page.mouse.up();

  await armTool(page, 'Draw');
  await page.mouse.move(markX(cfg, 980), 420);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(markX(cfg, 980 + i * 10), 420 + Math.round(Math.sin(i / 2) * 30));
  await page.mouse.up();

  await armTool(page, 'Text');
  await page.mouse.click(markX(cfg, 820), 260);
  const input = w.locator('[data-part="text-input"]');
  await expect(input).toBeFocused();
  await input.fill('Too slow');
  await page.keyboard.press('Enter');
  await expect(input).toHaveCount(0);
}

const TITLE = 'Price overlaps the photo';

async function fillTitle(page: Page): Promise<void> {
  const title = hostLocator(page).locator('#fw-pn-title');
  await expect(title).toBeVisible();
  await title.fill(TITLE);
}

/**
 * The panel filled in and ready to send. Flow `annotate` reaches it through Describe; `docked` and
 * `note` show it beside the marks already.
 */
async function openDescribe(page: Page, cfg: Cfg): Promise<string | null> {
  const r = await openAnnotate(page);
  if (r) return r;
  await seedMarks(page, cfg);
  if (cfg.flow === 'annotate') {
    await toolbarOf(page).locator('[data-part="describe"]').click();
    await expect(hostLocator(page).locator('#fw-pn-title')).toBeFocused();
  }
  await fillTitle(page);
  return null;
}

async function send(page: Page): Promise<void> {
  await hostLocator(page).locator('[data-part="send"]').click();
}

/**
 * The design's toast frame (1m) draws the countdown bar at 58% left, i.e. 42% of the 6 s countdown
 * elapsed. The widget's bar is a CSS animation, so pin it at that same elapsed time.
 */
const TOAST_COUNTDOWN_MS = 6000; // TOAST_SEND_DELAY_MS in src/ui/Receipt.tsx (a .tsx the spec does not import)
const TOAST_ELAPSED_MS = Math.round(TOAST_COUNTDOWN_MS * 0.42);

/** Pauses the toast countdown animation at `ms` elapsed. */
async function pinToastCountdown(page: Page, ms: number): Promise<void> {
  await page.evaluate((t) => {
    const fill = document.getElementById('feedback-widget-host')?.shadowRoot?.querySelector('[data-part="countdown"]');
    const anims = fill?.getAnimations() ?? [];
    if (anims.length === 0) throw new Error('toast countdown has no running animation');
    for (const a of anims) {
      a.pause();
      a.currentTime = t;
    }
  }, ms);
}

/**
 * The design's sending frames show the upload at 64%. The held-open request never reports real
 * upload progress, so the widget's XHR reports 64 of 100 bytes as soon as it is sent.
 */
const SENDING_PROGRESS = 64;

async function stubUploadProgress(page: Page, pct: number): Promise<void> {
  await page.evaluate((p) => {
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      send.call(this, body);
      const up = this.upload;
      setTimeout(() => up.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded: p, total: 100 })), 0);
    };
  }, pct);
}

/** Blurs whatever has focus inside the widget (a focused tool shows its tooltip). */
async function blurWidget(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.getElementById('feedback-widget-host')?.shadowRoot?.activeElement;
    if (el instanceof HTMLElement) el.blur();
  });
}

const accept = (page: Page) =>
  page.route('**/host/submit', (route) =>
    route.fulfill({ status: 201, contentType: 'application/json', body: '{"id":"FB-1042"}' }),
  );

/**
 * How to reach each scene on the real widget, in the shot's variant (the host page already carries
 * its config). Returns null when reached, else the reason it is not reachable (a failure).
 */
const DRIVERS: Record<SceneId, (page: Page, cfg: Cfg) => Promise<string | null>> = {
  idle: async (page, cfg) => {
    if (!(await widgetPainted(page))) return 'widget renders no launcher yet (no UI in shadow root)';
    // Hidden: no button, only the one-time coach toast.
    if (cfg.launcher === 'hidden') await expect(hostLocator(page).locator('.fw-coach')).toBeVisible();
    return null;
  },
  'launcher-hover': async (page) => {
    if (!(await widgetPainted(page))) return 'widget renders no launcher yet (no UI in shadow root)';
    const launcher = page.locator('#feedback-widget-host').locator('button').first();
    if ((await launcher.count()) === 0) return 'widget launcher is not a button yet';
    await launcher.hover();
    return null;
  },
  'annotate-empty': async (page, cfg) => {
    const r = await openAnnotate(page);
    if (r) return r;
    // Docked opens with the armed tool focused, which shows its tooltip; the design frame (1f) has none.
    if (cfg.flow === 'docked') {
      await blurWidget(page);
      await expect(toolbarOf(page).getByRole('tooltip')).toHaveCount(0);
    }
    return null;
  },
  annotate: async (page, cfg) => {
    const r = await openAnnotate(page);
    if (r) return r;
    await seedMarks(page, cfg);
    // The board's side panel and note carry the filled-in title next to the marks.
    if (cfg.flow !== 'annotate') await fillTitle(page);
    await armTool(page, 'Pin');
    await page.mouse.move(markX(cfg, 640), 760);
    return null;
  },
  pick: async (page) => {
    const r = await openAnnotate(page);
    if (r) return r;
    await armTool(page, 'Element');
    await hoverCentre(page, '#book', BOOK_FX);
    await expect(hostLocator(page).locator('[data-part="pick-outline"]')).toBeVisible();
    return null;
  },
  tools: async (page, cfg) => {
    const r = await openAnnotate(page);
    if (r) return r;
    await seedMarks(page, cfg);
    await hostLocator(page).getByRole('button', { name: 'Pin 1', exact: true }).click();
    await expect(hostLocator(page).locator('[data-part="popover"]')).toBeVisible();
    return null;
  },
  'tools-pick': async (page, cfg) => {
    const r = await openAnnotate(page);
    if (r) return r;
    await seedMarks(page, cfg);
    await armTool(page, 'Element');
    await hoverCentre(page, '#search');
    await expect(hostLocator(page).locator('[data-part="pick-outline"]')).toBeVisible();
    return null;
  },
  describe: async (page, cfg) => openDescribe(page, cfg),
  sending: async (page, cfg) => {
    // Hold the submit request open: the panel stays in `sending`.
    await page.route('**/host/submit', () => new Promise<void>(() => undefined));
    const r = await openDescribe(page, cfg);
    if (r) return r;
    await stubUploadProgress(page, SENDING_PROGRESS);
    await send(page);
    await expect(hostLocator(page).locator('[data-part="progress"]')).toHaveCount(1);
    await expect(hostLocator(page).locator('[data-part="send-label"]')).toHaveText(`Sending… ${SENDING_PROGRESS}%`);
    return null;
  },
  error: async (page, cfg) => {
    await page.route('**/host/submit', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }),
    );
    const r = await openDescribe(page, cfg);
    if (r) return r;
    await send(page);
    return null;
  },
  discard: async (page, cfg) => {
    const r = await openAnnotate(page);
    if (r) return r;
    await seedMarks(page, cfg);
    await page.keyboard.press('Escape');
    return null;
  },
  sent: async (page, cfg) => {
    await accept(page);
    const r = await openDescribe(page, cfg);
    if (r) return r;
    await send(page);
    // Toast: shown at once (the POST waits 6 s for Undo). Fold: the panel shrinks into the launcher,
    // which pings green with the ticket for 3.6 s; the shot is taken inside that window.
    if (cfg.success === 'toast') await expect(hostLocator(page).locator('[data-part="toast"]')).toBeVisible();
    if (cfg.success === 'fold') await expect(hostLocator(page).locator('[data-part="ping-bubble"]')).toBeVisible();
    return null;
  },
};

if (!DESIGN_RUN) test.describe('widget shots (built widget on the stand-in host)', () => {
  for (const shot of SHOTS) {
    test(shot.id, async ({ page }) => {
      await page.goto(`${base}/host/${shot.id}.html`, { waitUntil: 'networkidle' });
      await expect(page.locator('#feedback-widget-host')).toHaveCount(1);
      const reason = await DRIVERS[shot.scene](page, configOf(shot));
      expect(reason, `${shot.id}: widget scene is not reachable`).toBeNull();
      if (shot.marker) {
        await expect(
          hostLocator(page).getByRole('button', { name: shot.marker, exact: true }).or(
            // The send chip is "⌘↵" on macOS and "Ctrl↵" elsewhere; the label text is the same.
            hostLocator(page).getByText(shot.marker.replace(/\s*⌘↵$/, ''), { exact: true }),
          ).first(),
        ).toBeVisible({ timeout: 10_000 });
      }
      await waitForFonts(page);
      const toast = configOf(shot).success === 'toast' && shot.scene === 'sent';
      if (toast) await pinToastCountdown(page, TOAST_ELAPSED_MS);
      await settledShot(page, join(shotsDir, 'widget', `${shot.id}.png`), toast ? 'allow' : 'disabled');
      // The shot must land inside the 6 s countdown, before the toast sends and dismisses itself.
      if (toast) await expect(hostLocator(page).locator('[data-part="toast"]')).toBeVisible();
    });
  }
});
