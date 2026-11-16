'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const { scoreMemories, extractRoots } = require('../lib/memoryStale.cjs');

const DAY_MS = 86_400_000;
const NOW = 1_800_000_000_000; // fixed epoch ms for deterministic tests

test('a fresh linked memory is not stale', () => {
  const entries = [
    { name: 'a.md', mtimeMs: NOW - 5 * DAY_MS, body: 'links to [[b]]' },
    { name: 'b.md', mtimeMs: NOW - 5 * DAY_MS, body: 'nothing here' },
  ];
  const result = scoreMemories({ entries, now: NOW, existsPath: () => true });
  const b = result.find((r) => r.name === 'b.md');
  assert.equal(b.stale, false);
  assert.equal(b.inboundLinks, 1);
  assert.deepEqual(b.reasons, []);
});

test('a 200-day-old memory with zero inbound links is stale', () => {
  const entries = [
    { name: 'old.md', mtimeMs: NOW - 200 * DAY_MS, body: 'no links to me' },
  ];
  const result = scoreMemories({ entries, now: NOW, existsPath: () => true });
  const old = result[0];
  assert.equal(old.ageDays, 200);
  assert.equal(old.inboundLinks, 0);
  assert.equal(old.stale, true);
  assert.ok(old.reasons.some((r) => /90\+ days old/.test(r)));
});

test('a 200-day-old memory WITH an inbound link is not stale', () => {
  const entries = [
    { name: 'old.md', mtimeMs: NOW - 200 * DAY_MS, body: 'old content' },
    { name: 'linker.md', mtimeMs: NOW - 1 * DAY_MS, body: 'see [[old]] for context' },
  ];
  const result = scoreMemories({ entries, now: NOW, existsPath: () => true });
  const old = result.find((r) => r.name === 'old.md');
  assert.equal(old.inboundLinks, 1);
  assert.equal(old.stale, false);
});

test('a recent memory naming a dead path IS stale', () => {
  const entries = [
    { name: 'recent.md', mtimeMs: NOW - 1 * DAY_MS, body: 'see `src/main/gone.cjs` for details' },
  ];
  const existsPath = (p) => p !== 'src/main/gone.cjs';
  const result = scoreMemories({ entries, now: NOW, existsPath });
  const r = result[0];
  assert.equal(r.ageDays, 1);
  assert.deepEqual(r.deadRefs, ['src/main/gone.cjs']);
  assert.equal(r.stale, true);
  assert.ok(r.reasons.some((s) => /no longer exist/.test(s)));
});

test('a :42 line suffix is stripped before the existence check', () => {
  const entries = [
    { name: 'recent.md', mtimeMs: NOW - 1 * DAY_MS, body: 'see `src/main/config.cjs:42` for the helper' },
  ];
  let checked = null;
  const existsPath = (p) => { checked = p; return true; };
  const result = scoreMemories({ entries, now: NOW, existsPath });
  assert.equal(checked, 'src/main/config.cjs');
  assert.deepEqual(result[0].deadRefs, []);
  assert.equal(result[0].stale, false);
});

test('the candidate cap holds at 20', () => {
  const paths = Array.from({ length: 30 }, (_, i) => `src/main/file${i}.cjs`);
  const body = paths.map((p) => `\`${p}\``).join(' ');
  const entries = [{ name: 'many.md', mtimeMs: NOW - 1 * DAY_MS, body }];
  let callCount = 0;
  const existsPath = () => { callCount += 1; return false; };
  const result = scoreMemories({ entries, now: NOW, existsPath });
  assert.equal(result[0].deadRefs.length, 20);
  assert.equal(callCount, 20);
});

test('a bare backticked filename is not a dead-ref candidate', () => {
  const entries = [
    { name: 'bare.md', mtimeMs: NOW - 1 * DAY_MS, body: 'see `queue.json` and `webRemote.cjs` and `scheduler.cjs`' },
  ];
  let callCount = 0;
  const existsPath = () => { callCount += 1; return false; };
  const [r] = scoreMemories({ entries, now: NOW, existsPath });
  assert.equal(callCount, 0);
  assert.deepEqual(r.deadRefs, []);
  assert.equal(r.stale, false);
});

test('roots named in the body are passed to existsPath as the second argument', () => {
  const entries = [
    {
      name: 'roots.md',
      mtimeMs: NOW - 1 * DAY_MS,
      body: 'pages live in ~/Projects/Bilko/ (see `web/index.html`) and /home/bilko/Projects/session-manager.',
    },
  ];
  let seen = null;
  const existsPath = (p, roots) => { seen = roots; return true; };
  scoreMemories({ entries, now: NOW, existsPath });
  assert.deepEqual(seen, ['~/Projects/Bilko', '/home/bilko/Projects/session-manager']);
});

test('extractRoots dedupes, strips punctuation and caps at 5', () => {
  assert.deepEqual(extractRoots('`~/a/b`, ~/a/b/ and ~/a/b.'), ['~/a/b']);
  const body = Array.from({ length: 8 }, (_, i) => `~/p/r${i}`).join(' ');
  assert.equal(extractRoots(body).length, 5);
  assert.deepEqual(extractRoots('no roots here, src/main/x.cjs'), []);
});

test('[[self]] in a memory own body does not count as an inbound link', () => {
  const entries = [
    { name: 'self.md', mtimeMs: NOW - 200 * DAY_MS, body: 'refers to itself: [[self]]' },
  ];
  const result = scoreMemories({ entries, now: NOW, existsPath: () => true });
  assert.equal(result[0].inboundLinks, 0);
  assert.equal(result[0].stale, true);
});

test('frontmatter description/type/originSessionId parsed, incl. nested metadata keys and quoted description', () => {
  const body = [
    '---',
    'name: x',
    'description: "pages live in ~/Projects/Bilko"',
    'metadata:',
    '  type: project',
    '  originSessionId: de0e5dbe-8abe-4fec-a9a4-e667767ccbd9',
    '---',
    'body',
  ].join('\n');
  const [r] = scoreMemories({ entries: [{ name: 'x.md', mtimeMs: NOW, body }], now: NOW, existsPath: () => true });
  assert.equal(r.description, 'pages live in ~/Projects/Bilko');
  assert.equal(r.type, 'project');
  assert.equal(r.originSessionId, 'de0e5dbe-8abe-4fec-a9a4-e667767ccbd9');
});

test('a memory with no frontmatter yields null meta fields', () => {
  const [r] = scoreMemories({
    entries: [{ name: 'x.md', mtimeMs: NOW, body: 'type: project\ndescription: nope' }],
    now: NOW,
    existsPath: () => true,
  });
  assert.equal(r.description, null);
  assert.equal(r.type, null);
  assert.equal(r.originSessionId, null);
});

test('outLinks dedupe, exclude self, keep first-appearance order', () => {
  const body = 'see [[b]] then [[self]] then [[a]] and [[b]] again';
  const entries = [
    { name: 'self.md', mtimeMs: NOW, body },
    { name: 'a.md', mtimeMs: NOW, body: '' },
    { name: 'b.md', mtimeMs: NOW, body: '' },
  ];
  const r = scoreMemories({ entries, now: NOW, existsPath: () => true })[0];
  assert.deepEqual(r.outLinks, ['b', 'a']);
  assert.deepEqual(r.danglingLinks, []);
});

test('danglingLinks lists outLinks with no matching memory file', () => {
  const entries = [
    { name: 'a.md', mtimeMs: NOW, body: '[[b]] [[missing]]' },
    { name: 'b.md', mtimeMs: NOW, body: '' },
  ];
  const r = scoreMemories({ entries, now: NOW, existsPath: () => true });
  assert.deepEqual(r[0].outLinks, ['b', 'missing']);
  assert.deepEqual(r[0].danglingLinks, ['missing']);
  assert.deepEqual(r[1].outLinks, []);
});

const { makeLinkResolver } = require('../lib/memoryStale.cjs');
const fm = (name, rest = '') => `---\nname: ${name}\ndescription: d\n---\n${rest}`;

test('a [[kebab-name]] link resolves to a snake_case file via its frontmatter name', () => {
  const entries = [
    { name: 'release_v0136.md', mtimeMs: NOW - 200 * DAY_MS, body: fm('release-v0136', 'see [[cross-project-replies-plan]]') },
    { name: 'cross_project_replies_plan.md', mtimeMs: NOW - 200 * DAY_MS, body: fm('cross-project-replies-plan', 'from [[release-v0136]]') },
  ];
  const [rel, cross] = scoreMemories({ entries, now: NOW, existsPath: () => true });
  assert.deepEqual(rel.outLinks, ['cross_project_replies_plan']);
  assert.deepEqual(rel.danglingLinks, []);
  assert.equal(rel.inboundLinks, 1);
  assert.equal(rel.stale, false);
  assert.deepEqual(cross.outLinks, ['release_v0136']);
  assert.equal(cross.inboundLinks, 1);
  assert.equal(cross.stale, false);
});

test('a link by filename stem still resolves', () => {
  const entries = [
    { name: 'a.md', mtimeMs: NOW, body: 'see [[release_v0136]]' },
    { name: 'release_v0136.md', mtimeMs: NOW, body: fm('release-v0136') },
  ];
  const [a, rel] = scoreMemories({ entries, now: NOW, existsPath: () => true });
  assert.deepEqual(a.outLinks, ['release_v0136']);
  assert.deepEqual(a.danglingLinks, []);
  assert.equal(rel.inboundLinks, 1);
});

test('a target matching neither stem nor name is dangling', () => {
  const entries = [
    { name: 'a.md', mtimeMs: NOW, body: '[[no-such-memory]]' },
    { name: 'release_v0136.md', mtimeMs: NOW, body: fm('release-v0136') },
  ];
  const [a, rel] = scoreMemories({ entries, now: NOW, existsPath: () => true });
  assert.deepEqual(a.outLinks, ['no-such-memory']);
  assert.deepEqual(a.danglingLinks, ['no-such-memory']);
  assert.equal(rel.inboundLinks, 0);
});

test('a self-link by frontmatter name is excluded from outLinks and inbound', () => {
  const entries = [
    { name: 'release_v0136.md', mtimeMs: NOW - 200 * DAY_MS, body: fm('release-v0136', 'me: [[release-v0136]] [[Release V0136]]') },
  ];
  const [r] = scoreMemories({ entries, now: NOW, existsPath: () => true });
  assert.deepEqual(r.outLinks, []);
  assert.deepEqual(r.danglingLinks, []);
  assert.equal(r.inboundLinks, 0);
  assert.equal(r.stale, true);
});

test('normalized collisions: exact stem wins, else first filename by sort, deterministically', () => {
  const entries = [
    { name: 'foo_bar.md', mtimeMs: NOW, body: fm('zzz') },
    { name: 'foo-bar.md', mtimeMs: NOW, body: fm('yyy') },
    { name: 'b_note.md', mtimeMs: NOW, body: fm('shared-name') },
    { name: 'a_note.md', mtimeMs: NOW, body: fm('shared-name') },
  ];
  const resolve = makeLinkResolver(entries);
  assert.equal(resolve('foo_bar'), 'foo_bar');
  assert.equal(resolve('foo-bar'), 'foo-bar');
  assert.equal(resolve('Foo Bar'), 'foo-bar'); // '-' sorts before '_'
  assert.equal(resolve('shared-name'), 'a_note');
  assert.equal(resolve('Shared__Name'), 'a_note');
  assert.equal(resolve('zzz'), 'foo_bar');
  assert.equal(resolve('nothing'), null);
  // stem beats a frontmatter name with the same normalized key
  const r2 = makeLinkResolver([
    { name: 'a.md', body: fm('target-x') },
    { name: 'target_x.md', body: fm('other') },
  ]);
  assert.equal(r2('target-x'), 'target_x');
  // input order does not change the result
  assert.equal(makeLinkResolver([...entries].reverse())('shared-name'), 'a_note');
});
