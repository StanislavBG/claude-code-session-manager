/**
 * md-network-drift-check.test.cjs — drift-check.cjs against temp git repos.
 * Run: timeout 120 npx vitest run scripts/__tests__/md-network-drift-check.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(
  __dirname,
  '../../plugins/session-manager-dev/skills/maintaining-md-network/scripts/drift-check.cjs',
);

const dirs = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdnet-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

function run(dir, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', dir, ...args], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* usage error */ }
  return { code: r.status, json, stderr: r.stderr };
}

const lines = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n') + '\n';

test('clean repo exits 0', () => {
  const dir = repo({ 'CLAUDE.md': '# Hi\n[doc](docs/a.md) and `docs/a.md`\n', 'docs/a.md': '# A\n' });
  const { code, json } = run(dir);
  expect(code).toBe(0);
  expect(json.findings).toEqual([]);
  expect(json.map).toBeNull();
  expect(json.checkedFiles).toEqual(['CLAUDE.md', 'docs/a.md']);
});

test('broken-link, with anchors stripped and root-relative accepted', () => {
  const dir = repo({
    'README.md': '[x](nope.md#top) [y](docs/a.md#s) [i](![z](img/none.png))\n[ext](https://a.b/c) [h](#only)\n',
    'docs/a.md': '[root rel](docs/b.md) [here](b.md)\n',
    'docs/b.md': '# B\n',
  });
  const { code, json } = run(dir);
  expect(code).toBe(1);
  const links = json.findings.filter((f) => f.kind === 'broken-link');
  expect(links.map((f) => f.target)).toContain('nope.md#top');
  expect(links.every((f) => f.file === 'README.md')).toBe(true);
  expect(links.find((f) => f.target === 'nope.md#top').line).toBe(1);
  expect(json.findings.some((f) => f.file === 'docs/a.md')).toBe(false);
});

test('missing-path with :N suffix; existing and skipped spans are quiet', () => {
  const dir = repo({
    '.gitignore': 'build/\n',
    'README.md': [
      '`src/gone.js:12-20` `src/here.js:3` `bilko.run/x` `~/a/b` `a/*.js` `a b/c`',
      '`build/out.js` `@scope/pkg`',
      '```',
      '`fenced/missing.js`',
      '```',
      '<!-- `commented/missing.js` -->',
      '',
    ].join('\n'),
    'src/here.js': '',
  });
  const { json } = run(dir);
  expect(json.findings).toEqual([
    { kind: 'missing-path', file: 'README.md', line: 1, target: 'src/gone.js:12-20' },
  ]);
});

test('over-line-limit for CLAUDE.md, unscoped rules and the map', () => {
  const dir = repo({
    'CLAUDE.md': '<!-- md-network-map -->\n' + lines(80),
    'pkg/AGENTS.md': lines(201),
    '.claude/rules/a.md': lines(205),
    '.claude/rules/scoped.md': '---\npaths: src/**\n---\n' + lines(205),
  });
  const { json } = run(dir, '--checks', 'limits');
  expect(json.map).toBe('CLAUDE.md');
  const f = json.findings.map((x) => [x.file, x.limit]);
  expect(f).toContainEqual(['CLAUDE.md', 70]);
  expect(f).toContainEqual(['pkg/AGENTS.md', 200]);
  expect(f).toContainEqual(['.claude/rules/a.md', 200]);
  expect(f.some(([file]) => file === '.claude/rules/scoped.md')).toBe(false);
  expect(f.some(([file, l]) => file === 'CLAUDE.md' && l === 200)).toBe(false);
});

test('--map names the map file', () => {
  const dir = repo({ 'docs/map.md': lines(71) });
  const { json } = run(dir, '--map', 'docs/map.md', '--checks', 'limits');
  expect(json.map).toBe('docs/map.md');
  expect(json.findings).toEqual([{ kind: 'over-line-limit', file: 'docs/map.md', lines: 71, expandedLines: 71, limit: 70 }]);
});

test('no-contents-list, and contents lists are recognised', () => {
  const dir = repo({
    'long.md': '# L\n' + lines(120),
    'heading.md': '# H\n## Contents\n' + lines(120),
    'toc.md': '# T\n- [a](#a)\n- [b](#b)\n- [c](#c)\n' + lines(120),
    'short.md': lines(50),
  });
  const { json } = run(dir, '--checks', 'contents');
  expect(json.findings).toEqual([{ kind: 'no-contents-list', file: 'long.md', lines: 121 }]);
});

test('--file, --exclude and --checks narrow the run', () => {
  const dir = repo({
    'a.md': '[x](missing.md)\n`p/q.js`\n',
    'skip/b.md': '[x](missing.md)\n',
  });
  expect(run(dir).json.counts).toEqual({ 'broken-link': 2, 'missing-path': 1 });
  expect(run(dir, '--file', 'a.md').json.checkedFiles).toEqual(['a.md']);
  expect(run(dir, '--exclude', 'skip/').json.checkedFiles).toEqual(['a.md']);
  expect(run(dir, '--checks', 'links', '--exclude', 'skip/').json.counts).toEqual({ 'broken-link': 1 });
  expect(run(dir, '--checks', 'contents').code).toBe(0);
});

test('bad --root and bad flags exit 2', () => {
  expect(run(path.join(os.tmpdir(), 'mdnet-does-not-exist-xyz')).code).toBe(2);
  const dir = repo({ 'a.md': '' });
  expect(run(dir, '--bogus').code).toBe(2);
  expect(run(dir, '--checks', 'nope').code).toBe(2);
});

test('path candidates need an extension, a trailing slash, or an existing first segment', () => {
  const dir = repo({
    'README.md': '`origin/main` `ageMin/Max` `feature/x` `docs/missing.md` `src/nope/` `src/nope2`\n',
    'src/keep.js': '',
  });
  const t = run(dir).json.findings.filter((f) => f.kind === 'missing-path').map((f) => f.target);
  expect(t.sort()).toEqual(['docs/missing.md', 'src/nope/', 'src/nope2']);
});

test('suffix-of-tracked-file paths are quiet by default, unanchored-path with --strict-paths', () => {
  const dir = repo({
    'README.md': '`lib/util.js`\n',
    'src/lib/util.js': '',
    'src/a/lib/util.js': '',
  });
  expect(run(dir).json.findings).toEqual([]);
  const { json } = run(dir, '--strict-paths');
  expect(json.findings).toEqual([
    { kind: 'unanchored-path', file: 'README.md', line: 1, target: 'lib/util.js', matches: ['src/a/lib/util.js', 'src/lib/util.js'] },
  ]);
});

test('site-route links are quiet by default, broken-link with --strict-paths', () => {
  const dir = repo({
    'README.md': '[r](/projects/git-viewer/) [ok](/docs/a.md)\n',
    'docs/a.md': '# A\n',
  });
  expect(run(dir).json.findings).toEqual([]);
  expect(run(dir, '--strict-paths').json.findings).toEqual([
    { kind: 'broken-link', file: 'README.md', line: 1, target: '/projects/git-viewer/' },
  ]);
});

test('map is found through an @import of docs/map.md', () => {
  const dir = repo({
    'CLAUDE.md': '# Hi\n@docs/map.md\n',
    'docs/map.md': '<!-- md-network-map -->\n' + lines(80),
  });
  const { json } = run(dir, '--checks', 'limits');
  expect(json.map).toBe('docs/map.md');
  expect(json.notes).toEqual([]);
  expect(json.findings.some((f) => f.file === 'docs/map.md' && f.limit === 70)).toBe(true);
});

test('null map adds a note, not a finding', () => {
  const dir = repo({ 'CLAUDE.md': '# Hi\n' });
  const { code, json } = run(dir);
  expect(code).toBe(0);
  expect(json.map).toBeNull();
  expect(json.notes).toContain('no md-network-map comment found; the 70-line map limit was not applied');
  expect(json.findings).toEqual([]);
});

test('imports count toward the always-loaded limit', () => {
  const dir = repo({
    'CLAUDE.md': '# Hi\n' + lines(9) + '@docs/big.md\n',
    'docs/big.md': lines(250),
  });
  const { json } = run(dir, '--checks', 'limits');
  expect(json.findings).toEqual([
    { kind: 'over-line-limit', file: 'CLAUDE.md', lines: 11, expandedLines: 261, limit: 200 },
  ]);
});

test('import cycles terminate', () => {
  const dir = repo({
    'CLAUDE.md': '@a.md\n',
    'a.md': 'x\n@b.md\n',
    'b.md': 'y\n@a.md\n@CLAUDE.md\n@missing.md\n',
  });
  const { code, json } = run(dir, '--checks', 'limits');
  expect(code).toBe(0);
  expect(json.findings).toEqual([]);
});

test('emails, code spans, fences, home paths and outside-root targets are not imports', () => {
  const dir = repo({
    'CLAUDE.md': 'mail a@big.md here\n`@docs/big.md`\n```\n@docs/big.md\n```\n@~/big.md\n@../big.md\n',
    'docs/big.md': lines(250),
  });
  const { json } = run(dir, '--checks', 'limits');
  expect(json.findings).toEqual([]);
});

test('ellipsis spans are not path candidates; real missing paths still flagged', () => {
  const dir = repo({ 'README.md': '`src/main/...` `scripts/…` `src/a...` `src/main/missing.cjs`\n', 'src/x.js': '' });
  const t = run(dir).json.findings.map((f) => f.target);
  expect(t).toEqual(['src/main/missing.cjs']);
});

test('drift-check-ignore marker suppresses link and path findings on its line only', () => {
  const dir = repo({
    'README.md': [
      '[a](gone.md) `data/prds/x.md` <!-- drift-check-ignore -->',
      '[b](gone2.md) `data/prds/y.md`',
      '',
    ].join('\n'),
    'src/x.js': '',
  });
  for (const extra of [[], ['--strict-paths']]) {
    const f = run(dir, ...extra).json.findings;
    expect(f.every((x) => x.line === 2)).toBe(true);
    expect(f.map((x) => x.kind).sort()).toEqual(['broken-link', 'missing-path']);
  }
});

test('marker does not affect limit counts and has no effect inside a fence', () => {
  const dir = repo({
    'CLAUDE.md': '<!-- drift-check-ignore -->\n' + lines(205),
    'README.md': ['```', '`fenced/a.md` <!-- drift-check-ignore -->', '```', '`out/b.md` <!-- drift-check-ignore -->', '`out/c.md`', ''].join('\n'),
  });
  const f = run(dir).json.findings;
  expect(f.filter((x) => x.kind === 'over-line-limit')).toHaveLength(1);
  expect(f.filter((x) => x.kind === 'missing-path').map((x) => x.target)).toEqual(['out/c.md']);
  const dir2 = repo({ 'README.md': ['```', '<!-- drift-check-ignore -->', '```', '[x](gone.md)', ''].join('\n') });
  expect(run(dir2).json.findings.map((x) => x.kind)).toEqual(['broken-link']);
});

test('placeholder link targets are skipped, plain missing links still flagged', () => {
  const md = [
    '[issues]({{REPO_URL}}/issues) [b](${BASE}/x.md) [r](<repo>/docs/x.md) [e](a}}b.md)',
    '[gone](missing.md)',
    '',
  ].join('\n');
  for (const extra of [[], ['--strict-paths']]) {
    const dir = repo({ 'README.md': md });
    const f = run(dir, '--checks', 'links', ...extra).json.findings;
    expect(f).toEqual([{ kind: 'broken-link', file: 'README.md', line: 2, target: 'missing.md' }]);
  }
});

test('a normal broken link on the same line as a placeholder link is still flagged', () => {
  const dir = repo({ 'README.md': '[i]({{REPO_URL}}/issues) [gone](nope.md)\n' });
  const f = run(dir, '--checks', 'links').json.findings;
  expect(f.map((x) => x.target)).toEqual(['nope.md']);
});

test('missing link to a gitignored target is silent; non-ignored missing link still flagged', () => {
  const dir = repo({
    '.gitignore': 'runtime/\n',
    'CLAUDE.md': '# Hi\n[a](runtime/feedback/README.md)\n[b](docs/gone.md)\n',
  });
  for (const args of [[], ['--strict-paths']]) {
    const { json } = run(dir, ...args);
    const broken = json.findings.filter((f) => f.kind === 'broken-link');
    expect(broken.map((f) => f.target)).toEqual(['docs/gone.md']);
  }
});
