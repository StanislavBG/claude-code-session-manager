// Element tool (handoff README §5.4 "Element" + "Element-pick hover") on a host fixture page:
// the widget host + capture chrome + marks layer + element picker are mounted from source by an
// esbuild harness, the frozen screenshot is a real captureViewport() result, and the pointer is
// driven with real mouse input so hit-testing runs through document.elementFromPoint.
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

const HARNESS = `
import { render } from 'preact';
import { useEffect, useReducer, useState } from 'preact/hooks';
import { captureViewport } from './src/capture';
import { HOST_ID } from './src/host';
import { CaptureChrome } from './src/ui/CaptureChrome';
import { ElementPicker } from './src/ui/ElementPicker';
import { MarksLayer, useMarks } from './src/ui/MarksLayer';
import { initialState, reduce } from './src/ui/machine';
import { DEFAULT_MARK_COLOR } from './src/ui/marks';

const host = document.createElement('div');
host.id = HOST_ID;
Object.assign(host.style, { position: 'fixed', top: '0', right: '0', bottom: '0', left: '0', zIndex: '2147483000', pointerEvents: 'none' });
const shadow = host.attachShadow({ mode: 'open' });
document.body.appendChild(host);

function App({ capture }) {
  const [state, dispatch] = useReducer(reduce, initialState());
  const api = useMarks(dispatch);
  const [hovered, setHovered] = useState(null);
  useEffect(() => {
    dispatch({ type: 'open' });
    dispatch({ type: 'setTool', tool: 'element' });
  }, []);
  useEffect(() => { window.__marks = api.marks; }, [api.marks]);
  useEffect(() => { window.__hovered = hovered; }, [hovered]);
  const armed = state.mode === 'annotate' && state.tool === 'element';
  return (
    <CaptureChrome state={state} dispatch={dispatch} capture={capture}>
      <MarksLayer marks={api.marks} tool={state.tool} color={DEFAULT_MARK_COLOR} onCreate={api.add} />
      <ElementPicker active={armed} color={DEFAULT_MARK_COLOR} onCreate={api.add} onHover={setHovered} />
    </CaptureChrome>
  );
}

captureViewport({ hostEl: host }).then((capture) => {
  render(<App capture={capture} />, shadow);
  window.__ready = true;
});
`;

const HOST_PAGE = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Element pick fixture</title>
<link rel="stylesheet" href="./host.css">
</head>
<body>
<header><b class="brand">Lumen Stays</b><nav><a class="nav">Stays</a><a class="nav">Trips</a><a class="nav">Help</a></nav></header>
<main>
<h1>Alfama loft</h1>
<p>Two rooms above the tram line.</p>
<div class="actions"><button class="btn">Save</button><button class="btn book">Book</button></div>
<section class="grid"><div class="card"></div><div class="card"></div><div class="card"></div></section>
<i id="dot"></i>
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
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:32px}.card{height:220px;background:#ede6d6;border-radius:8px}
#dot{position:absolute;left:600px;top:700px;width:3px;height:3px;background:#a83818;display:block}
`;

let tmp = '';
let server: Server | undefined;
let base = '';

test.beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'fw-element-pick-'));
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

test.use({ viewport: VIEWPORT, deviceScaleFactor: 1 });

type Rect = { x: number; y: number; w: number; h: number };

/** A live page element's viewport rect (the page under the frozen screenshot). */
async function pageRect(page: Page, selector: string): Promise<Rect> {
  return page.evaluate((sel) => {
    const b = document.querySelector(sel)!.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  }, selector);
}

async function backdropBox(page: Page): Promise<Rect> {
  const box = await page.locator('#feedback-widget-host .fw-backdrop').boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x, y: box!.y, w: box!.width, h: box!.height };
}

const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const dim = (r: Rect) => `${Math.round(r.w)}×${Math.round(r.h)}`;

async function open(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/index.html`);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  await expect(page.locator('#feedback-widget-host .fw-backdrop')).toBeVisible();
  await expect(page.locator('#feedback-widget-host [data-part="pick-hit"]')).toHaveCount(1);
  expect(errors).toEqual([]);
}

test('hover outlines the live element under the frozen screenshot with its selector chip', async ({ page }) => {
  await open(page);
  const before = await backdropBox(page);
  expect(before).toEqual({ x: 0, y: 0, w: VIEWPORT.width, h: VIEWPORT.height });

  const book = await pageRect(page, 'button.book');
  await page.mouse.move(center(book).x, center(book).y);

  const widget = page.locator('#feedback-widget-host');
  const chip = widget.locator('[data-part="pick-chip"]');
  await expect(chip).toBeVisible();
  await expect(chip.locator('.fw-pick-sel')).toHaveText('button.btn.book');
  await expect(chip.locator('.fw-pick-dim')).toHaveText(dim(book));
  await expect(chip.locator('.fw-pick-cta')).toHaveText('click to select');
  await expect(chip).toHaveText(`button.btn.book${dim(book)}click to select`);

  // The hit-test reached the live page element, not a widget layer.
  expect(await page.evaluate(() => (window as unknown as { __hovered: Element | null }).__hovered?.className)).toBe('btn book');

  // §5.4 hover styles.
  const outline = widget.locator('[data-part="pick-outline"]');
  const os = await outline.evaluate((el) => {
    const s = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    return {
      border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
      bg: s.backgroundColor,
      radius: s.borderTopLeftRadius,
      rect: { x: b.left, y: b.top, w: b.width, h: b.height },
    };
  });
  expect(os.border).toBe('2px solid rgb(168, 56, 24)');
  expect(os.bg).toBe('rgba(168, 56, 24, 0.08)');
  expect(os.radius).toBe('3px');
  expect(os.rect).toEqual(book);

  const cs = await chip.evaluate((el) => {
    const s = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    const color = (q: string) => getComputedStyle(el.querySelector(q)!).color;
    return {
      bg: s.backgroundColor,
      font: `${s.fontWeight} ${s.fontSize}`,
      family: s.fontFamily,
      padding: s.padding,
      radius: s.borderTopLeftRadius,
      sel: color('.fw-pick-sel'),
      dim: color('.fw-pick-dim'),
      cta: color('.fw-pick-cta'),
      left: b.left,
      bottom: b.bottom,
      placement: el.getAttribute('data-placement'),
    };
  });
  expect(cs.bg).toBe('rgb(26, 22, 18)');
  expect(cs.font).toBe('500 11.5px');
  expect(cs.family).toContain('JetBrains Mono');
  expect(cs.padding).toBe('4px 8px');
  expect(cs.radius).toBe('5px');
  expect(cs.sel).toBe('rgb(244, 185, 66)');
  expect(cs.dim).toBe('rgb(201, 191, 169)');
  expect(cs.cta).toBe('rgb(245, 240, 230)');
  // Element top ≥ 34 → chip sits above it.
  expect(book.y).toBeGreaterThanOrEqual(34);
  expect(cs.placement).toBe('above');
  expect(cs.left).toBeCloseTo(book.x, 1);
  expect(cs.bottom).toBeCloseTo(book.y - 6, 1);

  // Element top < 34 → chip goes below it.
  const nav = await pageRect(page, 'b.brand');
  expect(nav.y).toBeLessThan(34);
  await page.mouse.move(center(nav).x, center(nav).y);
  await expect(chip.locator('.fw-pick-sel')).toHaveText('b.brand');
  await expect(chip).toHaveAttribute('data-placement', 'below');
  const navChip = await chip.boundingBox();
  expect(navChip!.y).toBeCloseTo(nav.y + nav.h + 6, 1);

  // html/body and elements under 4×4 are ignored: no hover.
  const dot = await pageRect(page, '#dot');
  await page.mouse.move(center(dot).x, center(dot).y);
  await expect(chip).toHaveCount(0);
  await page.mouse.move(VIEWPORT.width - 4, VIEWPORT.height - 4);
  await expect(chip).toHaveCount(0);
  await expect(outline).toHaveCount(0);

  // The frozen backdrop never moved.
  expect(await backdropBox(page)).toEqual(before);
});

test('a click adds an element mark with the element rect, dashed border, selector chip and describeElement data', async ({ page }) => {
  await open(page);
  const before = await backdropBox(page);
  const scrollBefore = await page.evaluate(() => [window.scrollX, window.scrollY]);

  const book = await pageRect(page, 'button.book');
  await page.mouse.move(center(book).x, center(book).y);
  await page.mouse.click(center(book).x, center(book).y);

  await page.waitForFunction(() => ((window as unknown as { __marks?: unknown[] }).__marks ?? []).length === 1);
  const mark = await page.evaluate(() => (window as unknown as { __marks: any[] }).__marks[0]);
  expect(mark.kind).toBe('element');
  expect(mark.n).toBe(1);
  expect(mark.color).toBe('#a83818');
  expect({ x: mark.x, y: mark.y, w: mark.w, h: mark.h }).toEqual(book);
  expect(mark.selector).toBe('button.btn.book');
  expect(mark.element).toMatchObject({
    selector: 'button.btn.book',
    label: 'button.btn',
    tag: 'button',
    classes: ['btn', 'book'],
    text: 'Book',
    xpath: '/html/body/main/div/button[2]',
  });

  // The stored selector matches exactly one live element — the one clicked.
  const match = await page.evaluate((sel) => {
    const all = document.querySelectorAll(sel);
    return { count: all.length, same: all[0] === document.querySelector('button.book') };
  }, mark.selector as string);
  expect(match).toEqual({ count: 1, same: true });

  // Rendered mark: dashed border on the element rect + selector chip.
  const widget = page.locator('#feedback-widget-host');
  const box = widget.locator('[data-mark-kind="element"]');
  await expect(box).toHaveCount(1);
  const bs = await box.evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { style: getComputedStyle(el).borderTopStyle, rect: { x: b.left, y: b.top, w: b.width, h: b.height } };
  });
  expect(bs.style).toBe('dashed');
  expect(bs.rect).toEqual(book);
  await expect(widget.locator('.fw-mk-sel')).toHaveText('button.btn.book');
  await expect(widget.locator('[data-badge-for]')).toHaveText('1');

  // The frozen backdrop stays in place and the live page never scrolled.
  expect(await backdropBox(page)).toEqual(before);
  expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual(scrollBefore);
});
