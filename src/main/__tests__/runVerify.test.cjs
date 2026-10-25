/**
 * runVerify.test.cjs — unit tests for the post-run reconciliation verifier.
 *
 * Run standalone: timeout 180 npx vitest run src/main/__tests__/runVerify.test.cjs
 *
 *   (Case 1 false-PASS pattern detection retired — the verdict is outcome-only.)
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

import { test, beforeAll, afterAll, vi } from 'vitest';
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { verifyRun, parseLog, scanHaltLine } = require('../runVerify.cjs');

// The verdicts sidecar goes through config.writeJsonSync, whose write allow-list
// rejects os.tmpdir() fixtures. Route it to a plain write for these fixtures.
let writeSpy;
beforeAll(() => {
  writeSpy = vi.spyOn(require('../config.cjs'), 'writeJsonSync').mockImplementation((abs, data) => {
    fs.writeFileSync(abs, JSON.stringify(data, null, 2) + '\n');
    return { ok: true, mtimeMs: 0 };
  });
});
afterAll(() => writeSpy.mockRestore());

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

// ─── self-recovery: sleep-prefix normalization (RCA 745-pr188-ci-lint-docs-integrity) ──

/**
 * Build N innocuous tool_use/tool_result pairs, used to push a later error
 * event into the last-20%-of-transcript window that the is_error scan
 * requires (parseLog counts every tool_use/tool_result as its own event).
 */
function paddingEvents(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_pad${i}`, name: 'Bash', input: { command: 'echo ok', description: `padding step ${i}` } }] },
    });
    out.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_pad${i}`, content: 'ok', is_error: false }] },
    });
  }
  return out;
}

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

// ─── feedback 2026-06-10 addendum — recovered env-probe false positives ──────
//
// Setup probes (interpreter/venv search) that surface ModuleNotFoundError but
// the run still reaches result:success are the missing-dependency class, not a
// real failure. They must NOT downgrade — only annotate. But a Traceback ending
// in a real logic exception (KeyError/AssertionError) still hard-flags, even on
// "success", preserving the 2026-05-23 false-PASS guard.

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

// ─── subagent-internal tool errors (incident: 955-route-epic-create-through-ipc, 2026-08-03) ──

test('subagent-internal is_error (parent_tool_use_id set) in final 20% → clean', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '955-route-epic-create-through-ipc';
    const events = [];
    for (let k = 0; k < 8; k++) {
      events.push({ type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', id: `t${k}`, name: 'Read', input: { description: `read ${k}` } }] } });
      events.push({ type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: `t${k}`, content: 'ok', is_error: false }] } });
    }
    // A code-reviewer Task subagent runs its own exploratory grep, which exits
    // 1 (no matches) — this happened INSIDE the subagent, not the main agent.
    events.push({
      type: 'assistant',
      parent_tool_use_id: 'toolu_task_001',
      message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'tgrep', name: 'Bash', input: { description: 'grep for buildPromptSession' } }] },
    });
    events.push({
      type: 'user',
      parent_tool_use_id: 'toolu_task_001',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tgrep', content: '', is_error: true }] },
    });
    events.push({ type: 'result', subtype: 'success', result: 'All acceptance criteria verified.' });

    writeLog(tmp, slug, events);
    const prdPath = writePrd(tmp, slug, '# Route Epic create through IPC');
    const verdict = await verifyRun({ runDir: tmp, prdPath, queueEntry: { slug, status: 'running' }, allJobs: [], committedDuringRun: true });
    assert.equal(verdict.verdict, 'clean', `subagent-internal is_error must not flag, got ${verdict.verdict}: ${verdict.reason}`);
  } finally { rmdir(tmp); }
});

test('parseLog populates parentToolUseId on tool_use and tool_result events, defaulting to null', () => {
  const tmp = makeTmpDir();
  try {
    const slug = '955-parselog-parent-id';
    const events = [
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_parent_001',
        message: { role: 'assistant', content: [
          { type: 'tool_use', id: 'tchild', name: 'Bash', input: { description: 'grep in subagent' } }] },
      },
      {
        type: 'user',
        parent_tool_use_id: 'toolu_parent_001',
        message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tchild', content: '', is_error: true }] },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [
          { type: 'tool_use', id: 'ttop', name: 'Bash', input: { description: 'run in main agent' } }] },
      },
      {
        type: 'user',
        message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'ttop', content: 'ok', is_error: false }] },
      },
    ];
    writeLog(tmp, slug, events);
    const { events: parsed } = parseLog(path.join(tmp, `${slug}.log`));

    const childUse = parsed.find((ev) => ev.kind === 'tool_use' && ev.toolUseId === 'tchild');
    const childResult = parsed.find((ev) => ev.kind === 'tool_result' && ev.toolUseId === 'tchild');
    const topUse = parsed.find((ev) => ev.kind === 'tool_use' && ev.toolUseId === 'ttop');
    const topResult = parsed.find((ev) => ev.kind === 'tool_result' && ev.toolUseId === 'ttop');

    assert.equal(childUse.parentToolUseId, 'toolu_parent_001');
    assert.equal(childResult.parentToolUseId, 'toolu_parent_001');
    assert.equal(topUse.parentToolUseId, null);
    assert.equal(topResult.parentToolUseId, null);
  } finally { rmdir(tmp); }
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

// ─── pre-sentinel heal (allowPreSentinelHeal) ─────────────────────────────────

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
    const slug = '406-capture-panel-ui';
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
    const slug = '406-capture-panel-ui-committed';
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
    const slug = '406-capture-panel-ui-sentinel';
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

// ─── abandoned_background_task: auto-backgrounded Bash + no sentinel/commit ─

/** A run whose Bash command hit the harness's 120s foreground timeout and was
 *  auto-backgrounded, then the run ended without ever coming back to commit
 *  or emit the finish-protocol sentinel. */
function abandonedBackgroundTaskRunEvents(resultText) {
  return [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_bg_001',
          name: 'Bash',
          input: { command: 'npm run test:unit', description: 'Run full unit suite' },
        }],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_bg_001',
          content: 'Command did not complete within its 120s timeout and was moved to the background (ID: bcn1lpvpd). Output is being written to: /tmp/claude-1000/tasks/bcn1lpvpd.output. You will be notified when it completes. To check interim output, use Read on that file path.',
          is_error: false,
        }],
      },
    },
    { type: 'result', subtype: 'success', result: resultText },
  ];
}

test('abandoned_background_task: background marker + no sentinel + no commit → abandoned_background_task', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '1116-encyclopedia-animations-section';
    writeLog(tmp, slug, abandonedBackgroundTaskRunEvents('Waiting for the backgrounded test run to finish.'));
    const prdPath = writePrd(tmp, slug, '# Encyclopedia animations section');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running' },
      allJobs: [],
      committedDuringRun: false,
    });
    assert.equal(verdict.verdict, 'abandoned_background_task', `expected abandoned_background_task, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, 'needs_review');
  } finally {
    rmdir(tmp);
  }
});

test('abandoned_background_task guard: no background marker, no sentinel, no commit → stays plain no_verdict_sentinel', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '1116-no-background-marker';
    writeLog(tmp, slug, noOpRunEvents('I need clarification on which capture API to target before proceeding.'));
    const prdPath = writePrd(tmp, slug, '# Encyclopedia animations section');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running' },
      allJobs: [],
      committedDuringRun: false,
    });
    assert.equal(verdict.verdict, 'no_verdict_sentinel', `expected plain no_verdict_sentinel, got ${verdict.verdict}: ${verdict.reason}`);
  } finally {
    rmdir(tmp);
  }
});

test('abandoned_background_task guard: background marker present but run DID commit → clean', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '1116-background-marker-but-committed';
    writeLog(tmp, slug, abandonedBackgroundTaskRunEvents('Backgrounded test run finished green; work committed.'));
    const prdPath = writePrd(tmp, slug, '# Encyclopedia animations section');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running' },
      allJobs: [],
      committedDuringRun: true,
    });
    assert.equal(verdict.verdict, 'clean', `background marker with a landed commit should stay clean, got ${verdict.verdict}: ${verdict.reason}`);
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

test('pass_no_commit: fix-plan job (slug ^\\d+-fix-) with PASS but no commit is exempt → clean', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '523-fix-bounded-fix-plan-retry';
    writeLog(tmp, slug, noOpRunEvents('Verification complete — no code gap exists.\nSCHEDULER_VERDICT: PASS'));
    const prdPath = writePrd(tmp, slug, '# Fix: bounded fix-plan retry');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running' },
      allJobs: [],
      committedDuringRun: false,
    });
    assert.equal(verdict.verdict, 'clean', `expected clean (fix-plan exemption), got ${verdict.verdict}: ${verdict.reason}`);
  } finally {
    rmdir(tmp);
  }
});

// ─── pass_no_commit_already_shipped: original PRD re-run after landing ─────
// (incident: 655-needs-review-rca-feedback-hook, 2026-07-31)

const { extractPrdDeliverablePaths, allDeliverablesAlreadyTracked } = require('../runVerify.cjs');
const REPO_ROOT = path.resolve(__dirname, '../../..');

test('pass_no_commit: original PRD, PASS no commit, all deliverable paths already tracked in git → pass_no_commit_already_shipped', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '655-needs-review-rca-feedback-hook';
    writeLog(tmp, slug, noOpRunEvents('Verified rcaReport.cjs already shipped in e13168d; typecheck + tests green; no commit needed.\nSCHEDULER_VERDICT: PASS'));
    const prdPath = writePrd(tmp, slug, 'Deliverables: `src/main/lib/scheduler/rcaReport.cjs` and `src/main/__tests__/rcaReport.test.cjs`.');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running', cwd: REPO_ROOT },
      allJobs: [],
      committedDuringRun: false,
    });
    assert.equal(verdict.verdict, 'pass_no_commit_already_shipped', `expected already-shipped exemption, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, null);
  } finally {
    rmdir(tmp);
  }
});

test('pass_no_commit: original PRD, PASS no commit, one deliverable path untracked → falls through to pass_no_commit', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '655-needs-review-rca-feedback-hook';
    writeLog(tmp, slug, noOpRunEvents('Nothing to do here.\nSCHEDULER_VERDICT: PASS'));
    const prdPath = writePrd(tmp, slug, 'Deliverables: `src/main/lib/scheduler/rcaReport.cjs` and `src/main/lib/does-not-exist-xyz.cjs`.');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running', cwd: REPO_ROOT },
      allJobs: [],
      committedDuringRun: false,
    });
    assert.equal(verdict.verdict, 'pass_no_commit', `expected fallback to pass_no_commit, got ${verdict.verdict}: ${verdict.reason}`);
  } finally {
    rmdir(tmp);
  }
});

test('pass_no_commit: original PRD, PASS no commit, zero extractable deliverable paths → falls through to pass_no_commit', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '999-some-vague-prd';
    writeLog(tmp, slug, noOpRunEvents('Nothing to do here.\nSCHEDULER_VERDICT: PASS'));
    const prdPath = writePrd(tmp, slug, 'This PRD names no file paths at all, just prose.');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running', cwd: REPO_ROOT },
      allJobs: [],
      committedDuringRun: false,
    });
    assert.equal(verdict.verdict, 'pass_no_commit', `expected fallback to pass_no_commit, got ${verdict.verdict}: ${verdict.reason}`);
  } finally {
    rmdir(tmp);
  }
});

// (incident: 812-commit-guard-retry-on-worktree-ref-visibility-delay — a
// stale scheduler process, booted before the already-shipped exemption
// landed, produced a false pass_no_commit for exactly this shape of re-run)
test('pass_no_commit: commit-guard-retry PRD naming scheduler.cjs + its committed-in-window test, PASS no commit → pass_no_commit_already_shipped', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '812-commit-guard-retry-on-worktree-ref-visibility-delay';
    writeLog(tmp, slug, noOpRunEvents('Retry + tests already present; nothing to change.\nSCHEDULER_VERDICT: PASS'));
    const prdPath = writePrd(
      tmp,
      slug,
      'Deliverables: `src/main/scheduler.cjs` and `src/main/__tests__/scheduler-committed-in-window.test.cjs`.',
    );
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running', cwd: REPO_ROOT },
      allJobs: [],
      committedDuringRun: false,
    });
    assert.equal(verdict.verdict, 'pass_no_commit_already_shipped', `expected already-shipped exemption, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, null);
  } finally {
    rmdir(tmp);
  }
});

test('extractPrdDeliverablePaths: extracts backticked repo-relative paths, ignores prose', () => {
  const body = 'Deliverables: `src/main/lib/scheduler/rcaReport.cjs` and `src/main/__tests__/rcaReport.test.cjs`. Also see node_modules/foo/bar.js which should be excluded.';
  const paths = extractPrdDeliverablePaths(body);
  assert.deepEqual(paths, ['src/main/lib/scheduler/rcaReport.cjs', 'src/main/__tests__/rcaReport.test.cjs']);
  assert.deepEqual(extractPrdDeliverablePaths(''), []);
  assert.deepEqual(extractPrdDeliverablePaths(undefined), []);
});

test('allDeliverablesAlreadyTracked: fail-safe on empty paths, non-git cwd, and git errors', () => {
  assert.equal(allDeliverablesAlreadyTracked({ cwd: REPO_ROOT, paths: [] }), false);
  assert.equal(allDeliverablesAlreadyTracked({
    cwd: REPO_ROOT,
    paths: ['src/main/runVerify.cjs'],
    execImpl: () => { throw new Error('boom'); },
  }), false);
  assert.equal(allDeliverablesAlreadyTracked({
    cwd: REPO_ROOT,
    paths: ['src/main/runVerify.cjs'],
    execImpl: () => '',
  }), true);
});

// ─── repo-root config deliverable extraction ────────────────────────────────
// (incident: 816-vitest-register-runverify-test, 2026-07-31 — PRD named only
// `vitest.config.ts` as its deliverable; the source-dir-only regex extracted
// nothing, so allDeliverablesAlreadyTracked early-returned false even though
// the config edit was already tracked in git)

test('extractPrdDeliverablePaths: extracts a root-config file alongside a src path', () => {
  const body = 'Register the test in `vitest.config.ts` and port `src/main/__tests__/runVerify.test.cjs` onto vitest.';
  const paths = extractPrdDeliverablePaths(body);
  assert.deepEqual(new Set(paths), new Set(['vitest.config.ts', 'src/main/__tests__/runVerify.test.cjs']));
});

test('extractPrdDeliverablePaths: root-config-only PRD body yields a non-empty result', () => {
  const body = 'The only deliverable is `vitest.config.ts` — add the missing test.include entry.';
  const paths = extractPrdDeliverablePaths(body);
  assert.deepEqual(paths, ['vitest.config.ts']);
});

test('extractPrdDeliverablePaths: nested or non-allowlisted root files do not produce spurious root-config entries', () => {
  const body = 'See `some/nested/package.json` for the dependency, and update README.md with notes.';
  const paths = extractPrdDeliverablePaths(body);
  assert.equal(paths.includes('package.json'), false);
  assert.equal(paths.includes('README.md'), false);
  assert.deepEqual(paths, []);
});

test('pass_no_commit: root-config-only PRD, PASS no commit, config already tracked → pass_no_commit_already_shipped', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '816-vitest-register-runverify-test';
    writeLog(tmp, slug, noOpRunEvents('Registered already in vitest.config.ts; 48 tests green.\nSCHEDULER_VERDICT: PASS'));
    const prdPath = writePrd(tmp, slug, 'Deliverable: register the test file in `vitest.config.ts`.');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running', cwd: REPO_ROOT },
      allJobs: [],
      committedDuringRun: false,
    });
    assert.equal(verdict.verdict, 'pass_no_commit_already_shipped', `expected already-shipped exemption, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, null);
  } finally {
    rmdir(tmp);
  }
});

// ─── pass_no_commit_prior_run_verified: re-fired slug whose PRIOR run landed ─
// (incident: 812-workbench-review-nits-cleanup, 2026-07-31)

const { isAncestorCommit } = require('../runVerify.cjs');
const REPO_ROOT_COMMIT = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
  cwd: REPO_ROOT, encoding: 'utf8',
}).trim().split('\n')[0];

test('pass_no_commit: PASS, no commit, priorLandedCommit is an ancestor of HEAD → pass_no_commit_prior_run_verified', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '812-workbench-review-nits-cleanup';
    writeLog(tmp, slug, noOpRunEvents('Re-checked every AC item; all already implemented by an earlier run.\nSCHEDULER_VERDICT: PASS'));
    const prdPath = writePrd(tmp, slug, 'This PRD names no deliverable paths, just prose.');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running', cwd: REPO_ROOT },
      allJobs: [],
      committedDuringRun: false,
      priorLandedCommit: REPO_ROOT_COMMIT,
    });
    assert.equal(verdict.verdict, 'pass_no_commit_prior_run_verified', `expected prior-run exemption, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, null);
    assert.equal(verdict.priorLandedCommit, REPO_ROOT_COMMIT);
  } finally {
    rmdir(tmp);
  }
});

test('pass_no_commit: PASS, no commit, priorLandedCommit is NOT an ancestor of HEAD → pass_no_commit', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '812-workbench-review-nits-cleanup';
    writeLog(tmp, slug, noOpRunEvents('Nothing to do here.\nSCHEDULER_VERDICT: PASS'));
    const prdPath = writePrd(tmp, slug, 'This PRD names no deliverable paths, just prose.');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running', cwd: REPO_ROOT },
      allJobs: [],
      committedDuringRun: false,
      priorLandedCommit: '0000000000000000000000000000000000000000',
    });
    assert.equal(verdict.verdict, 'pass_no_commit', `expected fallback to pass_no_commit, got ${verdict.verdict}: ${verdict.reason}`);
  } finally {
    rmdir(tmp);
  }
});

test('isAncestorCommit: fail-safe on missing sha and on a throwing execImpl (git error)', () => {
  assert.equal(isAncestorCommit({ cwd: REPO_ROOT, sha: null }), false);
  assert.equal(isAncestorCommit({
    cwd: REPO_ROOT,
    sha: REPO_ROOT_COMMIT,
    execImpl: () => { throw new Error('git: command not found'); },
  }), false);
  assert.equal(isAncestorCommit({
    cwd: REPO_ROOT,
    sha: REPO_ROOT_COMMIT,
    execImpl: () => '',
  }), true);
});

test('pass_no_commit: PASS, no commit, priorLandedCommit not supplied (null) → pass_no_commit (regression guard)', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '812-workbench-review-nits-cleanup';
    writeLog(tmp, slug, noOpRunEvents('Nothing to do here.\nSCHEDULER_VERDICT: PASS'));
    const prdPath = writePrd(tmp, slug, 'This PRD names no deliverable paths, just prose.');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running', cwd: REPO_ROOT },
      allJobs: [],
      committedDuringRun: false,
    });
    assert.equal(verdict.verdict, 'pass_no_commit', `expected pass_no_commit with no priorLandedCommit, got ${verdict.verdict}: ${verdict.reason}`);
  } finally {
    rmdir(tmp);
  }
});

// (e) halt line + sentinel PASS → clean (the verdict line now outranks the halt check)
test('halt line + sentinel PASS + committedDuringRun:true → clean', async () => {
  const v = await runReport('77-halt-sentinel-pass', 'HALT: prerequisite not met\nSCHEDULER_VERDICT: PASS', true);
  assert.equal(v.verdict, 'clean', `got ${v.verdict}: ${v.reason}`);
  assert.equal(v.downgradeTo, null);
});

async function runReport(slug, text, committedDuringRun) {
  const tmp = makeTmpDir();
  try {
    writeLog(tmp, slug, [{ type: 'result', subtype: 'success', result: text }]);
    const prdPath = writePrd(tmp, slug, '# Report test');
    return await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running' },
      allJobs: [],
      committedDuringRun,
    });
  } finally {
    rmdir(tmp);
  }
}

test('163-attack-scorecard: PASS report quoting the marker in backticks → clean', async () => {
  const text = 'I added `game/tools/attack_scorecard.gd`. The Godot suite passes (198 passed, 0 failed).\n\nI did not test the `HALT:` exit-1 path, since every move hits.\n\nSCHEDULER_VERDICT: PASS';
  const v = await runReport('163-attack-scorecard', text, true);
  assert.equal(v.verdict, 'clean', `got ${v.verdict}: ${v.reason}`);
  assert.equal(v.downgradeTo, null);
});

test('no verdict line + second line starts with the marker → halt/pending, reason uses that line', async () => {
  const v = await runReport('78-halt-second-line', 'Checking prerequisites.\nHALT: dep X not ready\nstopping', false);
  assert.equal(v.verdict, 'halt');
  assert.equal(v.downgradeTo, 'pending');
  assert.ok(v.reason.includes('HALT: dep X not ready'), v.reason);
  assert.ok(!v.reason.includes('Checking prerequisites'), v.reason);
});

test('verdict FAIL line + marker line → sentinel_fail/needs_review', async () => {
  const v = await runReport('79-fail-and-halt', 'HALT: something\nSCHEDULER_VERDICT: FAIL gate red', false);
  assert.equal(v.verdict, 'sentinel_fail');
  assert.equal(v.downgradeTo, 'needs_review');
});

test('scanHaltLine: column-0 line matches; quoted/indented/fenced/other-case do not', () => {
  assert.equal(scanHaltLine('intro\nHALT: dep missing  \r\nmore'), 'HALT: dep missing');
  assert.equal(scanHaltLine('it printed HALT: here'), null);
  assert.equal(scanHaltLine('see `HALT:` path'), null);
  assert.equal(scanHaltLine('halt: lower'), null);
  assert.equal(scanHaltLine('  HALT: indented'), null);
  assert.equal(scanHaltLine('```\nHALT: in fence\n```'), null);
  assert.equal(scanHaltLine('~~~\nHALT: in tilde fence\n~~~'), null);
  assert.equal(scanHaltLine('```\nx\n```\nHALT: after fence'), 'HALT: after fence');
  assert.equal(scanHaltLine(''), null);
  assert.equal(scanHaltLine(undefined), null);
});

// ─── -merge-main postcondition exemption tests (2026-07-18 feedback) ──────────

const { isMergeMainSlug, extractMergeMainPrNumber } = require('../runVerify.cjs');

test('isMergeMainSlug matches the NN-prXXX-merge-main and NN-fix-prXXX-merge-main conventions', () => {
  assert.equal(isMergeMainSlug('565-pr188-merge-main'), true);
  assert.equal(isMergeMainSlug('571-fix-pr141-merge-main'), true);
  assert.equal(isMergeMainSlug('523-fix-bounded-fix-plan-retry'), false);
  assert.equal(isMergeMainSlug('406-capture-panel-ui'), false);
  assert.equal(isMergeMainSlug(''), false);
  assert.equal(isMergeMainSlug(undefined), false);
});

test('extractMergeMainPrNumber prefers "PR #<n>" in text, falls back to slug', () => {
  assert.equal(extractMergeMainPrNumber('565-pr188-merge-main', 'title: Merge current main into sigma PR #188 (round 2)'), 188);
  assert.equal(extractMergeMainPrNumber('565-pr188-merge-main', 'no pr mention here'), 188);
  assert.equal(extractMergeMainPrNumber('non-standard-slug', 'no pr mention here'), null);
});

// (1) -merge-main + PASS + no commit + gh reports MERGEABLE/non-CONFLICTING → verified, no issue
test('merge-main exemption: gh reports MERGEABLE → pass_no_commit_target_verified, no issue pushed', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '565-pr188-merge-main';
    writeLog(tmp, slug, noOpRunEvents('PR #188 was already merged into main by another actor.\nSCHEDULER_VERDICT: PASS'));
    const prdPath = writePrd(tmp, slug, '# Merge current main into sigma PR #188');
    let ghCalls = 0;
    const ghExecImpl = (cmd, args, opts) => {
      ghCalls++;
      assert.equal(cmd, 'gh');
      assert.deepEqual(args, ['pr', 'view', '188', '--json', 'mergeable,mergeStateStatus']);
      assert.equal(opts.cwd, '/tmp/sigma');
      return JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' });
    };
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running', cwd: '/tmp/sigma' },
      allJobs: [],
      committedDuringRun: false,
      ghExecImpl,
    });
    assert.equal(ghCalls, 1);
    assert.equal(verdict.verdict, 'pass_no_commit_target_verified', `expected verified verdict, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, null);
    assert.equal(verdict.verifiedPrNumber, 188);
  } finally {
    rmdir(tmp);
  }
});

// (2) -merge-main + PASS + no commit + gh reports CONFLICTING → falls through to pass_no_commit
test('merge-main exemption: gh reports CONFLICTING → falls through to pass_no_commit', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '565-pr188-merge-main';
    writeLog(tmp, slug, noOpRunEvents('PR #188 needs no further work.\nSCHEDULER_VERDICT: PASS'));
    const prdPath = writePrd(tmp, slug, '# Merge current main into sigma PR #188');
    const ghExecImpl = () => JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CONFLICTING' });
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running', cwd: '/tmp/sigma' },
      allJobs: [],
      committedDuringRun: false,
      ghExecImpl,
    });
    assert.equal(verdict.verdict, 'pass_no_commit', `expected fallback to pass_no_commit, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, 'needs_review');
  } finally {
    rmdir(tmp);
  }
});

// (3) -merge-main + PASS + no commit + gh call fails/times out → falls through to pass_no_commit, never throws
test('merge-main exemption: gh call throws → falls through to pass_no_commit, never throws', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '565-pr188-merge-main';
    writeLog(tmp, slug, noOpRunEvents('PR #188 needs no further work.\nSCHEDULER_VERDICT: PASS'));
    const prdPath = writePrd(tmp, slug, '# Merge current main into sigma PR #188');
    const ghExecImpl = () => { throw new Error('gh: command not found'); };
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running', cwd: '/tmp/sigma' },
      allJobs: [],
      committedDuringRun: false,
      ghExecImpl,
    });
    assert.equal(verdict.verdict, 'pass_no_commit', `expected fallback to pass_no_commit, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, 'needs_review');
  } finally {
    rmdir(tmp);
  }
});

// (4) non-merge-main slug, PASS + no commit → unchanged pass_no_commit behavior, zero gh invocations
test('merge-main exemption: non-merge-main slug never attempts a gh call', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '406-capture-panel-ui';
    writeLog(tmp, slug, noOpRunEvents('All acceptance criteria verified.\nSCHEDULER_VERDICT: PASS'));
    const prdPath = writePrd(tmp, slug, '# Browser capture panel UI');
    let ghCalls = 0;
    const ghExecImpl = () => { ghCalls++; return JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }); };
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running', cwd: '/tmp/proj' },
      allJobs: [],
      committedDuringRun: false,
      ghExecImpl,
    });
    assert.equal(ghCalls, 0, 'gh must never be invoked for a non-merge-main slug');
    assert.equal(verdict.verdict, 'pass_no_commit', `expected unchanged pass_no_commit, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, 'needs_review');
  } finally {
    rmdir(tmp);
  }
});

// (5) -merge-main slug but a real commit DID land → unaffected, path unreachable, zero gh invocations
test('merge-main exemption: commit landed → path unreachable, zero gh invocations, verdict clean', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '565-pr188-merge-main';
    writeLog(tmp, slug, noOpRunEvents('Merged and pushed.\nSCHEDULER_VERDICT: PASS'));
    const prdPath = writePrd(tmp, slug, '# Merge current main into sigma PR #188');
    let ghCalls = 0;
    const ghExecImpl = () => { ghCalls++; return JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }); };
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running', cwd: '/tmp/sigma' },
      allJobs: [],
      committedDuringRun: true,
      ghExecImpl,
    });
    assert.equal(ghCalls, 0, 'gh must never be invoked when a commit already landed');
    assert.equal(verdict.verdict, 'clean', `expected clean (commit landed, sentinel PASS), got ${verdict.verdict}: ${verdict.reason}`);
  } finally {
    rmdir(tmp);
  }
});


// ─── outcome-only verdict: error text never changes the verdict ──────────────

function errorTextRunEvents(variant, sentinelLine) {
  const events = [];
  for (let k = 0; k < 8; k++) {
    events.push({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: `o${k}`, name: 'Read', input: { description: `read ${k}` } }] } });
    events.push({ type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: `o${k}`, content: 'ok', is_error: false }] } });
  }
  events.push({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'obad', name: 'Bash', input: { command: 'run', description: 'run checks' } }] } });
  const bad = variant === 'traceback'
    ? { content: 'Traceback (most recent call last):\n  File "x.py", line 1\nKeyError: \'a\'', is_error: false }
    : { content: 'command failed', is_error: true };
  events.push({ type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'obad', ...bad }] } });
  events.push({ type: 'result', subtype: 'success', result: sentinelLine });
  return events;
}

for (const { label, sentinelLine, committed, expected } of [
  { label: 'PASS + commit', sentinelLine: 'done\nSCHEDULER_VERDICT: PASS', committed: true, expected: 'clean' },
  { label: 'no sentinel + no commit', sentinelLine: 'done', committed: false, expected: 'no_verdict_sentinel' },
  { label: 'PASS + no commit', sentinelLine: 'done\nSCHEDULER_VERDICT: PASS', committed: false, expected: 'pass_no_commit' },
]) {
  test(`error text (Traceback vs is_error) in final 20% never changes the verdict — ${label} → ${expected}`, async () => {
    const out = [];
    for (const variant of ['traceback', 'is_error']) {
      const tmp = makeTmpDir();
      try {
        const slug = `70-outcome-only-${variant.replace('_', '-')}`;
        writeLog(tmp, slug, errorTextRunEvents(variant, sentinelLine));
        const prdPath = writePrd(tmp, slug, '# Outcome only');
        const v = await verifyRun({ runDir: tmp, prdPath, queueEntry: { slug, status: 'running' }, allJobs: [], committedDuringRun: committed, exitCode: 0 });
        out.push(v);
      } finally { rmdir(tmp); }
    }
    assert.equal(out[0].verdict, expected, `traceback: ${out[0].verdict}: ${out[0].reason}`);
    assert.equal(out[1].verdict, out[0].verdict, `is_error: ${out[1].verdict}: ${out[1].reason}`);
    assert.equal(out[1].downgradeTo, out[0].downgradeTo);
    for (const v of out) assert.notEqual(v.verdict, 'transcript_errors');
  });
}
