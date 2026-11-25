'use strict';
// Run: timeout 120 npx vitest run src/main/lib/scheduler/__tests__/prdOutcomeRecord.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OPS_ROOT_DIR } = require('../../opsOwnership.cjs');
const epicEventLog = require('../../epic/epicEventLog.cjs');
const {
  writeOutcomeRecord, outcomeRecordPath, buildOutcomeFromJob, mergeOutcomeChecks, writeCheckBody,
} = require('../prdOutcomeRecord.cjs');

const EPIC = 'epic-abc123';
let cwd;

beforeEach(() => {
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prd-outcome-')));
  epicEventLog._resetForTests();
});
afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

function readRecord(slug) {
  const file = path.join(cwd, OPS_ROOT_DIR, 'scheduler', 'epics', EPIC, 'outcomes', `${slug}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('writeOutcomeRecord', () => {
  it('writes a completed job record under scheduler/epics/<epicId>/outcomes and appends outcome.recorded', async () => {
    const file = await writeOutcomeRecord({
      cwd,
      epicId: EPIC,
      slug: '3786-ma-prd-outcome-record',
      commits: ['abc1234'],
      files: ['src/a.cjs', 'src/b.cjs'],
      gates: [{ source: 'verifier', verdict: 'clean', exitCode: 0 }],
      checks: [{ id: 'c1', kind: 'command', ok: true, detail: 'exit 0' }],
      verdict: 'completed',
    });
    assert.equal(file, outcomeRecordPath(cwd, EPIC, '3786-ma-prd-outcome-record'));
    const rec = readRecord('3786-ma-prd-outcome-record');
    assert.equal(rec.slug, '3786-ma-prd-outcome-record');
    assert.equal(rec.epicId, EPIC);
    assert.equal(rec.verdict, 'completed');
    assert.deepEqual(rec.commits, ['abc1234']);
    assert.deepEqual(rec.files, ['src/a.cjs', 'src/b.cjs']);
    assert.deepEqual(rec.gates, [{ source: 'verifier', verdict: 'clean', exitCode: 0 }]);
    assert.deepEqual(rec.checks, [{ id: 'c1', kind: 'command', ok: true, detail: 'exit 0' }]);
    assert.equal(typeof rec.recordedAt, 'string');
    // No leftover tmp files from the atomic write.
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['3786-ma-prd-outcome-record.json']);

    const { events } = await epicEventLog.readEpicEvents(cwd, EPIC, { kinds: ['outcome.recorded'] });
    assert.equal(events.length, 1);
    assert.equal(events[0].slug, '3786-ma-prd-outcome-record');
    assert.equal(events[0].verdict, 'completed');
  });

  it('writes a failed job record (no commits) and its event', async () => {
    const job = {
      slug: '9001-broken', status: 'failed', exitCode: 1, verifierVerdict: undefined,
      terminalReason: 'exit_nonzero', error: 'boom',
    };
    const built = buildOutcomeFromJob({ job, verifyResult: null, commits: [], files: [] });
    assert.equal(built.verdict, 'failed');
    assert.deepEqual(built.checks, []);
    assert.equal(built.gates[0].exitCode, 1);
    await writeOutcomeRecord({ cwd, epicId: EPIC, slug: job.slug, ...built });
    const rec = readRecord('9001-broken');
    assert.equal(rec.verdict, 'failed');
    assert.deepEqual(rec.commits, []);
    assert.deepEqual(rec.files, []);
    const { events } = await epicEventLog.readEpicEvents(cwd, EPIC);
    assert.deepEqual(events.map((e) => [e.kind, e.slug, e.verdict]), [['outcome.recorded', '9001-broken', 'failed']]);
  });

  it('buildOutcomeFromJob carries gate-shadow results and criteria checks for needs_review', () => {
    const job = {
      slug: 'x', status: 'needs_review', exitCode: 0, verifierVerdict: 'uncommitted_changes',
      gateShadow: { status: 'red', source: 'prd', head: 'h1', results: [{ cmd: 'npm test', code: 1 }], criteriaChecks: [{ id: 'k', kind: 'file', ok: false, detail: 'missing' }] },
    };
    const built = buildOutcomeFromJob({ job, verifyResult: { verdict: 'uncommitted_changes', reason: 'dirty' }, commits: ['s1'], files: ['f'] });
    assert.equal(built.verdict, 'needs_review');
    assert.equal(built.gates.length, 2);
    assert.equal(built.gates[0].verdict, 'uncommitted_changes');
    assert.equal(built.gates[1].status, 'red');
    assert.deepEqual(built.checks, [{ id: 'k', kind: 'file', ok: false, detail: 'missing' }]);
  });

  it('rejects an unsafe slug or epicId before touching disk', async () => {
    await assert.rejects(writeOutcomeRecord({ cwd, epicId: EPIC, slug: '../evil', verdict: 'failed' }));
    await assert.rejects(writeOutcomeRecord({ cwd, epicId: '../x', slug: 'ok', verdict: 'failed' }));
    assert.equal(fs.existsSync(path.join(cwd, OPS_ROOT_DIR)), false);
  });
});

describe('mergeOutcomeChecks', () => {
  const slug = '4459-merge';
  it('replaces checks by id, keeps unrelated entries, stamps fresh ones', async () => {
    await writeOutcomeRecord({
      cwd, epicId: EPIC, slug, commits: [], files: [], gates: [], verdict: 'completed',
      checks: [{ id: 'a', kind: 'command', ok: true, detail: 'exit 0' }, { id: 'b', kind: 'http', ok: null, detail: 'old' }],
      appendEvent: async () => {},
    });
    const ok = await mergeOutcomeChecks({ cwd, epicId: EPIC, slug, checks: [{ id: 'b', kind: 'http', ok: false, detail: 'HTTP 500' }] });
    assert.equal(ok, true);
    const rec = readRecord(slug);
    assert.equal(rec.verdict, 'completed');
    assert.equal(rec.checks.length, 2);
    assert.deepEqual(rec.checks[0], { id: 'a', kind: 'command', ok: true, detail: 'exit 0' });
    assert.equal(rec.checks[1].id, 'b');
    assert.equal(rec.checks[1].ok, false);
    assert.equal(rec.checks[1].stage, 'validator-dispatch');
    assert.match(rec.checks[1].ranAt, /^\d{4}-\d\d-\d\dT/);
  });

  it('writes nothing when no record exists', async () => {
    let called = 0;
    const ok = await mergeOutcomeChecks({ cwd, epicId: EPIC, slug: 'none', checks: [{ id: 'x', ok: true }], write: async () => { called++; } });
    assert.equal(ok, false);
    assert.equal(called, 0);
    assert.equal(fs.existsSync(path.join(cwd, OPS_ROOT_DIR, 'scheduler', 'epics', EPIC, 'outcomes', 'none.json')), false);
  });

  it('never throws on an unsafe epicId', async () => {
    assert.equal(await mergeOutcomeChecks({ cwd, epicId: '../evil', slug, checks: [] }), false);
  });
});

describe('writeCheckBody', () => {
  it('writes <slug>.bodies/<id>.txt, overwriting per id, and returns the path', async () => {
    const p1 = await writeCheckBody({ cwd, epicId: EPIC, slug: '4459-b', id: 'live', body: 'one' });
    const p2 = await writeCheckBody({ cwd, epicId: EPIC, slug: '4459-b', id: 'live', body: 'two' });
    assert.equal(p1, path.join(cwd, OPS_ROOT_DIR, 'scheduler', 'epics', EPIC, 'outcomes', '4459-b.bodies', 'live.txt'));
    assert.equal(p1, p2);
    assert.equal(fs.readFileSync(p1, 'utf8'), 'two');
  });
  it('returns null without throwing on unsafe ids', async () => {
    assert.equal(await writeCheckBody({ cwd, epicId: '../x', slug: 's', id: 'a', body: '' }), null);
    assert.equal(await writeCheckBody({ cwd, epicId: EPIC, slug: 's', id: '../a', body: '' }), null);
  });
});
