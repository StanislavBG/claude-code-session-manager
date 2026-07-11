/**
 * runVerify.test.cjs — unit tests for the post-run reconciliation verifier.
 *
 * Run standalone: node src/main/__tests__/runVerify.test.cjs
 *
 * Three fixture scenarios (matching the 2026-05-23→24 incident window):
 *
 *   1. Case 1 (false-PASS): M2 acceptance script prints test failures + Traceback,
 *      then echoes "M2 acceptance: PASS". Scheduler used to stamp 'completed'.
 *      Expected: transcript_errors → needs_review
 *
 *   2. Case 2 (HALT): M7 agent correctly halts because M1 soak is unmet.
 *      Expected: halt → pending, reason embeds soak floor date
 *
 *   3. Case 3 (deps_unmet): PRD 56 has an unsatisfied dependsOn entry.
 *      Expected: deps_unmet → pending
 *
 *   4. Truly clean: all tests pass, no error markers.
 *      Expected: clean → null (caller may stamp 'completed')
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { verifyRun } = require('../runVerify.cjs');

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Create a temp directory that is cleaned up after the test. */
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'run-verify-test-'));
}

function rmdir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

/**
 * Build a minimal stream-JSON log file.
 * `events` is an array of raw JSON objects to serialise one-per-line.
 * A "[scheduler] starting..." prefix line is also prepended (must be skipped).
 */
function writeLog(dir, slug, events) {
  const lines = ['[scheduler] starting ' + slug + ' at 2026-05-24T00:00:00.000Z'];
  for (const ev of events) lines.push(JSON.stringify(ev));
  lines.push('[scheduler] exit code=0 (raw code=0 signal=null) duration=47s');
  fs.writeFileSync(path.join(dir, `${slug}.log`), lines.join('\n') + '\n');
}

/** Write a minimal PRD .md file with frontmatter + body. */
function writePrd(dir, slug, body) {
  const text = `---\ntitle: Test PRD\ncwd: /tmp\nestimateMinutes: 30\n---\n${body}\n`;
  fs.writeFileSync(path.join(dir, `${slug}.md`), text);
  return path.join(dir, `${slug}.md`);
}

// ─── fixture: Case 1 — false-PASS (M2 acceptance) ─────────────────────────

test('Case 1: false-PASS (Traceback + echo PASS) → transcript_errors/needs_review', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '39-signal-builder-m2-sentiment-stack';
    const logEvents = [
      // Assistant turn: run acceptance script
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu_m2_001',
            name: 'Bash',
            input: {
              command: 'bash check_m2.sh',
              description: 'Run M2 acceptance checks',
            },
          }],
        },
      },
      // Tool result: test failures then echo PASS (the false-positive pattern)
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_m2_001',
            content: [
              '=== Signal-builder side ===',
              'ERROR tests/test_news_signals_panel.py',
              '!!!!!!!! stopping after 1 failures !!!!!!!!',
              '1 error in 0.03s',
              'SB: 0',
              '=== Sanity: SB sentiment_cache.db rows ===',
              'rows: 0',
              '=== contract.json panels.sentiment ===',
              'Traceback (most recent call last):',
              '  File "<string>", line 1, in <module>',
              "KeyError: 'panels.sentiment'",
              'M2 acceptance: PASS',
            ].join('\n'),
            is_error: false,
          }],
        },
      },
      // Result: agent declares success
      {
        type: 'result',
        subtype: 'success',
        result: 'M2 acceptance criteria verified. All checks passed.',
      },
    ];

    writeLog(tmp, slug, logEvents);
    const prdPath = writePrd(tmp, slug, '# M2 Sentiment Stack\n\nBuild the sentiment pipeline.');

    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running' },
      allJobs: [],
    });

    assert.equal(verdict.verdict, 'transcript_errors', `expected transcript_errors, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, 'needs_review');
    assert.ok(verdict.reason.length > 0, 'reason should be non-empty');

    // verdicts.json sidecar should have been written
    const sidecar = JSON.parse(fs.readFileSync(path.join(tmp, `${slug}.verdicts.json`), 'utf8'));
    assert.equal(sidecar.schemaVersion, 1);
    assert.equal(sidecar.verdict, 'transcript_errors');
  } finally {
    rmdir(tmp);
  }
});

// ─── fixture: Case 2 — HALT (M7 soak unmet) ──────────────────────────────────

test('Case 2: HALT in result event → halt/pending with floor date in reason', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '44-signal-builder-m7-final-cutover';
    const haltMsg = [
      'HALT: M7 prerequisite — M1 not yet soaked 30 days × 6 phases',
      '  M1 commit: f91ce44  2026-05-23 (age: 0 days, need ≥ 180)',
      '  M7 earliest eligible: ~2026-11-19',
    ].join('\n');

    const logEvents = [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu_m7_001',
            name: 'Bash',
            input: { command: 'git log --oneline m1-tag', description: 'Check M1 soak period' },
          }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_m7_001',
            content: 'f91ce44  2026-05-23 feat(m1): initial trading signals',
            is_error: false,
          }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: haltMsg,
      },
    ];

    writeLog(tmp, slug, logEvents);
    const prdPath = writePrd(
      tmp,
      slug,
      '# M7 Final Cutover\n\nOnly after M1–M6 have run 30+ days each.',
    );

    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running' },
      allJobs: [],
    });

    assert.equal(verdict.verdict, 'halt', `expected halt, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, 'pending');
    assert.ok(verdict.reason.includes('HALT'), 'reason should mention HALT');
    // Floor date from the HALT message should appear in reason
    assert.ok(
      verdict.reason.includes('2026-11-19') || verdict.reason.length > 20,
      `reason should embed soak floor date: ${verdict.reason}`,
    );
  } finally {
    rmdir(tmp);
  }
});

// ─── fixture: Case 3 — deps_unmet (dependsOn unsatisfied) ────────────────────

test('Case 3: dependsOn pointing at pending dep → deps_unmet/pending', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '56-burrow-mcp-retire-tier3-frozen-endpoints';
    const logEvents = [
      {
        type: 'result',
        subtype: 'success',
        result: 'Completed burrow MCP tier-3 retirement.',
      },
    ];

    writeLog(tmp, slug, logEvents);
    const prdPath = writePrd(
      tmp,
      slug,
      '# Burrow MCP Retire Tier-3\n\nRetire frozen endpoints.',
    );

    // M7 is a predecessor that is still pending.
    const allJobs = [
      { slug: '44-signal-builder-m7-final-cutover', status: 'pending', finishedAt: null },
      { slug: slug, status: 'running', finishedAt: null },
    ];
    const queueEntry = {
      slug,
      status: 'running',
      dependsOn: ['44-signal-builder-m7-final-cutover'],
    };

    const verdict = await verifyRun({ runDir: tmp, prdPath, queueEntry, allJobs });

    assert.equal(verdict.verdict, 'deps_unmet', `expected deps_unmet, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, 'pending');
    assert.ok(verdict.reason.includes('44-signal-builder-m7-final-cutover'), 'reason should name the unmet dep');
  } finally {
    rmdir(tmp);
  }
});

// ─── fixture: truly clean run ─────────────────────────────────────────────────

test('Truly clean run (no error markers) → clean/null', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '20-clean-feature';
    const logEvents = [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu_clean_001',
            name: 'Bash',
            input: { command: 'npm test', description: 'Run test suite' },
          }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_clean_001',
            content: '✓ 42 tests passed (1.3s)\nAll tests passed.',
            is_error: false,
          }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'Feature complete. All acceptance criteria satisfied.\nSCHEDULER_VERDICT: PASS',
      },
    ];

    writeLog(tmp, slug, logEvents);
    const prdPath = writePrd(tmp, slug, '# Clean Feature\n\nImplement a clean feature.');

    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running' },
      allJobs: [],
      committedDuringRun: true,
    });

    assert.equal(verdict.verdict, 'clean', `expected clean, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, null);
  } finally {
    rmdir(tmp);
  }
});

// ─── self-recovery: FAIL followed by successful retry ──────────────────────

test('FAIL recovered within 30 events → clean', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '21-self-recovering';
    const desc = 'Run pytest';
    const logEvents = [
      // First attempt: fails
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu_r1',
            name: 'Bash',
            input: { command: 'pytest', description: desc },
          }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_r1',
            content: 'FAILED tests/test_foo.py::test_bar - AssertionError',
            is_error: false,
          }],
        },
      },
      // Agent fixes and retries with same description
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu_r2',
            name: 'Bash',
            input: { command: 'pytest', description: desc },
          }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_r2',
            content: '5 passed in 0.42s',
            is_error: false,
          }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'Fixed the failing test and verified all pass.\nSCHEDULER_VERDICT: PASS',
      },
    ];

    writeLog(tmp, slug, logEvents);
    const prdPath = writePrd(tmp, slug, '# Self-recovering test');

    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running' },
      allJobs: [],
      committedDuringRun: true,
    });

    assert.equal(verdict.verdict, 'clean', `self-recovery should yield clean, got ${verdict.verdict}: ${verdict.reason}`);
  } finally {
    rmdir(tmp);
  }
});

// ─── fixtures: feedback 2026-06-10-01 — quoted-error false positives ─────────

/** Build a one-Bash-call log: tool_use → tool_result(content) → result event. */
function bashRunEvents(content, { toolName = 'Bash', resultSubtype = 'success' } = {}) {
  return [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_fb_001',
          name: toolName,
          input: { command: 'run something', description: 'Run checks' },
        }],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_fb_001',
          content,
          is_error: false,
        }],
      },
    },
    { type: 'result', subtype: resultSubtype, result: 'All acceptance criteria verified.\nSCHEDULER_VERDICT: PASS' },
  ];
}

test('feedback 01: reviewer prose mentioning ImportError mid-sentence → clean', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '25-self-pipeline-driver-hardening';
    const prose = [
      '{"finding": "the script will crash with ImportError rather than a clean RESULT: failed line",',
      ' "note": "a missing dep would fail with an ImportError that is captured only in cron.log"}',
    ].join('\n');
    writeLog(tmp, slug, bashRunEvents(prose));
    const prdPath = writePrd(tmp, slug, '# Hardening');
    const verdict = await verifyRun({ runDir: tmp, prdPath, queueEntry: { slug, status: 'running' }, allJobs: [], committedDuringRun: true });
    assert.equal(verdict.verdict, 'clean', `prose mention must not flag, got ${verdict.verdict}: ${verdict.reason}`);
  } finally { rmdir(tmp); }
});

test('feedback 01: real line-anchored ModuleNotFoundError in a FAILED run → verify_unavailable/needs_review', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '25-real-import-error';
    const out = [
      '$ python run_checks.py',
      'Traceback (most recent call last):',
      '  File "run_checks.py", line 2, in <module>',
      '    from playwright.sync_api import sync_playwright',
      "ModuleNotFoundError: No module named 'playwright'",
    ].join('\n');
    // Run did NOT succeed: the missing dependency was never resolved, so the
    // "couldn't verify" signal must still escalate to a human.
    writeLog(tmp, slug, bashRunEvents(out, { resultSubtype: 'error_during_execution' }));
    const prdPath = writePrd(tmp, slug, '# Real failure');
    const verdict = await verifyRun({ runDir: tmp, prdPath, queueEntry: { slug, status: 'running' }, allJobs: [] });
    assert.equal(verdict.verdict, 'verify_unavailable', `unresolved missing-dep must flag, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, 'needs_review');
  } finally { rmdir(tmp); }
});

// ─── feedback 2026-06-10 addendum — recovered env-probe false positives ──────
//
// Setup probes (interpreter/venv search) that surface ModuleNotFoundError but
// the run still reaches result:success are the missing-dependency class, not a
// real failure. They must NOT downgrade — only annotate. But a Traceback ending
// in a real logic exception (KeyError/AssertionError) still hard-flags, even on
// "success", preserving the 2026-05-23 false-PASS guard.

test('addendum: Traceback→ModuleNotFoundError in a SUCCEEDED run → clean (annotated, not downgraded)', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '26-self-billbot-shared-lib';
    const probe = [
      'Exit code 1',
      'Traceback (most recent call last):',
      '  File "/home/bilko/Self/.claude/skills/snopud-bill/download_bill.py", line 42, in <module>',
      '    from playwright.sync_api import TimeoutError as PWTimeout',
      "ModuleNotFoundError: No module named 'playwright'",
    ].join('\n');
    writeLog(tmp, slug, bashRunEvents(probe)); // resultSubtype defaults to success
    const prdPath = writePrd(tmp, slug, '# Shared lib');
    const verdict = await verifyRun({ runDir: tmp, prdPath, queueEntry: { slug, status: 'running' }, allJobs: [], committedDuringRun: true });
    assert.equal(verdict.verdict, 'clean', `recovered env probe must not downgrade, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, null);
    assert.ok(Array.isArray(verdict.annotations) && verdict.annotations.length === 1, 'should record one annotation');
    assert.equal(verdict.annotations[0].verdict, 'verify_unavailable');
  } finally { rmdir(tmp); }
});

test('addendum: bare Import/ModuleNotFound probe (no traceback) in SUCCEEDED run → clean/annotated', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '26-self-parser-tests';
    writeLog(tmp, slug, bashRunEvents("ModuleNotFoundError: No module named 'conftest'"));
    const prdPath = writePrd(tmp, slug, '# Parser tests');
    const verdict = await verifyRun({ runDir: tmp, prdPath, queueEntry: { slug, status: 'running' }, allJobs: [], committedDuringRun: true });
    assert.equal(verdict.verdict, 'clean', `got ${verdict.verdict}: ${verdict.reason}`);
    assert.ok(Array.isArray(verdict.annotations) && verdict.annotations.length === 1);
  } finally { rmdir(tmp); }
});

test('addendum: Traceback→KeyError (real logic failure) on "success" → still transcript_errors/needs_review', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '26-real-logic-failure';
    const out = [
      '=== contract.json panels.sentiment ===',
      'Traceback (most recent call last):',
      '  File "<string>", line 1, in <module>',
      "KeyError: 'panels.sentiment'",
    ].join('\n');
    writeLog(tmp, slug, bashRunEvents(out)); // success result — must NOT rescue a real failure
    const prdPath = writePrd(tmp, slug, '# Logic failure');
    const verdict = await verifyRun({ runDir: tmp, prdPath, queueEntry: { slug, status: 'running' }, allJobs: [] });
    assert.equal(verdict.verdict, 'transcript_errors', `real logic Traceback must still flag, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, 'needs_review');
  } finally { rmdir(tmp); }
});

test('feedback 01: error-shaped text inside a Task (subagent) result → clean', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '25-subagent-quoting-error';
    const reviewFinding = [
      'Finding 3 (high): startup crash path:',
      'Traceback (most recent call last):',
      "ImportError: cannot import name 'foo'",
      'This is what WOULD happen if the guard is removed.',
    ].join('\n');
    writeLog(tmp, slug, bashRunEvents(reviewFinding, { toolName: 'Task' }));
    const prdPath = writePrd(tmp, slug, '# Review-heavy PRD');
    const verdict = await verifyRun({ runDir: tmp, prdPath, queueEntry: { slug, status: 'running' }, allJobs: [], committedDuringRun: true });
    assert.equal(verdict.verdict, 'clean', `Task results must be exempt from pattern scan, got ${verdict.verdict}: ${verdict.reason}`);
  } finally { rmdir(tmp); }
});

test('feedback 01: quoted "Traceback..." line (leading quote) → clean', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '25-quoted-traceback';
    const prose = [
      'The log format doc says:',
      '  "Traceback (most recent call last):" appears first, then',
      '  "SomeError: message" on a later line.',
    ].join('\n');
    writeLog(tmp, slug, bashRunEvents(prose));
    const prdPath = writePrd(tmp, slug, '# Docs PRD');
    const verdict = await verifyRun({ runDir: tmp, prdPath, queueEntry: { slug, status: 'running' }, allJobs: [], committedDuringRun: true });
    assert.equal(verdict.verdict, 'clean', `quoted traceback prose must not flag, got ${verdict.verdict}: ${verdict.reason}`);
  } finally { rmdir(tmp); }
});

// ─── harness tool errors (feedback follow-up 2026-06-10) ─────────────────────

test('harness tool error (<tool_use_error>) in final 20% → clean', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '58-harness-tool-error';
    // Pad with benign events so the error lands in the final 20%, then a
    // successful result — mirrors the real 58-web-remote-correctness-batch run.
    const events = [];
    for (let k = 0; k < 8; k++) {
      events.push({ type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', id: `t${k}`, name: 'Read', input: { description: `read ${k}` } }] } });
      events.push({ type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: `t${k}`, content: 'ok', is_error: false }] } });
    }
    events.push({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tbad', name: 'bash', input: { description: 'run tests' } }] } });
    events.push({ type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tbad',
        content: '<tool_use_error>Error: No such tool available: bash</tool_use_error>', is_error: true }] } });
    events.push({ type: 'result', subtype: 'success', result: 'All acceptance criteria verified.\nSCHEDULER_VERDICT: PASS' });

    writeLog(tmp, slug, events);
    const prdPath = writePrd(tmp, slug, '# Correctness batch');
    const verdict = await verifyRun({ runDir: tmp, prdPath, queueEntry: { slug, status: 'running' }, allJobs: [], committedDuringRun: true });
    assert.equal(verdict.verdict, 'clean', `harness tool error must not flag, got ${verdict.verdict}: ${verdict.reason}`);
  } finally { rmdir(tmp); }
});

test('isHarnessToolError detects wrapper and "No such tool available"', () => {
  const { isHarnessToolError } = require('../runVerify.cjs');
  assert.equal(isHarnessToolError('<tool_use_error>Error: No such tool available: bash</tool_use_error>'), true);
  assert.equal(isHarnessToolError('No such tool available: Foo'), true);
  assert.equal(isHarnessToolError('ModuleNotFoundError: No module named x'), false);
  assert.equal(isHarnessToolError(''), false);
});

// ─── SCHEDULER_VERDICT sentinel override tests ────────────────────────────────

/** Build a log where a tool_result contains a Traceback+KeyError and the
 *  result event optionally contains the sentinel line. */
function tracebackRunEvents(sentinelLine) {
  const resultText = sentinelLine
    ? `All work done.\n${sentinelLine}`
    : 'All work done.';
  return [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_tv_001',
          name: 'Bash',
          input: { command: 'pytest', description: 'Run acceptance tests' },
        }],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_tv_001',
          content: [
            '=== TDD red phase ===',
            'Traceback (most recent call last):',
            '  File "test_foo.py", line 5, in test_bar',
            "KeyError: 'missing_key'",
          ].join('\n'),
          is_error: false,
        }],
      },
    },
    { type: 'result', subtype: 'success', result: resultText },
  ];
}

// (a) sentinel PASS + committedDuringRun:true + Traceback+Error → clean
test('sentinel PASS + committedDuringRun:true + Traceback → clean (override)', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '77-sentinel-override-pass';
    writeLog(tmp, slug, tracebackRunEvents('SCHEDULER_VERDICT: PASS'));
    const prdPath = writePrd(tmp, slug, '# Sentinel override test');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running' },
      allJobs: [],
      committedDuringRun: true,
    });
    assert.equal(verdict.verdict, 'clean', `expected clean, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, null);
    assert.ok(verdict.reason.includes('SCHEDULER_VERDICT: PASS'), `reason should mention sentinel: ${verdict.reason}`);
    // Sidecar should record the sentinel and override
    const sidecar = JSON.parse(fs.readFileSync(path.join(tmp, `${slug}.verdicts.json`), 'utf8'));
    assert.equal(sidecar.sentinel, 'pass');
    assert.ok(sidecar.sentinelOverride, 'sidecar should record sentinelOverride');
  } finally {
    rmdir(tmp);
  }
});

// (b) no sentinel + Traceback+Error → transcript_errors (unchanged baseline)
test('no sentinel + Traceback+Error + committedDuringRun:true → transcript_errors (no override)', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '77-no-sentinel-baseline';
    writeLog(tmp, slug, tracebackRunEvents(null));
    const prdPath = writePrd(tmp, slug, '# No sentinel baseline');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running' },
      allJobs: [],
      committedDuringRun: true,
    });
    assert.equal(verdict.verdict, 'transcript_errors', `expected transcript_errors without sentinel, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, 'needs_review');
  } finally {
    rmdir(tmp);
  }
});

// (c) sentinel PASS + committedDuringRun:false → stays transcript_errors (commit not confirmed)
test('sentinel PASS + committedDuringRun:false → transcript_errors (commit unconfirmed)', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '77-sentinel-no-commit';
    writeLog(tmp, slug, tracebackRunEvents('SCHEDULER_VERDICT: PASS'));
    const prdPath = writePrd(tmp, slug, '# Sentinel without commit');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running' },
      allJobs: [],
      committedDuringRun: false,
    });
    assert.equal(verdict.verdict, 'transcript_errors', `PASS without commit must not override, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, 'needs_review');
  } finally {
    rmdir(tmp);
  }
});

// (d) sentinel FAIL → never clean (even with committedDuringRun:true)
test('sentinel FAIL + committedDuringRun:true → transcript_errors (FAIL never overrides)', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '77-sentinel-fail';
    writeLog(tmp, slug, tracebackRunEvents('SCHEDULER_VERDICT: FAIL AC gate was red'));
    const prdPath = writePrd(tmp, slug, '# Sentinel FAIL');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running' },
      allJobs: [],
      committedDuringRun: true,
    });
    assert.equal(verdict.verdict, 'transcript_errors', `FAIL sentinel must not override to clean, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, 'needs_review');
  } finally {
    rmdir(tmp);
  }
});

// ─── pre-sentinel heal (allowPreSentinelHeal) ─────────────────────────────────

// (f) allowPreSentinelHeal=true + committed + no sentinel → clean
test('pre-sentinel heal: committed + no sentinel + allowPreSentinelHeal → clean', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '86-pre-sentinel-heal-pass';
    writeLog(tmp, slug, tracebackRunEvents(null)); // no SCHEDULER_VERDICT line
    const prdPath = writePrd(tmp, slug, '# Pre-sentinel heal');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'needs_review' },
      allJobs: [],
      committedDuringRun: true,
      allowPreSentinelHeal: true,
    });
    assert.equal(verdict.verdict, 'clean', `expected clean via pre-sentinel heal, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, null);
    assert.ok(verdict.reason.includes('pre-sentinel heal'), `reason should mention pre-sentinel heal: ${verdict.reason}`);
    const sidecar = JSON.parse(fs.readFileSync(path.join(tmp, `${slug}.verdicts.json`), 'utf8'));
    assert.ok(sidecar.preSentinelHeal, 'sidecar should record preSentinelHeal');
  } finally {
    rmdir(tmp);
  }
});

// (g) allowPreSentinelHeal=true + committed + FAIL sentinel → stays transcript_errors
test('pre-sentinel heal: committed + SCHEDULER_VERDICT: FAIL + allowPreSentinelHeal → transcript_errors', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '86-pre-sentinel-heal-fail';
    writeLog(tmp, slug, tracebackRunEvents('SCHEDULER_VERDICT: FAIL AC gate was red'));
    const prdPath = writePrd(tmp, slug, '# Pre-sentinel heal blocked by FAIL');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'needs_review' },
      allJobs: [],
      committedDuringRun: true,
      allowPreSentinelHeal: true,
    });
    assert.equal(verdict.verdict, 'transcript_errors', `FAIL sentinel must block pre-sentinel heal, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, 'needs_review');
  } finally {
    rmdir(tmp);
  }
});

// (h) allowPreSentinelHeal=true + NOT committed + no sentinel → stays transcript_errors
test('pre-sentinel heal: not committed + no sentinel + allowPreSentinelHeal → transcript_errors', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '86-pre-sentinel-heal-uncommitted';
    writeLog(tmp, slug, tracebackRunEvents(null));
    const prdPath = writePrd(tmp, slug, '# Pre-sentinel heal blocked by no commit');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'needs_review' },
      allJobs: [],
      committedDuringRun: false,
      allowPreSentinelHeal: true,
    });
    assert.equal(verdict.verdict, 'transcript_errors', `no commit must block pre-sentinel heal, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, 'needs_review');
  } finally {
    rmdir(tmp);
  }
});

// (i) allowPreSentinelHeal=false (default) + committed + no sentinel → baseline unchanged
test('no sentinel + committed + allowPreSentinelHeal=false (default) → transcript_errors', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '86-pre-sentinel-heal-disabled';
    writeLog(tmp, slug, tracebackRunEvents(null));
    const prdPath = writePrd(tmp, slug, '# allowPreSentinelHeal disabled by default');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'needs_review' },
      allJobs: [],
      committedDuringRun: true,
      // allowPreSentinelHeal defaults to false
    });
    assert.equal(verdict.verdict, 'transcript_errors', `must not heal without allowPreSentinelHeal, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, 'needs_review');
  } finally {
    rmdir(tmp);
  }
});

// ─── no_verdict_sentinel: no commit + no sentinel is not "clean" by default ──

/** A run with zero tool_result pattern hits — e.g. the agent asked a
 *  clarifying question and stopped, ending its turn without touching tools. */
function noOpRunEvents(resultText) {
  return [
    { type: 'result', subtype: 'success', result: resultText },
  ];
}

test('no_verdict_sentinel: no tool_result issues, no sentinel, no commit → needs_review', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '406-browser-capture-panel-ui';
    writeLog(tmp, slug, noOpRunEvents('I need clarification on which capture API to target before proceeding.'));
    const prdPath = writePrd(tmp, slug, '# Browser capture panel UI');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running' },
      allJobs: [],
      committedDuringRun: false,
    });
    assert.equal(verdict.verdict, 'no_verdict_sentinel', `expected no_verdict_sentinel, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, 'needs_review');
  } finally {
    rmdir(tmp);
  }
});

test('no_verdict_sentinel guard: same run but committedDuringRun:true → stays clean', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '406-browser-capture-panel-ui-committed';
    writeLog(tmp, slug, noOpRunEvents('I need clarification on which capture API to target before proceeding.'));
    const prdPath = writePrd(tmp, slug, '# Browser capture panel UI');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running' },
      allJobs: [],
      committedDuringRun: true,
    });
    assert.equal(verdict.verdict, 'clean', `commit landed should stay clean, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, null);
  } finally {
    rmdir(tmp);
  }
});

test('no_verdict_sentinel guard: same run but with SCHEDULER_VERDICT: PASS sentinel + a commit → stays clean', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '406-browser-capture-panel-ui-sentinel';
    writeLog(tmp, slug, noOpRunEvents('All acceptance criteria verified.\nSCHEDULER_VERDICT: PASS'));
    const prdPath = writePrd(tmp, slug, '# Browser capture panel UI');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running' },
      allJobs: [],
      committedDuringRun: true,
    });
    assert.equal(verdict.verdict, 'clean', `PASS sentinel + commit should stay clean, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, null);
  } finally {
    rmdir(tmp);
  }
});

// ─── pass_no_commit: PASS sentinel with no commit is not "clean" ───────────

test('pass_no_commit: SCHEDULER_VERDICT: PASS but no commit landed → needs_review', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '511-recorder-mouse-drag-panel-export';
    writeLog(tmp, slug, noOpRunEvents('All acceptance criteria verified.\nSCHEDULER_VERDICT: PASS'));
    const prdPath = writePrd(tmp, slug, '# Recorder mouse drag panel export');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running' },
      allJobs: [],
      committedDuringRun: false,
    });
    assert.equal(verdict.verdict, 'pass_no_commit', `expected pass_no_commit, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, 'needs_review');
  } finally {
    rmdir(tmp);
  }
});

// (e) halt + sentinel PASS → still halt (override must not apply to halt)
test('halt result + sentinel PASS + committedDuringRun:true → still halt', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '77-halt-sentinel-pass';
    const logEvents = [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu_halt_001',
            name: 'Bash',
            input: { command: 'check deps', description: 'Check prerequisites' },
          }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_halt_001',
            content: 'dep not ready',
            is_error: false,
          }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'HALT: prerequisite not met\nSCHEDULER_VERDICT: PASS',
      },
    ];
    writeLog(tmp, slug, logEvents);
    const prdPath = writePrd(tmp, slug, '# Halt with sentinel');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running' },
      allJobs: [],
      committedDuringRun: true,
    });
    assert.equal(verdict.verdict, 'halt', `halt must survive even with PASS sentinel, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, 'pending');
  } finally {
    rmdir(tmp);
  }
});
