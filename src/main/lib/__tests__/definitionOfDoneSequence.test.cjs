/**
 * definitionOfDoneSequence.test.cjs — extractAcSequence / resolveGate parsing
 * matrix plus real gate lines lifted from archived PRDs (gateFixtures.json).
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/definitionOfDoneSequence.test.cjs
 */
'use strict';

const assert = require('node:assert/strict');
const { extractAcSequence, extractAcCommand, resolveGate } = require('../definitionOfDone.cjs');
const fixtures = require('./gateFixtures.json');

const ac = (...lines) => ['# Acceptance criteria', '', ...lines, '', '# Out of scope', ''].join('\n');
const argvs = (seq) => seq.map((c) => c.argv);

test('splits a && chain, honouring a leading timeout N per command', () => {
  const seq = extractAcSequence(ac('- [ ] Gate: `timeout 300 npm run typecheck && timeout 60 npm run lint`'));
  assert.deepEqual(argvs(seq), [['npm', 'run', 'typecheck'], ['npm', 'run', 'lint']]);
  assert.deepEqual(seq.map((c) => c.timeoutMs), [300_000, 60_000]);
});

test('a command with no timeout token gets the default timeout', () => {
  const seq = extractAcSequence(ac('- [ ] `timeout 5 npm run a && npm run b`'));
  assert.equal(seq[0].timeoutMs, 5_000);
  assert.equal(seq[1].timeoutMs, 300_000);
});

test('&& inside quotes is never a split point', () => {
  const seq = extractAcSequence(ac('- [ ] `timeout 30 node -e "a && b" && timeout 30 echo \'x && y\'`'));
  assert.deepEqual(argvs(seq), [['node', '-e', 'a && b'], ['echo', 'x && y']]);
});

test('a leading TMPDIR=$(mktemp -d) is dropped, other literal env is kept', () => {
  const seq = extractAcSequence(ac('- [ ] `TMPDIR=$(mktemp -d) timeout 900 npm run test:unit && FOO=bar timeout 10 npm run x`'));
  assert.deepEqual(argvs(seq), [['npm', 'run', 'test:unit'], ['npm', 'run', 'x']]);
  assert.deepEqual(seq[0].env, {});
  assert.deepEqual(seq[1].env, { FOO: 'bar' });
});

test('any surviving shell metacharacter makes the whole gate unparseable (no shell)', () => {
  for (const bad of [
    '`timeout 60 npm run a | tail -5`', '`timeout 60 npm run a > out.txt`', '`timeout 60 npm run a; rm x`',
    '`timeout 60 npm run a & echo`', '`timeout 60 echo $(whoami)`', '`timeout 60 npm run a && timeout 60 npm run b || true`',
  ]) {
    assert.deepEqual(extractAcSequence(ac(`- [ ] ${bad}`)), [], bad);
  }
});

test('an empty segment (dangling &&) is unparseable', () => {
  assert.deepEqual(extractAcSequence(ac('- [ ] `timeout 60 npm run a &&`')), []);
});

test('frontmatter gate: list takes priority over the AC line', () => {
  const text = '---\ntitle: t\ngate:\n  - timeout 10 npm run one\n  - "timeout 20 npm run two && timeout 30 npm run three"\n---\n' +
    ac('- [ ] `timeout 999 npm run ignored`');
  const g = resolveGate(text);
  assert.equal(g.source, 'explicit');
  assert.deepEqual(argvs(g.sequence), [['npm', 'run', 'one'], ['npm', 'run', 'two'], ['npm', 'run', 'three']]);
});

test('frontmatter inline gate list', () => {
  const g = resolveGate('---\ngate: [timeout 10 npm run one, timeout 20 npm run two]\n---\nbody');
  assert.deepEqual(argvs(g.sequence), [['npm', 'run', 'one'], ['npm', 'run', 'two']]);
});

test('a fenced ```gate block takes priority', () => {
  const text = ac('- [ ] `timeout 999 npm run ignored`', '', '```gate', 'timeout 10 npm run a && timeout 20 npm run b', '```');
  const g = resolveGate(text);
  assert.equal(g.source, 'explicit');
  assert.deepEqual(argvs(g.sequence), [['npm', 'run', 'a'], ['npm', 'run', 'b']]);
});

test('gate: none is an explicit opt-out, distinct from absent', () => {
  const none = resolveGate('---\ngate: none\n---\n' + ac('- [ ] `timeout 60 npm test`'));
  assert.equal(none.source, 'none');
  assert.deepEqual(none.sequence, []);
  assert.equal(resolveGate(ac('- [ ] prose only')).source, 'absent');
});

test('extractAcCommand delegates: single command → original string, chain → null', () => {
  assert.equal(extractAcCommand(ac('- [ ] `timeout 60 npm test`')), 'timeout 60 npm test');
  assert.equal(extractAcCommand(ac('- [ ] `timeout 60 npm a && timeout 60 npm b`')), null);
});

test('real archived gate lines: count how many now parse', () => {
  const parsed = fixtures.filter((line) => extractAcSequence(ac(line)).length > 0);
  console.log(`[gate-fixtures] ${parsed.length}/${fixtures.length} real gate lines now parse`);
  const chains = fixtures.filter((l) => l.includes('&&') && /^- \[ \] (Gate|Locally)/.test(l));
  for (const line of chains) assert.ok(extractAcSequence(ac(line)).length >= 2, line);
  // The three deliberately un-runnable fixtures (shell loop, pipe, prose) stay empty.
  const unparseable = fixtures.filter((l) => /for i in|\| tail|Prose only/.test(l));
  assert.equal(unparseable.length, 3);
  for (const line of unparseable) assert.deepEqual(extractAcSequence(ac(line)), [], line);
  assert.equal(parsed.length, fixtures.length - 3);
});
