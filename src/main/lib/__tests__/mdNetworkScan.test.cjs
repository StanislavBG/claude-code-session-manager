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
const { buildMdNetwork, scanMdNetwork } = require('../mdNetworkScan.cjs');

const doc = (p, ...lines) => ({ path: p, text: lines.join('\n') });
const brokenLinks = (r) => r.findings.filter((f) => f.type === 'broken-link');
const MISSING = 'The link target doesn’t exist.';
const ESCAPES = 'The link target is outside the project.';
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
  const fakeRepo = ({ tracked, texts, log = '', grep = '', onDisk = () => false, probes = [] }) => {
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
    expect(gitCalls.map((c) => c.args[0])).toEqual(['ls-files', 'log', 'grep']);
    expect(gitCalls[1]).toEqual({ args: LOG_ARGS, opts: { maxBuffer: 64 * 1024 * 1024 } });
    expect(gitCalls[2].opts).toEqual({ maxBuffer: 16 * 1024 * 1024 });
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

  it('lists tracked docs with git, checks untracked targets on disk and reads at most 256 KB per doc', async () => {
    write('CLAUDE.md', ['# Map', '[big](docs/big.md)', '[local notes](local.txt)', '[gone](docs/gone.md)'].join('\n'));
    write('docs/big.md', `${'x'.repeat(300 * 1024)}\n[past the read cap](missing-late.md)\n`);
    write('notes/orphan.md', 'nobody links here');
    write('.gitignore', 'local.txt\n');
    write('local.txt', 'on disk, not tracked');
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'pipe' });

    const r = await scanMdNetwork(root);
    expect(r).toMatchObject({ ok: true, root: 'CLAUDE.md', docs: 3, links: 2, scopes: ['docs/'] });
    expect(r.nodes.map((n) => n.id)).toEqual(['CLAUDE.md', 'docs/big.md']);
    expect(r.findings.map((f) => f.where)).toEqual(['CLAUDE.md:4 → docs/gone.md', 'notes/']);
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
