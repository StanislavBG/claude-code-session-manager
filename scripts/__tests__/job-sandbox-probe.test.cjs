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
const { classifyProbeRun } = require(SCRIPT);

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

test('--dry-run prints parseable settings JSON for both profiles and exits 0', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--dry-run'], { encoding: 'utf8', timeout: 30_000 });
  expect(res.status).toBe(0);
  const out = JSON.parse(res.stdout);
  expect(out.deps).toHaveProperty('available');
  expect(Object.keys(out.profiles).sort()).toEqual(['dev-lead', 'validator']);
  for (const p of Object.values(out.profiles)) {
    expect(['os-sandbox', 'tool-rules']).toContain(p.level);
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
