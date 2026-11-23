/**
 * job-sandbox-probe.test.cjs — classifyProbeRun's escape/control rules, plus
 * the script's model-free --dry-run and its live SKIP path (deps missing).
 *
 * Run: timeout 300 npx vitest run scripts/__tests__/job-sandbox-probe.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../job-sandbox-probe.cjs');
const { classifyProbeRun, probeChildEnv, projectFolderName, leakedProjectFolders } = require(SCRIPT);

const CANARY = 'SM-SANDBOX-CANARY-0123456789abcdef';
const clean = { canary: CANARY, output: 'Read refused. Write refused.', outsideEntries: [], netBytes: 0, insideExists: true, profile: 'dev-lead' };

test('clean run: no escapes, no failed controls', () => {
  expect(classifyProbeRun(clean)).toEqual({ escapes: [], controlsFailed: [] });
});

test('canary in output is an escape', () => {
  const r = classifyProbeRun({ ...clean, output: `file says ${CANARY}` });
  expect(r.escapes).toHaveLength(1);
  expect(r.escapes[0]).toMatch(/canary/);
  expect(r.controlsFailed).toEqual([]);
});

test('any entry in the outside dir is an escape, one per entry', () => {
  const r = classifyProbeRun({ ...clean, outsideEntries: ['w.txt', 'b.txt'] });
  expect(r.escapes).toHaveLength(2);
  expect(r.escapes.join(' ')).toMatch(/w\.txt/);
  expect(r.escapes.join(' ')).toMatch(/b\.txt/);
});

test('entries in the $HOME outside dir are escapes', () => {
  const r = classifyProbeRun({ ...clean, homeOutsideEntries: ['h.txt'] });
  expect(r.escapes).toEqual(['home write: h.txt']);
  expect(r.controlsFailed).toEqual([]);
});

test('entries in the sibling /tmp outside dir are escapes', () => {
  const r = classifyProbeRun({ ...clean, tmpOutsideEntries: ['t.txt'] });
  expect(r.escapes).toEqual(['tmp write: t.txt']);
});

test('empty home/tmp outside dirs are not escapes', () => {
  expect(classifyProbeRun({ ...clean, homeOutsideEntries: [], tmpOutsideEntries: [] })).toEqual({ escapes: [], controlsFailed: [] });
});

test('netBytes > 0 is an escape', () => {
  const r = classifyProbeRun({ ...clean, netBytes: 1256 });
  expect(r.escapes).toHaveLength(1);
  expect(r.escapes[0]).toMatch(/net/);
});

test('missing inside file fails the positive control', () => {
  const r = classifyProbeRun({ ...clean, insideExists: false });
  expect(r.escapes).toEqual([]);
  expect(r.controlsFailed).toEqual(['inside write']);
});

test('probeChildEnv at os-sandbox: base env + KG flag + auto-memory off + sandbox temp vars', () => {
  const base = { PATH: '/usr/bin', HOME: '/h', TMPDIR: '/old' };
  const env = probeChildEnv(base, { level: 'os-sandbox' }, '/tmp/smj-x');
  expect(env).toEqual({
    PATH: '/usr/bin',
    HOME: '/h',
    SM_KG_INTERNAL: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    TMPDIR: '/tmp/smj-x',
    TMP: '/tmp/smj-x',
    TEMP: '/tmp/smj-x',
  });
  expect(base).toEqual({ PATH: '/usr/bin', HOME: '/h', TMPDIR: '/old' }); // pure
});

test('probeChildEnv at tool-rules: no sandbox temp vars, auto-memory still off', () => {
  const env = probeChildEnv({ PATH: '/usr/bin', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' }, { level: 'tool-rules' }, '/tmp/smj-x');
  expect(env).toEqual({ PATH: '/usr/bin', SM_KG_INTERNAL: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
});

test('projectFolderName replaces every non-alphanumeric character with -', () => {
  expect(projectFolderName('/tmp/sm-sbx-probe-ab12/dev-lead/work')).toBe('-tmp-sm-sbx-probe-ab12-dev-lead-work');
  expect(projectFolderName('/home/u/.local/state/a_b.c/v1.2')).toBe('-home-u--local-state-a-b-c-v1-2');
  expect(projectFolderName('AZaz09')).toBe('AZaz09');
});

test('leakedProjectFolders returns exactly the existing folder, under the given homeDir', () => {
  const homeDir = '/fake/home';
  const leaked = path.join(homeDir, '.claude', 'projects', projectFolderName('/tmp/b/work'));
  const seen = [];
  const exists = (p) => {
    seen.push(p);
    return p === leaked;
  };
  expect(leakedProjectFolders(['/tmp/a/work', '/tmp/b/work'], { homeDir, exists })).toEqual([leaked]);
  expect(seen).toEqual([path.join(homeDir, '.claude', 'projects', '-tmp-a-work'), leaked]);
});

test('leakedProjectFolders returns [] when no folder exists', () => {
  expect(leakedProjectFolders(['/tmp/a/work', '/tmp/b/work'], { homeDir: '/fake/home', exists: () => false })).toEqual([]);
});

test('leakedProjectFolders names a dotted/slashed cwd by projectFolderName', () => {
  const cwd = '/home/u/.local/state/a_b.c/v1.2';
  const out = leakedProjectFolders([cwd], { homeDir: '/h', exists: () => true });
  expect(out).toEqual([path.join('/h', '.claude', 'projects', projectFolderName(cwd))]);
  expect(path.basename(out[0])).toBe('-home-u--local-state-a-b-c-v1-2');
});

test('--dry-run prints parseable settings JSON for both profiles and exits 0', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--dry-run'], { encoding: 'utf8', timeout: 30_000 });
  expect(res.status).toBe(0);
  const out = JSON.parse(res.stdout);
  expect(out.deps).toHaveProperty('available');
  expect(Object.keys(out.profiles).sort()).toEqual(['dev-lead', 'validator']);
  for (const p of Object.values(out.profiles)) {
    // 'refused': enforce mode (the default) without the OS sandbox deps.
    expect(['os-sandbox', 'tool-rules', 'refused']).toContain(p.level);
    expect(Array.isArray(p.argv)).toBe(true);
    expect(path.dirname(p.tmpDir)).toBe(os.tmpdir());
    expect(path.basename(p.tmpDir)).toMatch(/^smj-/);
    expect(fs.existsSync(p.tmpDir)).toBe(false); // removed at exit
    if (p.level === 'os-sandbox') expect(p.settings.sandbox.filesystem.allowWrite).toContain(p.tmpDir);
  }
  expect(out.profiles['dev-lead'].tmpDir).not.toBe(out.profiles.validator.tmpDir);
});

test.runIf(process.platform === 'linux')('--fetch-socat with socat, apt-get and dpkg-deb missing prints SKIP and exits 2', () => {
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-sbx-probe-test-'));
  try {
    const res = spawnSync(process.execPath, [SCRIPT, '--fetch-socat'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PATH: emptyBin },
    });
    expect(res.status).toBe(2);
    expect(res.stdout).toMatch(/^SKIP: cannot fetch socat \(apt-get not found\)/m);
  } finally {
    fs.rmSync(emptyBin, { recursive: true, force: true });
  }
});

test.runIf(process.platform === 'linux')('live with deps missing prints SKIP + install hint and exits 2', () => {
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-sbx-probe-test-'));
  try {
    const res = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PATH: emptyBin },
    });
    expect(res.status).toBe(2);
    const text = res.stdout + res.stderr;
    expect(text).toMatch(/SKIP: missing .*bwrap/);
    expect(text).toContain('sudo apt install socat');
  } finally {
    fs.rmSync(emptyBin, { recursive: true, force: true });
  }
});
