/**
 * mdDocCensus.test.cjs — the per-doc census behind Review MD network: roles
 * (with @-imports), record collections (heuristic + overrides), recency from a
 * real git log, counts, refs caps and malformed input.
 *
 * Run: timeout 300 npx vitest run src/main/lib/__tests__/mdDocCensus.test.cjs
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { censusMdDocs, parseGitLog, importsOf } = require('../mdDocCensus.cjs');

const reach = (entries) => new Map(entries.map(([p, depth, linkedFrom = 1]) => [p, { depth, linkedFrom }]));
const many = (folder, n) => Array.from({ length: n }, (_, i) => ({ path: `${folder}r${String(i).padStart(2, '0')}.md`, text: 'x' }));
const roleOf = (census, p) => census.docs.find((d) => d.path === p)?.role;

describe('importsOf', () => {
  it('finds @path.md imports outside code, resolved and distinct', () => {
    const text = [
      '@docs/a.md and see @./b.md.',
      'mail me@x.md is not an import; inline `@c.md` skipped',
      '```',
      '@fenced.md',
      '```',
      '  @../up.md @~/home.md @/abs.md @../../escape.md @notes.txt @docs/a.md',
    ].join('\n');
    expect(importsOf(text, 'sub/CLAUDE.md')).toEqual(['sub/docs/a.md', 'sub/b.md', 'up.md']);
    expect(importsOf('@x.md', 'CLAUDE.md')).toEqual(['x.md']);
  });
});

describe('censusMdDocs roles', () => {
  it('applies map > scoped > agent > record > doc', () => {
    const docs = [
      { path: 'CLAUDE.md', text: '# Map\n@docs/rules.md', lines: 2, bytes: 20 },
      { path: 'docs/rules.md', text: '@deep.md' },
      { path: 'docs/deep.md', text: 'leaf' },
      { path: 'src/CLAUDE.md', text: '' },
      { path: 'web/AGENTS.md' },
      { path: 'CLAUDE.local.md' },
      { path: '.claude/agents/x.md' },
      { path: 'plugins/p/skills/s/SKILL.md' },
      { path: 'plugins/p/commands/c.md' },
      { path: 'plugins/p/README.md' },
      { path: 'guide.md' },
      { path: 'linked.md' },
    ];
    const c = censusMdDocs({ docs, reachable: reach([['CLAUDE.md', 0], ['linked.md', 1, 2]]) });
    expect(c.docs.map((d) => [d.path, d.role])).toEqual([
      ['CLAUDE.md', 'map'],
      ['docs/rules.md', 'map'],
      ['docs/deep.md', 'map'],
      ['src/CLAUDE.md', 'scoped'],
      ['web/AGENTS.md', 'scoped'],
      ['CLAUDE.local.md', 'scoped'],
      ['.claude/agents/x.md', 'agent'],
      ['plugins/p/skills/s/SKILL.md', 'agent'],
      ['plugins/p/commands/c.md', 'agent'],
      ['plugins/p/README.md', 'doc'],
      ['guide.md', 'doc'],
      ['linked.md', 'doc'],
    ]);
    const root = c.docs[0];
    expect(root).toMatchObject({ depth: 0, lines: 2, bytes: 20, commits: 0, lastCommitMs: null, codeRefs: 0, codeRefFiles: [], deadRefs: [], changedSince: [], collection: null });
    expect(c.docs.find((d) => d.path === 'linked.md')).toMatchObject({ depth: 1, linkedFrom: 2 });
    expect(c.counts).toEqual({
      tracked: 12,
      network: 4,
      records: 0,
      unlinked: 2,
      byRole: { map: 3, scoped: 3, agent: 3, record: 0, doc: 3 },
    });
    expect(c.gitWindow).toEqual({ commits: 0, oldestMs: null });
  });
});

describe('censusMdDocs record collections', () => {
  const T = 1_700_000_000_000;
  it('marks an unlinked write-once 25-doc folder, not one with 3 reachable docs', () => {
    const records = many('ops/reviews/', 25);
    const lively = many('docs/', 25);
    // two linked docs in ops/ keep ops/ itself (28 docs, 7% linked) from qualifying
    const opsLinked = [{ path: 'ops/guide.md' }, { path: 'ops/plan.md' }];
    const docs = [{ path: 'CLAUDE.md', text: '' }, ...opsLinked, ...records, { path: 'ops/reviews/README.md' }, ...lively];
    const log = [
      { ms: T + 2000, files: ['ops/reviews/r00.md', 'docs/r00.md'] },
      { ms: T + 1000, files: ['ops/reviews/r01.md', 'ops/reviews/r00.md'] },
      { ms: T, files: records.map((d) => d.path) },
    ];
    const c = censusMdDocs({
      docs,
      reachable: reach([['CLAUDE.md', 0], ['ops/guide.md', 1], ['ops/plan.md', 1], ['docs/r00.md', 1], ['docs/r01.md', 1], ['docs/r02.md', 2]]),
      log,
    });
    expect(c.collections).toEqual([{ folder: 'ops/reviews/', docs: 26, linked: 0, lastCommitMs: T + 2000, source: 'heuristic' }]);
    expect(roleOf(c, 'ops/reviews/r05.md')).toBe('record');
    expect(c.docs.find((d) => d.path === 'ops/reviews/r05.md').collection).toBe('ops/reviews/');
    expect(roleOf(c, 'ops/reviews/README.md')).toBe('doc');
    expect(roleOf(c, 'docs/r10.md')).toBe('doc');
    expect(c.docs.find((d) => d.path === 'ops/reviews/r00.md')).toMatchObject({ commits: 3, lastCommitMs: T + 2000 });
    expect(c.counts.records).toBe(25);
    expect(c.gitWindow).toEqual({ commits: 3, oldestMs: T });
  });

  it('rejects a folder whose docs are rewritten often', () => {
    const docs = many('notes/', 22);
    const log = [1, 2, 3].map((i) => ({ ms: T + i, files: docs.map((d) => d.path) }));
    expect(censusMdDocs({ docs, reachable: new Map(), log }).collections).toEqual([]);
  });

  it('honours recordFolders and docFolders overrides', () => {
    const docs = [...many('ops/reviews/', 25), ...many('small/', 3)];
    const c = censusMdDocs({ docs, reachable: new Map(), recordFolders: ['small'], docFolders: ['ops/'] });
    expect(c.collections).toEqual([{ folder: 'small/', docs: 3, linked: 0, lastCommitMs: null, source: 'override' }]);
    expect(roleOf(c, 'small/r00.md')).toBe('record');
    expect(roleOf(c, 'ops/reviews/r00.md')).toBe('doc');
  });

  it('picks the shallowest qualifying folder, never the repo root', () => {
    const docs = many('', 30).concat(many('a/b/', 25));
    const c = censusMdDocs({ docs, reachable: new Map() });
    expect(c.collections.map((x) => x.folder)).toEqual(['a/']);
  });
});

describe('censusMdDocs refs', () => {
  it('caps refs fields from the optional maps', () => {
    const codes = Array.from({ length: 15 }, (_, i) => `src/f${i}.ts`);
    const dead = Array.from({ length: 12 }, (_, i) => `gone${i}.ts`);
    const changed = Array.from({ length: 25 }, (_, i) => ({ path: `src/f${i}.ts`, ms: i }));
    const c = censusMdDocs({
      docs: [{ path: 'a.md' }],
      reachable: new Map(),
      codeMentions: new Map([['a.md', codes]]),
      refs: new Map([['a.md', { deadRefs: dead, changedSince: changed }]]),
    });
    const d = c.docs[0];
    expect(d.codeRefs).toBe(15);
    expect(d.codeRefFiles).toEqual(codes.slice(0, 10));
    expect(d.deadRefs).toEqual(dead.slice(0, 10));
    expect(d.changedSince).toEqual(changed.slice(0, 20));
  });

  it('never throws on malformed input', () => {
    const c = censusMdDocs({
      docs: [null, { path: 5 }, { path: 'a.md', lines: 'x' }, { path: 'a.md' }],
      reachable: new Map(),
      log: [null, { ms: 'x', files: [] }, { ms: 1000, files: ['a.md', 7] }],
    });
    expect(c.docs).toHaveLength(1);
    expect(c.docs[0]).toMatchObject({ path: 'a.md', lines: null, commits: 1, lastCommitMs: 1000 });
    expect(c.warnings.length).toBe(2);
  });
});

describe('parseGitLog', () => {
  it('parses real git log output, newest first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-census-'));
    try {
      const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
      git('init', '-q');
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'one');
      fs.mkdirSync(path.join(dir, 'docs'));
      fs.writeFileSync(path.join(dir, 'docs', 'a.md'), 'a');
      git('add', '.');
      const commit = (msg, date) =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg], {
          cwd: dir,
          env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
        });
      commit('one', '2020-01-01T00:00:00Z');
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'two');
      git('add', '.');
      commit('two', '2021-01-01T00:00:00Z');
      const out = git('log', '--max-count=2000', '--no-renames', '--format=%x01%ct', '--name-only', '-z');
      const log = parseGitLog(out);
      expect(log).toHaveLength(2);
      expect(log[0].files).toEqual(['CLAUDE.md']);
      expect(log[1].files.sort()).toEqual(['CLAUDE.md', 'docs/a.md']);
      expect(log.map((e) => e.ms)).toEqual([Date.parse('2021-01-01T00:00:00Z'), Date.parse('2020-01-01T00:00:00Z')]);
      const c = censusMdDocs({ docs: [{ path: 'CLAUDE.md' }, { path: 'docs/a.md' }], reachable: new Map(), log });
      expect(c.docs.map((d) => [d.commits, d.lastCommitMs])).toEqual([[2, log[0].ms], [1, log[1].ms]]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] for empty or unparseable input', () => {
    expect(parseGitLog('')).toEqual([]);
    expect(parseGitLog('CLAUDE.md\0')).toEqual([]);
    expect(parseGitLog('\x01abc\nx.md')).toEqual([]);
    expect(parseGitLog(/** @type {any} */ (null))).toEqual([]);
  });
});
