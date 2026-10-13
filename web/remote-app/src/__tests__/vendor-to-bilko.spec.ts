// @vitest-environment node
// This project has no @types/node, so the node built-in imports below are untyped.
import { describe, it, expect, afterEach } from 'vitest';
// @ts-ignore no @types/node
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
// @ts-ignore no @types/node
import { tmpdir } from 'node:os';
// @ts-ignore no @types/node
import { join } from 'node:path';
// @ts-expect-error plain .mjs script without type declarations
import { vendorBundle } from '../../scripts/vendor-to-bilko.mjs';

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'vendor-spec-'));
  dirs.push(d);
  return d;
}
async function makeDist(root: string, withIndex = true): Promise<string> {
  const dist = join(root, 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  if (withIndex) await writeFile(join(dist, 'index.html'), '<html></html>');
  await writeFile(join(dist, 'manifest.json'), '{}');
  await writeFile(join(dist, 'assets', 'index-new.js'), 'new');
  return dist;
}
const has = (p: string) => stat(p).then(() => true, () => false);

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('vendorBundle', () => {
  it('copies dist and removes stale assets', async () => {
    const root = await tmp();
    const dist = await makeDist(root);
    const target = join(root, 'target');
    await mkdir(join(target, 'assets'), { recursive: true });
    await writeFile(join(target, 'assets', 'index-old.js'), 'old');
    const res = await vendorBundle({ distDir: dist, targetDir: target });
    expect(res).toEqual({ copied: 3 });
    expect(await has(join(target, 'assets', 'index-old.js'))).toBe(false);
    expect(await readFile(join(target, 'assets', 'index-new.js'), 'utf8')).toBe('new');
    expect(await has(join(target, 'index.html'))).toBe(true);
  });

  it('throws on missing index.html and leaves target untouched', async () => {
    const root = await tmp();
    const dist = await makeDist(root, false);
    const target = join(root, 'target');
    await mkdir(join(target, 'assets'), { recursive: true });
    await writeFile(join(target, 'assets', 'index-old.js'), 'old');
    await expect(vendorBundle({ distDir: dist, targetDir: target })).rejects.toThrow(/index\.html/);
    expect(await has(join(target, 'assets', 'index-old.js'))).toBe(true);
  });

  it('throws when the target parent does not exist', async () => {
    const root = await tmp();
    const dist = await makeDist(root);
    await expect(
      vendorBundle({ distDir: dist, targetDir: join(root, 'nope', 'target') }),
    ).rejects.toThrow(/parent/);
  });
});
