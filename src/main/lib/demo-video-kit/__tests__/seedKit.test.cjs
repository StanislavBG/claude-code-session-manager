/**
 * seedKit.test.cjs — kit seeder: fresh copy, no-op on same stamp, overwrite on new stamp.
 * Run: timeout 120 npx vitest run src/main/lib/demo-video-kit/__tests__/seedKit.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { seedDemoVideoKit, KIT_FILES, KIT_VERSION, KIT_DIGEST, kitDigest, kitDestDir, kitFiles } = require('../seedKit.cjs');

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

test('fresh install copies all kit files and the stamp', async () => {
  const { srcDir, destDir } = setup();
  const r = await seedDemoVideoKit({ logger: quiet, srcDir, destDir, kitVersion: '1' });
  expect(r).toEqual({ seeded: true, reason: 'fresh' });
  expect(KIT_FILES).toEqual(['checks.cjs', 'sound.cjs', 'capture.cjs', 'frames.cjs', 'character.cjs', 'playwrightLoader.cjs', 'export.cjs', 'kind-tiktok.md', 'kind-marketing.md', 'cast.md', 'project-home-html.md', 'resumableRun.cjs', 'voiceLibrary.cjs', 'voiceLane.cjs', 'kokoroSay.cjs', 'projectSounds.cjs', 'standalone.cjs']);
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

test('a fresh install copies the kind playbooks with the modules', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-seedkit-md-'));
  tmp.push(root);
  const destDir = path.join(root, 'kit');
  await seedDemoVideoKit({ logger: quiet, destDir });
  expect(fs.readFileSync(path.join(destDir, 'kind-tiktok.md'))).toEqual(fs.readFileSync(path.join(__dirname, '..', 'kind-tiktok.md')));
  expect(fs.readFileSync(path.join(destDir, 'kind-marketing.md'))).toEqual(fs.readFileSync(path.join(__dirname, '..', 'kind-marketing.md')));
});

test('kitDestDir follows SM_SCHEDULER_HOME when set', () => {
  const prev = process.env.SM_SCHEDULER_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-seedkit-home-'));
  tmp.push(home);
  process.env.SM_SCHEDULER_HOME = home;
  try {
    expect(kitDestDir()).toBe(path.join(home, 'demo-video-kit'));
  } finally {
    if (prev === undefined) delete process.env.SM_SCHEDULER_HOME; else process.env.SM_SCHEDULER_HOME = prev;
  }
});

test('KIT_VERSION is bumped to 47 (resumableRun.cjs exposes supervisorExited so callers await a reaped supervisor)', () => {
  expect(KIT_VERSION).toBe('47');
});

test('the playbook path both personas name is where the kit installs it by default', () => {
  const POINTER = '~/.claude/session-manager/demo-video-kit/project-home-html.md';
  const agentsDir = path.join(__dirname, '..', '..', '..', '..', 'seed', 'agents');
  expect(fs.readFileSync(path.join(agentsDir, 'demo-video-builder.md'), 'utf8')).toContain(POINTER);
  expect(fs.readFileSync(path.join(agentsDir, 'project-home-builder.md'), 'utf8')).toContain(POINTER);
  expect(kitFiles()).toContain('project-home-html.md');
  // Default destination: SM_SCHEDULER_HOME unset. HOME points at a temp dir so the
  // live-root guard (schedulerPaths.cjs) allows the resolve under vitest.
  const prevSched = process.env.SM_SCHEDULER_HOME;
  const prevHome = process.env.HOME;
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-seedkit-defhome-'));
  tmp.push(fakeHome);
  delete process.env.SM_SCHEDULER_HOME;
  process.env.HOME = fakeHome;
  try {
    expect(os.homedir()).toBe(fakeHome);
    const dest = kitDestDir();
    expect(path.join(dest, 'project-home-html.md')).toBe(path.join(os.homedir(), POINTER.slice(2)));
  } finally {
    if (prevSched === undefined) delete process.env.SM_SCHEDULER_HOME; else process.env.SM_SCHEDULER_HOME = prevSched;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  }
});

test('KIT_DIGEST matches the shipped kit files (a kit file changed without a version bump?)', () => {
  const actual = kitDigest(path.join(__dirname, '..'));
  expect(
    actual,
    `A demo-video kit file changed but KIT_DIGEST did not. Bump KIT_VERSION in seedKit.cjs (so installed kits are refreshed) and update KIT_DIGEST to '${actual}'.`,
  ).toBe(KIT_DIGEST);
});

test('kitDigest is sha256 over sorted relative path + NUL + bytes, and changes when a file changes', () => {
  const crypto = require('node:crypto');
  const { srcDir } = setup();
  const h = crypto.createHash('sha256');
  for (const f of [...KIT_FILES].sort()) {
    h.update(f); h.update(Buffer.from([0])); h.update(fs.readFileSync(path.join(srcDir, f)));
  }
  const expected = h.digest('hex');
  expect(kitDigest(srcDir)).toBe(expected);
  fs.writeFileSync(path.join(srcDir, 'checks.cjs'), '// changed\n');
  expect(kitDigest(srcDir)).not.toBe(expected);
});

test('a stamp-2 install with a stale checks.cjs is refreshed to the real source and stamped 5', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-seedkit-v2-'));
  tmp.push(root);
  const destDir = path.join(root, 'kit');
  fs.mkdirSync(destDir, { recursive: true });
  const srcDir = path.join(__dirname, '..');
  for (const f of KIT_FILES) fs.copyFileSync(path.join(srcDir, f), path.join(destDir, f));
  fs.writeFileSync(path.join(destDir, 'checks.cjs'), '// stale v2 checks without own-playback-controls\n');
  fs.writeFileSync(path.join(destDir, 'KIT_VERSION'), '2\n');
  const r = await seedDemoVideoKit({ logger: quiet, destDir });
  expect(r).toEqual({ seeded: true, reason: 'updated' });
  expect(fs.readFileSync(path.join(destDir, 'checks.cjs'))).toEqual(fs.readFileSync(path.join(srcDir, 'checks.cjs')));
  expect(fs.readFileSync(path.join(destDir, 'KIT_VERSION'), 'utf8').trim()).toBe(KIT_VERSION);
});

test('every seeded kit module loads standalone from a copied kit folder (playbooks are markdown, not required)', async () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-seedkit-real-'));
  tmp.push(root);
  const destDir = path.join(root, 'kit');
  const r = await seedDemoVideoKit({ logger: quiet, destDir });
  expect(r.seeded).toBe(true);
  const failures = [];
  for (const f of KIT_FILES.filter((k) => k.endsWith('.cjs'))) {
    const file = path.join(destDir, f);
    const out = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(file)})`], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 30000 });
    if (out.status !== 0) failures.push(`${f}: exit ${out.status}\n${(out.stderr || '').split('\n').slice(0, 6).join('\n')}`);
  }
  expect(failures).toEqual([]);
});
