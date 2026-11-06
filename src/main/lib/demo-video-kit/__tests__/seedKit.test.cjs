/**
 * seedKit.test.cjs — kit seeder: fresh copy, no-op on same stamp, overwrite on new stamp.
 * Run: timeout 120 npx vitest run src/main/lib/demo-video-kit/__tests__/seedKit.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { seedDemoVideoKit, KIT_FILES } = require('../seedKit.cjs');

const tmp = [];
afterEach(() => {
  delete process.env.SM_SEED_DEMO_VIDEO_KIT_DISABLE;
  while (tmp.length) fs.rmSync(tmp.pop(), { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-seedkit-'));
  tmp.push(root);
  const srcDir = path.join(root, 'src');
  fs.mkdirSync(srcDir);
  for (const f of KIT_FILES) fs.writeFileSync(path.join(srcDir, f), `// ${f} v1\n`);
  return { srcDir, destDir: path.join(root, 'dest', 'kit') };
}
const quiet = { log() {}, warn() {} };

test('fresh install copies all five files and the stamp', async () => {
  const { srcDir, destDir } = setup();
  const r = await seedDemoVideoKit({ logger: quiet, srcDir, destDir, kitVersion: '1' });
  expect(r).toEqual({ seeded: true, reason: 'fresh' });
  expect(KIT_FILES).toEqual(['checks.cjs', 'sound.cjs', 'capture.cjs', 'frames.cjs', 'character.cjs']);
  for (const f of KIT_FILES) expect(fs.readFileSync(path.join(destDir, f), 'utf8')).toBe(`// ${f} v1\n`);
  expect(fs.readFileSync(path.join(destDir, 'KIT_VERSION'), 'utf8').trim()).toBe('1');
});

test('same stamp is a no-op (local edits survive)', async () => {
  const { srcDir, destDir } = setup();
  await seedDemoVideoKit({ logger: quiet, srcDir, destDir, kitVersion: '1' });
  fs.writeFileSync(path.join(destDir, 'checks.cjs'), '// touched\n');
  fs.writeFileSync(path.join(srcDir, 'checks.cjs'), '// changed upstream\n');
  const r = await seedDemoVideoKit({ logger: quiet, srcDir, destDir, kitVersion: '1' });
  expect(r).toEqual({ seeded: false, reason: 'current' });
  expect(fs.readFileSync(path.join(destDir, 'checks.cjs'), 'utf8')).toBe('// touched\n');
});

test('a new stamp overwrites the files and updates the stamp', async () => {
  const { srcDir, destDir } = setup();
  await seedDemoVideoKit({ logger: quiet, srcDir, destDir, kitVersion: '1' });
  fs.writeFileSync(path.join(srcDir, 'checks.cjs'), '// v2\n');
  const r = await seedDemoVideoKit({ logger: quiet, srcDir, destDir, kitVersion: '2' });
  expect(r).toEqual({ seeded: true, reason: 'updated' });
  expect(fs.readFileSync(path.join(destDir, 'checks.cjs'), 'utf8')).toBe('// v2\n');
  expect(fs.readFileSync(path.join(destDir, 'KIT_VERSION'), 'utf8').trim()).toBe('2');
});

test('the kill-switch skips seeding', async () => {
  const { srcDir, destDir } = setup();
  process.env.SM_SEED_DEMO_VIDEO_KIT_DISABLE = '1';
  const r = await seedDemoVideoKit({ logger: quiet, srcDir, destDir, kitVersion: '1' });
  expect(r.seeded).toBe(false);
  expect(fs.existsSync(destDir)).toBe(false);
});

test('the real kit files exist beside the seeder', () => {
  for (const f of KIT_FILES) expect(fs.existsSync(path.join(__dirname, '..', f))).toBe(true);
});
