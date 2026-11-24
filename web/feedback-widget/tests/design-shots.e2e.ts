// Design-vs-widget screenshot pairs at 1280x800 (tests/shots/README.md).
//
// design/<scene>.png — the Claude Design prototype ("Feedback Widget.dc.html") rendered through the
//   same <dc-import> pattern "Feedback Widget States.dc.html" uses, default variant only
//   (launcher corner · flow annotate · toolbar dock · success receipt).
// widget/<scene>.png — the built widget (src/index.ts) mounted on a stand-in host page, for every
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

function sceneWrapper(scene: SceneId): string {
  const attrs = Object.entries(DEFAULTS)
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
const HOST_PAGE = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Stand-in host</title>
<link rel="stylesheet" href="./host.css">
<script>window.FeedbackConfig = ${JSON.stringify({ ...DEFAULTS, endpoint: '/host/submit', user: { id: 'u_1', name: 'Ada Reporter' } })};</script>
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
    for (const s of SCENES) await writeFile(join(tmp, 'design', `scene-${s.id}.html`), sceneWrapper(s.id));
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
  await writeFile(join(tmp, 'host', 'index.html'), HOST_PAGE);
  await writeFile(join(tmp, 'host', 'host.css'), HOST_CSS);
}

test.afterAll(async () => {
  await new Promise<void>((ok) => (server ? server.close(() => ok()) : ok()));
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

test.use({ viewport: VIEWPORT, deviceScaleFactor: 1 });

/** Screenshots until two consecutive frames match (timers and transitions settled), then saves. */
async function settledShot(page: Page, out: string): Promise<void> {
  let prev: Buffer | null = null;
  for (let i = 0; i < 20; i++) {
    const buf = await page.screenshot({ animations: 'disabled', caret: 'hide' });
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

if (DESIGN_RUN) test.describe('design shots (prototype, default variant)', () => {
  for (const scene of SCENES) {
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

async function hoverCentre(page: Page, selector: string): Promise<void> {
  const box = (await page.locator(selector).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
}

/** One mark of every kind, with real mouse input; every popover closed again. */
async function seedMarks(page: Page): Promise<void> {
  const w = hostLocator(page);
  const popover = w.locator('[data-part="popover"]');
  await armTool(page, 'Pin');
  await page.mouse.click(240, 330);
  await expect(popover).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);

  await armTool(page, 'Element');
  await hoverCentre(page, '#book');
  await expect(w.locator('[data-part="pick-outline"]')).toBeVisible();
  const book = (await page.locator('#book').boundingBox())!;
  await page.mouse.click(book.x + book.width / 2, book.y + book.height / 2);
  await expect(popover).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);

  await armTool(page, 'Box');
  await page.mouse.move(420, 430);
  await page.mouse.down();
  await page.mouse.move(600, 560, { steps: 8 });
  await page.mouse.up();
  await expect(popover).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);

  await armTool(page, 'Arrow');
  await page.mouse.move(760, 380);
  await page.mouse.down();
  await page.mouse.move(900, 480, { steps: 8 });
  await page.mouse.up();

  await armTool(page, 'Draw');
  await page.mouse.move(980, 420);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(980 + i * 10, 420 + Math.round(Math.sin(i / 2) * 30));
  await page.mouse.up();

  await armTool(page, 'Text');
  await page.mouse.click(820, 260);
  const input = w.locator('[data-part="text-input"]');
  await expect(input).toBeFocused();
  await input.fill('Too slow');
  await page.keyboard.press('Enter');
  await expect(input).toHaveCount(0);
}

async function openDescribe(page: Page): Promise<string | null> {
  const r = await openAnnotate(page);
  if (r) return r;
  await seedMarks(page);
  await toolbarOf(page).locator('[data-part="describe"]').click();
  const title = hostLocator(page).locator('#fw-pn-title');
  await expect(title).toBeFocused();
  await title.fill('Price overlaps the photo');
  return null;
}

/**
 * How to reach each scene on the real widget. Returns null when reached, else the reason it is not reachable (a failure).
 */
const DRIVERS: Record<SceneId, (page: Page) => Promise<string | null>> = {
  idle: async (page) => ((await widgetPainted(page)) ? null : 'widget renders no launcher yet (no UI in shadow root)'),
  'launcher-hover': async (page) => {
    if (!(await widgetPainted(page))) return 'widget renders no launcher yet (no UI in shadow root)';
    const launcher = page.locator('#feedback-widget-host').locator('button').first();
    if ((await launcher.count()) === 0) return 'widget launcher is not a button yet';
    await launcher.hover();
    return null;
  },
  'annotate-empty': async (page) => openAnnotate(page),
  annotate: async (page) => {
    const r = await openAnnotate(page);
    if (r) return r;
    await seedMarks(page);
    await armTool(page, 'Pin');
    await page.mouse.move(640, 760);
    return null;
  },
  pick: async (page) => {
    const r = await openAnnotate(page);
    if (r) return r;
    await armTool(page, 'Element');
    await hoverCentre(page, '#book');
    await expect(hostLocator(page).locator('[data-part="pick-outline"]')).toBeVisible();
    return null;
  },
  tools: async (page) => {
    const r = await openAnnotate(page);
    if (r) return r;
    await seedMarks(page);
    await hostLocator(page).getByRole('button', { name: 'Pin 1', exact: true }).click();
    await expect(hostLocator(page).locator('[data-part="popover"]')).toBeVisible();
    return null;
  },
  'tools-pick': async (page) => {
    const r = await openAnnotate(page);
    if (r) return r;
    await seedMarks(page);
    await armTool(page, 'Element');
    await hoverCentre(page, '#search');
    await expect(hostLocator(page).locator('[data-part="pick-outline"]')).toBeVisible();
    return null;
  },
  describe: async (page) => {
    const r = await openDescribe(page);
    return r;
  },
  sending: async (page) => {
    // Hold the submit request open: the panel stays in `sending`.
    await page.route('**/host/submit', () => new Promise<void>(() => undefined));
    const r = await openDescribe(page);
    if (r) return r;
    await hostLocator(page).locator('[data-part="send"]').click();
    return null;
  },
  error: async (page) => {
    await page.route('**/host/submit', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }),
    );
    const r = await openDescribe(page);
    if (r) return r;
    await hostLocator(page).locator('[data-part="send"]').click();
    return null;
  },
  discard: async (page) => {
    const r = await openAnnotate(page);
    if (r) return r;
    await seedMarks(page);
    await page.keyboard.press('Escape');
    return null;
  },
  sent: async (page) => {
    await page.route('**/host/submit', (route) =>
      route.fulfill({ status: 201, contentType: 'application/json', body: '{"id":"FB-1042"}' }),
    );
    const r = await openDescribe(page);
    if (r) return r;
    await hostLocator(page).locator('[data-part="send"]').click();
    return null;
  },
};

if (!DESIGN_RUN) test.describe('widget shots (built widget on the stand-in host)', () => {
  for (const scene of SCENES) {
    test(scene.id, async ({ page }) => {
      await page.goto(`${base}/host/index.html`, { waitUntil: 'networkidle' });
      await expect(page.locator('#feedback-widget-host')).toHaveCount(1);
      const reason = await DRIVERS[scene.id](page);
      expect(reason, `${scene.id}: widget scene is not reachable`).toBeNull();
      if (scene.marker) {
        await expect(
          hostLocator(page).getByRole('button', { name: scene.marker, exact: true }).or(
            // The send chip is "⌘↵" on macOS and "Ctrl↵" elsewhere; the label text is the same.
            hostLocator(page).getByText(scene.marker.replace(/\s*⌘↵$/, ''), { exact: true }),
          ).first(),
        ).toBeVisible({ timeout: 10_000 });
      }
      await waitForFonts(page);
      await settledShot(page, join(shotsDir, 'widget', `${scene.id}.png`));
    });
  }
});
