// Builds web/feedback-widget and copies its output into dist/widget/v1/, so the published
// session-manager bundle serves /projects/session-manager/widget/v1/feedback.js (+ fonts/ and
// a demo/ page for live checks). Runs after `vite build` (which empties dist/) and before
// emit-manifest.mjs, which lists these files via widgetManifestEntries(). Node built-ins only.
import { cp, stat, mkdir, rm } from 'node:fs/promises';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const WIDGET_DIR = 'widget/v1';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_WIDGET = join(root, '..', 'feedback-widget');
const DEFAULT_DIST = join(root, 'dist');

/** Runs the widget's own build; throws (failing the remote-app build) when it fails. */
export function buildWidget({ widgetDir = DEFAULT_WIDGET, cmd = 'npm', args } = {}) {
  const argv = args ?? ['--prefix', widgetDir, 'run', 'build'];
  const res = spawnSync(cmd, argv, { stdio: 'inherit', shell: false });
  if (res.error || res.status !== 0) {
    const why = res.error ? res.error.message : `exit ${res.status ?? res.signal}`;
    throw new Error(`copy-widget: widget build failed (${cmd} ${argv.join(' ')}): ${why}`);
  }
}

async function requirePath(p, what) {
  try {
    return await stat(p);
  } catch {
    throw new Error(`copy-widget: missing ${what} at ${p} — did the widget build run?`);
  }
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Widget files under dist/widget/v1/ as `{ path, sizeBytes }`, path relative to dist, sorted. */
export function widgetManifestEntries(distDir = DEFAULT_DIST) {
  const dir = join(distDir, ...WIDGET_DIR.split('/'));
  if (!existsSync(dir)) return [];
  return walk(dir)
    .map((f) => ({ path: relative(distDir, f).split(sep).join('/'), sizeBytes: statSync(f).size }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Copies a built widget (dist/feedback.js, dist/fonts/, demo/index.html) into dist/widget/v1/. */
export async function copyWidget({ widgetDir = DEFAULT_WIDGET, distDir = DEFAULT_DIST } = {}) {
  const js = join(widgetDir, 'dist', 'feedback.js');
  const fonts = join(widgetDir, 'dist', 'fonts');
  const demo = join(widgetDir, 'demo', 'index.html');
  await requirePath(js, 'widget feedback.js');
  if (!(await requirePath(fonts, 'widget fonts/')).isDirectory()) {
    throw new Error(`copy-widget: widget fonts/ at ${fonts} is not a directory`);
  }
  if (readdirSync(fonts).length === 0) throw new Error(`copy-widget: widget fonts/ at ${fonts} is empty`);
  await requirePath(demo, 'widget demo page');

  const out = join(distDir, ...WIDGET_DIR.split('/'));
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, 'demo'), { recursive: true });
  await cp(js, join(out, 'feedback.js'));
  await cp(fonts, join(out, 'fonts'), { recursive: true });
  await cp(demo, join(out, 'demo', 'index.html'));
  return widgetManifestEntries(distDir);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    buildWidget();
    const files = await copyWidget();
    const total = files.reduce((n, f) => n + f.sizeBytes, 0);
    console.log(`copy-widget: ${files.length} files (${(total / 1024).toFixed(1)} KB) → dist/${WIDGET_DIR}/`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
