'use strict';

// Per-criterion cross-check in parseValidatorVerdict(value, { expected }):
// a verdict that omits a criterion id, or marks met a criterion whose
// mechanical check failed, is refused with a named error.
// Run: timeout 120 npx vitest run src/main/lib/scheduler/__tests__/validatorVerdictCriteria.test.cjs

const assert = require('node:assert/strict');
const {
  VALIDATOR_VERDICT_SCHEMA,
  parseValidatorVerdict,
  expectedFromCriteria,
  formatCriteriaChecksSection,
} = require('../validatorVerdictSchema.cjs');

const entry = (prd, criteria, verdict = 'VERIFIED') => ({
  prd,
  verdict,
  reason: verdict === 'REFUTED' ? 'a criterion is unmet' : '',
  criteria,
  findings: [],
});
const run = (...verdicts) => ({ schedulerVerdict: 'PASS', verdicts });
const expected = { '3787-a': { ids: ['ac-1', 'ac-2'], failedIds: ['ac-2'] } };

describe('parseValidatorVerdict with expected criteria', () => {
  it('refuses met: true on a criterion whose mechanical check failed', () => {
    const v = run(entry('3787-a', [
      { id: 'ac-1', met: true, evidence: 'ok' },
      { id: 'ac-2', met: true, evidence: 'looked fine' },
    ]));
    const r = parseValidatorVerdict(v, { expected });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'criterion-met-on-failed-check');
    assert.match(r.error, /verdicts\[0\] \(3787-a\): criterion ac-2 marked met but its mechanical check failed/);
  });

  it('refuses a verdict that omits a criterion id', () => {
    const v = run(entry('3787-a', [{ id: 'ac-1', met: true, evidence: 'ok' }]));
    const r = parseValidatorVerdict(v, { expected });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'criterion-missing');
    assert.match(r.error, /verdicts\[0\] \(3787-a\): missing criterion id ac-2/);
  });

  it('matches an expected key by bare slug', () => {
    const v = run(entry('a', [{ id: 'ac-1', met: true, evidence: 'ok' }]));
    const r = parseValidatorVerdict(v, { expected: new Map(Object.entries(expected)) });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'criterion-missing');
  });

  it('accepts every id present with the failed one unmet', () => {
    const v = run(
      entry('3787-a', [
        { id: 'ac-1', met: true, evidence: 'ok' },
        { id: 'ac-2', met: false, evidence: 'check exit 1', missKind: 'gate-red' },
      ], 'REFUTED'),
      // A PRD with no expected record is checked as before.
      entry('3788-b', [{ id: '1', met: true, evidence: 'ok' }]),
    );
    const r = parseValidatorVerdict(v, { expected });
    assert.equal(r.ok, true);
    assert.equal(r.value, v);
  });

  it('legacy call (no expected) is unchanged: the same met-on-failed verdict passes', () => {
    const v = run(entry('3787-a', [{ id: 'ac-2', met: true, evidence: 'looked fine' }]));
    assert.equal(parseValidatorVerdict(v).ok, true);
    assert.equal(parseValidatorVerdict(v, {}).ok, true);
    assert.equal(parseValidatorVerdict(v, { expected: null }).ok, true);
    // Legacy structural errors still come back without a code.
    const bad = parseValidatorVerdict({ schedulerVerdict: 'PASS' });
    assert.deepEqual(bad, { ok: false, error: 'verdict: missing verdicts' });
  });
});

describe('expectedFromCriteria', () => {
  it('collects ids and only ok: false checks as failed', () => {
    const criteria = [
      { id: 'ac-1', statement: 'x', check: { kind: 'command', spec: 'npm test' } },
      { id: 'ac-2', statement: 'y', check: { kind: 'file', spec: 'a.txt' } },
      { id: 'ac-3', statement: 'z', check: { kind: 'manual' } },
    ];
    const checks = [
      { id: 'ac-1', kind: 'command', ok: true, detail: 'exit 0' },
      { id: 'ac-2', kind: 'file', ok: false, detail: 'missing' },
      { id: 'ac-3', kind: 'manual', ok: null, detail: '' },
      { id: 'other', kind: 'file', ok: false, detail: 'stale' },
    ];
    assert.deepEqual(expectedFromCriteria(criteria, checks), { ids: ['ac-1', 'ac-2', 'ac-3'], failedIds: ['ac-2'] });
    assert.deepEqual(expectedFromCriteria(criteria, undefined), { ids: ['ac-1', 'ac-2', 'ac-3'], failedIds: [] });
    assert.equal(expectedFromCriteria(undefined, checks), null);
    assert.equal(expectedFromCriteria([], checks), null);
  });
});

describe('formatCriteriaChecksSection', () => {
  it('lists each id with its stored check result, and is empty with no criteria', () => {
    const text = formatCriteriaChecksSection([
      {
        slug: '3787-a',
        criteria: [
          { id: 'ac-1', statement: 'tests pass', check: { kind: 'command' } },
          { id: 'ac-2', statement: 'file exists', check: { kind: 'file' } },
        ],
        checks: [{ id: 'ac-2', ok: false, detail: 'not found' }],
      },
      { slug: '3788-b', criteria: undefined, checks: [] },
    ]);
    assert.match(text, /Stored mechanical check results/);
    assert.match(text, /### 3787-a/);
    assert.match(text, /`ac-1` \(command\) not run: tests pass/);
    assert.match(text, /`ac-2` \(file\) FAIL — not found: file exists/);
    assert.doesNotMatch(text, /3788-b/);
    assert.equal(formatCriteriaChecksSection([{ slug: 'x', criteria: [], checks: [] }]), '');
  });
});

describe('schema', () => {
  it('criteria items stay { id, met, evidence } required', () => {
    const items = VALIDATOR_VERDICT_SCHEMA.properties.verdicts.items;
    assert.ok(items.required.includes('criteria'));
    assert.deepEqual(items.properties.criteria.items.required, ['id', 'met', 'evidence']);
    assert.match(items.properties.criteria.items.properties.id.description, /one entry per criterion id/i);
  });
});

describe('scheduler loadValidatorCriteriaContext', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  let tmpHome;
  let originalHome;
  let loadValidatorCriteriaContext;

  beforeAll(() => {
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-validator-criteria-'));
    process.env.HOME = tmpHome;
    ({ loadValidatorCriteriaContext } = require('../../../scheduler.cjs'));
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('builds expected { ids, failedIds } from PRD frontmatter criteria + the stored outcome checks', async () => {
    const cwd = fs.mkdtempSync(path.join(tmpHome, 'proj-'));
    const epicId = 'epic-abc';
    const epicDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', epicId);
    fs.mkdirSync(path.join(epicDir, 'prds'), { recursive: true });
    fs.mkdirSync(path.join(epicDir, 'outcomes'), { recursive: true });
    const criteria = [
      { id: 'ac-1', statement: 'tests pass', check: { kind: 'command', spec: 'npm test' } },
      { id: 'ac-2', statement: 'file exists', check: { kind: 'file', spec: 'a.txt' } },
    ];
    fs.writeFileSync(
      path.join(epicDir, 'prds', '3787-a.md'),
      `---\ntitle: A\ncriteria: ${JSON.stringify(criteria)}\n---\n# Goal\n\nx\n`,
    );
    fs.writeFileSync(path.join(epicDir, 'prds', '3788-b.md'), '---\ntitle: B\n---\n# Goal\n\ny\n');
    fs.writeFileSync(
      path.join(epicDir, 'outcomes', '3787-a.json'),
      JSON.stringify({ slug: '3787-a', checks: [{ id: 'ac-1', ok: true, detail: 'exit 0' }, { id: 'ac-2', ok: false, detail: 'missing' }] }),
    );
    const ctx = await loadValidatorCriteriaContext({ agentType: 'validator', cwd, epicId, slug: '3790-validate', dependsOn: ['3787-a', '3788-b'] });
    assert.deepEqual(ctx.expected, { '3787-a': { ids: ['ac-1', 'ac-2'], failedIds: ['ac-2'] } });
    assert.match(ctx.section, /`ac-2` \(file\) FAIL — missing: file exists/);
    assert.doesNotMatch(ctx.section, /3788-b/);

    const nonValidator = await loadValidatorCriteriaContext({ agentType: 'dev-lead', cwd, epicId, dependsOn: ['3787-a'] });
    assert.deepEqual(nonValidator, { expected: {}, section: '' });
  });
});
