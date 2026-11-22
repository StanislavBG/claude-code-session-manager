/**
 * configInstructionWrite.test.cjs — the renderer's config:write-text may save
 * instruction files (any CLAUDE.md / CLAUDE.local.md in the read boundary, plus
 * files main proves are @-imported by a named CLAUDE.md), while main's own
 * writers (writeTextAtomic & co.) keep the strict validateWrite boundary.
 *
 * Runs against a throwaway HOME set before config.cjs loads, because config.cjs
 * snapshots os.homedir() into its allowed roots at require time.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/configInstructionWrite.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-instr-home-')));
const prevHome = process.env.HOME;
process.env.HOME = HOME;
const config = require('../config.cjs');

const ROOT = path.join(HOME, 'Projects', 'demo');
const USER_CLAUDE = path.join(HOME, '.claude', 'CLAUDE.md');
const CORE = path.join(HOME, 'Projects', 'Agents', 'shared', 'core.md');

function put(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

beforeAll(() => {
  put(path.join(ROOT, 'CLAUDE.md'), '# demo\n');
  put(path.join(ROOT, 'package.json'), '{}\n');
  put(CORE, '# core\n');
  put(path.join(HOME, '.ssh', 'config'), 'Host x\n');
  put(path.join(HOME, 'real', 'target.md'), '# target\n');
  fs.symlinkSync(path.join(HOME, 'real', 'target.md'), path.join(HOME, 'linked.md'));
  // Blank lines between imports: personaImportHealth's marked lexer pairs two
  // '~' on adjacent lines into a strikethrough and drops both imports.
  put(USER_CLAUDE, '@~/Projects/Agents/shared/core.md\n\n@~/.ssh/config\n\n@~/linked.md\n');
  config.addAllowedRoot(ROOT);
});

afterAll(() => {
  process.env.HOME = prevHome;
  fs.rmSync(HOME, { recursive: true, force: true });
});

const write = (p, importedBy) => config.writeRendererText(p, 'edited\n', { importedBy });

test('a registered root CLAUDE.md, CLAUDE.local.md and src/CLAUDE.md are writable', async () => {
  for (const rel of ['CLAUDE.md', 'CLAUDE.local.md', path.join('src', 'CLAUDE.md')]) {
    const p = path.join(ROOT, rel);
    expect(config.checkInstructionWrite(p, {})).toEqual({ ok: true });
    const r = await write(p);
    expect(r.ok).toBe(true);
    expect(typeof r.mtimeMs).toBe('number');
    expect(fs.readFileSync(p, 'utf8')).toBe('edited\n');
    expect(await config.canWrite(p)).toEqual({ ok: true });
  }
});

test('an import is writable only with an importedBy that imports it', async () => {
  expect(config.checkInstructionWrite(CORE, {})).toEqual({ ok: false, reason: 'not-imported' });
  await expect(write(CORE)).rejects.toThrow(/Write outside allowed write boundaries/);
  await expect(write(CORE, path.join(ROOT, 'CLAUDE.md'))).rejects.toThrow(/Write outside allowed write boundaries/);
  expect(await config.canWrite(CORE, { importedBy: path.join(ROOT, 'CLAUDE.md') }))
    .toEqual({ ok: false, reason: 'not-imported' });
  expect(await config.canWrite(CORE, { importedBy: USER_CLAUDE })).toEqual({ ok: true });
  const r = await write(CORE, USER_CLAUDE);
  expect(r.ok).toBe(true);
  expect(fs.readFileSync(CORE, 'utf8')).toBe('edited\n');
});

test('an importedBy that is not an instruction file is ignored', () => {
  put(path.join(HOME, '.claude', 'notes.md'), '@~/Projects/Agents/shared/core.md\n');
  expect(config.checkInstructionWrite(CORE, { importedBy: path.join(HOME, '.claude', 'notes.md') }))
    .toEqual({ ok: false, reason: 'not-imported' });
});

test('an import of ~/.ssh/config is refused as sensitive', async () => {
  const ssh = path.join(HOME, '.ssh', 'config');
  expect(config.checkInstructionWrite(ssh, { importedBy: USER_CLAUDE })).toEqual({ ok: false, reason: 'sensitive' });
  expect(await config.canWrite(ssh, { importedBy: USER_CLAUDE })).toEqual({ ok: false, reason: 'sensitive' });
  await expect(write(ssh, USER_CLAUDE)).rejects.toThrow(/Write outside allowed write boundaries/);
  expect(fs.readFileSync(ssh, 'utf8')).toBe('Host x\n');
});

test('~/.claude/.credentials.json stays refused', async () => {
  const cred = path.join(HOME, '.claude', '.credentials.json');
  await expect(write(cred, USER_CLAUDE)).rejects.toThrow();
  expect(await config.canWrite(cred)).toEqual({ ok: false, reason: 'sensitive' });
  expect(fs.existsSync(cred)).toBe(false);
});

test('an import reached through a symlink is matched by realpath', async () => {
  const real = path.join(HOME, 'real', 'target.md');
  expect(config.checkInstructionWrite(real, { importedBy: USER_CLAUDE })).toEqual({ ok: true });
  const r = await write(path.join(HOME, 'linked.md'), USER_CLAUDE);
  expect(r.ok).toBe(true);
  expect(fs.readFileSync(real, 'utf8')).toBe('edited\n');
});

test('<root>/package.json stays refused', async () => {
  const pkg = path.join(ROOT, 'package.json');
  await expect(write(pkg, path.join(ROOT, 'CLAUDE.md'))).rejects.toThrow(/Write outside allowed write boundaries/);
  expect((await config.canWrite(pkg)).ok).toBe(false);
  expect(fs.readFileSync(pkg, 'utf8')).toBe('{}\n');
});

test('a CLAUDE.md inside session-manager-operations/ is refused as ops-root', async () => {
  const p = path.join(ROOT, 'session-manager-operations', 'architecture', 'CLAUDE.md');
  expect(config.checkInstructionWrite(p, {})).toEqual({ ok: false, reason: 'ops-root' });
  await expect(write(p)).rejects.toThrow(/Write outside allowed write boundaries/);
});

test('a path outside the read boundary gives outside-boundary', async () => {
  expect(await config.canWrite('/etc/CLAUDE.md')).toEqual({ ok: false, reason: 'outside-boundary' });
  await expect(write('/etc/CLAUDE.md')).rejects.toThrow();
});

test('main writers keep the strict boundary: writeTextAtomic(<root>/CLAUDE.md) throws', async () => {
  await expect(config.writeTextAtomic(path.join(ROOT, 'CLAUDE.md'), 'x'))
    .rejects.toThrow(/Write outside allowed write boundaries/);
  expect(() => config.validateWrite(path.join(ROOT, 'CLAUDE.md'))).toThrow();
});

test('~/.claude files still pass through the unchanged validateWrite path', async () => {
  const p = path.join(HOME, '.claude', 'settings.json');
  expect(await config.canWrite(p)).toEqual({ ok: true });
  expect((await write(p)).ok).toBe(true);
});
