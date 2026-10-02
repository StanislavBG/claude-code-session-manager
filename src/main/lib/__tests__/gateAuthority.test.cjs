/**
 * gateAuthority.test.cjs — one case per decideGateAuthority reason, plus the
 * all-pass case.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/gateAuthority.test.cjs
 */
'use strict';

const assert = require('node:assert/strict');
const { GATE_AUTHORITY_VERDICTS, decideGateAuthority } = require('../gateAuthority.cjs');

// A fully-eligible baseline: every check passes, so decideGateAuthority
// returns gate-green. Each test overrides exactly the field(s) its check
// reads, so a failing assertion points straight at the one broken check.
function baseParams(overrides = {}) {
  const { job, gate, outcome, ...rest } = overrides;
  return {
    job: {
      status: 'needs_review',
      verifierVerdict: 'transcript_errors',
      landedCommit: 'abc1234',
      ...job,
    },
    gate: { source: 'ac-line', sequence: [{ argv: ['npm', 'run', 'test'] }], ...gate },
    outcome: { status: 'green', ...outcome },
    evidenceOk: true,
    ancestorOk: true,
    cleanOk: true,
    headStable: true,
    env: {},
    ...rest,
  };
}

test('all checks pass → complete, gate-green', () => {
  assert.deepEqual(decideGateAuthority(baseParams()), { complete: true, reason: 'gate-green' });
});

test('GATE_AUTHORITY_VERDICTS is exactly the three transcript-noise verdicts', () => {
  assert.deepEqual(GATE_AUTHORITY_VERDICTS, ['transcript_errors', 'no_verdict_sentinel', 'abandoned_background_task']);
  assert.throws(() => { GATE_AUTHORITY_VERDICTS.push('x'); });
});

test('check 1: kill switch wins over an otherwise-eligible row', () => {
  const params = baseParams({ env: { SM_GATE_AUTHORITATIVE_DISABLE: '1' } });
  assert.deepEqual(decideGateAuthority(params), { complete: false, reason: 'kill-switch' });
});

test('check 2: verdict-not-eligible — wrong verdict, and wrong status', () => {
  const wrongVerdict = baseParams({ job: { verifierVerdict: 'shared_tree_reverted' } });
  assert.deepEqual(decideGateAuthority(wrongVerdict), { complete: false, reason: 'verdict-not-eligible' });

  const wrongStatus = baseParams({ job: { status: 'completed' } });
  assert.deepEqual(decideGateAuthority(wrongStatus), { complete: false, reason: 'verdict-not-eligible' });
});

test('check 3: no-landed-commit — missing or empty', () => {
  const missing = baseParams({ job: { landedCommit: undefined } });
  assert.deepEqual(decideGateAuthority(missing), { complete: false, reason: 'no-landed-commit' });

  const empty = baseParams({ job: { landedCommit: '' } });
  assert.deepEqual(decideGateAuthority(empty), { complete: false, reason: 'no-landed-commit' });
});

test('check 4: commit-not-from-this-run when evidenceOk is false', () => {
  const params = { ...baseParams(), evidenceOk: false };
  assert.deepEqual(decideGateAuthority(params), { complete: false, reason: 'commit-not-from-this-run' });
});

test('check 5: commit-not-on-head when ancestorOk is false', () => {
  const params = { ...baseParams(), ancestorOk: false };
  assert.deepEqual(decideGateAuthority(params), { complete: false, reason: 'commit-not-on-head' });
});

test('check 6: tree-dirty when cleanOk is false', () => {
  const params = { ...baseParams(), cleanOk: false };
  assert.deepEqual(decideGateAuthority(params), { complete: false, reason: 'tree-dirty' });
});

test('check 7: head-moved-during-gate when headStable is false', () => {
  const params = { ...baseParams(), headStable: false };
  assert.deepEqual(decideGateAuthority(params), { complete: false, reason: 'head-moved-during-gate' });
});

test('check 8: no-gate — absent source, and an explicit source with an empty sequence', () => {
  const absent = baseParams({ gate: { source: 'absent', sequence: [] } });
  assert.deepEqual(decideGateAuthority(absent), { complete: false, reason: 'no-gate' });

  const emptySequence = baseParams({ gate: { source: 'explicit', sequence: [] } });
  assert.deepEqual(decideGateAuthority(emptySequence), { complete: false, reason: 'no-gate' });
});

test('check 9: gate-not-green when the re-run outcome is not green', () => {
  const red = baseParams({ outcome: { status: 'red' } });
  assert.deepEqual(decideGateAuthority(red), { complete: false, reason: 'gate-not-green' });

  const unavailable = baseParams({ outcome: { status: 'unavailable' } });
  assert.deepEqual(decideGateAuthority(unavailable), { complete: false, reason: 'gate-not-green' });
});

test('check order: evidenceOk wins over ancestorOk, cleanOk and headStable all failing at once', () => {
  const params = { ...baseParams(), evidenceOk: false, ancestorOk: false, cleanOk: false, headStable: false };
  assert.deepEqual(decideGateAuthority(params), { complete: false, reason: 'commit-not-from-this-run' });
});

test('check order: ancestorOk wins over cleanOk and headStable both failing, once evidenceOk passes', () => {
  const params = { ...baseParams(), ancestorOk: false, cleanOk: false, headStable: false };
  assert.deepEqual(decideGateAuthority(params), { complete: false, reason: 'commit-not-on-head' });
});

test('check order: cleanOk wins over headStable failing too, once evidenceOk and ancestorOk pass', () => {
  const params = { ...baseParams(), cleanOk: false, headStable: false };
  assert.deepEqual(decideGateAuthority(params), { complete: false, reason: 'tree-dirty' });
});

test('defaults env to process.env when not passed', () => {
  const prior = process.env.SM_GATE_AUTHORITATIVE_DISABLE;
  delete process.env.SM_GATE_AUTHORITATIVE_DISABLE;
  try {
    const { env, ...rest } = baseParams();
    assert.deepEqual(decideGateAuthority(rest), { complete: true, reason: 'gate-green' });
  } finally {
    if (prior === undefined) delete process.env.SM_GATE_AUTHORITATIVE_DISABLE;
    else process.env.SM_GATE_AUTHORITATIVE_DISABLE = prior;
  }
});
