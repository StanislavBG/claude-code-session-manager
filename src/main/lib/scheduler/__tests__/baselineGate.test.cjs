'use strict';

const assert = require('node:assert/strict');
const { parseFailingTests, decideBaselineAuthority } = require('../baselineGate.cjs');

const red = (...outs) => ({ status: 'red', results: outs.map((o, i) => ({ status: i === outs.length - 1 ? 'fail' : 'pass', outputTail: o })) });
const job = { status: 'needs_review', verifierVerdict: 'sentinel_fail', landedCommit: 'abc123' };
const proofs = { evidenceOk: true, ancestorOk: true, cleanOk: true, headStable: true };
const PY = 'FAILED tests/a.py::test_x - assert 1\nFAILED tests/b.py::test_y\n';

describe('parseFailingTests', () => {
  it('pytest', () => {
    assert.deepEqual(parseFailingTests(PY), ['tests/a.py::test_x', 'tests/b.py::test_y']);
  });
  it('vitest FAIL lines and × lines', () => {
    const out = ' FAIL  src/a.test.ts > suite > does it 5ms\n FAIL  src/b.test.ts\n   × other thing 3ms\n';
    assert.deepEqual(parseFailingTests(out), ['src/a.test.ts > suite > does it', 'src/b.test.ts > other thing']);
  });
  it('jest', () => {
    assert.deepEqual(parseFailingTests('  ● Suite › works\n  ● Console\n'), ['Suite › works']);
  });
  it('tsc', () => {
    assert.deepEqual(parseFailingTests('src/x.ts(10,5): error TS2322: bad\n'), ['src/x.ts:TS2322']);
  });
  it('strips ANSI and returns null when nothing parses', () => {
    assert.deepEqual(parseFailingTests('\u001b[31mFAILED a::b\u001b[0m'), ['a::b']);
    assert.equal(parseFailingTests('something exploded'), null);
    assert.equal(parseFailingTests(undefined), null);
  });
});

describe('decideBaselineAuthority', () => {
  const ok = { job, ...proofs, headOutcome: red('x', PY), baseOutcome: red('y', PY + 'FAILED c.py::z\n'), env: {} };
  const reason = (over) => decideBaselineAuthority({ ...ok, ...over }).reason;

  it('completes when HEAD failures are a subset of base', () => {
    assert.deepEqual(decideBaselineAuthority(ok), {
      complete: true,
      reason: 'baseline-identical',
      preexisting: ['tests/a.py::test_x', 'tests/b.py::test_y'],
    });
  });
  it('refusals', () => {
    assert.equal(reason({ env: { SM_BASELINE_GATE_AUTHORITY_DISABLE: '1' } }), 'kill-switch');
    assert.equal(reason({ job: { ...job, verifierVerdict: 'transcript_errors' } }), 'verdict-not-eligible');
    assert.equal(reason({ job: { ...job, status: 'completed' } }), 'verdict-not-eligible');
    assert.equal(reason({ job: { ...job, landedCommit: '' } }), 'no-landed-commit');
    assert.equal(reason({ evidenceOk: false }), 'commit-not-from-this-run');
    assert.equal(reason({ ancestorOk: false }), 'commit-not-on-head');
    assert.equal(reason({ cleanOk: false }), 'tree-dirty');
    assert.equal(reason({ headStable: false }), 'head-moved-during-gate');
    assert.equal(reason({ headOutcome: { status: 'green', results: [] } }), 'head-not-red');
    assert.equal(reason({ baseOutcome: { status: 'green', results: [] } }), 'base-green');
    assert.equal(reason({ baseOutcome: { status: 'unavailable', results: [] } }), 'base-unavailable');
    assert.equal(reason({ baseOutcome: red(PY) }), 'different-failing-step');
    assert.equal(reason({ headOutcome: red('x', 'boom') }), 'unparseable-output');
    assert.equal(reason({ baseOutcome: red('y', 'boom') }), 'unparseable-output');
    assert.equal(reason({ headOutcome: red('x', PY + 'FAILED new.py::n\n') }), 'new-failures');
  });
});
