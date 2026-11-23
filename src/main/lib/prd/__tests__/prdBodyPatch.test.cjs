/**
 * prdBodyPatch.test.cjs — applyStructuredPrdPatch coverage on a body from the
 * real createPrd renderer (buildPrdBody).
 *
 * Run: timeout 120 npx vitest run src/main/lib/prd/__tests__/prdBodyPatch.test.cjs
 */
'use strict';

const assert = require('node:assert/strict');
const { applyStructuredPrdPatch } = require('../prdBodyPatch.cjs');
const { buildPrdBody } = require('../prdCreate.cjs');
const { splitFrontmatter, parsePrdFile } = require('../prdFrontmatter.cjs');
const { resolveGate, parseChain } = require('../../scheduler/definitionOfDone.cjs');

function makeBody() {
  return buildPrdBody({
    title: 'T', goal: 'Do the thing.',
    acceptanceCriteria: ['first works', 'second works'],
    implementationNotes: 'Read src/a.cjs first.',
    outOfScope: ['nothing else'],
    files: ['src/a.cjs', 'src/b.cjs'],
    gate: ['timeout 60 npx vitest run src/a.test.cjs'],
  });
}

function section(body, heading) {
  const i = body.indexOf(`\n${heading}\n`);
  assert.ok(i >= 0, `missing ${heading}`);
  const rest = body.slice(i + 1);
  const m = rest.slice(heading.length).search(/\n#{1,2} /);
  return m === -1 ? rest : rest.slice(0, heading.length + m + 1);
}

describe('applyStructuredPrdPatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gate-only patch reads back to exactly the new commands', () => {
    const body = makeBody();
    const gate = ['timeout 30 npm run typecheck', 'timeout 60 npx vitest run src/x.test.cjs'];
    const r = applyStructuredPrdPatch(body, { gate });
    assert.equal(r.ok, true);
    const resolved = resolveGate(r.body);
    assert.equal(resolved.source, 'explicit');
    assert.deepEqual(resolved.sequence, gate.flatMap(parseChain));
    assert.equal(section(r.body, '# Files'), section(body, '# Files'));
  });

  it('files-only patch replaces the Files section and dedupes', () => {
    const r = applyStructuredPrdPatch(makeBody(), { files: ['./src/c.cjs', 'src/c.cjs'] });
    assert.equal(r.ok, true);
    assert.match(r.body, /# Files\n\nChange only these files[^\n]*\n\n- src\/c\.cjs\n\n# Implementation notes/);
    assert.ok(!r.body.includes('src/b.cjs'));
  });

  it('acceptanceCriteria-only patch replaces the criteria', () => {
    // scheduler.updatePrd passes the body after the frontmatter.
    const r = applyStructuredPrdPatch(splitFrontmatter(makeBody()).body, { acceptanceCriteria: ['only one'] });
    assert.equal(r.ok, true);
    assert.match(r.body, /# Acceptance criteria\n\n- \[ \] ac-1: only one\n\n# Files/);
    assert.ok(!r.body.includes('first works'));
    assert.deepEqual(r.criteria, [{ id: 'ac-1', statement: 'only one', check: { kind: 'manual' } }]);
  });

  it('acceptanceCriteria patch keeps ids stable for unchanged statements', () => {
    const previousCriteria = parsePrdFile(makeBody()).frontmatter.criteria;
    assert.deepEqual(previousCriteria.map((c) => c.id), ['ac-1', 'ac-2']);
    const r = applyStructuredPrdPatch(splitFrontmatter(makeBody()).body, {
      acceptanceCriteria: ['new first', 'second works', 'first works'],
      previousCriteria,
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.criteria.map((c) => [c.id, c.statement]), [['ac-3', 'new first'], ['ac-2', 'second works'], ['ac-1', 'first works']]);
    assert.match(r.body, /- \[ \] ac-3: new first\n- \[ \] ac-2: second works\n- \[ \] ac-1: first works\n/);
  });

  it('acceptanceCriteria patch accepts structured entries and refuses a bad one with its index', () => {
    const ok = applyStructuredPrdPatch(makeBody(), {
      acceptanceCriteria: [{ id: 'up', statement: 'Server up', check: { kind: 'http', spec: 'http://127.0.0.1:3000/' } }],
    });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.criteria[0].check, { kind: 'http', spec: { url: 'http://127.0.0.1:3000/', status: 200 } });
    const bad = applyStructuredPrdPatch(makeBody(), {
      acceptanceCriteria: ['a', { statement: 'x', check: { kind: 'http', spec: 'http://example.com/' } }],
    });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /criteria entry 2: http check url must be loopback only/);
  });

  it('rejects a gate with a shell metacharacter and leaves the body unchanged', { repeats: 20 }, () => {
    const body = makeBody();
    const r = applyStructuredPrdPatch(body, { gate: ['npm test | tee out.txt'] });
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
    // A failed result carries no body field (see prdBodyPatch.cjs ok:false shapes).
    assert.equal('body' in r, false);
  });

  it('rejects invalid files and an empty patch', () => {
    assert.equal(applyStructuredPrdPatch(makeBody(), { files: ['/abs/path'] }).ok, false);
    assert.equal(applyStructuredPrdPatch(makeBody(), {}).ok, false);
  });

  it('keeps untouched sections byte-identical', () => {
    const body = makeBody();
    const r = applyStructuredPrdPatch(body, { gate: ['timeout 5 node x.js'] });
    assert.equal(r.ok, true);
    for (const h of ['# Goal', '# Acceptance criteria', '# Files', '# Implementation notes', '# Out of scope', '## Engineering standards']) {
      assert.equal(section(r.body, h), section(body, h), h);
    }
    assert.equal(r.body.slice(0, body.indexOf('# Goal')), body.slice(0, body.indexOf('# Goal')));
  });
});
