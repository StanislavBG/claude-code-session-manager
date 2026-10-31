'use strict';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

// Exercises the identity guard (session-manager-operations/architecture/identity-boundary.md) in throwaway repos with a
// SYNTHETIC deny-list. The real strings must never appear in this repo, tests included.
const GUARD = join(__dirname, '../identity-guard.sh');
const EMAIL = 'zz-forbidden-owner@example.invalid';
const SURNAME = 'Qqsurnameqq';
const ZERO = '0'.repeat(40);

describe('identity-guard.sh', () => {
  let dir;
  let repo;
  let denylist;

  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf-8', env: { ...process.env, ...isolatedGit } }).trim();
  const isolatedGit = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

  function guard(args, opts = {}) {
    const r = spawnSync('bash', [GUARD, ...args], {
      cwd: repo,
      input: opts.input,
      encoding: 'utf-8',
      timeout: 15_000,
      env: { ...process.env, ...isolatedGit, BILKO_IDENTITY_DENYLIST: denylist, ...opts.env },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  function commitFile(path, body, message = `add ${path}`) {
    writeFileSync(join(repo, path), body);
    git('add', path);
    git('commit', '-q', '--no-verify', '-m', message);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'identity-guard-'));
    repo = join(dir, 'repo');
    mkdirSync(repo);
    denylist = join(dir, 'denylist');
    writeFileSync(denylist, `# comment\n${EMAIL}\n\n${SURNAME}\n`);
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Bilko');
    git('config', 'user.email', 'bilko@bilko.run');
    commitFile('README.md', 'hello\n', 'init');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('blocks a staged line with a deny-listed string, case-insensitively, without echoing it', () => {
    writeFileSync(join(repo, 'notes.md'), `Requested by the owner (${EMAIL.toUpperCase()})\n`);
    git('add', 'notes.md');
    const r = guard(['pre-commit']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('notes.md: 1 line(s), deny-list entry #1');
    expect(r.out.toLowerCase()).not.toContain(EMAIL);
  });

  it('allows a commit that only removes a deny-listed line', () => {
    commitFile('old.md', `by ${SURNAME}\n`);
    git('rm', '-q', 'old.md');
    expect(guard(['pre-commit']).status).toBe(0);
  });

  it('blocks a deny-listed author identity', () => {
    const r = guard(['pre-commit'], { env: { GIT_AUTHOR_EMAIL: EMAIL } });
    expect(r.status).toBe(1);
    expect(r.out).toContain('identity');
  });

  it('blocks a deny-listed commit message but ignores git comment lines', () => {
    const msg = join(dir, 'msg');
    writeFileSync(msg, `fix\n# ${EMAIL}\n`);
    expect(guard(['commit-msg', msg]).status).toBe(0);
    writeFileSync(msg, `fix for ${SURNAME}\n`);
    expect(guard(['commit-msg', msg]).status).toBe(1);
  });

  it('blocks a push whose new commits add a deny-listed string, even if a later commit removes it', () => {
    git('init', '-q', '--bare', join(dir, 'remote.git'));
    git('remote', 'add', 'origin', join(dir, 'remote.git'));
    git('push', '-q', '--no-verify', 'origin', 'main');
    const base = git('rev-parse', 'HEAD');
    commitFile('leak.md', `${EMAIL}\n`);
    git('rm', '-q', 'leak.md');
    git('commit', '-q', '--no-verify', '-m', 'remove');
    const r = guard(['pre-push', 'origin'], { input: `refs/heads/main ${git('rev-parse', 'HEAD')} refs/heads/main ${base}\n` });
    expect(r.status).toBe(1);
    expect(r.out).toContain('leak.md: 1 line(s), deny-list entry #1');
  });

  it('lets a clean push through and only warns on a deny-listed identity', () => {
    git('init', '-q', '--bare', join(dir, 'remote.git'));
    git('remote', 'add', 'origin', join(dir, 'remote.git'));
    git('push', '-q', '--no-verify', 'origin', 'main');
    const base = git('rev-parse', 'HEAD');
    execFileSync('git', ['commit', '-q', '--no-verify', '--allow-empty', '-m', 'empty'], {
      cwd: repo,
      env: { ...process.env, ...isolatedGit, GIT_AUTHOR_EMAIL: EMAIL },
    });
    const r = guard(['pre-push', 'origin'], { input: `refs/heads/main ${git('rev-parse', 'HEAD')} refs/heads/main ${base}\n` });
    expect(r.status).toBe(0);
    expect(r.out).toContain('warning: 1 pushed commit(s)');
    // A new branch is scanned against everything not already on the remote.
    const fresh = guard(['pre-push', 'origin'], { input: `refs/heads/x ${git('rev-parse', 'HEAD')} refs/heads/x ${ZERO}\n` });
    expect(fresh.status).toBe(0);
  });

  it('tree mode lists matching tracked files and exits 1, and exits 0 on a clean tree', () => {
    expect(guard(['tree']).status).toBe(0);
    commitFile('a.json', `{"by": "${SURNAME.toLowerCase()}"}\n`);
    const r = guard(['tree']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('a.json: 1 line(s), deny-list entry #2');
    expect(guard(['tree', 'HEAD~1']).status).toBe(0);
  });

  it('is a no-op without a deny-list, and treats an empty one as no entries', () => {
    writeFileSync(join(repo, 'n.md'), `${EMAIL}\n`);
    git('add', 'n.md');
    expect(guard(['pre-commit'], { env: { BILKO_IDENTITY_DENYLIST: join(dir, 'missing') } }).status).toBe(0);
    writeFileSync(denylist, '\n# only comments\n');
    expect(guard(['pre-commit']).status).toBe(0);
  });

  it('tree mode flags a deny-listed string inside a binary file', () => {
    const bytes = Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(EMAIL.toUpperCase()), Buffer.from([0])]);
    writeFileSync(join(repo, 'b.bin'), bytes);
    git('add', 'b.bin');
    git('commit', '-q', '--no-verify', '-m', 'add b.bin');
    const r = guard(['tree']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('b.bin: 1 line(s), deny-list entry #1');
    expect(r.out.toLowerCase()).not.toContain(EMAIL);
  });
});
