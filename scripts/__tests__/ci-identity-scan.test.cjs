'use strict';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, readFileSync, rmSync, copyFileSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

// Lifts the "Identity scan" run: block out of the real ci.yml as text and runs it in a throwaway repo.
// Synthetic strings only: the real deny-list must never appear in this repo.
const ROOT = join(__dirname, '../..');
const ENTRY = 'zz-synthetic-entry';
const isolatedGit = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function liftBody() {
  const lines = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf-8').split('\n');
  const name = lines.findIndex((l) => l.trim() === '- name: Identity scan');
  if (name < 0) throw new Error('Identity scan step not found');
  const run = lines.findIndex((l, i) => i > name && l.trim() === 'run: |');
  if (run < 0) throw new Error('run block not found');
  let end = lines.findIndex((l, i) => i > run && l.startsWith('      - '));
  if (end < 0) end = lines.length;
  return lines
    .slice(run + 1, end)
    .map((l) => l.slice(10))
    .join('\n') + '\n';
}

describe('ci.yml Identity scan step', () => {
  let dir;
  let repo;
  let bodyFile;

  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf-8', env: { ...process.env, ...isolatedGit } }).trim();

  function step(event, secret) {
    const r = spawnSync('bash', ['-e', bodyFile], {
      cwd: repo,
      encoding: 'utf-8',
      timeout: 45_000,
      env: { ...process.env, ...isolatedGit, GITHUB_EVENT_NAME: event, IDENTITY_DENYLIST: secret },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ci-identity-scan-'));
    repo = join(dir, 'repo');
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    bodyFile = join(dir, 'body.sh');
    writeFileSync(bodyFile, liftBody());
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Bilko');
    git('config', 'user.email', 'bilko@bilko.run');
    copyFileSync(join(ROOT, 'scripts/identity-guard.sh'), join(repo, 'scripts/identity-guard.sh'));
    const real = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'sandbox', version: '0.0.0', scripts: { 'identity:scan': real.scripts['identity:scan'] } }),
    );
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    git('add', 'scripts/identity-guard.sh', 'package.json', 'README.md');
    git('commit', '-q', '--no-verify', '-m', 'init');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('push + empty secret fails with an error naming the secret and doc', { timeout: 60_000 }, () => {
    const r = step('push', '');
    expect(r.status).toBe(1);
    expect(r.out).toContain('::error::');
    expect(r.out).toContain('IDENTITY_DENYLIST');
    expect(r.out).toContain('session-manager-operations/architecture/identity-boundary.md');
  });

  it('pull_request + empty secret warns and exits 0', { timeout: 60_000 }, () => {
    const r = step('pull_request', '');
    expect(r.status).toBe(0);
    expect(r.out).toContain('::warning::');
    expect(r.out).toContain('IDENTITY_DENYLIST');
  });

  for (const event of ['push', 'pull_request']) {
    it(`${event} + comment-only secret fails`, { timeout: 60_000 }, () => {
      const r = step(event, '# comment\n\n');
      expect(r.status).toBe(1);
      expect(r.out).toContain('::error::');
    });
  }

  it('push + whitespace-only secret fails', { timeout: 60_000 }, () => {
    const r = step('push', '  \n \n');
    expect(r.status).toBe(1);
    expect(r.out).toContain('::error::');
  });

  for (const event of ['push', 'pull_request']) {
    it(`${event} + clean tree with one entry passes with the pass line`, { timeout: 60_000 }, () => {
      const r = step(event, ENTRY);
      expect(r.status).toBe(0);
      expect(r.out).toContain('(1 entries checked)');
    });
  }

  it('push + tracked file holding the entry fails without printing the entry', { timeout: 60_000 }, () => {
    writeFileSync(join(repo, 'leak.txt'), `contains ${ENTRY} here\n`);
    git('add', 'leak.txt');
    const r = step('push', ENTRY);
    expect(r.status).toBe(1);
    expect(r.out).toContain('deny-list entry #1');
    expect(r.out).not.toContain(ENTRY);
  });
});
