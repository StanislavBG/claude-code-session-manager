'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const { ask, proposeFix, buildAskPrompt, buildFixPrompt, FIX_POLICY } = require('../memoryAssist.cjs');

const files = [
  { name: 'MEMORY.md', mtimeMs: 9, body: '- index' },
  { name: 'alpha.md', mtimeMs: 3, body: '---\ndescription: a\n---\nSee [[beta]].' },
  { name: 'beta.md', mtimeMs: 2, body: '---\ndescription: b\n---\nBeta body.' },
  { name: 'gamma.md', mtimeMs: 1, body: '---\ndescription: g\n---\nGamma body.' },
];

function makeDeps({ out, ok = true, slot = 'tok' } = {}) {
  const calls = { run: [], acquire: [], release: [] };
  return {
    calls,
    deps: {
      readDir: async () => files,
      sessionSlots: {
        acquire: (label) => { calls.acquire.push(label); return slot; },
        release: (t) => { calls.release.push(t); },
      },
      runClaudeP: async (prompt, opts) => {
        calls.run.push({ prompt, opts });
        if (out instanceof Error) throw out;
        return ok ? { ok: true, out } : { ok: false, error: 'boom' };
      },
      trackedFiles: ['src/main/old/helper.cjs', 'src/other/helper.cjs', 'CLAUDE.md', 'src/CLAUDE.md'],
      exists: () => false,
      readFile: (p) => {
        if (p.endsWith('/src/CLAUDE.md')) return '# Src docs\nline one\nline one\nuse `helper.cjs` here\nanchor line';
        if (p.endsWith('/CLAUDE.md')) return '# Root\nSee [src](src/CLAUDE.md).';
        throw new Error('ENOENT');
      },
    },
  };
}

test('no free slot → error and runClaudeP is never called', async () => {
  const { deps, calls } = makeDeps({ out: '{}', slot: null });
  const r = await ask({ question: 'q', dir: '/m' }, deps);
  assert.deepEqual(r.ok, false);
  assert.equal(r.error, 'No free session slot — try again shortly');
  assert.equal(calls.run.length, 0);
  const f = await proposeFix({ name: 'alpha.md', dir: '/m', cwd: '/c' }, deps);
  assert.equal(f.error, 'No free session slot — try again shortly');
  assert.equal(calls.run.length, 0);
});

test('ask pins model, releases slot, and keeps only citations that exist', async () => {
  const { deps, calls } = makeDeps({ out: 'noise {"answer":"yes","citations":["alpha.md","beta","ghost.md"]} tail' });
  const r = await ask({ question: 'what?', dir: '/m' }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.answer, 'yes');
  assert.deepEqual(r.citations, ['alpha.md', 'beta.md']);
  assert.equal(calls.run[0].opts.model, 'sonnet');
  assert.equal(calls.run[0].opts.timeoutMs, 120_000);
  assert.deepEqual(calls.release, ['tok']);
  assert.equal(calls.acquire[0], 'memory-assist:ask');
});

test('ask excludes MEMORY.md; contextName narrows to it plus wikilinked files', async () => {
  const all = buildAskPrompt({ question: 'q', files: files.filter((f) => f.name !== 'MEMORY.md') });
  assert.ok(all.includes('gamma.md') && !all.includes('- index'));
  const { deps, calls } = makeDeps({ out: '{"answer":"x","citations":[]}' });
  await ask({ question: 'q', dir: '/m', contextName: 'alpha.md' }, deps);
  const p = calls.run[0].prompt;
  assert.ok(p.includes('alpha.md') && p.includes('beta.md'));
  assert.ok(!p.includes('Gamma body'));
});

test('ask caps prompt body at 200 KB, newest first', () => {
  const big = [
    { name: 'new.md', mtimeMs: 2, body: 'N'.repeat(150_000) },
    { name: 'old.md', mtimeMs: 1, body: 'O'.repeat(150_000) },
  ];
  const p = buildAskPrompt({ question: 'q', files: big });
  assert.ok(p.includes('NNNN'));
  assert.ok(!p.includes('OOOO'));
});

test('unparsable output → ok:false', async () => {
  const { deps, calls } = makeDeps({ out: 'no json here' });
  const r = await ask({ question: 'q', dir: '/m' }, deps);
  assert.equal(r.ok, false);
  assert.deepEqual(calls.release, ['tok']);
});

const run = (out) => {
  const m = makeDeps({ out: typeof out === 'string' ? out : JSON.stringify(out) });
  return proposeFix({ name: 'alpha.md', dir: '/m', cwd: '/c' }, m.deps).then((r) => ({ r, ...m }));
};
const J = (o) => ({ summary: 's', reason: 'why', content: '', fold: null, ...o });

test('proposeFix update: keeps frontmatter, rejects content lacking it', async () => {
  const bad = await run(J({ action: 'update', content: 'Alpha without frontmatter' }));
  assert.equal(bad.r.ok, false);
  const good = await run(J({ action: 'update', content: '---\ndescription: a\n---\nFixed.' }));
  assert.equal(good.r.ok, true);
  assert.equal(good.r.action, 'update');
  assert.equal(good.r.summary, 's');
  assert.equal(good.r.reason, 'why');
  assert.ok(good.r.content.endsWith('Fixed.'));
  assert.equal(good.r.fold, null);
});

test('proposeFix delete and keep: empty content, null fold', async () => {
  for (const action of ['delete', 'keep']) {
    const { r } = await run(J({ action, content: 'ignored' }));
    assert.equal(r.ok, true);
    assert.equal(r.action, action);
    assert.equal(r.content, '');
    assert.equal(r.fold, null);
  }
});

test('proposeFix fold happy path (unique anchor, and empty anchor)', async () => {
  const a = await run(J({ action: 'fold', fold: { target: 'src/CLAUDE.md', anchor: 'anchor line', insert: 'new rule' } }));
  assert.equal(a.r.ok, true);
  assert.deepEqual(a.r.fold, { target: 'src/CLAUDE.md', anchor: 'anchor line', insert: 'new rule' });
  assert.equal(a.r.content, '');
  const b = await run(J({ action: 'fold', fold: { target: 'CLAUDE.md', anchor: '', insert: 'x' } }));
  assert.equal(b.r.ok, true);
  assert.equal(b.r.fold.anchor, '');
});

test('proposeFix rejects invalid action and missing summary/reason', async () => {
  assert.equal((await run(J({ action: 'merge' }))).r.ok, false);
  assert.equal((await run(J({ action: 'keep', summary: '' }))).r.ok, false);
  assert.equal((await run(J({ action: 'keep', reason: undefined }))).r.ok, false);
});

test('proposeFix fold rejection rules', async () => {
  const f = (fold) => run(J({ action: 'fold', fold })).then((x) => x.r);
  assert.equal((await f(null)).ok, false);
  assert.equal((await f({ target: 'other/README.md', anchor: '', insert: 'x' })).ok, false);
  assert.equal((await f({ target: 'CLAUDE.md', anchor: '', insert: '  ' })).ok, false);
  assert.equal((await f({ target: 'CLAUDE.md', anchor: '', insert: 'a\nb\nc\nd' })).ok, false);
  assert.equal((await f({ target: 'CLAUDE.md', anchor: '', insert: 'x'.repeat(601) })).ok, false);
  assert.equal((await f({ target: 'src/CLAUDE.md', anchor: 'line one', insert: 'x' })).ok, false);
  assert.equal((await f({ target: 'src/CLAUDE.md', anchor: 'missing', insert: 'x' })).ok, false);
});

test('fix prompt says unresolved (never "no longer exists"), lists docs and a coverage hit', async () => {
  const { calls } = await run(J({ action: 'keep' }));
  const p = calls.run[0].prompt;
  assert.ok(p.includes('unresolved') || p.includes('Unresolved'));
  // FIX_POLICY (exact text per PRD) itself says "Never write that a path no longer exists";
  // everything the builder adds around it must not.
  assert.ok(!p.replace(FIX_POLICY, '').includes('no longer exists'));
  assert.ok(!calls.run[0].opts.systemPrompt.includes('no longer exists'));
  assert.ok(p.includes('- src/CLAUDE.md — Src docs'));
  assert.ok(p.includes('<doc path="CLAUDE.md">'));
});

test('buildFixPrompt renders coverage hits and unresolved candidates', () => {
  const p = buildFixPrompt({
    name: 'x.md',
    text: 'FULLTEXT',
    unresolved: { 'src/gone/helper.cjs': ['a/helper.cjs'], 'z/none.cjs': [] },
    network: { rootClaudeMd: 'ROOT', docs: [], coverage: [{ term: 'helper.cjs', hits: [{ path: 'src/CLAUDE.md', line: 4, text: 'use it' }] }] },
  });
  assert.ok(p.includes('FULLTEXT') && p.includes('a/helper.cjs') && p.includes('none found'));
  assert.ok(p.includes('- `helper.cjs`: src/CLAUDE.md:4-use it'));
  assert.ok(!p.replace(FIX_POLICY, '').includes('no longer exists'));
});

test('proposeFix rejects path-traversing names and unknown files', async () => {
  const { deps, calls } = makeDeps({ out: '{}' });
  assert.equal((await proposeFix({ name: '../x.md', dir: '/m', cwd: '/c' }, deps)).ok, false);
  assert.equal((await proposeFix({ name: 'nope.md', dir: '/m', cwd: '/c' }, deps)).ok, false);
  assert.equal(calls.run.length, 0);
});

test('slot released when runClaudeP fails or throws', async () => {
  const a = makeDeps({ out: '', ok: false });
  const r = await ask({ question: 'q', dir: '/m' }, a.deps);
  assert.equal(r.ok, false);
  assert.deepEqual(a.calls.release, ['tok']);
  const b = makeDeps({ out: new Error('kaboom') });
  const t = await ask({ question: 'q', dir: '/m' }, b.deps);
  assert.equal(t.ok, false);
  assert.deepEqual(b.calls.release, ['tok']);
});
