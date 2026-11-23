/**
 * md-links.test.cjs — the shared markdown link convention (mdLinks.cjs):
 * inline / image / autolinks, @imports and backticked paths, outside code
 * fences, inline code and HTML comments.
 *
 * Run: timeout 300 npx vitest run scripts/__tests__/md-links.test.cjs
 */
'use strict';

import { test, expect, describe } from 'vitest';
const path = require('node:path');

const mdLinks = require(path.resolve(
  __dirname,
  '../../plugins/session-manager-dev/skills/maintaining-md-network/scripts/mdLinks.cjs',
));
const { linksOf, rawLinksOf, followLink, visibleText, visibleLine, importsOf, backtickPaths, toRepoPath, isAgentsStub } = mdLinks;
const census = require('../../src/main/lib/mdDocCensus.cjs');
const docRefs = require('../../src/main/lib/mdDocRefs.cjs');

/** @param {string} text @param {string} [p] */
const targets = (text, p = 'docs/a.md') => linksOf({ path: p, text }).map((l) => l.to);

describe('exports', () => {
  test('exports exactly the nine convention functions', () => {
    expect(Object.keys(mdLinks).sort()).toEqual(
      ['backtickPaths', 'followLink', 'importsOf', 'isAgentsStub', 'linksOf', 'rawLinksOf', 'toRepoPath', 'visibleLine', 'visibleText'],
    );
  });

  test('requires only node built-ins', () => {
    const src = require('node:fs').readFileSync(
      path.resolve(__dirname, '../../plugins/session-manager-dev/skills/maintaining-md-network/scripts/mdLinks.cjs'),
      'utf8',
    );
    const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    expect(reqs.length).toBeGreaterThan(0);
    for (const r of reqs) expect(r.startsWith('node:')).toBe(true);
  });
});

describe('linksOf', () => {
  test('inline link resolves against the doc folder, with line numbers', () => {
    const links = linksOf({ path: 'docs/a.md', text: 'intro\nsee [b](b.md#sec) and [c](../c.md?x=1)' });
    expect(links).toEqual([
      { line: 2, target: 'b.md', to: 'docs/b.md', escapes: false },
      { line: 2, target: '../c.md', to: 'c.md', escapes: false },
    ]);
  });

  test('image link', () => {
    expect(targets('![shot](img/x.png)')).toEqual(['docs/img/x.png']);
  });

  test('<x.md> autolink, but not non-.md autolinks or a link destination in <>', () => {
    expect(targets('<x.md> <y.txt> [z](<z.md>)')).toEqual(['docs/z.md', 'docs/x.md']);
  });

  test('link inside a fenced block is ignored', () => {
    expect(targets('```md\n[a](a.md)\n```\n~~~\n[b](b.md)\n~~~\n[c](c.md)')).toEqual(['docs/c.md']);
  });

  test('link inside inline code is ignored', () => {
    expect(targets('`[a](a.md)` and ``[b](b.md)`` but [c](c.md)')).toEqual(['docs/c.md']);
  });

  test('link inside a multi-line HTML comment is ignored', () => {
    expect(targets('<!-- start\n[a](a.md)\nend --> [b](b.md)\n<!-- [c](c.md) --> [d](d.md)')).toEqual([
      'docs/b.md',
      'docs/d.md',
    ]);
  });

  test('scheme, absolute and #anchor targets are ignored', () => {
    expect(
      targets('[h](https://x.io/a.md) [m](mailto:a@b.c) [a](#top) [r](/abs.md) [n](//host/x.md) [ok](ok.md)'),
    ).toEqual(['docs/ok.md']);
  });

  test('escaping target is flagged; result is memoized per file object', () => {
    const file = { path: 'a.md', text: '[up](../out.md)' };
    const first = linksOf(file);
    expect(first[0].escapes).toBe(true);
    expect(linksOf(file)).toBe(first);
  });
});

describe('rawLinksOf / visibleLine', () => {
  test('rawLinksOf keeps destinations as written, outside code and comments', () => {
    const text = '[a](/site/route/) [b](b.md#top) <c.md?x>\n`[z](z.md)` <!-- [h](h.md) -->\n```\n[f](f.md)\n```\n[u](https://x.y)';
    expect(rawLinksOf(text)).toEqual([
      { line: 1, raw: '/site/route/' },
      { line: 1, raw: 'b.md#top' },
      { line: 1, raw: 'c.md?x' },
      { line: 6, raw: 'https://x.y' },
    ]);
  });

  test('linksOf is rawLinksOf passed through followLink', () => {
    const text = '[a](/abs.md) [b](b.md#top) [c](#only)';
    const viaRaw = rawLinksOf(text).map((r) => followLink('docs/a.md', r.raw, r.line)).filter(Boolean);
    expect(linksOf({ path: 'docs/a.md', text })).toEqual(viaRaw);
  });

  test('visibleLine keeps inline code, drops comments and fenced lines', () => {
    const state = { fence: '', inComment: false };
    const out = ['`a/b.md` <!-- x', 'y --> `c/d.md`', '```', '`e/f.md`', '```'].map((l) => visibleLine(l, state));
    expect(out.map((l) => l.trim())).toEqual(['`a/b.md`', '`c/d.md`', '', '', '']);
  });
});

describe('followLink / visibleText / toRepoPath', () => {
  test('followLink decodes and strips fragment', () => {
    expect(followLink('docs/a.md', ' my%20doc.md#x ', 3)).toEqual({
      line: 3,
      target: 'my%20doc.md',
      to: 'docs/my doc.md',
      escapes: false,
    });
    expect(followLink('docs/a.md', '#x', 1)).toBeNull();
    expect(followLink('docs/a.md', '?q', 1)).toBeNull();
  });

  test('visibleText tracks fences and comments across lines', () => {
    const state = { fence: '', inComment: false };
    expect(visibleText('```', state)).toBe('');
    expect(state.fence).toBe('```');
    expect(visibleText('[a](a.md)', state)).toBe('');
    expect(visibleText('```', state)).toBe('');
    expect(state.fence).toBe('');
    expect(visibleText('x <!-- y', state)).toBe('x  ');
    expect(state.inComment).toBe(true);
    expect(visibleText('z --> w', state)).toBe(' w');
    expect(visibleText('a `code` b', state)).toBe('a   b');
  });

  test('toRepoPath normalizes', () => {
    expect(toRepoPath('./a/../b/')).toBe('b');
    expect(toRepoPath('./')).toBe('.');
  });
});

describe('importsOf', () => {
  const text = [
    '@sub/x.md and @../y.md.',
    '`@code.md` ignored',
    '```',
    '@fenced.md',
    '```',
    '@~/home.md @/abs.md @../../out.md @sub/x.md @notes.txt',
  ].join('\n');

  test('resolves @imports relative to the doc folder, skipping code, ~, absolute and escaping', () => {
    expect(importsOf(text, 'docs/CLAUDE.md')).toEqual(['docs/sub/x.md', 'y.md']);
  });

  test('matches mdDocCensus importsOf', () => {
    expect(importsOf(text, 'docs/CLAUDE.md')).toEqual(census.importsOf(text, 'docs/CLAUDE.md'));
    expect(importsOf(null, 'a.md')).toEqual([]);
  });
});

describe('backtickPaths', () => {
  const text = [
    'see `src/main/x.cjs:12` and `docs/a.md#sec` and `lib/`',
    '`not a path` `noslash.md` `/abs/x.md` `~/x.md` `https://x/y.md` `a/*.md` `a/b`',
    '```',
    '`fenced/x.md`',
    '```',
    '<!-- `commented/x.md`',
    '-->`after/c.md` `src/main/x.cjs`',
  ].join('\n');

  test('path-shaped tokens outside fences and comments, deduped in order', () => {
    expect(backtickPaths(text)).toEqual(['src/main/x.cjs', 'docs/a.md', 'lib/', 'after/c.md']);
  });

  test('matches mdDocRefs backtickPaths (shared stripComments)', () => {
    expect(backtickPaths(text)).toEqual(docRefs.backtickPaths(text));
    expect(backtickPaths('')).toEqual([]);
  });
});

describe('isAgentsStub', () => {
  test('true when the first non-blank line is @AGENTS.md or @./AGENTS.md', () => {
    expect(isAgentsStub('@AGENTS.md\n')).toBe(true);
    expect(isAgentsStub('@./AGENTS.md')).toBe(true);
    expect(isAgentsStub('\n  \r\n   @AGENTS.md  \n# more')).toBe(true);
  });

  test('false for any other first line, an empty doc or a nested path', () => {
    expect(isAgentsStub('# Map\n@AGENTS.md')).toBe(false);
    expect(isAgentsStub('')).toBe(false);
    expect(isAgentsStub('\n\n')).toBe(false);
    expect(isAgentsStub('@src/AGENTS.md')).toBe(false);
    expect(isAgentsStub('See @AGENTS.md')).toBe(false);
  });
});
