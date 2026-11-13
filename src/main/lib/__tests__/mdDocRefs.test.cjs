/**
 * mdDocRefs.test.cjs — the repo paths a markdown doc names (backticked paths),
 * their currency (dead refs, files changed since the doc), and the fixed-string
 * patterns + git grep parsing that tell which code files name each doc.
 *
 * Run: timeout 300 npx vitest run src/main/lib/__tests__/mdDocRefs.test.cjs
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { backtickPaths, assessRefs, mentionPatterns, parseMentions } = require('../mdDocRefs.cjs');

describe('backtickPaths', () => {
  it('keeps distinct path-shaped inline code tokens in document order', () => {
    const text = [
      'See `src/main/a.cjs` and `docs/b.md#intro` and `src/x/` then `src/main/a.cjs` again.',
      'Line ref `lib/c.ts:42`, double ``web/d.tsx`` here.',
    ].join('\n');
    expect(backtickPaths(text)).toEqual(['src/main/a.cjs', 'docs/b.md', 'src/x/', 'lib/c.ts', 'web/d.tsx']);
  });

  it('drops excluded token shapes', () => {
    const bad = [
      'noslash.md', '/abs/path.md', '~/home/x.md', '$HOME/x.md', '<dir>/x.md', 'http://a/b.md', 'https://a/b.md',
      'a b/c.md', 'src/*.ts', 'src/{a,b}.ts', 'a/b<c>.ts', 'C:/x.ts', 'src/main', 'a/b.toolongext1', 'npm run/x',
    ];
    const text = bad.map((t) => `\`${t}\``).join(' ');
    expect(backtickPaths(text)).toEqual([]);
  });

  it('ignores fenced code blocks and HTML comments', () => {
    const text = [
      '```js',
      '`in/fence.js`',
      '```',
      '<!-- `in/comment.md`',
      '`still/comment.md` -->',
      '~~~',
      '`tilde/fence.md`',
      '~~~',
      'after <!-- `inline/comment.md` --> `kept/one.md`',
    ].join('\n');
    expect(backtickPaths(text)).toEqual(['kept/one.md']);
  });

  it('caps at 200 tokens', () => {
    const text = Array.from({ length: 250 }, (_, i) => `\`d/f${i}.md\``).join('\n');
    const out = backtickPaths(text);
    expect(out).toHaveLength(200);
    expect(out[0]).toBe('d/f0.md');
    expect(out[199]).toBe('d/f199.md');
  });

  it('tolerates empty / non-string input', () => {
    expect(backtickPaths('')).toEqual([]);
    // @ts-expect-error — defensive
    expect(backtickPaths(undefined)).toEqual([]);
  });
});

describe('assessRefs', () => {
  const files = new Set(['docs/guide.md', 'src/a.cjs', 'docs/sub/b.md', 'src/lib', 'docs/local.ts']);
  const exists = (p) => files.has(p);
  const commits = { 'src/a.cjs': 500, 'docs/sub/b.md': 300, 'docs/local.ts': 50, 'docs/guide.md': 900, 'src/lib': 999 };
  const lastCommitOf = (p) => commits[p];

  it('resolves root-relative first, then doc folder, and reports dead tokens in root form', () => {
    const r = assessRefs({
      docPath: 'docs/guide.md',
      linkTargets: ['docs/sub/b.md', 'docs/missing.md'],
      tokens: ['src/a.cjs', 'sub/b.md', 'local.ts', 'gone/x.ts', 'gone/dir/', 'src/lib/', '../../escape/x.md'],
      docMs: 100,
      exists,
      lastCommitOf,
    });
    expect(r.deadRefs).toEqual(['gone/x.ts', 'gone/dir']);
    // folders (src/lib) and the doc itself never appear; local.ts (50) is older than the doc
    expect(r.changedSince).toEqual([
      { path: 'src/a.cjs', ms: 500 },
      { path: 'docs/sub/b.md', ms: 300 },
    ]);
  });

  it('treats any commit as newer when docMs is null and skips non-numbers', () => {
    const r = assessRefs({
      docPath: 'docs/guide.md',
      linkTargets: [],
      tokens: ['local.ts', 'src/a.cjs', 'docs/guide.md'],
      docMs: null,
      exists,
      lastCommitOf: (p) => (p === 'src/a.cjs' ? null : commits[p]),
    });
    expect(r.deadRefs).toEqual([]);
    expect(r.changedSince).toEqual([{ path: 'docs/local.ts', ms: 50 }]);
  });

  it('caps changedSince at 20, newest first', () => {
    const tokens = Array.from({ length: 30 }, (_, i) => `f/${i}.ts`);
    const r = assessRefs({
      docPath: 'README.md', linkTargets: [], tokens, docMs: 0, exists: () => true,
      lastCommitOf: (p) => Number(p.slice(2, -3)) + 1,
    });
    expect(r.changedSince).toHaveLength(20);
    expect(r.changedSince[0]).toEqual({ path: 'f/29.ts', ms: 30 });
  });
});

describe('mentionPatterns', () => {
  it('adds full paths plus unshared parent/basename suffixes', () => {
    const { patterns, owner } = mentionPatterns([
      'README.md',
      'src/renderer/CLAUDE.md',
      'web/remote-app/CLAUDE.md',
      'a/b/c/guide.md',
      'x/y/z.md',
      'p/y/z.md',
    ]);
    expect(patterns).toEqual([
      'README.md',
      'src/renderer/CLAUDE.md', 'renderer/CLAUDE.md',
      'web/remote-app/CLAUDE.md', 'remote-app/CLAUDE.md',
      'a/b/c/guide.md', 'c/guide.md',
      'x/y/z.md',
      'p/y/z.md',
    ]);
    expect(owner.get('renderer/CLAUDE.md')).toBe('src/renderer/CLAUDE.md');
    expect(owner.get('README.md')).toBe('README.md');
    expect(owner.has('y/z.md')).toBe(false);
  });

  it('caps at 4000 patterns', () => {
    const docs = Array.from({ length: 3000 }, (_, i) => `d${i}/e/f${i}.md`);
    const { patterns, owner } = mentionPatterns(docs);
    expect(patterns).toHaveLength(4000);
    expect(owner.size).toBe(4000);
  });
});

describe('parseMentions', () => {
  it('maps matches to docs with distinct files and ignores malformed lines', () => {
    const owner = new Map([['a/b.md', 'a/b.md'], ['b.md', 'x/a/b.md']]);
    const out = parseMentions('src/x.ts\0a/b.md\nsrc/x.ts\0a/b.md\ngarbage\n\0a/b.md\nsrc/y.ts\0nope.md\nsrc/z.ts\0b.md\nsrc/w.ts\0a/b.md\n', owner);
    expect([...out.entries()]).toEqual([
      ['a/b.md', ['src/x.ts', 'src/w.ts']],
      ['x/a/b.md', ['src/z.ts']],
    ]);
    // @ts-expect-error — defensive
    expect(parseMentions(null, owner).size).toBe(0);
  });

  it('parses a real git grep run', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-doc-refs-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.mkdirSync(path.join(dir, 'docs', 'deep'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'one.cjs'), "// see docs/deep/guide.md\nconst x = 'deep/guide.md';\n");
      fs.writeFileSync(path.join(dir, 'src', 'two.ts'), '// nothing here\n// README.md too\n');
      fs.writeFileSync(path.join(dir, 'docs', 'deep', 'guide.md'), 'mentions docs/deep/guide.md itself\n');
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['add', '.'], { cwd: dir });
      const { patterns, owner } = mentionPatterns(['docs/deep/guide.md', 'README.md']);
      const args = ['grep', '--no-color', '-I', '-F', '-o', '--null'];
      for (const p of patterns) args.push('-e', p);
      args.push('--', '.', ':(exclude)*.md');
      let stdout = '';
      try {
        stdout = execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
      } catch (err) {
        stdout = /** @type {{ stdout?: string }} */ (err).stdout || '';
      }
      const out = parseMentions(stdout, owner);
      expect(out.get('docs/deep/guide.md')).toEqual(['src/one.cjs']);
      expect(out.get('README.md')).toEqual(['src/two.ts']);
      expect(out.size).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
