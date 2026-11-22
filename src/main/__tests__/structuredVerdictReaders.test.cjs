/**
 * structuredVerdictReaders.test.cjs — the loop-efficiency, reaper and RCA
 * readers take a `--json-schema` result event's structured_output first and
 * keep the text sentinel scan for older/text-only runs. Temp run logs only.
 * Run: timeout 300 npx vitest run src/main/__tests__/structuredVerdictReaders.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { gatherLoopEfficiency } = require('../loopEfficiencyHandlers.cjs');
const { classifyRunOutcome, resolveReapGateOutcome } = require('../lib/scheduler/reaperHelpers.cjs');
const { classifyFailure, FAILURE_CLASSES } = require('../lib/scheduler/rcaReport.cjs');

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
let root;

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'structverdict-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function structured(schedulerVerdict) {
  return {
    schedulerVerdict,
    verdicts: [
      { prd: 'one', verdict: 'VERIFIED', reason: 'ok', criteria: [{ id: 'AC1', met: true, evidence: 'x' }], findings: [] },
      {
        prd: 'two', verdict: 'REFUTED', reason: 'missing test',
        criteria: [{ id: 'AC1', met: false, evidence: 'no test', missKind: 'missing-test' }], findings: [],
      },
    ],
  };
}

/** A stream-json result line the way `claude -p --json-schema` writes it. */
function structuredResultLine(so) {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(so), structured_output: so });
}

function addRun(runId, slug, log) {
  const dir = path.join(root, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.meta.json`), JSON.stringify({ slug, cwd: '/p/alpha', totalCostUsd: 1 }));
  fs.writeFileSync(path.join(dir, `${slug}.log`), log);
  return path.join(dir, `${slug}.log`);
}

function resultOf(logPath) {
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.includes('"type":"result"'));
  return JSON.parse(lines[lines.length - 1]);
}

test('loop efficiency: a structured-output validator log yields its verdicts', async () => {
  const so = structured('FAIL');
  addRun('2026-10-22T03-00-00-000Z', 'plan-validate-s', `noise\n${structuredResultLine(so)}\n`);
  const r = await gatherLoopEfficiency({ runsRoot: root, nowMs: NOW, usage: null });
  expect(r.totals.verified).toBe(1);
  expect(r.totals.refuted).toBe(1);
});

test('loop efficiency: an older text-sentinel validator log still yields its verdicts', async () => {
  const line = JSON.stringify({ type: 'result', result: 'done\nVALIDATION: one VERIFIED\nVALIDATION: two REFUTED — nope\n' });
  addRun('2026-10-22T03-00-00-000Z', 'plan-validate-t', `noise\n${line}\n`);
  const r = await gatherLoopEfficiency({ runsRoot: root, nowMs: NOW, usage: null });
  expect(r.totals.verified).toBe(1);
  expect(r.totals.refuted).toBe(1);
});

test('loop efficiency: a structured_output that fails the schema falls back to the text scan', async () => {
  const line = JSON.stringify({ type: 'result', result: 'VALIDATION: one VERIFIED\n', structured_output: { schedulerVerdict: 'PASS' } });
  addRun('2026-10-22T03-00-00-000Z', 'plan-validate-b', `${line}\n`);
  const r = await gatherLoopEfficiency({ runsRoot: root, nowMs: NOW, usage: null });
  expect(r.totals.verified).toBe(1);
  expect(r.totals.refuted).toBe(0);
});

test('reaper: a reaped validator row with structured PASS is passed, FAIL is failed', () => {
  for (const [sv, want] of [['PASS', 'passed'], ['FAIL', 'failed']]) {
    const logPath = addRun(`2026-10-22T03-00-00-00${sv === 'PASS' ? 1 : 2}Z`, 'plan-validate-r', `${structuredResultLine(structured(sv))}\n`);
    const outcome = classifyRunOutcome(logPath);
    expect(outcome).toBe('success');
    const ev = resultOf(logPath);
    // As scheduler.cjs calls it today (result text only — the JSON string)…
    expect(resolveReapGateOutcome(outcome, ev.result)).toBe(want);
    // …and with the structured output passed explicitly.
    expect(resolveReapGateOutcome(outcome, ev.result, ev.structured_output)).toBe(want);
  }
});

test('reaper: text-only rows are unchanged', () => {
  const pass = JSON.stringify({ type: 'result', subtype: 'success', result: 'done\nSCHEDULER_VERDICT: PASS' });
  const logPath = addRun('2026-10-22T03-00-00-000Z', 'plain-job', `${pass}\n`);
  expect(resolveReapGateOutcome(classifyRunOutcome(logPath), resultOf(logPath).result)).toBe('passed');
  expect(resolveReapGateOutcome('success', 'SCHEDULER_VERDICT: PASS\nSCHEDULER_VERDICT: FAIL boom')).toBe('failed');
  expect(resolveReapGateOutcome('success', 'all done, no verdict')).toBe('unknown');
  expect(resolveReapGateOutcome('success', '{"not":"a verdict"}')).toBe('unknown');
  expect(resolveReapGateOutcome('success', null)).toBe('unknown');
  expect(resolveReapGateOutcome('no_result', null)).toBe('never_ran');
  expect(resolveReapGateOutcome('failed', 'SCHEDULER_VERDICT: PASS')).toBe('failed');
});

test('rca: a structured PASS result event after the AC counts as PASS seen', () => {
  const ac = '- [x] did the thing';
  const filler = Array.from({ length: 5 }, (_, i) => `work line ${i}`);
  const structuredTail = [ac, ...filler, structuredResultLine(structured('PASS'))].join('\n');
  expect(classifyFailure({ verdict: 'uncommitted_changes', logTail: structuredTail })).toBe(FAILURE_CLASSES.UNCOMMITTED);
  const failTail = [ac, ...filler, structuredResultLine(structured('FAIL'))].join('\n');
  expect(classifyFailure({ verdict: 'uncommitted_changes', logTail: failTail })).toBe(FAILURE_CLASSES.POST_AC_OVERRUN);
  const textTail = [ac, ...filler, 'SCHEDULER_VERDICT: PASS'].join('\n');
  expect(classifyFailure({ verdict: 'uncommitted_changes', logTail: textTail })).toBe(FAILURE_CLASSES.UNCOMMITTED);
});
