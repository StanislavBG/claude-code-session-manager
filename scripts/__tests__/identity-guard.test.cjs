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

  describe('word: entries', () => {
    const NAME = 'Qqnameqq';
    const LONGER = `${NAME}xy`;
    const staged = (line) => {
      writeFileSync(join(repo, 'notes.md'), `${line}\n`);
      git('add', 'notes.md');
      return guard(['pre-commit']);
    };
    const BLOCKED = [NAME, `by ${NAME.toUpperCase()}.`, `${NAME.toLowerCase()}'s kit`, `(${NAME} Persona)`, `${LONGER} and ${NAME}`];
    const ALLOWED = [`github.com/${LONGER}/repo`, `${LONGER}@example.invalid`, `x${NAME}`, `${NAME}_x`, `${NAME}9`];

    beforeEach(() => writeFileSync(denylist, `word:${NAME}\n`));

    it('blocks the whole word in any case without echoing it', () => {
      for (const line of BLOCKED) {
        const r = staged(line);
        expect(r.status).toBe(1);
        expect(r.out).toContain('notes.md: 1 line(s), deny-list entry #1');
        expect(r.out.toLowerCase()).not.toContain(NAME.toLowerCase());
        expect(r.out.toLowerCase()).not.toContain('word:');
      }
    });

    it('allows a longer word', () => {
      for (const line of ALLOWED) expect(staged(line).status).toBe(0);
    });

    it('applies in commit-msg and pre-push', () => {
      const msg = join(dir, 'msg');
      writeFileSync(msg, `fix for ${NAME}\n`);
      expect(guard(['commit-msg', msg]).status).toBe(1);
      writeFileSync(msg, `fix for ${LONGER}\n`);
      expect(guard(['commit-msg', msg]).status).toBe(0);

      git('init', '-q', '--bare', join(dir, 'remote.git'));
      git('remote', 'add', 'origin', join(dir, 'remote.git'));
      git('push', '-q', '--no-verify', 'origin', 'main');
      const base = git('rev-parse', 'HEAD');
      commitFile('p.md', `by ${NAME}\n`);
      const bad = guard(['pre-push', 'origin'], { input: `refs/heads/main ${git('rev-parse', 'HEAD')} refs/heads/main ${base}\n` });
      expect(bad.status).toBe(1);
      const mid = git('rev-parse', 'HEAD');
      commitFile('q.md', `by ${LONGER}\n`);
      git('reset', '-q', '--hard', base);
      commitFile('q.md', `by ${LONGER}\n`);
      const ok = guard(['pre-push', 'origin'], { input: `refs/heads/main ${git('rev-parse', 'HEAD')} refs/heads/main ${base}\n` });
      expect(ok.status).toBe(0);
      expect(mid).not.toBe(git('rev-parse', 'HEAD'));
    });

    it('blocks a new path and an author name holding the word', () => {
      writeFileSync(join(repo, `${NAME}.md`), 'clean\n');
      git('add', `${NAME}.md`);
      expect(guard(['pre-commit']).status).toBe(1);
      git('reset', '-q');
      expect(guard(['pre-commit'], { env: { GIT_AUTHOR_NAME: NAME } }).status).toBe(1);
    });

    it('tree mode reports the whole word only, in text and binary files', () => {
      const early = git('rev-parse', 'HEAD');
      commitFile('only-longer.md', `by ${LONGER}\n`);
      expect(guard(['tree']).status).toBe(0);
      commitFile('t.md', `by ${NAME}\n`);
      writeFileSync(join(repo, 'b.bin'), Buffer.concat([Buffer.from([0, 1, 0]), Buffer.from(NAME.toUpperCase()), Buffer.from([0])]));
      git('add', 'b.bin');
      git('commit', '-q', '--no-verify', '-m', 'add b.bin');
      const r = guard(['tree']);
      expect(r.status).toBe(1);
      expect(r.out).toContain('t.md: 1 line(s), deny-list entry #1');
      expect(r.out).toContain('b.bin: 1 line(s), deny-list entry #1');
      expect(r.out).not.toContain('only-longer.md');
      expect(guard(['tree', early]).status).toBe(0);
    });

    it('pre-commit and tree mode agree on every line', () => {
      for (const line of [...BLOCKED, ...ALLOWED]) {
        const pre = staged(line).status;
        git('commit', '-q', '--no-verify', '-m', 'line');
        expect(guard(['tree']).status).toBe(pre);
      }
    });

    it('treats the prefix case-insensitively and keeps plain entries as substrings', () => {
      for (const prefix of ['WORD:', 'Word:']) {
        writeFileSync(denylist, `${prefix}${NAME}\n`);
        expect(staged(`by ${NAME}`).status).toBe(1);
        expect(staged(`by ${LONGER}`).status).toBe(0);
      }
      writeFileSync(denylist, `${NAME}\n`);
      expect(staged(`by ${LONGER}`).status).toBe(1);
      git('commit', '-q', '--no-verify', '-m', 'longer');
      expect(guard(['tree']).status).toBe(1);
    });

    it('treats the entry as a literal string, not a pattern', () => {
      writeFileSync(denylist, 'word:q.q\n');
      expect(staged('by qxq').status).toBe(0);
      git('commit', '-q', '--no-verify', '-m', 'x');
      expect(guard(['tree']).status).toBe(0);
      expect(staged('by q.q').status).toBe(1);
      git('commit', '-q', '--no-verify', '-m', 'y');
      expect(guard(['tree']).status).toBe(1);
    });

    it('drops empty word: lines instead of matching everything', () => {
      writeFileSync(denylist, `word:\nWORD:  \n${SURNAME}\n`);
      expect(staged('an unrelated line').status).toBe(0);
      expect(staged(`by ${SURNAME}`).status).toBe(1);
      git('reset', '-q');
      expect(guard(['tree']).out).toContain('(1 entries checked)');
      writeFileSync(denylist, 'word:\n');
      expect(guard(['tree']).out).toContain('has no entries');
    });
  });
});

describe('install-git-hooks.sh', () => {
  const { readFileSync, copyFileSync, existsSync, statSync } = require('node:fs');
  const SCRIPTS = join(__dirname, '..');
  const isolatedGit = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  let dir;
  let repo;
  let denylist;

  const env = () => ({ ...process.env, ...isolatedGit, BILKO_IDENTITY_DENYLIST: denylist });
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf-8', env: env(), timeout: 30_000 });
  const install = () =>
    spawnSync('bash', ['scripts/install-git-hooks.sh'], { cwd: repo, encoding: 'utf-8', env: env(), timeout: 30_000 });
  const hooksDir = () => join(repo, '.git', 'hooks');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'install-hooks-'));
    repo = join(dir, 'repo');
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    denylist = join(dir, 'denylist');
    writeFileSync(denylist, `${EMAIL}\n`);
    for (const f of ['identity-guard.sh', 'install-git-hooks.sh']) copyFileSync(join(SCRIPTS, f), join(repo, 'scripts', f));
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Bilko');
    git('config', 'user.email', 'bilko@bilko.run');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('installs hooks that reject a deny-listed commit without echoing the value, and accept a clean one', () => {
    const i = install();
    expect(i.status).toBe(0);
    for (const h of ['pre-commit', 'commit-msg', 'pre-push']) expect(existsSync(join(hooksDir(), h))).toBe(true);
    writeFileSync(join(repo, 'leak.md'), `contact ${EMAIL}\n`);
    git('add', 'leak.md');
    const bad = git('commit', '-q', '-m', 'add leak');
    expect(bad.status).not.toBe(0);
    expect(`${bad.stdout}${bad.stderr}`.toLowerCase()).not.toContain(EMAIL);
    git('reset', '-q');
    writeFileSync(join(repo, 'ok.md'), 'clean\n');
    git('add', 'ok.md');
    expect(git('commit', '-q', '-m', 'add ok').status).toBe(0);
  });

  it('refuses to replace a foreign hook, leaving it untouched', () => {
    mkdirSync(hooksDir(), { recursive: true });
    const foreign = join(hooksDir(), 'pre-commit');
    writeFileSync(foreign, '#!/bin/sh\necho mine\n');
    const r = install();
    expect(r.status).toBe(1);
    expect(readFileSync(foreign, 'utf-8')).toBe('#!/bin/sh\necho mine\n');
  });

  it('is idempotent and warns when there is no deny-list', () => {
    expect(install().status).toBe(0);
    expect(install().status).toBe(0);
    rmSync(denylist);
    const r = install();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('no deny-list');
    expect(statSync(join(repo, 'scripts', 'install-git-hooks.sh')).isFile()).toBe(true);
  });
});
