// @vitest-environment node
// This project has no @types/node, so the node built-in imports below are untyped.
import { describe, it, expect, afterEach } from 'vitest';
// @ts-ignore no @types/node
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
// @ts-ignore no @types/node
import { tmpdir } from 'node:os';
// @ts-ignore no @types/node
import { join } from 'node:path';
// @ts-ignore no @types/node
import { execFileSync } from 'node:child_process';
// @ts-ignore no @types/node
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain .mjs script without type declarations
import { copyWidget, buildWidget, widgetManifestEntries, WIDGET_DIR } from '../../scripts/copy-widget.mjs';

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'copy-widget-spec-'));
  dirs.push(d);
  return d;
}
const has = (p: string) => stat(p).then(() => true, () => false);

/** A fake widget package: dist/feedback.js + dist/fonts/*.woff2 + demo/index.html. */
async function makeWidget(root: string): Promise<string> {
  const widget = join(root, 'feedback-widget');
  await mkdir(join(widget, 'dist', 'fonts'), { recursive: true });
  await mkdir(join(widget, 'demo'), { recursive: true });
  await writeFile(join(widget, 'dist', 'feedback.js'), '(function(){/*widget*/})();');
  await writeFile(join(widget, 'dist', 'fonts', 'a.woff2'), 'AAAA');
  await writeFile(join(widget, 'dist', 'fonts', 'b.woff2'), 'BBBBBBBB');
  await writeFile(join(widget, 'demo', 'index.html'), '<html>demo</html>');
  return widget;
}
async function makeDist(root: string): Promise<string> {
  const dist = join(root, 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<html>Session Manager</html>');
  await writeFile(join(dist, 'assets', 'index-x.js'), 'app');
  return dist;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('copyWidget', () => {
  it('copies feedback.js, fonts and the demo page into dist/widget/v1/', async () => {
    const root = await tmp();
    const widget = await makeWidget(root);
    const dist = await makeDist(root);
    const files = await copyWidget({ widgetDir: widget, distDir: dist });
    expect(WIDGET_DIR).toBe('widget/v1');
    const out = join(dist, 'widget', 'v1');
    expect(await readFile(join(out, 'feedback.js'), 'utf8')).toBe('(function(){/*widget*/})();');
    expect(await readFile(join(out, 'fonts', 'a.woff2'), 'utf8')).toBe('AAAA');
    expect(await readFile(join(out, 'fonts', 'b.woff2'), 'utf8')).toBe('BBBBBBBB');
    expect(await readFile(join(out, 'demo', 'index.html'), 'utf8')).toBe('<html>demo</html>');
    expect(files.map((f: { path: string }) => f.path).sort()).toEqual([
      'widget/v1/demo/index.html',
      'widget/v1/feedback.js',
      'widget/v1/fonts/a.woff2',
      'widget/v1/fonts/b.woff2',
    ]);
  });

  it('fails when the widget build output is missing', async () => {
    const root = await tmp();
    const widget = join(root, 'feedback-widget');
    await mkdir(join(widget, 'demo'), { recursive: true });
    await writeFile(join(widget, 'demo', 'index.html'), 'x');
    const dist = await makeDist(root);
    await expect(copyWidget({ widgetDir: widget, distDir: dist })).rejects.toThrow(/feedback\.js/);
  });

  it('fails when the widget has no fonts', async () => {
    const root = await tmp();
    const widget = await makeWidget(root);
    await rm(join(widget, 'dist', 'fonts'), { recursive: true });
    const dist = await makeDist(root);
    await expect(copyWidget({ widgetDir: widget, distDir: dist })).rejects.toThrow(/fonts/);
  });

  it('throws when the widget build command fails', () => {
    expect(() => buildWidget({ widgetDir: '/nonexistent-widget-dir', cmd: 'false', args: [] })).toThrow(
      /widget build failed/,
    );
  });

  it('lists the widget files with sizes, and emit-manifest puts them in manifest.json', async () => {
    const root = await tmp();
    const widget = await makeWidget(root);
    const dist = await makeDist(root);
    await copyWidget({ widgetDir: widget, distDir: dist });
    const entries = widgetManifestEntries(dist);
    expect(entries).toEqual([
      { path: 'widget/v1/demo/index.html', sizeBytes: 17 },
      { path: 'widget/v1/feedback.js', sizeBytes: 27 },
      { path: 'widget/v1/fonts/a.woff2', sizeBytes: 4 },
      { path: 'widget/v1/fonts/b.woff2', sizeBytes: 8 },
    ]);

    const script = fileURLToPath(new URL('../../scripts/emit-manifest.mjs', import.meta.url));
    execFileSync(process.execPath, [script, dist], { stdio: 'pipe' });
    const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
    expect(manifest.slug).toBe('session-manager');
    expect(manifest.widget).toEqual({ path: '/projects/session-manager/widget/v1/', files: entries });
    // index.html + assets/index-x.js + 4 widget files.
    expect(manifest.bundle.fileCount).toBe(6);
  });

  it('emits no widget section when the dist has no widget', async () => {
    const root = await tmp();
    const dist = await makeDist(root);
    expect(await has(join(dist, 'widget'))).toBe(false);
    expect(widgetManifestEntries(dist)).toEqual([]);
  });
});
