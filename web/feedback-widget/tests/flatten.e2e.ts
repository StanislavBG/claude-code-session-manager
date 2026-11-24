// Flattened `annotated` PNG (handoff README §1 "Flatten marks into a second PNG … using the same
// geometry as the on-screen rendering"). One mark of each kind is created with real pointer +
// keyboard input on a host fixture page (widget host + capture chrome + marks layer + element
// picker mounted from source by an esbuild harness, backdrop = a real captureViewport() result).
// flattenAnnotated() is then compared pixel-by-pixel with a browser screenshot of the on-screen
// marks over the backdrop.
import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const widgetRoot = join(here, '..');
const VIEWPORT = { width: 1280, height: 800 };
/** AC: at most 1 % of pixels may differ by more than 16 in any channel. */
const CHANNEL_TOLERANCE = 16;
const MAX_DIFF_RATIO = 0.01;

const HARNESS = `
import { render } from 'preact';
import { useEffect, useReducer } from 'preact/hooks';
import { captureViewport } from './src/capture';
import { HOST_ID } from './src/host';
import { CaptureChrome } from './src/ui/CaptureChrome';
import { ElementPicker } from './src/ui/ElementPicker';
import { MarksLayer, useMarks } from './src/ui/MarksLayer';
import { flattenAnnotated } from './src/ui/flatten';
import { initialState, reduce } from './src/ui/machine';
import { MARK_COLORS } from './src/ui/marks';
import { baseSheet } from './src/ui/tokens';

const host = document.createElement('div');
host.id = HOST_ID;
Object.assign(host.style, { position: 'fixed', top: '0', right: '0', bottom: '0', left: '0', zIndex: '2147483000', pointerEvents: 'none' });
const shadow = host.attachShadow({ mode: 'open' });
shadow.adoptedStyleSheets = [baseSheet()];
document.body.appendChild(host);

function App({ capture }) {
  const [state, dispatch] = useReducer(reduce, initialState());
  const api = useMarks(dispatch);
  const color = MARK_COLORS[window.__color || 'rust'];
  useEffect(() => { dispatch({ type: 'open' }); }, []);
  useEffect(() => {
    window.__setTool = (tool, c) => { window.__color = c; dispatch({ type: 'setTool', tool }); };
  }, []);
  useEffect(() => { window.__marks = api.marks; }, [api.marks]);
  useEffect(() => { window.__tool = state.tool; }, [state.tool]);
  const armed = state.mode === 'annotate' && state.tool === 'element';
  return (
    <CaptureChrome state={state} dispatch={dispatch} capture={capture}>
      <MarksLayer marks={api.marks} tool={state.tool} color={color} onCreate={api.add} />
      <ElementPicker active={armed} color={color} onCreate={api.add} />
    </CaptureChrome>
  );
}

/** Base64 of a Blob, for handing PNGs back to the test. */
async function b64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function pixels(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  return { width: bmp.width, height: bmp.height, data: ctx.getImageData(0, 0, bmp.width, bmp.height).data };
}

window.__flatten = async () => {
  const cap = window.__capture;
  const out = await flattenAnnotated(cap.png, window.__marks, { scale: cap.scale });
  const raw = await pixels(cap.png);
  const img = await pixels(out);
  return { type: out.type, width: img.width, height: img.height, rawWidth: raw.width, rawHeight: raw.height, png: await b64(out) };
};

/** Compares a base64 PNG (the on-screen screenshot) with the last flatten output. */
window.__compare = async (shotB64, flatB64, tol) => {
  const toBlob = (s) => new Blob([Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))], { type: 'image/png' });
  const a = await pixels(toBlob(shotB64));
  const b = await pixels(toBlob(flatB64));
  if (a.width !== b.width || a.height !== b.height) return { sized: false, a: [a.width, a.height], b: [b.width, b.height] };
  let differ = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      Math.abs(a.data[i] - b.data[i]) > tol ||
      Math.abs(a.data[i + 1] - b.data[i + 1]) > tol ||
      Math.abs(a.data[i + 2] - b.data[i + 2]) > tol
    ) differ++;
  }
  return { sized: true, differ, total: a.width * a.height };
};

/** Pixels of the raw screenshot that differ from the flattened one (marks actually drawn). */
window.__changedFromRaw = async (flatB64, tol) => {
  const toBlob = (s) => new Blob([Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))], { type: 'image/png' });
  const a = await pixels(window.__capture.png);
  const b = await pixels(toBlob(flatB64));
  let differ = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.abs(a.data[i] - b.data[i]) > tol || Math.abs(a.data[i + 1] - b.data[i + 1]) > tol || Math.abs(a.data[i + 2] - b.data[i + 2]) > tol) differ++;
  }
  return differ;
};

/** Hides the chrome that is not a mark (frame, hint, flash, pick outline) for the shot. */
window.__marksOnly = () => {
  const s = new CSSStyleSheet();
  s.replaceSync('.fw-frame,.fw-hint,.fw-flash,[data-part="pick-outline"],[data-part="pick-chip"]{display:none!important}');
  shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, s];
};

captureViewport({ hostEl: host }).then((capture) => {
  window.__capture = capture;
  render(<App capture={capture} />, shadow);
  window.__ready = true;
});
`;

const HOST_PAGE = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Flatten fixture</title>
<link rel="stylesheet" href="./host.css">
</head>
<body>
<header><b class="brand">Lumen Stays</b><nav><a class="nav">Stays</a><a class="nav">Trips</a><a class="nav">Help</a></nav></header>
<main>
<h1>Alfama loft</h1>
<p>Two rooms above the tram line.</p>
<div class="actions"><button class="btn">Save</button><button class="btn book">Book</button></div>
<section class="grid"><div class="card"></div><div class="card dark"></div><div class="card"></div></section>
</main>
<script src="./harness.js"></script>
</body>
</html>
`;
const HOST_CSS = `html,body{margin:0;background:#fff;color:#1a1612;font:15px/1.5 system-ui,sans-serif}
header{display:flex;align-items:center;gap:24px;height:56px;padding:0 32px;border-bottom:1px solid #d4ccb8}
nav{display:flex;gap:16px;flex:1}
main{padding:32px}h1{margin:0 0 8px;font-size:32px}
.btn{font:inherit;padding:8px 14px;border-radius:6px;border:1px solid #1a1612;background:#fff}.book{background:#1a1612;color:#fff}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:32px}.card{height:260px;background:#ede6d6;border-radius:8px}
.card.dark{background:#3a342b}
`;

let tmp = '';
let server: Server | undefined;
let base = '';

test.beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'fw-flatten-'));
  const bundled = await build({
    stdin: { contents: HARNESS, resolveDir: widgetRoot, loader: 'tsx', sourcefile: 'harness.tsx' },
    bundle: true,
    format: 'iife',
    write: false,
    target: 'es2020',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    define: { __WIDGET_VERSION__: JSON.stringify('0.0.0-e2e') },
  });
  await writeFile(join(tmp, 'harness.js'), bundled.outputFiles[0].text);
  await writeFile(join(tmp, 'index.html'), HOST_PAGE);
  await writeFile(join(tmp, 'host.css'), HOST_CSS);
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  server = createServer(async (req, res) => {
    const file = normalize(join(tmp, new URL(req.url ?? '/', 'http://x').pathname));
    if (!file.startsWith(tmp)) return void res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((ok) => (server ? server.close(() => ok()) : ok()));
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

type Win = Window & {
  __ready?: boolean;
  __marks?: Array<{ kind: string }>;
  __tool?: string;
  __setTool(tool: string, color?: string): void;
};

async function open(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${base}/index.html`);
  await page.waitForFunction(() => (window as unknown as Win).__ready === true);
  await expect(page.locator('#feedback-widget-host .fw-backdrop')).toBeVisible();
  await page.waitForFunction(() => {
    const img = document.querySelector('#feedback-widget-host')!.shadowRoot!.querySelector('img.fw-backdrop') as HTMLImageElement | null;
    return !!img && img.complete && img.naturalWidth > 0;
  });
  expect(errors).toEqual([]);
}

async function tool(page: Page, t: string, color = 'rust'): Promise<void> {
  await page.evaluate(([tt, c]) => (window as unknown as Win).__setTool(tt, c), [t, color]);
  await page.waitForFunction((tt) => (window as unknown as Win).__tool === tt, t);
}

async function markCount(page: Page, n: number): Promise<void> {
  await page.waitForFunction((k) => ((window as unknown as Win).__marks ?? []).length === k, n);
}

async function drag(page: Page, pts: Array<[number, number]>): Promise<void> {
  await page.mouse.move(pts[0][0], pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.up();
}

/** One mark of every kind, in several colours, over light and dark parts of the page. */
async function markEverything(page: Page): Promise<void> {
  await tool(page, 'pin');
  await page.mouse.click(160, 420);
  await markCount(page, 1);

  await tool(page, 'box', 'amber');
  await drag(page, [[480, 380], [760, 560]]);
  await markCount(page, 2);

  await tool(page, 'element', 'green');
  const book = await page.locator('button.book').boundingBox();
  await page.mouse.move(book!.x + book!.width / 2, book!.y + book!.height / 2);
  await page.mouse.click(book!.x + book!.width / 2, book!.y + book!.height / 2);
  await markCount(page, 3);

  await tool(page, 'arrow', 'rust');
  await drag(page, [[900, 640], [1040, 470]]);
  await markCount(page, 4);

  await tool(page, 'draw', 'ink');
  await drag(page, [[300, 650], [340, 610], [400, 640], [450, 600], [500, 660], [560, 620]]);
  await markCount(page, 5);

  await tool(page, 'text', 'rust');
  // A pointerdown alone opens the label input: a full mouse click's mousedown default moves
  // focus off the just-mounted input, whose blur commits it empty (discarded) — see report.
  await page.mouse.move(820, 260);
  await page.locator('#feedback-widget-host [data-part="marks-hit"]').dispatchEvent('pointerdown', { button: 0, clientX: 820, clientY: 260, pointerId: 1, isPrimary: true });
  const input = page.locator('#feedback-widget-host [data-part="text-input"]');
  await expect(input).toBeFocused();
  await page.keyboard.type('Price looks wrong');
  await page.keyboard.press('Enter');
  await markCount(page, 6);

  await tool(page, 'pin');
  await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2);
}

for (const dpr of [1, 2]) {
  test.describe(`deviceScaleFactor ${dpr}`, () => {
    test.use({ viewport: VIEWPORT, deviceScaleFactor: dpr });

    test('flattenAnnotated matches the on-screen marks over the backdrop', async ({ page }) => {
      await open(page);
      await markEverything(page);
      const kinds = await page.evaluate(() => (window as unknown as Win).__marks!.map((m) => m.kind));
      expect(kinds).toEqual(['pin', 'box', 'element', 'arrow', 'draw', 'text']);

      await page.evaluate(() => (window as unknown as { __marksOnly(): void }).__marksOnly());
      await page.waitForTimeout(100);
      const shot = (await page.screenshot({ animations: 'disabled', caret: 'hide' })).toString('base64');

      const flat = await page.evaluate(() =>
        (window as unknown as { __flatten(): Promise<{ type: string; width: number; height: number; rawWidth: number; rawHeight: number; png: string }> }).__flatten(),
      );
      // A PNG Blob the size of the screenshot.
      expect(flat.type).toBe('image/png');
      expect({ w: flat.width, h: flat.height }).toEqual({ w: flat.rawWidth, h: flat.rawHeight });
      expect({ w: flat.width, h: flat.height }).toEqual({ w: VIEWPORT.width * dpr, h: VIEWPORT.height * dpr });

      // The marks were actually drawn (not just the raw screenshot passed through).
      const drawn = await page.evaluate(
        ([png, tol]) => (window as unknown as { __changedFromRaw(p: string, t: number): Promise<number> }).__changedFromRaw(png, tol),
        [flat.png, CHANNEL_TOLERANCE] as const,
      );
      expect(drawn).toBeGreaterThan(5000 * dpr * dpr);

      const cmp = await page.evaluate(
        ([s, f, tol]) =>
          (window as unknown as { __compare(a: string, b: string, t: number): Promise<{ sized: boolean; differ: number; total: number }> }).__compare(s, f, tol),
        [shot, flat.png, CHANNEL_TOLERANCE] as const,
      );
      expect(cmp.sized).toBe(true);
      const ratio = cmp.differ / cmp.total;
      console.log(`dpr ${dpr}: ${cmp.differ}/${cmp.total} px differ (${(ratio * 100).toFixed(3)} %); marks changed ${drawn} px`);
      expect(ratio).toBeLessThanOrEqual(MAX_DIFF_RATIO);
    });
  });
}
