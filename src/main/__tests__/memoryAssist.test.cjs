'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const { ask, proposeFix, buildAskPrompt, buildFixPrompt } = require('../memoryAssist.cjs');

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
      gitLsFiles: async () => ['src/main/old/helper.cjs', 'src/other/helper.cjs'],
      existsPath: () => false,
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

test('proposeFix rejects content lacking the original frontmatter', async () => {
  const bad = makeDeps({ out: JSON.stringify({ summary: 's', content: 'Alpha without frontmatter' }) });
  const r = await proposeFix({ name: 'alpha.md', dir: '/m', cwd: '/c' }, bad.deps);
  assert.equal(r.ok, false);
  const good = makeDeps({ out: JSON.stringify({ summary: 's', content: '---\ndescription: a\n---\nFixed.' }) });
  const g = await proposeFix({ name: 'alpha.md', dir: '/m', cwd: '/c' }, good.deps);
  assert.equal(g.ok, true);
  assert.equal(g.summary, 's');
  assert.ok(g.content.endsWith('Fixed.'));
});

test('proposeFix prompt carries full text and ≤5 basename matches per dead path', () => {
  const p = buildFixPrompt({
    name: 'x.md',
    text: 'FULLTEXT',
    suggestions: { 'src/gone/helper.cjs': ['a/helper.cjs', 'b/helper.cjs'] },
  });
  assert.ok(p.includes('FULLTEXT') && p.includes('a/helper.cjs'));
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
