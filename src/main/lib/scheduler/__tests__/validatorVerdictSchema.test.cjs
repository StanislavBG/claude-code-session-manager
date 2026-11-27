'use strict';

const assert = require('node:assert/strict');
const {
  VALIDATOR_VERDICT_SCHEMA,
  MISS_KINDS,
  MISS_KIND_MEANINGS,
  SEVERITIES,
  parseValidatorVerdict,
  verdictRowsFromStructured,
} = require('../validatorVerdictSchema.cjs');

const verified = (prd = '3612-a') => ({
  prd,
  verdict: 'VERIFIED',
  reason: '',
  criteria: [{ id: '1', met: true, evidence: 'file exists' }],
  findings: [],
});
const refuted = (prd = '3613-b') => ({
  prd,
  verdict: 'REFUTED',
  reason: 'gate fails',
  criteria: [
    { id: '1', met: true, evidence: 'ok' },
    { id: '2', met: false, evidence: 'vitest red', missKind: 'gate-red' },
  ],
  findings: [
    { severity: 'Important', text: 'no test for X', file: 'src/x.cjs', missKind: 'missing-test' },
    { severity: 'Minor', text: 'again red', missKind: 'gate-red' },
  ],
});
const run = (...verdicts) => ({ schedulerVerdict: 'PASS', verdicts });
const clone = (v) => JSON.parse(JSON.stringify(v));

describe('constants', () => {
  it('MISS_KINDS is frozen, ordered, and every kind has a meaning', () => {
    assert.deepEqual([...MISS_KINDS], [
      'not-landed', 'gate-red', 'behavior-wrong', 'not-checked-live', 'missing-test',
      'regression', 'spec-gap', 'security', 'docs-drift', 'other',
    ]);
    assert.ok(Object.isFrozen(MISS_KINDS));
    assert.deepEqual(Object.keys(MISS_KIND_MEANINGS), [...MISS_KINDS]);
    for (const k of MISS_KINDS) assert.ok(MISS_KIND_MEANINGS[k].length > 0);
    assert.deepEqual([...SEVERITIES], ['Critical', 'Important', 'Minor']);
  });
});

describe('VALIDATOR_VERDICT_SCHEMA', () => {
  it('is plain JSON and under 8192 chars', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(VALIDATOR_VERDICT_SCHEMA)), VALIDATOR_VERDICT_SCHEMA);
    assert.ok(JSON.stringify(VALIDATOR_VERDICT_SCHEMA).length < 8192);
  });
  it('has the required shape with additionalProperties false everywhere', () => {
    const s = VALIDATOR_VERDICT_SCHEMA;
    assert.deepEqual(s.required, ['schedulerVerdict', 'verdicts']);
    assert.deepEqual(s.properties.schedulerVerdict.enum, ['PASS', 'FAIL']);
    assert.equal(s.properties.failReason.type, 'string');
    const item = s.properties.verdicts.items;
    assert.deepEqual(item.required, ['prd', 'verdict', 'reason', 'criteria', 'findings']);
    assert.equal(item.properties.prd.minLength, 1);
    assert.deepEqual(item.properties.verdict.enum, ['VERIFIED', 'REFUTED']);
    const crit = item.properties.criteria.items;
    assert.deepEqual(crit.required, ['id', 'met', 'evidence']);
    assert.deepEqual(crit.properties.missKind.enum, [...MISS_KINDS]);
    assert.match(crit.properties.id.description, /1-based/);
    const find = item.properties.findings.items;
    assert.deepEqual(find.required, ['severity', 'text']);
    assert.deepEqual(find.properties.severity.enum, [...SEVERITIES]);
    assert.deepEqual(find.properties.missKind.enum, [...MISS_KINDS]);
    assert.equal(find.properties.file.type, 'string');
    for (const obj of [s, item, crit, find]) {
      assert.equal(obj.type, 'object');
      assert.equal(obj.additionalProperties, false);
    }
  });
});

describe('parseValidatorVerdict — ok', () => {
  it('accepts a well-formed run', () => {
    const v = run(verified(), refuted());
    assert.deepEqual(parseValidatorVerdict(v), { ok: true, value: v });
  });
  it('accepts FAIL with failReason and an empty verdicts array', () => {
    const v = { schedulerVerdict: 'FAIL', failReason: 'gate red', verdicts: [] };
    assert.equal(parseValidatorVerdict(v).ok, true);
  });
  it('accepts REFUTED whose missKind lives only on a finding', () => {
    const r = refuted();
    delete r.criteria[1].missKind;
    assert.equal(parseValidatorVerdict(run(r)).ok, true);
  });
});

describe('parseValidatorVerdict — errors (never throws)', () => {
  /** @type {Array<[string, unknown]>} */
  const cases = [];
  cases.push(['null', null], ['string', 'PASS'], ['array', []], ['number', 3]);
  cases.push(['unknown schedulerVerdict', { ...run(verified()), schedulerVerdict: 'OK' }]);
  cases.push(['missing verdicts', { schedulerVerdict: 'PASS' }]);
  cases.push(['non-string failReason', { ...run(), failReason: 1 }]);
  cases.push(['extra top-level key', { ...run(), extra: 1 }]);
  { const r = verified(); r.verdict = 'MAYBE'; cases.push(['unknown verdict', run(r)]); }
  { const r = verified(); r.prd = ''; cases.push(['empty prd', run(r)]); }
  { const r = refuted(); r.reason = '  '; cases.push(['REFUTED empty reason', run(r)]); }
  { const r = verified(); r.criteria[0].met = 'yes'; cases.push(['met not boolean', run(r)]); }
  { const r = verified(); r.criteria[0].id = 1; cases.push(['criterion id not string', run(r)]); }
  { const r = verified(); r.criteria[0].extra = 1; cases.push(['extra criterion key', run(r)]); }
  { const r = refuted(); r.findings[0].severity = 'Major'; cases.push(['bad severity', run(r)]); }
  { const r = refuted(); r.findings[0].missKind = 'typo'; cases.push(['bad finding missKind', run(r)]); }
  { const r = refuted(); r.criteria[1].missKind = 'nope'; cases.push(['bad criterion missKind', run(r)]); }
  { const r = refuted(); r.findings[0].file = 5; cases.push(['file not string', run(r)]); }
  { const r = verified(); delete r.findings; cases.push(['missing findings', run(r)]); }
  cases.push(['duplicate prd', run(verified('3612-a'), refuted('3612-a'))]);
  {
    const r = refuted();
    delete r.criteria[1].missKind;
    for (const f of r.findings) delete f.missKind;
    cases.push(['REFUTED without any missKind', run(r)]);
  }
  for (const [name, value] of cases) {
    it(name, () => {
      let res;
      assert.doesNotThrow(() => { res = parseValidatorVerdict(value); });
      assert.equal(res.ok, false);
      assert.equal(typeof res.error, 'string');
      assert.ok(res.error.length > 0);
    });
  }
  it('does not mutate input', () => {
    const v = run(refuted());
    const before = clone(v);
    parseValidatorVerdict(v);
    assert.deepEqual(v, before);
  });
});

describe('verdictRowsFromStructured', () => {
  it('returns rows in input order with deduped sorted missKinds', () => {
    const r = refuted('3613-b');
    r.criteria.push({ id: '3', met: true, evidence: 'ok', missKind: 'security' });
    const rows = verdictRowsFromStructured(run(r, verified('3612-a')));
    assert.deepEqual(rows, [
      { slug: '3613-b', verdict: 'refuted', reason: 'gate fails', missKinds: ['gate-red', 'missing-test'] },
      { slug: '3612-a', verdict: 'verified', reason: '', missKinds: [] },
    ]);
  });
  it('returns [] for an invalid value', () => {
    assert.deepEqual(verdictRowsFromStructured(null), []);
    assert.deepEqual(verdictRowsFromStructured({ schedulerVerdict: 'X', verdicts: [] }), []);
  });
});

describe('optional lessons field', () => {
  it('is optional: verdicts without it still validate', () => {
    assert.equal(parseValidatorVerdict(run(verified())).ok, true);
    assert.equal(VALIDATOR_VERDICT_SCHEMA.required.includes('lessons'), false);
  });
  it('accepts up to 3 strings of at most 200 chars', () => {
    assert.equal(parseValidatorVerdict({ ...run(verified()), lessons: ['a', 'b'.repeat(200)] }).ok, true);
  });
  it('rejects more than 3, a long one, or a non-string', () => {
    assert.equal(parseValidatorVerdict({ ...run(verified()), lessons: ['a', 'b', 'c', 'd'] }).ok, false);
    assert.equal(parseValidatorVerdict({ ...run(verified()), lessons: ['x'.repeat(201)] }).ok, false);
    assert.equal(parseValidatorVerdict({ ...run(verified()), lessons: [1] }).ok, false);
  });
});
