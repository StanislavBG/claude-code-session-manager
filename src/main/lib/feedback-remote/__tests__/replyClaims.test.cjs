'use strict';

import { test, expect, describe, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  findUnfilledPlaceholders,
  findSessionManagerVersions,
  normalizeReleaseClaim,
  isSessionManagerRepo,
  checkReleaseContains,
  isCommitHash,
  MAX_COMMITS,
} = require('../replyClaims.cjs');

describe('isCommitHash', () => {
  test('true for 7 and 40 hex chars, either case', () => {
    expect(isCommitHash('abc1234')).toBe(true);
    expect(isCommitHash('ABC1234')).toBe(true);
    expect(isCommitHash('a'.repeat(40))).toBe(true);
  });
  test('false for 6 or 41 hex, non-hex, and non-strings', () => {
    expect(isCommitHash('abc123')).toBe(false);
    expect(isCommitHash('a'.repeat(41))).toBe(false);
    expect(isCommitHash('xyz1234')).toBe(false);
    expect(isCommitHash('abc1234 ')).toBe(false);
    for (const v of [1234567, null, undefined, {}, ['abc1234']]) expect(isCommitHash(v)).toBe(false);
  });
  test('MAX_COMMITS is 20', () => {
    expect(MAX_COMMITS).toBe(20);
  });
});

describe('findUnfilledPlaceholders', () => {
  test('finds every wrapper style, first-seen order, distinct', () => {
    const msg = 'live in {version}, {{appVersion}} and ${release} <semver> [SM_VERSION] %app-version% {version}';
    expect(findUnfilledPlaceholders(msg)).toEqual([
      '{version}', '{{appVersion}}', '${release}', '<semver>', '[SM_VERSION]', '%app-version%',
    ]);
  });
  test('inner spaces and case-insensitivity', () => {
    expect(findUnfilledPlaceholders('ships in { Version } / {{ release_version }}'))
      .toEqual(['{ Version }', '{{ release_version }}']);
  });
  test('every name is recognised', () => {
    for (const n of ['version', 'appversion', 'app_version', 'app-version', 'release', 'releaseversion',
      'release_version', 'smversion', 'sm_version', 'semver']) {
      expect(findUnfilledPlaceholders(`x {${n}} y`)).toEqual([`{${n}}`]);
    }
  });
  test('allowVersionToken skips only exact lowercase {version}', () => {
    const msg = 'a {version} b {Version} c {{version}} d ${version}';
    expect(findUnfilledPlaceholders(msg, { allowVersionToken: true }))
      .toEqual(['{Version}', '{{version}}', '${version}']);
  });
  test('ignores filled text, other names, non-strings', () => {
    expect(findUnfilledPlaceholders('live in Session Manager 0.143.0 {name} <div>')).toEqual([]);
    expect(findUnfilledPlaceholders(null)).toEqual([]);
    expect(findUnfilledPlaceholders(42)).toEqual([]);
  });
});

describe('findSessionManagerVersions', () => {
  test('finds Session Manager and SM forms', () => {
    const msg = 'live in Session Manager 0.143.0; also session manager release v0.144.1, '
      + 'SM version 1.2.3, SM app v2.0.0 and Session Manager 0.143.0 again';
    expect(findSessionManagerVersions(msg)).toEqual(['0.143.0', '0.144.1', '1.2.3', '2.0.0']);
  });
  test('SM must be uppercase; unrelated versions ignored', () => {
    expect(findSessionManagerVersions('sm 1.2.3')).toEqual([]);
    expect(findSessionManagerVersions('Electron 42.11.18')).toEqual([]);
    expect(findSessionManagerVersions('kit v41')).toEqual([]);
    expect(findSessionManagerVersions('Session Manager {version}')).toEqual([]);
    expect(findSessionManagerVersions(undefined)).toEqual([]);
  });
});

describe('normalizeReleaseClaim', () => {
  test('accepts and normalizes', () => {
    const r = normalizeReleaseClaim({ commits: ['ABCDEF1', 'abcdef1', '884d5211aa'] });
    expect(r).toEqual({ ok: true, value: { commits: ['abcdef1', '884d5211aa'] } });
  });
  test('rejects bad shapes', () => {
    for (const raw of [null, undefined, 'x', [], { commits: [] }, { commits: 'abcdef1' },
      { commits: ['abc'] }, { commits: ['zzzzzzz'] }, { commits: ['a'.repeat(41)] },
      { commits: [7] }, { commits: ['abcdef1'], extra: 1 }, {},
      { commits: Array.from({ length: 21 }, (_, i) => `abcdef${i.toString(16).padStart(2, '0')}`) },
      Object.assign(Object.create({ x: 1 }), { commits: ['abcdef1'] }), new Date()]) {
      const r = normalizeReleaseClaim(raw);
      expect(r.ok).toBe(false);
      expect(typeof r.error).toBe('string');
    }
  });
  test('accepts 20 commits', () => {
    const commits = Array.from({ length: 20 }, (_, i) => `abcdef${i.toString(16).padStart(2, '0')}`);
    expect(normalizeReleaseClaim({ commits }).ok).toBe(true);
  });
});

describe('isSessionManagerRepo', () => {
  let dir;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-replyclaims-pkg-')); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  test('true only for the right package name; never throws', () => {
    expect(isSessionManagerRepo(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, 'package.json'), '{not json');
    expect(isSessionManagerRepo(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'other' }));
    expect(isSessionManagerRepo(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, 'package.json'), 'null');
    expect(isSessionManagerRepo(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'claude-code-session-manager' }));
    expect(isSessionManagerRepo(dir)).toBe(true);
    expect(isSessionManagerRepo(undefined)).toBe(false);
    expect(isSessionManagerRepo(path.join(dir, 'nope'))).toBe(false);
  });
  test('malformed package.json is false, never throws', () => {
    const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-replyclaims-bad-'));
    try {
      fs.writeFileSync(path.join(bad, 'package.json'), '{"name": "claude-code-session-manager",');
      expect(() => isSessionManagerRepo(bad)).not.toThrow();
      expect(isSessionManagerRepo(bad)).toBe(false);
      fs.writeFileSync(path.join(bad, 'package.json'), '');
      expect(isSessionManagerRepo(bad)).toBe(false);
      fs.writeFileSync(path.join(bad, 'package.json'), '"claude-code-session-manager"');
      expect(isSessionManagerRepo(bad)).toBe(false);
      expect(isSessionManagerRepo(42)).toBe(false);
      expect(isSessionManagerRepo('')).toBe(false);
    } finally {
      fs.rmSync(bad, { recursive: true, force: true });
    }
  });
});

describe('checkReleaseContains', () => {
  let repo, first, second;
  const git = (...args) => execFileSync('git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
    { cwd: repo, encoding: 'utf8' }).trim();
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-replyclaims-git-'));
    git('init', '-q');
    fs.writeFileSync(path.join(repo, 'a.txt'), '1');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'one');
    first = git('rev-parse', 'HEAD');
    git('tag', 'v1.0.0');
    fs.writeFileSync(path.join(repo, 'a.txt'), '2');
    git('commit', '-q', '-am', 'two');
    second = git('rev-parse', 'HEAD');
  });
  afterAll(() => { fs.rmSync(repo, { recursive: true, force: true }); });

  test('tag containing the commit is ok', async () => {
    expect(await checkReleaseContains({ repoCwd: repo, version: '1.0.0', commits: [first.slice(0, 8)] }))
      .toEqual({ ok: true, tag: 'v1.0.0' });
  });
  test('commit after the tag is refused, naming it', async () => {
    const r = await checkReleaseContains({ repoCwd: repo, version: '1.0.0', commits: [first, second.slice(0, 8)] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('v1.0.0');
    expect(r.error).toContain(second.slice(0, 8));
  });
  test('missing tag is refused, naming it', async () => {
    const r = await checkReleaseContains({ repoCwd: repo, version: '9.9.9', commits: [first] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('v9.9.9');
  });
  test('unknown commit is refused, naming it', async () => {
    const r = await checkReleaseContains({ repoCwd: repo, version: '1.0.0', commits: ['deadbeefdeadbeef'] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('deadbeefdeadbeef');
  });
  test('invalid version refused without running git', async () => {
    let calls = 0;
    const runGit = async () => { calls += 1; return ''; };
    for (const version of ['1.0', 'v1.0.0', '{version}', '', null]) {
      const r = await checkReleaseContains({ repoCwd: repo, version, commits: [first] }, { runGit });
      expect(r.ok).toBe(false);
      expect(typeof r.error).toBe('string');
    }
    expect(calls).toBe(0);
  });
  test('bad commits refused; injected runGit used; never throws', async () => {
    expect((await checkReleaseContains({ repoCwd: repo, version: '1.0.0', commits: [] })).ok).toBe(false);
    expect((await checkReleaseContains({ repoCwd: repo, version: '1.0.0', commits: ['--all'] })).ok).toBe(false);
    expect((await checkReleaseContains(undefined)).ok).toBe(false);
    const seen = [];
    const ok = await checkReleaseContains({ repoCwd: '/x', version: '2.0.0', commits: ['abcdef1'] },
      { runGit: async (cwd, args) => { seen.push([cwd, args]); return 'sha\n'; } });
    expect(ok).toEqual({ ok: true, tag: 'v2.0.0' });
    expect(seen[0]).toEqual(['/x', ['rev-parse', '-q', '--verify', 'refs/tags/v2.0.0^{commit}']]);
    const boom = await checkReleaseContains({ repoCwd: '/x', version: '2.0.0', commits: ['abcdef1'] },
      { runGit: () => { throw new Error('sync boom'); } });
    expect(boom.ok).toBe(false);
  });
});
