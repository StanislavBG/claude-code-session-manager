/**
 * validatorStructuredVerdict.test.cjs — PRD 3614: with `--json-schema` the
 * CLI replaces a validator's result text with the JSON string, so the
 * scheduler reads the run's verdicts (notifyOriginatingTab) and its
 * scheduler verdict (runVerify scanSentinel) from structured_output.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/validatorStructuredVerdict.test.cjs
 */

'use strict';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clearMainModuleCache } = require('./_helpers/schedulerHarness.cjs');
const { scanSentinel, scanSentinelReason, parseLog } = require('../runVerify.cjs');

let notifyOriginatingTab;
let extractStructuredOutputFromLog;
let tmpRoot;

beforeAll(() => {
  clearMainModuleCache();
  ({ notifyOriginatingTab, extractStructuredOutputFromLog } = require('../scheduler.cjs'));
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'validator-structured-'));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const VALID = {
  schedulerVerdict: 'PASS',
  verdicts: [
    { prd: '3612-alpha', verdict: 'VERIFIED', reason: 'all criteria met', criteria: [{ id: '1', met: true, evidence: 'ok' }], findings: [] },
    {
      prd: '3613-beta',
      verdict: 'REFUTED',
      reason: 'no test for AC 2',
      criteria: [{ id: '2', met: false, evidence: 'missing', missKind: 'missing-test' }],
      findings: [{ severity: 'Important', text: 'regressed X', missKind: 'regression' }],
    },
  ],
};

function writeLog(name, lines) {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

describe('extractStructuredOutputFromLog', () => {
  test('returns the last result event structured_output', () => {
    const p = writeLog('ok.log', [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'SCHEDULER_VERDICT: PASS' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(VALID), structured_output: VALID }),
    ]);
    expect(extractStructuredOutputFromLog(p)).toEqual(VALID);
  });

  test('null for missing file, torn line, or no field — never throws', () => {
    expect(extractStructuredOutputFromLog(null)).toBeNull();
    expect(extractStructuredOutputFromLog(path.join(tmpRoot, 'nope.log'))).toBeNull();
    expect(extractStructuredOutputFromLog(writeLog('torn.log', ['{"type":"result","structured_output":{"sch']))).toBeNull();
    expect(extractStructuredOutputFromLog(writeLog('nofield.log', [JSON.stringify({ type: 'result', result: 'x' })]))).toBeNull();
  });
});

describe('runVerify scanSentinel with structured_output', () => {
  test('structured PASS with no text sentinel gives pass', () => {
    const ev = { kind: 'result', seq: 0, subtype: 'success', resultText: JSON.stringify(VALID), structuredOutput: VALID };
    expect(scanSentinel(ev, [ev])).toBe('pass');
  });

  test('structured FAIL plus failReason gives fail with that reason', () => {
    const so = { schedulerVerdict: 'FAIL', failReason: 'could not run the gate', verdicts: [] };
    const ev = { kind: 'result', seq: 0, subtype: 'success', resultText: JSON.stringify(so), structuredOutput: so };
    expect(scanSentinel(ev, [ev])).toBe('fail');
    expect(scanSentinelReason(ev, [ev])).toBe('could not run the gate');
  });

  test('parseLog carries structured_output onto the result event', () => {
    const p = writeLog('parse.log', [
      JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(VALID), structured_output: VALID }),
    ]);
    const { resultEvent } = parseLog(p);
    expect(resultEvent.structuredOutput).toEqual(VALID);
    expect(scanSentinel(resultEvent, [])).toBe('pass');
  });

  test('a non-validator run (no structured_output) is scanned as today', () => {
    const ev = { kind: 'result', seq: 0, subtype: 'success', resultText: 'done\nSCHEDULER_VERDICT: FAIL gate red' };
    expect(scanSentinel(ev, [ev])).toBe('fail');
    expect(scanSentinelReason(ev, [ev])).toBe('gate red');
    expect(scanSentinel({ ...ev, resultText: 'no verdict here' }, [])).toBeNull();
  });
});

describe('notifyOriginatingTab validator verdicts', () => {
  function deps(structured, extra = {}) {
    return {
      parsePrdRaw: vi.fn(async () => ({ sourcePromptId: 'epic-3614' })),
      loadSessions: vi.fn(async () => ({ tabs: [] })),
      sendPrompt: vi.fn(),
      appendResponseEvent: vi.fn(async () => true),
      appendTranscriptTurn: vi.fn(async () => {}),
      readResultFromLog: vi.fn(() => JSON.stringify(structured)),
      readStructuredFromLog: vi.fn(() => structured),
      scheduleSettle: vi.fn(),
      ...extra,
    };
  }

  test('verdict events carry reason, missKinds and validator', async () => {
    const d = deps(VALID, { writeVerdictsFile: vi.fn(async () => {}) });
    await notifyOriginatingTab(
      { slug: '3640-validate-plan', status: 'completed', cwd: tmpRoot, agentType: 'validator', runId: 'run-1' },
      d,
    );
    expect(d.appendResponseEvent).toHaveBeenCalledTimes(3);
    expect(d.appendResponseEvent.mock.calls[0][3]).toEqual({
      prdSlug: '3612-alpha', outcome: 'completed', validation: 'verified',
      reason: 'all criteria met', missKinds: [], validator: '3640-validate-plan',
    });
    expect(d.appendResponseEvent.mock.calls[1][3]).toEqual({
      prdSlug: '3613-beta', outcome: 'completed', validation: 'refuted',
      reason: 'no test for AC 2', missKinds: ['missing-test', 'regression'], validator: '3640-validate-plan',
    });
    expect(d.appendResponseEvent.mock.calls[1][2]).toContain('3613-beta');
  });

  test('writes <bare slug>.verdicts.json under plan-records/<epic>', async () => {
    const d = deps(VALID);
    await notifyOriginatingTab(
      { slug: '3640-validate-plan', status: 'completed', cwd: tmpRoot, agentType: 'validator', runId: 'run-7' },
      d,
    );
    const file = path.join(tmpRoot, 'session-manager-operations', 'plan-records', 'epic-3614', 'validate-plan.verdicts.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved).toEqual({
      validator: '3640-validate-plan',
      runId: 'run-7',
      at: expect.any(String),
      schedulerVerdict: 'PASS',
      verdicts: VALID.verdicts,
    });
    expect(Number.isNaN(Date.parse(saved.at))).toBe(false);
  });

  test('a failing write is logged and never stops the verdict events', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps(VALID, { writeVerdictsFile: vi.fn(async () => { throw new Error('disk full'); }) });
    await notifyOriginatingTab(
      { slug: '3640-validate-plan', status: 'completed', cwd: tmpRoot, agentType: 'validator' },
      d,
    );
    expect(d.appendResponseEvent).toHaveBeenCalledTimes(3);
    expect(err.mock.calls.some((c) => String(c[0]).includes('verdicts file write error'))).toBe(true);
    err.mockRestore();
  });

  test('an unsafe epicId writes no verdicts file anywhere and still appends the verdict events', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'validator-unsafe-'));
    try {
      const d = deps(VALID, { parsePrdRaw: vi.fn(async () => ({ sourcePromptId: '../scheduler' })) });
      await notifyOriginatingTab(
        { slug: '3640-validate-plan', status: 'completed', cwd: root, agentType: 'validator', runId: 'run-9' },
        d,
      );
      expect(d.appendResponseEvent).toHaveBeenCalledTimes(3);
      expect(d.appendResponseEvent.mock.calls[0][1]).toBe('../scheduler');
      expect(fs.readdirSync(root, { recursive: true })).toEqual([]);
      const skipped = err.mock.calls.filter((c) => String(c[0]).includes('verdicts file skipped'));
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toContain('3640-validate-plan');
    } finally {
      err.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('invalid structured output gives no verdict events and one error naming slug + checker error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = { schedulerVerdict: 'MAYBE', verdicts: [] };
    const d = deps(bad, { writeVerdictsFile: vi.fn(async () => {}) });
    await notifyOriginatingTab(
      { slug: '3640-validate-plan', status: 'completed', cwd: tmpRoot, agentType: 'validator' },
      d,
    );
    expect(d.appendResponseEvent).toHaveBeenCalledTimes(1);
    expect(d.appendResponseEvent.mock.calls[0][3]).toMatchObject({ validation: 'unvalidated', prdSlug: '3640-validate-plan' });
    expect(d.writeVerdictsFile).not.toHaveBeenCalled();
    const rejected = err.mock.calls.filter((c) => String(c[0]).includes('structured output rejected'));
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0][0])).toContain('3640-validate-plan');
    expect(String(rejected[0][0])).toContain('schedulerVerdict: not PASS or FAIL');
    err.mockRestore();
  });

  test('missing structured output (null) also gives no verdict events', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps(null, { readResultFromLog: vi.fn(() => 'VALIDATION: 1-x VERIFIED') });
    await notifyOriginatingTab(
      { slug: '3640-validate-plan', status: 'completed', cwd: tmpRoot, agentType: 'validator' },
      d,
    );
    expect(d.appendResponseEvent).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
  describe('dispatch-time validatorCriteriaExpected stamp (PRD validator-expected-run-once)', () => {
    const MET = {
      schedulerVerdict: 'PASS',
      verdicts: [{ prd: '3612-alpha', verdict: 'VERIFIED', reason: 'ok', criteria: [{ id: 'ac-1', met: true, evidence: 'PASS' }], findings: [] }],
    };
    const row = (extra) => ({ slug: '3640-validate-plan', status: 'completed', cwd: tmpRoot, agentType: 'validator', runId: 'run-s', dependsOn: ['3612-alpha'], ...extra });
    const verdictCalls = (d) => d.appendResponseEvent.mock.calls.filter((c) => c[3] && c[3].validator === '3640-validate-plan');

    test('a stamp with failedIds [ac-1] refuses a met ac-1 verdict and never calls loadValidatorCriteria', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const spy = vi.fn(async () => ({ expected: {}, section: '' }));
      const d = deps(MET, { loadValidatorCriteria: spy, writeVerdictsFile: vi.fn(async () => {}) });
      await notifyOriginatingTab(row({ validatorCriteriaExpected: { '3612-alpha': { ids: ['ac-1'], failedIds: ['ac-1'] } } }), d);
      expect(verdictCalls(d)).toHaveLength(0);
      expect(spy).not.toHaveBeenCalled();
      err.mockRestore();
    });

    test('a stamp with failedIds [] accepts the same verdict and appends its verdict events', async () => {
      const spy = vi.fn(async () => ({ expected: {}, section: '' }));
      const d = deps(MET, { loadValidatorCriteria: spy, writeVerdictsFile: vi.fn(async () => {}) });
      await notifyOriginatingTab(row({ validatorCriteriaExpected: { '3612-alpha': { ids: ['ac-1'], failedIds: [] } } }), d);
      const calls = verdictCalls(d);
      expect(calls).toHaveLength(1);
      expect(calls[0][3]).toMatchObject({ prdSlug: '3612-alpha', validation: 'verified' });
      expect(spy).not.toHaveBeenCalled();
    });

    test('a row without the stamp calls loadValidatorCriteria once with { runChecks: false }', async () => {
      const spy = vi.fn(async () => ({ expected: {}, section: '' }));
      const d = deps(MET, { loadValidatorCriteria: spy, writeVerdictsFile: vi.fn(async () => {}) });
      const job = row({});
      await notifyOriginatingTab(job, d);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({ slug: '3640-validate-plan' });
      expect(spy.mock.calls[0][1]).toEqual({ runChecks: false });
      expect(verdictCalls(d)).toHaveLength(1);
    });
  });
});
