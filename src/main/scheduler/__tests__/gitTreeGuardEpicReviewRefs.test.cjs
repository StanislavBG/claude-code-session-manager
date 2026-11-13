/**
 * gitTreeGuardEpicReviewRefs.test.cjs — committedInWindow's --all scan must not
 * credit a job with a commit reachable only from refs/sm-epic-review/* (Epic
 * Changes pin refs / completion snapshots), while a normal branch commit still counts.
 *
 * Run: timeout 120 npx vitest run src/main/scheduler/__tests__/gitTreeGuardEpicReviewRefs.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gitTreeGuard = require('../gitTreeGuard.cjs');

let repo;
let baseSecs;

function git(args, env) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: env || process.env });
}

function commitAt(file, msg, secs) {
  fs.writeFileSync(path.join(repo, file), `${msg}\n`, 'utf8');
  git(['add', file]);
  git(['commit', '-q', '-m', msg], { ...process.env, GIT_AUTHOR_DATE: `@${secs} +0000`, GIT_COMMITTER_DATE: `@${secs} +0000` });
  return git(['rev-parse', 'HEAD']).trim();
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-tree-guard-review-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@test.com']);
  git(['config', 'user.name', 'Test']);
  baseSecs = Math.floor(Date.now() / 1000) - 3600;
  commitAt('base.txt', 'base', baseSecs - 600);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

const iso = (secs) => new Date(secs * 1000).toISOString();

test('a commit reachable only from refs/sm-epic-review/* is not reported', async () => {
  git(['checkout', '-q', '-b', 'tmp']);
  const sha = commitAt('pin.txt', 'pin snapshot', baseSecs + 10);
  git(['update-ref', 'refs/sm-epic-review/x/y/head', sha]);
  git(['checkout', '-q', 'main']);
  git(['branch', '-q', '-D', 'tmp']);
  expect(await gitTreeGuard.committedInWindow(repo, iso(baseSecs), iso(baseSecs + 20))).toBe(false);
});

test('a normal branch commit in the window is still reported', async () => {
  git(['checkout', '-q', '-b', 'feature']);
  commitAt('job.txt', 'job work', baseSecs + 10);
  git(['checkout', '-q', 'main']);
  expect(await gitTreeGuard.committedInWindow(repo, iso(baseSecs), iso(baseSecs + 20))).toBe(true);
});
