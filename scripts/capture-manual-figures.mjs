#!/usr/bin/env node
/**
 * capture-manual-figures.mjs — turns the Field Manual's declared figure slots
 * (session-manager-operations/manual/chapters/*.html) into real, annotated
 * screenshots of the running app.
 *
 * For each <figure data-figure="X"><div class="manual-figure__frame"
 * data-capture="..."></div> ... <span class="callout" data-arrow="...">N</span>
 * ... </figure>, this script:
 *
 *   1. Refuses to run if Session Manager is already open, or if any scheduler
 *      job is live — a second Electron instance rewrites
 *      ~/.claude/session-manager/admin-api.json out from under the running app
 *      and its boot reconciliation SIGTERMs running jobs.
 *   2. Launches the real app under Playwright's Electron driver (same pattern
 *      as tests/e2e/_helpers/launchApp.ts / npm run test:e2e — run this under
 *      `xvfb-run` on Linux).
 *   3. Navigates to the figure's declared surface (figure-captures.json),
 *      resolves each callout's DOM selector to a live bounding box, and
 *      composites numbered arrow callouts onto a real screenshot with sharp.
 *   4. Writes session-manager-operations/manual/figures/<data-figure>.png and
 *      rewrites the chapter's <div class="manual-figure__frame"> into
 *      <img src="figures/<id>.png">.
 *
 * A figure that can't be reached (missing recipe, selector never appears,
 * nav fails) FAILS LOUDLY naming that figure and leaves its existing
 * placeholder/image untouched — this script never emits a blank, cropped, or
 * synthesized image. See memory "no-second-electron-while-jobs-run".
 *
 * Usage: npm run manual:figures   (wired to `xvfb-run -a node <this file>`)
 */

import { _electron as electron } from '@playwright/test';
import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const MANUAL_DIR = join(ROOT, 'session-manager-operations', 'manual');
const CHAPTERS_DIR = join(MANUAL_DIR, 'chapters');
const FIGURES_DIR = join(MANUAL_DIR, 'figures');
const RECIPES_PATH = join(MANUAL_DIR, 'figure-captures.json');

function escapeHtmlAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeHtmlAttr(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

class FigureCaptureError extends Error {
  constructor(figureId, reason) {
    super(`figure "${figureId}": ${reason}`);
    this.figureId = figureId;
  }
}

// ── 1. Guard: refuse to run alongside an existing app instance ───────────────

/**
 * Is a Session Manager Electron instance already up?
 *
 * Probes the admin API named in ~/.claude/session-manager/admin-api.json. That
 * file IS the resource a second instance clobbers, so asking whether something
 * is still answering on its port is the most direct possible signal — more
 * reliable than scanning `ps` output for an electron binary path that varies
 * between npx, a global install, and a dev checkout.
 *
 * A stale file whose port no longer answers means the app is gone; the connect
 * attempt fails fast and we proceed.
 */
async function appInstanceIsLive() {
  const adminPath = join(homedir(), '.claude', 'session-manager', 'admin-api.json');
  if (!existsSync(adminPath)) return false;

  let port;
  try {
    port = JSON.parse(readFileSync(adminPath, 'utf-8')).port;
  } catch {
    return false; // unreadable/corrupt — treat as no live instance
  }
  if (!Number.isInteger(port)) return false;

  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (live) => {
      socket.destroy();
      resolve(live);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function assertSafeToLaunch() {
  // (a) A second instance's boot reconciliation SIGTERMs running jobs.
  const { readMergedSync } = require(join(ROOT, 'src', 'main', 'lib', 'queueStore.cjs'));
  const merged = readMergedSync();
  const live = merged.jobs.filter((j) => j.status === 'running');
  if (live.length > 0) {
    console.error(
      `✗ refusing to launch a second Electron instance: ${live.length} scheduler job(s) ` +
        `still running (${live.map((j) => j.slug).join(', ')}). A second instance's boot ` +
        `reconciliation SIGTERMs live jobs and clobbers admin-api.json. Wait for the queue ` +
        `to go idle and re-run.`
    );
    process.exit(1);
  }

  // (b) An idle queue is NOT sufficient. If the app is open at all, launching a
  // second instance rewrites admin-api.json out from under it — breaking the
  // scheduler MCP tools of whatever session is using it — and any QUEUED job
  // the live instance picks up mid-capture becomes a running job we already
  // decided we must not kill. Checking only for `running` missed this entirely.
  if (await appInstanceIsLive()) {
    const queued = merged.jobs.filter((j) => j.status === 'queued');
    console.error(
      `✗ refusing to launch a second Electron instance: Session Manager is already ` +
        `running (its admin API is answering on 127.0.0.1). A second instance rewrites ` +
        `~/.claude/session-manager/admin-api.json, which breaks the running app's own ` +
        `scheduler tooling.` +
        (queued.length
          ? ` It also has ${queued.length} queued job(s) (${queued.map((j) => j.slug).join(', ')}) ` +
            `it may start at any moment.`
          : '') +
        ` Quit the app and re-run.`
    );
    process.exit(1);
  }
}

// ── 2. Parse chapters for figures ─────────────────────────────────────────────

// The 'd' flag (match indices) lets us splice replacements by absolute byte
// offset instead of a global string search-and-replace, so two figures that
// happen to share identical frame-div text (e.g. both mid-authoring with an
// empty data-capture) can never have their replacements swapped.
const DIV_RE = /<div class="manual-figure__frame" data-capture="([^"]*)"[^>]*><\/div>/d;
const IMG_RE = /<img[^>]*\bdata-capture="([^"]*)"[^>]*>/d;
const FIGURE_RE = /<figure class="manual-figure" data-figure="([^"]+)">([\s\S]*?)<\/figure>/gd;
const CALLOUT_RE = /<span class="callout" data-arrow="(left|right|up|down)">(\d+)<\/span>/g;

function parseChapterFigures(html) {
  const figures = [];
  let m;
  FIGURE_RE.lastIndex = 0;
  while ((m = FIGURE_RE.exec(html))) {
    const [fullMatch, figureId, inner] = m;
    const innerStart = m.indices[2][0];
    const divMatch = DIV_RE.exec(inner);
    const frameMatch = divMatch || IMG_RE.exec(inner);
    if (!frameMatch) {
      throw new FigureCaptureError(figureId, 'no manual-figure__frame div or captured <img> found inside <figure>');
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(figureId)) {
      throw new FigureCaptureError(figureId, `data-figure "${figureId}" must match [a-z0-9-]+`);
    }
    // The div form carries the author's raw text; the img form (a figure
    // already captured on a prior run) carries text this script itself
    // HTML-escaped last time — re-escaping it here would compound on every
    // re-run (&amp; -> &amp;amp; -> ...). Escape only text sourced from the div.
    const dataCapture = divMatch ? frameMatch[1] : unescapeHtmlAttr(frameMatch[1]);
    const [frameStartRel, frameEndRel] = frameMatch.indices[0];
    const callouts = [];
    let cm;
    CALLOUT_RE.lastIndex = 0;
    while ((cm = CALLOUT_RE.exec(inner))) {
      callouts.push({ arrow: cm[1], num: Number(cm[2]) });
    }
    figures.push({
      figureId,
      dataCapture,
      callouts,
      fullMatch,
      frameSnippet: frameMatch[0],
      frameStart: innerStart + frameStartRel,
      frameEnd: innerStart + frameEndRel,
    });
  }
  return figures;
}

function listChapterFiles() {
  return readdirSync(CHAPTERS_DIR)
    .filter((f) => f.endsWith('.html'))
    .map((f) => join(CHAPTERS_DIR, f));
}

// ── 3. Drive the real app ─────────────────────────────────────────────────────

async function launchApp() {
  const app = await electron.launch({
    args: ['--ozone-platform=x11', join(ROOT, 'src', 'main', 'index.cjs')],
    cwd: ROOT,
    env: {
      ...process.env,
      WAYLAND_DISPLAY: '',
      ELECTRON_OZONE_PLATFORM_HINT: 'x11',
      NODE_ENV: 'development',
      SM_E2E: '1',
      SM_SUPERVISOR_DISABLE: '1',
    },
  });
  const win = await app.firstWindow();
  await win.waitForSelector('text=Claude Session Manager', { timeout: 15_000 });
  await win.waitForTimeout(300);
  return { app, win };
}

async function navigateToTab(win, navKey) {
  await win.keyboard.press('Control+K');
  const palette = win.locator('[data-testid="command-palette"]');
  await palette.waitFor({ state: 'visible', timeout: 5_000 });
  const input = win.locator('[data-testid="command-palette"] input[role="combobox"]');
  const LABEL_OVERRIDES = { projects: 'file explorer' };
  await input.fill(`go to ${LABEL_OVERRIDES[navKey] ?? navKey.replace(/-/g, ' ')}`);
  await win.locator(`button[data-cmd-id="nav:${navKey}"]`).first().waitFor({ state: 'visible', timeout: 3_000 });
  await win.keyboard.press('Enter');
  await palette.waitFor({ state: 'hidden', timeout: 3_000 });
}

async function capturePagePng(app) {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const img = await w.webContents.capturePage();
    return img.toPNG().toString('base64');
  });
  return Buffer.from(b64, 'base64');
}

// ── 4. Annotate with numbered arrow callouts, resolved from live selectors ───

function calloutAnchor(box, arrow, imgW, imgH) {
  const pad = 40;
  const midX = box.x + box.width / 2;
  const midY = box.y + box.height / 2;
  let cx, cy, ex, ey;
  switch (arrow) {
    case 'left':
      cx = box.x - pad; cy = midY; ex = box.x; ey = midY; break;
    case 'right':
      cx = box.x + box.width + pad; cy = midY; ex = box.x + box.width; ey = midY; break;
    case 'up':
      cx = midX; cy = box.y - pad; ex = midX; ey = box.y; break;
    case 'down':
      cx = midX; cy = box.y + box.height + pad; ex = midX; ey = box.y + box.height; break;
    default:
      cx = midX; cy = midY; ex = midX; ey = midY;
  }
  cx = Math.max(22, Math.min(imgW - 22, cx));
  cy = Math.max(22, Math.min(imgH - 22, cy));
  return { cx, cy, ex, ey };
}

async function annotate(pngBuffer, resolvedCallouts) {
  const meta = await sharp(pngBuffer).metadata();
  const W = meta.width;
  const H = meta.height;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`,
    `<defs><marker id="sm-arrowhead" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">`,
    `<path d="M0,0 L8,3 L0,6 Z" fill="#5fdf9f"/></marker></defs>`,
  ];
  resolvedCallouts.forEach((c, i) => {
    const { cx, cy, ex, ey } = calloutAnchor(c.box, c.arrow, W, H);
    parts.push(
      `<line x1="${cx}" y1="${cy}" x2="${ex}" y2="${ey}" stroke="#5fdf9f" stroke-width="4" marker-end="url(#sm-arrowhead)"/>`
    );
    parts.push(`<circle cx="${cx}" cy="${cy}" r="17" fill="#5fdf9f" stroke="#0a0a0a" stroke-width="2.5"/>`);
    parts.push(
      `<text x="${cx}" y="${cy + 6}" font-family="system-ui,sans-serif" font-size="19" font-weight="700" ` +
        `text-anchor="middle" fill="#0a0a0a">${i + 1}</text>`
    );
  });
  parts.push('</svg>');
  const svg = Buffer.from(parts.join(''));
  return sharp(pngBuffer).composite([{ input: svg, top: 0, left: 0 }]).png().toBuffer();
}

function writeFileAtomic(path, buffer) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, buffer);
  renameSync(tmp, path);
}

// ── 5. Per-figure capture ─────────────────────────────────────────────────────

async function captureOneFigure(app, win, figure, recipe) {
  const { figureId } = figure;
  if (figure.callouts.length !== recipe.callouts.length) {
    throw new FigureCaptureError(
      figureId,
      `HTML declares ${figure.callouts.length} callout(s) but the recipe declares ${recipe.callouts.length}`
    );
  }

  if (recipe.navKey) {
    try {
      await navigateToTab(win, recipe.navKey);
    } catch (e) {
      throw new FigureCaptureError(figureId, `could not navigate to "${recipe.navKey}": ${e.message}`);
    }
  }

  for (const step of recipe.steps ?? []) {
    if (step.action !== 'click') throw new FigureCaptureError(figureId, `unknown recipe step action "${step.action}"`);
    const loc = win.locator(step.selector).first();
    try {
      await loc.waitFor({ state: 'visible', timeout: 8_000 });
      await loc.click();
    } catch (e) {
      throw new FigureCaptureError(figureId, `setup step click on "${step.selector}" failed: ${e.message}`);
    }
  }

  try {
    await win.locator(recipe.waitForSelector).first().waitFor({ state: 'visible', timeout: 8_000 });
  } catch (e) {
    throw new FigureCaptureError(figureId, `target surface never appeared ("${recipe.waitForSelector}"): ${e.message}`);
  }
  await win.waitForTimeout(400);

  const resolvedCallouts = [];
  for (let i = 0; i < recipe.callouts.length; i++) {
    const c = recipe.callouts[i];
    const loc = win.locator(c.selector).first();
    let box = null;
    try {
      await loc.waitFor({ state: 'visible', timeout: 5_000 });
      box = await loc.boundingBox();
    } catch {
      // fall through — box stays null, handled below
    }
    if (!box) {
      throw new FigureCaptureError(
        figureId,
        `callout ${i + 1} selector "${c.selector}" is not visible on screen — refusing to fabricate a placement`
      );
    }
    resolvedCallouts.push({ arrow: c.arrow, box });
  }

  const rawPng = await capturePagePng(app);
  const composited = await annotate(rawPng, resolvedCallouts);

  mkdirSync(FIGURES_DIR, { recursive: true });
  const outPath = join(FIGURES_DIR, `${figureId}.png`);
  writeFileAtomic(outPath, composited);
  return outPath;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  await assertSafeToLaunch();

  if (!existsSync(RECIPES_PATH)) {
    console.error(`✗ no capture recipes at ${RECIPES_PATH}`);
    process.exit(1);
  }
  const recipes = JSON.parse(readFileSync(RECIPES_PATH, 'utf-8'));

  const chapterFiles = listChapterFiles();
  const chapterFigures = new Map(); // chapterPath -> { html, figures }
  for (const file of chapterFiles) {
    const html = readFileSync(file, 'utf-8');
    chapterFigures.set(file, { html, figures: parseChapterFigures(html) });
  }

  const totalFigures = [...chapterFigures.values()].reduce((n, c) => n + c.figures.length, 0);
  console.log(`found ${totalFigures} figure(s) across ${chapterFiles.length} chapter(s)`);

  const { app, win } = await launchApp();
  const failures = [];

  try {
    for (const [file, entry] of chapterFigures) {
      const html = entry.html;
      // Splices are applied by absolute offset (never a global string
      // search-and-replace) so two figures with identical frame-div text
      // can't have their replacements swapped; collected here and applied
      // last-to-first so each figure's offset stays valid against `html`.
      const splices = [];
      for (const figure of entry.figures) {
        const recipe = recipes[figure.figureId];
        if (!recipe) {
          failures.push(new FigureCaptureError(figure.figureId, 'no capture recipe declared in figure-captures.json'));
          continue;
        }
        try {
          const outPath = await captureOneFigure(app, win, figure, recipe);
          const relPath = `figures/${figure.figureId}.png`;
          const escapedCapture = escapeHtmlAttr(figure.dataCapture);
          const img = `<img src="${relPath}" data-capture="${escapedCapture}" alt="${escapedCapture}">`;
          splices.push({ start: figure.frameStart, end: figure.frameEnd, img });
          console.log(`✓ ${figure.figureId} → ${outPath}`);
        } catch (e) {
          failures.push(e instanceof FigureCaptureError ? e : new FigureCaptureError(figure.figureId, e.message));
        }
      }
      if (splices.length > 0) {
        let next = html;
        for (const s of [...splices].sort((a, b) => b.start - a.start)) {
          next = next.slice(0, s.start) + s.img + next.slice(s.end);
        }
        writeFileAtomic(file, Buffer.from(next, 'utf-8'));
      }
    }
  } finally {
    await app.close();
  }

  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} figure(s) failed to capture:`);
    for (const f of failures) console.error(`  - ${f.message}`);
    console.error('\nExisting placeholders/images for failed figures were left untouched.');
    process.exit(1);
  }

  console.log(`\n✓ captured ${totalFigures} figure(s)`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
  });
}

export { parseChapterFigures, listChapterFiles, annotate, calloutAnchor, FigureCaptureError };
