'use strict';
import { test, expect, beforeEach, afterEach, describe } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const mod = require('../claudeJsonApproval.cjs');

let dir;
let cfg;
const PARENT = '/proj/parent';
const CHILD = '/proj/wt/child';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-'));
  cfg = path.join(dir, '.claude.json');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function write(obj) { fs.writeFileSync(cfg, JSON.stringify(obj, null, 2)); }
function read() { return JSON.parse(fs.readFileSync(cfg, 'utf8')); }
function noLeftovers() {
  expect(fs.readdirSync(dir).filter((n) => n !== '.claude.json')).toEqual([]);
}
const approved = { hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true, hasTrustDialogAccepted: true };

test('claudeJsonPath honors CLAUDE_CONFIG_DIR', () => {
  expect(mod.claudeJsonPath({ CLAUDE_CONFIG_DIR: '/x' })).toBe(path.join('/x', '.claude.json'));
  expect(mod.claudeJsonPath({})).toBe(path.join(os.homedir(), '.claude.json'));
});

test('applyApproval returns same ref when nothing to do', () => {
  const c = { projects: { [PARENT]: { hasClaudeMdExternalIncludesApproved: false } } };
  expect(mod.applyApproval(c, PARENT, CHILD)).toBe(c);
  expect(mod.applyApproval({ projects: {} }, PARENT, CHILD)).toEqual({ projects: {} });
  const a = { projects: { [PARENT]: approved } };
  expect(mod.applyApproval(a, PARENT, PARENT)).toBe(a);
});

for (const variant of ['async', 'sync']) {
  const run = variant === 'async'
    ? (a) => mod.copyExternalIncludeApproval(a)
    : async (a) => mod.copyExternalIncludeApprovalSync(a);

  describe(variant, () => {
    test('copies onto a new entry, trust not copied', async () => {
      write({ other: 1, projects: { [PARENT]: approved } });
      expect(await run({ fromPath: PARENT, toPath: CHILD, configPath: cfg })).toEqual({ ok: true, changed: true });
      const e = read().projects[CHILD];
      expect(e.hasClaudeMdExternalIncludesApproved).toBe(true);
      expect(e.hasClaudeMdExternalIncludesWarningShown).toBe(true);
      expect(e.hasTrustDialogAccepted).toBe(false);
      expect(e.allowedTools).toEqual([]);
      expect(read().other).toBe(1);
      noLeftovers();
      expect(await run({ fromPath: PARENT, toPath: CHILD, configPath: cfg })).toEqual({ ok: true, changed: false });
    });

    test('copies onto an existing entry preserving keys', async () => {
      write({ projects: { [PARENT]: approved, [CHILD]: { allowedTools: ['x'], custom: 5 } } });
      expect((await run({ fromPath: PARENT, toPath: CHILD + '/', configPath: cfg })).changed).toBe(true);
      expect(read().projects[CHILD]).toEqual({ allowedTools: ['x'], custom: 5, hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true });
      noLeftovers();
    });

    test('unapproved or absent parent leaves file byte-identical', async () => {
      write({ projects: { [PARENT]: { hasClaudeMdExternalIncludesApproved: false } } });
      const before = fs.readFileSync(cfg);
      expect(await run({ fromPath: PARENT, toPath: CHILD, configPath: cfg })).toEqual({ ok: true, changed: false });
      expect(await run({ fromPath: '/nope', toPath: CHILD, configPath: cfg })).toEqual({ ok: true, changed: false });
      expect(fs.readFileSync(cfg).equals(before)).toBe(true);
      noLeftovers();
    });

    test('missing file returns missing and creates nothing', async () => {
      expect(await run({ fromPath: PARENT, toPath: CHILD, configPath: cfg })).toEqual({ ok: false, reason: 'missing' });
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    test('malformed JSON is unparseable and untouched', async () => {
      fs.writeFileSync(cfg, '{ not json');
      expect(await run({ fromPath: PARENT, toPath: CHILD, configPath: cfg })).toEqual({ ok: false, reason: 'unparseable' });
      expect(fs.readFileSync(cfg, 'utf8')).toBe('{ not json');
      noLeftovers();
    });

    test('stale lock is reclaimed', async () => {
      write({ projects: { [PARENT]: approved } });
      fs.mkdirSync(cfg + '.lock');
      const old = new Date(Date.now() - 60000);
      fs.utimesSync(cfg + '.lock', old, old);
      expect((await run({ fromPath: PARENT, toPath: CHILD, configPath: cfg })).changed).toBe(true);
      noLeftovers();
    });

    test('fresh lock held throughout yields lock-timeout', async () => {
      write({ projects: { [PARENT]: approved } });
      const before = fs.readFileSync(cfg);
      fs.mkdirSync(cfg + '.lock');
      const t0 = Date.now();
      expect(await run({ fromPath: PARENT, toPath: CHILD, configPath: cfg })).toEqual({ ok: false, reason: 'lock-timeout' });
      expect(Date.now() - t0).toBeLessThan(4000);
      expect(fs.readFileSync(cfg).equals(before)).toBe(true);
      fs.rmdirSync(cfg + '.lock');
      noLeftovers();
    });

    test('key added by another writer before lock survives', async () => {
      write({ projects: { [PARENT]: approved } });
      const c = read(); c.addedElsewhere = 'yes'; write(c);
      await run({ fromPath: PARENT, toPath: CHILD, configPath: cfg });
      expect(read().addedElsewhere).toBe('yes');
      noLeftovers();
    });

    test('preserves file mode', async () => {
      write({ projects: { [PARENT]: approved } });
      fs.chmodSync(cfg, 0o600);
      await run({ fromPath: PARENT, toPath: CHILD, configPath: cfg });
      expect(fs.statSync(cfg).mode & 0o777).toBe(0o600);
    });

    test('parent found via realpath', async () => {
      const real = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-real-'));
      const link = path.join(dir, 'link');
      fs.symlinkSync(real, link);
      write({ projects: { [fs.realpathSync(real)]: approved } });
      try {
        expect((await run({ fromPath: link, toPath: CHILD, configPath: cfg })).changed).toBe(true);
      } finally { fs.rmSync(real, { recursive: true, force: true }); fs.unlinkSync(link); }
    });
  });
}
