/**
 * runVerify-policy-denial.test.cjs — a PreToolUse hook denial (`Blocked: ...`
 * tool_result) must not downgrade an otherwise-clean run, but a genuine
 * late-run failure must still downgrade normally.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/runVerify-policy-denial.test.cjs
 */

import { test } from 'vitest';
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { verifyRun } = require('../runVerify.cjs');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'run-verify-policy-denial-test-'));
}

function rmdir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

function writeLog(dir, slug, events) {
  const lines = ['[scheduler] starting ' + slug + ' at 2026-09-02T00:00:00.000Z'];
  for (const ev of events) lines.push(JSON.stringify(ev));
  lines.push('[scheduler] exit code=0 (raw code=0 signal=null) duration=47s');
  fs.writeFileSync(path.join(dir, `${slug}.log`), lines.join('\n') + '\n');
}

function writePrd(dir, slug, body) {
  const text = `---\ntitle: Test PRD\ncwd: /tmp\nestimateMinutes: 30\n---\n${body}\n`;
  fs.writeFileSync(path.join(dir, `${slug}.md`), text);
  return path.join(dir, `${slug}.md`);
}

test('PreToolUse policy denial (Blocked: ...) in final 20% → clean, surfaced as annotation', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '1106-policy-denial-exempt';
    const events = [];
    for (let k = 0; k < 8; k++) {
      events.push({ type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', id: `t${k}`, name: 'Read', input: { description: `read ${k}` } }] } });
      events.push({ type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: `t${k}`, content: 'ok', is_error: false }] } });
    }
    events.push({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tgit', name: 'Bash', input: { command: 'git stash', description: 'stash before checkout' } }] } });
    events.push({ type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tgit',
        content: 'Blocked: `stash` in what this hook believes is a SHARED working tree (/home/bilko/Projects/session-manager).',
        is_error: true }] } });
    events.push({ type: 'result', subtype: 'success', result: 'All acceptance criteria verified.\nSCHEDULER_VERDICT: PASS' });

    writeLog(tmp, slug, events);
    const prdPath = writePrd(tmp, slug, '# Policy denial exempt');
    const verdict = await verifyRun({ runDir: tmp, prdPath, queueEntry: { slug, status: 'running' }, allJobs: [], committedDuringRun: true });
    assert.equal(verdict.verdict, 'clean', `policy denial must not flag, got ${verdict.verdict}: ${verdict.reason}`);
    assert.ok(
      Array.isArray(verdict.annotations) && verdict.annotations.some((a) => a.verdict === 'policy_denial'),
      `expected a policy_denial annotation, got ${JSON.stringify(verdict.annotations)}`,
    );
  } finally { rmdir(tmp); }
});

test('genuine late-run failure (not a policy denial) still downgrades to transcript_errors', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '1106-genuine-failure-still-flags';
    const events = [];
    for (let k = 0; k < 8; k++) {
      events.push({ type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', id: `t${k}`, name: 'Read', input: { description: `read ${k}` } }] } });
      events.push({ type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: `t${k}`, content: 'ok', is_error: false }] } });
    }
    events.push({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'ttest', name: 'Bash', input: { command: 'npm test', description: 'run tests' } }] } });
    events.push({ type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'ttest', content: 'FAILED: 1 test failed', is_error: true }] } });
    events.push({ type: 'result', subtype: 'success', result: 'All acceptance criteria verified.' });

    writeLog(tmp, slug, events);
    const prdPath = writePrd(tmp, slug, '# Genuine failure still flags');
    const verdict = await verifyRun({ runDir: tmp, prdPath, queueEntry: { slug, status: 'running' }, allJobs: [], committedDuringRun: true });
    assert.equal(verdict.verdict, 'transcript_errors', `genuine failure must still flag, got ${verdict.verdict}: ${verdict.reason}`);
  } finally { rmdir(tmp); }
});
