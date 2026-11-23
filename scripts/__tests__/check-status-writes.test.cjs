/**
 * check-status-writes.test.cjs — a planted bare `.status =` write under src/main fails the
 * lint with file:line; owner modules, allowlisted lines and the real tree pass.
 *
 * Run: timeout 120 npx vitest run scripts/__tests__/check-status-writes.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../check-status-writes.cjs');
const REPO = path.resolve(__dirname, '../..');
const { scan, loadAllowlist } = require('../check-status-writes.cjs');

let root;
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const writeAllowlist = (entries) => {
  const p = path.join(root, 'allow.json');
  fs.writeFileSync(p, JSON.stringify({ entries }));
  return p;
};
const run = (allow = writeAllowlist([])) => spawnSync('node', [SCRIPT, root, allow], { encoding: 'utf8', timeout: 30000 });

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-write-lint-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('planted job status write in src/main fails naming file:line', () => {
  write('src/main/foo.cjs', "// c\nfunction f(job) {\n  job.status = 'failed';\n}\n");
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('src/main/foo.cjs:3');
});

test('comparisons, arrows and comments are not writes', () => {
  write('src/main/ok.cjs', "if (j.status === 'x' || j.status == 'y') {}\nconst g = (j) => j.status\n// j.status = 'z'\n");
  expect(run().status).toBe(0);
});

test('the four owner modules may write status', () => {
  for (const rel of [
    'src/main/lib/scheduler/scheduleJobTransitions.cjs',
    'src/main/lib/epic/epicTransitions.cjs',
    'src/main/lib/epic/epicMint.cjs',
    'src/main/lib/tasks/taskLedger.cjs',
  ]) write(rel, "x.status = 'done';\n");
  expect(run().status).toBe(0);
});

test('an allowlisted line passes; the same file with another write still fails', () => {
  write('src/main/view.cjs', "row.status = 'running';\n");
  const allow = writeAllowlist([{ file: 'src/main/view.cjs', match: "row.status = 'running';", reason: 'display copy' }]);
  expect(run(allow).status).toBe(0);
  write('src/main/view.cjs', "row.status = 'running';\njob.status = 'failed';\n");
  const r = run(allow);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('src/main/view.cjs:2');
});

test('__tests__ dirs are not scanned', () => {
  write('src/main/__tests__/x.test.cjs', "job.status = 'failed';\n");
  expect(run().status).toBe(0);
});

test('an allowlist entry without a reason is rejected', () => {
  const p = writeAllowlist([{ file: 'a', match: 'b' }]);
  expect(() => loadAllowlist(p)).toThrow(/reason/);
});

test('the real tree is clean and every real allowlist entry still matches', () => {
  const { violations, unused } = scan(REPO);
  expect(violations).toEqual([]);
  expect(unused).toEqual([]);
  const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 60000 });
  expect(r.status).toBe(0);
});
