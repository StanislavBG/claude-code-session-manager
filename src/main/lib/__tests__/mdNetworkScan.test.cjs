/**
 * mdNetworkScan.test.cjs — the markdown link network behind Project Home's
 * Tools > Review MD network: reachability from CLAUDE.md, broken and escaping
 * links, ignored link kinds, orphan folders, the read bounds and the error
 * results. buildMdNetwork runs on in-memory docs, scanMdNetwork on injected
 * git/fs fakes, plus one scratch git repo for the real default wiring.
 *
 * Run: timeout 300 npx vitest run src/main/lib/__tests__/mdNetworkScan.test.cjs
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildMdNetwork, scanMdNetwork, LOADED_BY_TOOLS } = require('../mdNetworkScan.cjs');

const doc = (p, ...lines) => ({ path: p, text: lines.join('\n') });
const brokenLinks = (r) => r.findings.filter((f) => f.type === 'broken-link');
const MISSING = 'The link target doesn’t exist.';
const ESCAPES = 'The link target is outside the project.';
const LOCAL_ONLY = 'Works only on this machine: the target is not tracked in git.';
const LOG_ARGS = ['log', '--max-count=2000', '--no-renames', '--format=%x01%ct', '--name-only', '-z'];

describe('buildMdNetwork', () => {
  it('reaches every doc linked from CLAUDE.md breadth-first, typed by depth and name', () => {
    const r = buildMdNetwork({
      files: [
        doc('CLAUDE.md', '# Map', '- [src](src/CLAUDE.md)', '- [guide](docs/guide.md#setup) and <README.md>'),
        doc('README.md', 'Back to [the map](CLAUDE.md).'),
        doc('src/CLAUDE.md', 'See [a](a.md) and [the guide](../docs/guide.md?plain=1).'),
        doc('src/a.md', '[deeper](nested/CLAUDE.md) [itself](a.md)'),
        doc('src/nested/CLAUDE.md', 'leaf'),
        doc('docs/guide.md', '[a again](../src/a.md)'),
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.root).toBe('CLAUDE.md');
    expect(r.nodes).toEqual([
      { id: 'CLAUDE.md', path: 'CLAUDE.md', depth: 0, type: 'hub', linksOut: 3, linkedFrom: 1 },
      { id: 'src/CLAUDE.md', path: 'src/CLAUDE.md', depth: 1, type: 'owner', linksOut: 2, linkedFrom: 1 },
      { id: 'docs/guide.md', path: 'docs/guide.md', depth: 1, type: 'doc', linksOut: 1, linkedFrom: 2 },
      { id: 'README.md', path: 'README.md', depth: 1, type: 'owner', linksOut: 1, linkedFrom: 1 },
      { id: 'src/a.md', path: 'src/a.md', depth: 2, type: 'doc', linksOut: 1, linkedFrom: 2 },
      { id: 'src/nested/CLAUDE.md', path: 'src/nested/CLAUDE.md', depth: 3, type: 'doc', linksOut: 0, linkedFrom: 1 },
    ]);
    expect(r.edges).toEqual([
      { from: 'CLAUDE.md', to: 'src/CLAUDE.md' },
      { from: 'CLAUDE.md', to: 'docs/guide.md' },
      { from: 'CLAUDE.md', to: 'README.md' },
      { from: 'src/CLAUDE.md', to: 'src/a.md' },
      { from: 'src/CLAUDE.md', to: 'docs/guide.md' },
      { from: 'docs/guide.md', to: 'src/a.md' },
      { from: 'README.md', to: 'CLAUDE.md' },
      { from: 'src/a.md', to: 'src/nested/CLAUDE.md' },
    ]);
    expect(r.findings).toEqual([]);
    expect([r.docs, r.links]).toEqual([6, 8]);
    expect(r.scopes).toEqual(['docs/', 'src/']);
  });

  it('reports a missing target with its file and line, and a target escaping the project', () => {
    const r = buildMdNetwork({
      files: [
        doc('CLAUDE.md', '# Map', '', 'Read [the gone doc](docs/gone.md#intro) first.', '[src](src/CLAUDE.md)'),
        doc('src/CLAUDE.md', 'line one', '[up and out](../../outside.md)'),
      ],
    });
    expect(brokenLinks(r)).toEqual([
      { type: 'broken-link', file: 'CLAUDE.md', line: 3, target: 'docs/gone.md', to: 'docs/gone.md', where: 'CLAUDE.md:3 → docs/gone.md', detail: MISSING },
      { type: 'broken-link', file: 'src/CLAUDE.md', line: 2, target: '../../outside.md', to: '../outside.md', where: 'src/CLAUDE.md:2 → ../../outside.md', detail: ESCAPES },
    ]);
    expect(r.edges).toEqual([
      { from: 'CLAUDE.md', to: 'docs/gone.md', broken: true },
      { from: 'CLAUDE.md', to: 'src/CLAUDE.md' },
      { from: 'src/CLAUDE.md', to: '../outside.md', broken: true },
    ]);
    expect(r.nodes.map((n) => n.id)).toEqual(['CLAUDE.md', 'src/CLAUDE.md']);
    expect(r.nodes.map((n) => n.linksOut)).toEqual([2, 1]);
  });

  it('counts folders and targets `exists` vouches for as present, without drawing edges to them', () => {
    const files = [doc('CLAUDE.md', '[code](src/main.cjs) [docs folder](docs/) [here](./)', '[a](docs/a.md)'), doc('docs/a.md', '')];
    const vouched = buildMdNetwork({ files, exists: (p) => p === 'src/main.cjs' });
    expect(brokenLinks(vouched)).toEqual([]);
    expect(vouched.edges).toEqual([{ from: 'CLAUDE.md', to: 'docs/a.md' }]);
    expect(brokenLinks(buildMdNetwork({ files })).map((f) => f.where)).toEqual(['CLAUDE.md:1 → src/main.cjs']);
  });

  it('ignores external, mailto, absolute and anchor-only links, and links inside code or comments', () => {
    const r = buildMdNetwork({
      files: [
        doc(
          'CLAUDE.md',
          '[site](https://example.com/x.md) [plain](http://example.com) <https://example.com/y.md>',
          '[mail](mailto:dev@example.com) [top](#section) [web route](/pricing) [empty]()',
          'Inline `[code](missing-inline.md)` is prose, not a link.',
          '```md',
          '[fenced](missing-fenced.md)',
          '```',
          '<!-- [commented](missing-comment.md) -->',
          '[kept](docs/a.md "title")',
        ),
        doc('docs/a.md', ''),
      ],
    });
    expect(r.findings).toEqual([]);
    expect(r.edges).toEqual([{ from: 'CLAUDE.md', to: 'docs/a.md' }]);
  });

  it('groups docs no link path reaches into one orphan finding per top-level folder', () => {
    const r = buildMdNetwork({
      files: [
        doc('CLAUDE.md', '[linked](notes/linked.md)'),
        doc('notes/linked.md', ''),
        doc('notes/deep/lost.md', 'An orphan linking [another orphan](../lost-too.md) is still lost.'),
        doc('notes/lost-too.md', ''),
        doc('TODO.md', ''),
      ],
    });
    expect(r.findings).toEqual([
      {
        type: 'orphan',
        where: './',
        count: 1,
        paths: ['TODO.md'],
        detail: 'No link path from CLAUDE.md reaches this doc, so agents starting there never find it.',
      },
      {
        type: 'orphan',
        where: 'notes/',
        count: 2,
        paths: ['notes/deep/lost.md', 'notes/lost-too.md'],
        detail: 'No link path from CLAUDE.md reaches these 2 docs, so agents starting there never find them.',
      },
    ]);
    expect(r.docs).toBe(5);
    expect(r.scopes).toEqual(['notes/']);
  });

  it('leaves `records` paths out of orphan groups, dropping a group that is all records', () => {
    const files = [doc('CLAUDE.md', ''), doc('log/a.md', ''), doc('log/b.md', ''), doc('notes/x.md', ''), doc('notes/y.md', '')];
    const r = buildMdNetwork({ files, records: new Set(['log/a.md', 'log/b.md', 'notes/x.md']) });
    expect(r.findings.map((f) => [f.where, f.paths])).toEqual([['notes/', ['notes/y.md']]]);
    expect(buildMdNetwork({ files }).findings.map((f) => f.where)).toEqual(['log/', 'notes/']);
  });

  it('never orphans docs a tool loads by name: .claude/, .github/, plugins/, src/seed/, any skills/ folder and GitHub root files', () => {
    expect(LOADED_BY_TOOLS).toEqual(['.claude/', '.github/', 'plugins/', 'src/seed/']);
    const files = [
      doc('CLAUDE.md', ''),
      doc('.claude/agents/dev-lead.md', ''),
      doc('src/seed/welcome.md', ''),
      doc('.github/PULL_REQUEST_TEMPLATE.md', ''),
      doc('plugins/packs/x/rules.md', ''),
      doc('tools/skills/run/SKILL.md', ''),
      doc('README.md', ''),
      doc('CONTRIBUTING.md', ''),
      doc('CHANGELOG.md', ''),
      doc('docs/README.md', ''),
      doc('extra/loaded.md', ''),
    ];
    const r = buildMdNetwork({ files });
    expect(r.findings.map((f) => [f.where, f.paths])).toEqual([
      ['docs/', ['docs/README.md']],
      ['extra/', ['extra/loaded.md']],
    ]);
    const extra = buildMdNetwork({ files, loadedByTools: ['extra/'] });
    expect(extra.findings.map((f) => f.where)).toEqual(['docs/']);
  });

  it('never walks history or record docs: links into them are edges, but their own links pull nothing in', () => {
    const files = [
      doc('CLAUDE.md', '[past](history/2026-01-01.md) [rec](log/a.md)'),
      doc('history/2026-01-01.md', '[gone](nowhere.md) [only via history](notes/old.md)'),
      doc('history/2026-02-01.md', ''),
      doc('log/a.md', '[via record](notes/rec.md)'),
      doc('notes/old.md', ''),
      doc('notes/rec.md', ''),
    ];
    const r = buildMdNetwork({ files, history: ['history/'], records: new Set(['log/a.md']) });
    expect(r.edges).toEqual([
      { from: 'CLAUDE.md', to: 'history/2026-01-01.md' },
      { from: 'CLAUDE.md', to: 'log/a.md' },
    ]);
    expect(r.nodes.map((n) => [n.id, n.depth, n.linksOut])).toEqual([
      ['CLAUDE.md', 0, 2],
      ['history/2026-01-01.md', 1, 0],
      ['log/a.md', 1, 0],
    ]);
    expect(brokenLinks(r)).toEqual([]);
    // history docs are never orphans; docs only a history/record doc links to are
    expect(r.findings.map((f) => [f.where, f.paths])).toEqual([['notes/', ['notes/old.md', 'notes/rec.md']]]);
  });

  it('follows backticked repo-root .md paths in a table like links', () => {
    const r = buildMdNetwork({
      files: [
        doc('CLAUDE.md', '| Doc | Covers |', '| --- | --- |', '| `docs/a.md` | a |', '| `docs/b.md` | b |', '| `src/CLAUDE.md` | src |'),
        doc('docs/a.md', 'a'),
        doc('docs/b.md', 'b'),
        doc('src/CLAUDE.md', 'src'),
      ],
    });
    expect(r.findings).toEqual([]);
    expect(r.edges).toEqual([
      { from: 'CLAUDE.md', to: 'docs/a.md' },
      { from: 'CLAUDE.md', to: 'docs/b.md' },
      { from: 'CLAUDE.md', to: 'src/CLAUDE.md' },
    ]);
    expect(r.links).toBe(3);
  });

  it('follows an @-import, so the imported map and the docs it links are reachable', () => {
    const r = buildMdNetwork({
      files: [
        doc('CLAUDE.md', '@docs/map.md'),
        doc('docs/map.md', '- [a](a.md)', '- [b](sub/b.md)'),
        doc('docs/a.md', ''),
        doc('docs/sub/b.md', ''),
      ],
    });
    expect(r.findings).toEqual([]);
    expect(r.nodes.map((n) => [n.path, n.depth])).toEqual([
      ['CLAUDE.md', 0],
      ['docs/map.md', 1],
      ['docs/a.md', 2],
      ['docs/sub/b.md', 2],
    ]);
    expect(r.links).toBe(3);
  });

  it('never draws edges or findings for fenced, commented, dead or non-.md backticked paths', () => {
    const r = buildMdNetwork({
      files: [
        doc('CLAUDE.md', '```', '`docs/fenced.md`', '@docs/fenced.md', '```', '<!-- `docs/commented.md` -->', '`docs/gone.md` `src/x.ts` `docs/` `@docs/ignored.md`'),
        doc('docs/fenced.md', ''),
        doc('docs/commented.md', ''),
        doc('docs/ignored.md', ''),
      ],
      exists: (p) => p === 'src/x.ts',
    });
    expect(r.edges).toEqual([]);
    expect(r.links).toBe(0);
    expect(brokenLinks(r)).toEqual([]);
    expect(r.findings.map((f) => [f.type, f.paths])).toEqual([['orphan', ['docs/commented.md', 'docs/fenced.md', 'docs/ignored.md']]]);
  });

  it('resolves a nested doc’s backticked path doc-relative when the root form is not a doc', () => {
    const r = buildMdNetwork({
      files: [
        doc('CLAUDE.md', 'See `src/CLAUDE.md`.'),
        doc('src/CLAUDE.md', 'Read `lib/notes.md` and `docs/top.md`.'),
        doc('src/lib/notes.md', ''),
        doc('docs/top.md', ''),
      ],
    });
    expect(r.findings).toEqual([]);
    expect(r.edges).toEqual([
      { from: 'CLAUDE.md', to: 'src/CLAUDE.md' },
      { from: 'src/CLAUDE.md', to: 'src/lib/notes.md' },
      { from: 'src/CLAUDE.md', to: 'docs/top.md' },
    ]);
  });

  it('returns { ok: false, error } for a missing root or bad input', () => {
    expect(buildMdNetwork({ files: [doc('README.md', '')] })).toEqual({ ok: false, error: 'no CLAUDE.md at the project root' });
    const bad = buildMdNetwork({ files: null });
    expect(bad.ok).toBe(false);
    expect(typeof bad.error).toBe('string');
  });
});

describe('scanMdNetwork with injected git and fs', () => {
  const enoent = () => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });

  it('reads at most 2000 docs, 256 KB each, 32 at a time: the root and its links first, then the shallowest', async () => {
    const bulk = Array.from({ length: 2500 }, (_, i) => `bulk/doc-${String(i).padStart(4, '0')}.md`);
    const listing = `${['CLAUDE.md', ...bulk, 'z/y/x/deep.md', 'q/w/e/r/far.md', 'src/main.cjs'].join('\0')}\0`;
    const texts = { 'CLAUDE.md': '[deep](z/y/x/deep.md) [code](src/main.cjs)', 'z/y/x/deep.md': '[last](../../../bulk/doc-2499.md)' };
    const gitCalls = [];
    const reads = [];
    let existsCalls = 0;
    let inFlight = 0;
    let peak = 0;
    const r = await scanMdNetwork('/repo', {
      execGit: async (cwd, args) => {
        gitCalls.push([cwd, args]);
        return listing;
      },
      readFile: async (abs, maxBytes) => {
        const rel = path.relative('/repo', abs).split(path.sep).join('/');
        reads.push([rel, maxBytes]);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return texts[rel] ?? '';
      },
      exists: async () => {
        existsCalls += 1;
        return false;
      },
    });
    expect(gitCalls.map(([cwd, args]) => [cwd, args[0]])).toEqual([
      ['/repo', 'ls-files'],
      ['/repo', 'log'],
      ['/repo', 'grep'],
    ]);
    expect(gitCalls[0][1]).toEqual(['ls-files', '-z']);
    expect(gitCalls[1][1]).toEqual(LOG_ARGS);
    expect(gitCalls[2][1].slice(0, 6)).toEqual(['grep', '--no-color', '-I', '-F', '-o', '--null']);
    expect(gitCalls[2][1].slice(-3)).toEqual(['--', '.', ':(exclude)*.md']);
    expect(gitCalls[2][1].slice(6, 10)).toEqual(['-e', 'CLAUDE.md', '-e', 'bulk/doc-0000.md']);
    expect(reads).toHaveLength(2000);
    expect(new Set(reads.map(([, maxBytes]) => maxBytes))).toEqual(new Set([256 * 1024]));
    expect(peak).toBe(32);
    expect(reads.slice(0, 3).map(([rel]) => rel)).toEqual(['CLAUDE.md', 'z/y/x/deep.md', 'bulk/doc-2499.md']);
    expect(reads.some(([rel]) => rel === 'q/w/e/r/far.md')).toBe(false);
    expect(existsCalls).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.docs).toBe(2000);
    expect(r.nodes.map((n) => n.id)).toEqual(['CLAUDE.md', 'z/y/x/deep.md', 'bulk/doc-2499.md']);
    expect(brokenLinks(r)).toEqual([]);
    expect(r.census.docs).toHaveLength(2503);
    expect(r.census.docs.find((d) => d.path === 'q/w/e/r/far.md')).toMatchObject({ lines: null, bytes: null });
    expect(r.census.docs.find((d) => d.path === 'CLAUDE.md')).toMatchObject({ role: 'map', lines: 1, depth: 0 });
  });

  /** A fake repo: `git` answers by subcommand, files come from `texts`. */
  const fakeRepo = ({ tracked, texts, log = '', grep = '', onDisk = () => false, probes = [], ignore = () => false }) => {
    const gitCalls = [];
    return {
      gitCalls,
      deps: {
        execGit: async (cwd, args, opts) => {
          gitCalls.push({ args, opts });
          if (args[0] === 'ls-files') return `${tracked.join('\0')}\0`;
          if (args[0] === 'log') {
            if (log instanceof Error) throw log;
            return log;
          }
          if (args[0] === 'grep') {
            if (grep instanceof Error) throw grep;
            return grep;
          }
          if (args.includes('check-ignore')) {
            const asked = args.slice(args.indexOf('--') + 1);
            const link = asked.find((p) => p.startsWith('linked/'));
            if (link) throw Object.assign(new Error('Command failed'), { code: 128, stderrText: `fatal: pathspec '${link}' is beyond a symbolic link\n` });
            const hits = asked.filter(ignore);
            if (hits.length === 0) throw Object.assign(new Error('Command failed: git check-ignore'), { code: 1 });
            return `${hits.join('\n')}\n`;
          }
          throw new Error(`unexpected git ${args[0]}`);
        },
        readFile: async (abs) => {
          const rel = path.relative('/repo', abs).split(path.sep).join('/');
          if (!(rel in texts)) throw enoent();
          return texts[rel];
        },
        exists: async (abs) => {
          const rel = path.relative('/repo', abs).split(path.sep).join('/');
          probes.push(rel);
          return onDisk(rel);
        },
      },
    };
  };
  const at = (sec, ...files) => `\x01${sec}\n\0${files.join('\0')}\0`;

  it('attaches a census: sizes, recency from one git log, refs and code mentions from one git grep', async () => {
    const { deps, gitCalls } = fakeRepo({
      tracked: ['CLAUDE.md', 'docs/a.md', 'docs/orphan.md', 'src/main.cjs', 'src/util.cjs'],
      texts: {
        'CLAUDE.md': '# Map\n[a](docs/a.md)\n',
        'docs/a.md': 'Uses `src/main.cjs`, `src/util.cjs` and `src/gone.cjs`.\n[code](../src/main.cjs)',
        'docs/orphan.md': '',
      },
      log: `${at(300, 'src/main.cjs')}${at(200, 'docs/a.md', 'CLAUDE.md')}${at(100, 'src/util.cjs', 'docs/a.md')}`,
      grep: 'src/main.cjs\0docs/a.md\nsrc/util.cjs\0docs/a.md\nsrc/util.cjs\0docs/a.md\n',
    });
    const r = await scanMdNetwork('/repo', deps);
    expect(r.ok).toBe(true);
    expect(gitCalls.map((c) => c.args.find((a) => a !== '-c' && !a.includes('=')))).toEqual(['ls-files', 'check-ignore', 'log', 'grep']);
    expect(gitCalls[2]).toEqual({ args: LOG_ARGS, opts: { maxBuffer: 64 * 1024 * 1024 } });
    expect(gitCalls[3].opts).toEqual({ maxBuffer: 16 * 1024 * 1024 });
    expect(r.census.warnings).toEqual([]);
    expect(r.census.gitWindow).toEqual({ commits: 3, oldestMs: 100000 });
    const byPath = new Map(r.census.docs.map((d) => [d.path, d]));
    expect([...byPath.keys()]).toEqual(['CLAUDE.md', 'docs/a.md', 'docs/orphan.md']);
    expect(byPath.get('CLAUDE.md')).toMatchObject({ role: 'map', depth: 0, lines: 3, bytes: 21, lastCommitMs: 200000, commits: 1 });
    expect(byPath.get('docs/a.md')).toMatchObject({
      role: 'doc',
      depth: 1,
      linkedFrom: 1,
      lastCommitMs: 200000,
      commits: 2,
      codeRefs: 2,
      codeRefFiles: ['src/main.cjs', 'src/util.cjs'],
      deadRefs: ['src/gone.cjs'],
      changedSince: [{ path: 'src/main.cjs', ms: 300000 }],
    });
    expect(byPath.get('docs/orphan.md')).toMatchObject({ depth: null, lines: 0, bytes: 0, lastCommitMs: null });
    expect(r.findings.map((f) => f.where)).toEqual(['docs/']);
  });

  it('resolves shorthand refs by suffix, lists ambiguous ones, and never calls a gitignored ref dead', async () => {
    const { deps, gitCalls } = fakeRepo({
      tracked: ['CLAUDE.md', 'src/renderer/lib/epicIntake.ts', 'a/x/CLAUDE.md', 'b/x/CLAUDE.md'],
      texts: { 'CLAUDE.md': 'See `lib/epicIntake.ts`, `x/CLAUDE.md`, `linked/pkg/a.json`, `dist/index.html`, `logs/` and `src/gone.cjs`.', 'a/x/CLAUDE.md': '', 'b/x/CLAUDE.md': '' },
      ignore: (p) => p === 'dist/index.html' || p === 'logs/',
    });
    const r = await scanMdNetwork('/repo', deps);
    expect(r.census.warnings).toEqual([]);
    // a path beyond a symlink fails the call; it is dropped and the rest retried
    const asked = gitCalls.filter((c) => c.args.includes('check-ignore')).map((c) => c.args.slice(c.args.indexOf('--') + 1));
    expect(asked).toEqual([
      ['lib/epicIntake.ts', 'x/CLAUDE.md', 'linked/pkg/a.json', 'dist/index.html', 'logs/', 'src/gone.cjs'],
      ['lib/epicIntake.ts', 'x/CLAUDE.md', 'dist/index.html', 'logs/', 'src/gone.cjs'],
    ]);
    expect(r.census.docs.find((d) => d.path === 'CLAUDE.md')).toMatchObject({ deadRefs: ['linked/pkg/a.json', 'src/gone.cjs'], ambiguousRefs: ['x/CLAUDE.md'] });
  });

  it('degrades a failing git log or git grep to null recency / zero code refs plus a warning', async () => {
    const noCommits = Object.assign(new Error('Command failed: git log'), {
      code: 128,
      stderrText: "fatal: your current branch 'main' does not have any commits yet\n",
    });
    const overflow = Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
    const base = { tracked: ['CLAUDE.md', 'src/x.cjs'], texts: { 'CLAUDE.md': 'see `src/x.cjs`' } };
    const failed = await scanMdNetwork('/repo', fakeRepo({ ...base, log: noCommits, grep: overflow }).deps);
    expect(failed.ok).toBe(true);
    expect(failed.census.warnings).toEqual([
      "git history unavailable: fatal: your current branch 'main' does not have any commits yet",
      'code mentions unavailable: stdout maxBuffer length exceeded',
    ]);
    expect(failed.census.docs[0]).toMatchObject({ lastCommitMs: null, commits: 0, codeRefs: 0, deadRefs: [] });
    expect(failed.census.gitWindow).toEqual({ commits: 0, oldestMs: null });

    const noMatch = Object.assign(new Error('Command failed: git grep'), { code: 1, stderrText: '' });
    const quiet = await scanMdNetwork('/repo', fakeRepo({ ...base, grep: noMatch }).deps);
    expect(quiet.ok).toBe(true);
    expect(quiet.census.warnings).toEqual([]);
    expect(quiet.census.docs[0].codeRefs).toBe(0);

    const garbled = await scanMdNetwork('/repo', fakeRepo({ ...base, log: 'not a git log' }).deps);
    expect(garbled.ok).toBe(true);
    expect(garbled.census.warnings).toEqual(['git history unavailable: unparseable git log output']);
  });

  it('probes untracked backticked paths on disk 32 at a time, at most 500, and counts the rest as existing', async () => {
    const tokens = (doc) => Array.from({ length: 200 }, (_, i) => `\`gone/${doc}-${i}.cjs\``).join(' ');
    const texts = { 'CLAUDE.md': `${tokens('r')}\n[a](a.md) [b](b.md)`, 'a.md': tokens('a'), 'b.md': tokens('b') };
    const probes = [];
    let inFlight = 0;
    let peak = 0;
    const { deps } = fakeRepo({ tracked: ['CLAUDE.md', 'a.md', 'b.md'], texts, probes });
    const exists = deps.exists;
    deps.exists = async (abs) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return exists(abs);
    };
    const r = await scanMdNetwork('/repo', deps);
    expect(r.ok).toBe(true);
    expect(probes).toHaveLength(500);
    expect(peak).toBe(32);
    const dead = r.census.docs.reduce((n, d) => n + d.deadRefs.length, 0);
    expect(dead).toBe(30); // per-doc deadRefs is capped at 10 by the census
    expect(r.census.docs.find((d) => d.path === 'b.md').deadRefs).toHaveLength(10);
    // b.md's last 100 tokens were never probed, so they are not dead
    const bProbed = new Set(probes.filter((p) => p.startsWith('gone/b-')));
    expect(bProbed.size).toBe(100);
  });

  it('keeps record collections out of orphan findings, from the heuristic or an override folder', async () => {
    const records = Array.from({ length: 25 }, (_, i) => `records/r-${String(i).padStart(2, '0')}.md`);
    const tracked = ['CLAUDE.md', 'notes/lost.md', ...records];
    const texts = Object.fromEntries(tracked.map((p) => [p, p === 'CLAUDE.md' ? '# Map' : '']));
    const r = await scanMdNetwork('/repo', fakeRepo({ tracked, texts }).deps);
    expect(r.census.collections.map((c) => [c.folder, c.source])).toEqual([['records/', 'heuristic']]);
    expect(r.census.counts.records).toBe(25);
    expect(r.findings.map((f) => f.where)).toEqual(['notes/']);
    expect(r.nodes.map((n) => n.id)).toEqual(['CLAUDE.md']);

    const forced = await scanMdNetwork('/repo', fakeRepo({ tracked, texts }).deps, { recordFolders: ['notes'], docFolders: ['records/'] });
    expect(forced.census.collections.map((c) => [c.folder, c.source])).toEqual([['notes/', 'override']]);
    expect(forced.findings.map((f) => [f.where, f.count])).toEqual([['records/', 25]]);

    // A linked record is a leaf: its own links pull nothing into the network.
    const linked = { ...texts, 'CLAUDE.md': '[one record](records/r-00.md)', 'records/r-00.md': '[lost](../notes/lost.md)' };
    const leaf = await scanMdNetwork('/repo', fakeRepo({ tracked, texts: linked }).deps);
    expect(leaf.census.collections.map((c) => c.folder)).toEqual(['records/']);
    expect(leaf.nodes.map((n) => n.id)).toEqual(['CLAUDE.md', 'records/r-00.md']);
    expect(leaf.findings.map((f) => f.where)).toEqual(['notes/']);
  });

  it('reads mdNetwork.loadedByTools / history from a tracked .session-manager.json, warning on a malformed one', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'md-network-cfg-'));
    try {
      const tracked = ['.session-manager.json', 'CLAUDE.md', 'past/old.md', 'agents/a.md', 'notes/n.md'];
      const texts = { 'CLAUDE.md': '[old](past/old.md)', 'past/old.md': '[n](../notes/n.md)', 'agents/a.md': '', 'notes/n.md': '' };
      const deps = fakeRepo({ tracked, texts }).deps;
      fs.writeFileSync(path.join(base, '.session-manager.json'), JSON.stringify({ mdNetwork: { loadedByTools: ['agents/'], history: ['past/'] } }));
      const r = await scanMdNetwork(base, { ...deps, readFile: async (abs) => deps.readFile(path.join('/repo', path.relative(base, abs))) });
      expect(r.nodes.map((n) => n.id)).toEqual(['CLAUDE.md', 'past/old.md']);
      expect(r.findings.map((f) => [f.where, f.paths])).toEqual([['notes/', ['notes/n.md']]]);
      expect(r.census.warnings).toEqual([]);

      fs.writeFileSync(path.join(base, '.session-manager.json'), '{ not json');
      const bad = await scanMdNetwork(base, { ...deps, readFile: async (abs) => deps.readFile(path.join('/repo', path.relative(base, abs))) });
      expect(bad.nodes.map((n) => n.id)).toEqual(['CLAUDE.md', 'past/old.md', 'notes/n.md']);
      expect(bad.findings.map((f) => f.where)).toEqual(['agents/']);
      expect(bad.census.warnings).toEqual([expect.stringMatching(/^\.session-manager\.json unreadable, mdNetwork settings ignored: /)]);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('reports duplicated text between living docs, never against history or record docs', async () => {
    const shared = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const records = Array.from({ length: 25 }, (_, i) => `records/r-${String(i).padStart(2, '0')}.md`);
    const tracked = ['CLAUDE.md', 'docs/a.md', 'docs/b.md', 'past/old.md', ...records];
    const texts = {
      ...Object.fromEntries(records.map((p) => [p, ''])),
      'CLAUDE.md': '[a](docs/a.md) [b](docs/b.md) [old](past/old.md)',
      'docs/a.md': `# A\n\n${shared}\n\nOnly in a.`,
      'docs/b.md': `# B\n\nIntro to b.\n\n${shared}`,
      'past/old.md': `# Old\n\n${shared}`,
      'records/r-00.md': `# Rec\n\n${shared}`,
    };
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'md-network-dup-'));
    try {
      fs.writeFileSync(path.join(base, '.session-manager.json'), JSON.stringify({ mdNetwork: { history: ['past/'] } }));
      const deps = fakeRepo({ tracked: ['.session-manager.json', ...tracked], texts }).deps;
      const r = await scanMdNetwork(base, { ...deps, readFile: async (abs) => deps.readFile(path.join('/repo', path.relative(base, abs))) });
      expect(r.ok).toBe(true);
      expect(r.census.collections.map((c) => c.folder)).toEqual(['records/']);
      expect(r.duplicates).toHaveLength(1);
      expect(r.duplicates[0]).toMatchObject({ a: 'docs/a.md', b: 'docs/b.md', sharedRuns: 23 });
      expect(r.duplicates[0].samples[0]).toContain('word0 word1');
      expect(r.census.warnings).toEqual([]);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('degrades a duplicates failure to [] plus a census warning', async () => {
    const tracked = ['CLAUDE.md'];
    const texts = { 'CLAUDE.md': '# Map' };
    const dupMod = require('../../../../plugins/session-manager-dev/skills/maintaining-md-network/scripts/mdDuplicates.cjs');
    const real = dupMod.findDuplicates;
    dupMod.findDuplicates = () => {
      throw new Error('boom');
    };
    try {
      const r = await scanMdNetwork('/repo', fakeRepo({ tracked, texts }).deps);
      expect(r.ok).toBe(true);
      expect(r.duplicates).toEqual([]);
      expect(r.census.warnings).toEqual(['duplicates unavailable: boom']);
    } finally {
      dupMod.findDuplicates = real;
    }
  });

  it('returns the missing-root error when CLAUDE.md cannot be found', async () => {
    const r = await scanMdNetwork('/repo', {
      execGit: async () => 'README.md\0',
      readFile: async () => {
        throw enoent();
      },
      exists: async () => false,
    });
    expect(r).toEqual({ ok: false, error: 'no CLAUDE.md at the project root' });
  });

  it('turns a failing git listing or an unreadable root into { ok: false, error }', async () => {
    const notRepo = Object.assign(new Error('Command failed: git ls-files -z'), { stderrText: 'fatal: not a git repository\n' });
    const noGit = await scanMdNetwork('/repo', {
      execGit: async () => {
        throw notRepo;
      },
    });
    expect(noGit).toEqual({ ok: false, error: 'git ls-files failed: fatal: not a git repository' });
    const denied = await scanMdNetwork('/repo', {
      execGit: async () => 'CLAUDE.md\0',
      readFile: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
      exists: async () => true,
    });
    expect(denied).toEqual({ ok: false, error: 'EACCES: permission denied' });
  });
});

describe('scanMdNetwork on a scratch git repo (real git and fs)', () => {
  let root;
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-network-scan-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists tracked docs with git, flags untracked targets local-only and reads at most 256 KB per doc', async () => {
    write('CLAUDE.md', ['# Map', '[big](docs/big.md)', '[local notes](local.txt)', '[gone](docs/gone.md)', '[ignored, absent](cache/out.md)', '[untracked](scratch.txt)'].join('\n'));
    write('docs/big.md', `${'x'.repeat(300 * 1024)}\n[past the read cap](missing-late.md)\n`);
    write('notes/orphan.md', 'nobody links here');
    write('.gitignore', 'local.txt\ncache/\nscratch.txt\n');
    write('local.txt', 'on disk, not tracked');
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'pipe' });
    write('.gitignore', 'local.txt\ncache/\n'); // scratch.txt: on disk, untracked, not ignored
    write('scratch.txt', 'untracked');

    const r = await scanMdNetwork(root);
    expect(r).toMatchObject({ ok: true, root: 'CLAUDE.md', docs: 3, links: 5, scopes: ['docs/'] });
    expect(r.nodes.map((n) => n.id)).toEqual(['CLAUDE.md', 'docs/big.md']);
    expect(r.findings.map((f) => [f.where, f.localOnly ?? false, f.detail])).toEqual([
      ['CLAUDE.md:3 → local.txt', true, LOCAL_ONLY],
      ['CLAUDE.md:4 → docs/gone.md', false, MISSING],
      ['CLAUDE.md:5 → cache/out.md', true, LOCAL_ONLY],
      ['CLAUDE.md:6 → scratch.txt', true, LOCAL_ONLY],
      ['notes/', false, expect.any(String)],
    ]);
    expect(r.census.docs.map((d) => [d.path, d.lastCommitMs])).toEqual([
      ['CLAUDE.md', null],
      ['docs/big.md', null],
      ['notes/orphan.md', null],
    ]);
    expect(r.census.warnings).toEqual([expect.stringMatching(/^git history unavailable: /)]);
  });

  it('dates docs from real git history and finds code files naming them', async () => {
    write('CLAUDE.md', '# Map\n[guide](docs/guide.md)\n');
    write('docs/guide.md', 'Runs `src/run.cjs`.\n');
    write('src/run.cjs', "// see docs/guide.md\n");
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', 'init', '--date=2001-01-01T00:00:00Z');
    const r = await scanMdNetwork(root);
    expect(r.census.warnings).toEqual([]);
    const guide = r.census.docs.find((d) => d.path === 'docs/guide.md');
    expect(guide.codeRefFiles).toEqual(['src/run.cjs']);
    expect(typeof guide.lastCommitMs).toBe('number');
    expect(guide.deadRefs).toEqual([]);
  });
});
