/**
 * check-ops-path-literals.test.cjs — a bare ops-root literal in a scratch tree fails the
 * lint; an allowlisted one passes.
 *
 * Run: timeout 120 npx vitest run scripts/__tests__/check-ops-path-literals.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../check-ops-path-literals.cjs');
const { scan, scanLiveRoots } =require('../check-ops-path-literals.cjs');
const BARE = "const p = path.join(cwd, 'session-manager-operations', 'x');\n";

let root;
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const run = () => spawnSync('node', [SCRIPT, root], { encoding: 'utf8', timeout: 30000 });

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-path-lint-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('bare join in src/main fails with file:line', () => {
  write('src/main/foo.cjs', `// c\n${BARE}`);
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('src/main/foo.cjs:2');
});

test('bare join in scripts/ fails', () => {
  write('scripts/bar.cjs', BARE);
  expect(run().status).toBe(1);
});

test('resolver, __tests__, and allowlisted files pass', () => {
  write('src/main/lib/opsOwnership.cjs', BARE);
  write('src/main/__tests__/t.test.cjs', BARE);
  write('scripts/allowed.cjs', BARE);
  expect(scan(root, { allowlist: new Map([['scripts/allowed.cjs', 'test reason']]) })).toEqual([]);
});

test('clean tree exits 0', () => {
  write('src/main/ok.cjs', "const x = opsPath(cwd, 'a');\n");
  expect(run().status).toBe(0);
});

test('the real repo tree is clean', () => {
  expect(scan(path.resolve(__dirname, '../..'))).toEqual([]);
  expect(scanLiveRoots(path.resolve(__dirname, '../..'))).toEqual([]);
});

const LIVE = "const p = path.join(os.homedir(), '.claude', 'session-manager', 'x');\n";
const LIVE_TMP = "const w = path.join(os.tmpdir(), 'session-manager-job-worktrees');\n";

test('LIVE_ROOT_LITERAL: home/tmp join in src/main, tests/ (incl. .ts) fails with file:line', () => {
  write('src/main/lib/__tests__/a.test.cjs', `// c\n${LIVE}`);
  write('tests/e2e/b.spec.ts', LIVE_TMP);
  write('scripts/c.cjs', LIVE);
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('src/main/lib/__tests__/a.test.cjs:2');
  expect(r.stderr).toContain('tests/e2e/b.spec.ts:1');
  expect(r.stderr).toContain('scripts/c.cjs:1');
  expect(r.stderr).toContain('LIVE_ROOT_LITERAL');
});

test('LIVE_ROOT_LITERAL: resolver, self, allowlisted, comments, and non-root joins pass', () => {
  write('src/main/lib/schedulerPaths.cjs', LIVE);
  write('scripts/check-ops-path-literals.cjs', LIVE);
  write('scripts/allowed.cjs', LIVE);
  write('src/main/comment.cjs', `// ${LIVE}`);
  write('src/main/agents.cjs', "const a = path.join(os.homedir(), '.claude', 'agents');\n");
  write('src/main/cfg.cjs', "const a = path.join(os.homedir(), '.config', 'session-manager', 'x.json');\n");
  write('src/main/cwd.cjs', "const a = path.join(os.homedir(), 'Projects', 'session-manager');\n");
  expect(scanLiveRoots(root, { allowlist: new Map([['scripts/allowed.cjs', 'test reason']]) })).toEqual([]);
});

test('LIVE_ROOT_LITERAL: the scanner script never matches itself (self-match guard)', () => {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, 'scripts/check-ops-path-literals.cjs'));
  expect(scanLiveRoots(root, { allowlist: new Map() })).toEqual([]);
  expect(scan(root)).toEqual([]);
});
