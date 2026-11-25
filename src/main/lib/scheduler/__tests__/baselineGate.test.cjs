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
  const ok = {
    job, ...proofs, headOutcome: red('x', PY), baseOutcome: red('y', PY + 'FAILED c.py::z\n'), env: {},
    failReason: 'gate red: 2 pre-existing failures in tests/a.py, identical on base',
  };
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
  it("refuses an already-red gate when the FAIL reason is about something else", () => {
    const VT = ' FAIL  src/a.test.ts > suite > does it 5ms\n FAIL  src/b.test.ts\n   × other thing 3ms\n';
    const r = decideBaselineAuthority({
      ...ok,
      headOutcome: red('x', VT),
      baseOutcome: red('y', VT),
      failReason: 'executor reported SCHEDULER_VERDICT: FAIL: HUMAN_ACTION_REQUIRED: owner must complete App Store Connect compliance forms SECURITYASF395E, AIGENERATEFD1DE',
    });
    assert.deepEqual(r, { complete: false, reason: 'fail-not-about-gate', preexisting: [] });
  });
  it('completes when the FAIL reason names a failing test file', () => {
    const VT = ' FAIL  src/a.test.ts > suite > does it 5ms\n FAIL  src/b.test.ts\n   × other thing 3ms\n';
    const r = decideBaselineAuthority({
      ...ok,
      headOutcome: red('x', VT),
      baseOutcome: red('y', VT),
      failReason: 'gate red: 2 pre-existing failures in src/b.test.ts, identical on base',
    });
    assert.deepEqual(r, {
      complete: true,
      reason: 'baseline-identical',
      preexisting: ['src/a.test.ts > suite > does it', 'src/b.test.ts > other thing'],
    });
  });
  it('refuses when failReason is omitted or empty', () => {
    const { failReason: _omit, ...noReason } = ok;
    assert.equal(decideBaselineAuthority(noReason).reason, 'fail-not-about-gate');
    assert.equal(reason({ failReason: '' }), 'fail-not-about-gate');
  });
  it('matches a pytest id by its path part and a tsc id by its file part', () => {
    assert.equal(reason({ failReason: 'red: tests/b.py fails on base too' }), 'baseline-identical');
    const TS = 'src/x.ts(10,5): error TS2322: bad\n';
    assert.equal(
      reason({ headOutcome: red('x', TS), baseOutcome: red('y', TS), failReason: 'typecheck red in src/x.ts, pre-existing' }),
      'baseline-identical',
    );
  });
});
