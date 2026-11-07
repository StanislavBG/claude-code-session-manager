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
    expect(gitCalls).toEqual([['/repo', ['ls-files', '-z']]]);
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
  });
});
