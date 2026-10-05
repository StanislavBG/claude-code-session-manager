/**
 * runVerify-sentinel-fail.test.cjs — an explicit `SCHEDULER_VERDICT: FAIL` is
 * always a blocking `sentinel_fail` verdict, whatever the commit evidence or
 * transcript noise (incident: Self 50-evolet-v2-deploy marked completed).
 */
import { test, beforeAll, afterAll, vi } from 'vitest';
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { verifyRun, parseLog } = require('../runVerify.cjs');

let writeSpy;
beforeAll(() => {
  writeSpy = vi.spyOn(require('../config.cjs'), 'writeJsonSync').mockImplementation((abs, data) => {
    fs.writeFileSync(abs, JSON.stringify(data, null, 2) + '\n');
    return { ok: true, mtimeMs: 0 };
  });
});
afterAll(() => writeSpy.mockRestore());

function writeLog(dir, slug, events) {
  const lines = ['[scheduler] starting ' + slug + ' at 2026-05-24T00:00:00.000Z'];
  for (const ev of events) lines.push(JSON.stringify(ev));
  lines.push('[scheduler] exit code=0 (raw code=0 signal=null) duration=47s');
  fs.writeFileSync(path.join(dir, `${slug}.log`), lines.join('\n') + '\n');
}

function writePrd(dir, slug) {
  const p = path.join(dir, `${slug}.md`);
  fs.writeFileSync(p, `---\ntitle: Test PRD\ncwd: /tmp\nestimateMinutes: 30\n---\n# Body\n`);
  return p;
}

function events(sentinelLine, withTraceback) {
  const evs = [];
  if (withTraceback) {
    evs.push(
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pytest' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false,
        content: ['Traceback (most recent call last):', '  File "t.py", line 5, in t', "KeyError: 'k'"].join('\n') }] } },
    );
  }
  evs.push({ type: 'result', subtype: 'success', result: `Done.\n${sentinelLine}` });
  return evs;
}

async function run(sentinelLine, withTraceback, extra) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-verify-sentinel-fail-'));
  try {
    const slug = '90-sentinel-fail';
    writeLog(tmp, slug, events(sentinelLine, withTraceback));
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath: writePrd(tmp, slug),
      queueEntry: { slug, status: 'running' },
      allJobs: [],
      ...extra,
    });
    const sidecar = JSON.parse(fs.readFileSync(path.join(tmp, `${slug}.verdicts.json`), 'utf8'));
    return { verdict, sidecar };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  }
}

const FAIL = 'SCHEDULER_VERDICT: FAIL deploy blocked by missing token';

test('(a) FAIL, no other hits, no commit → sentinel_fail/needs_review with reason', async () => {
  const { verdict, sidecar } = await run(FAIL, false, { committedDuringRun: false });
  assert.equal(verdict.verdict, 'sentinel_fail');
  assert.equal(verdict.downgradeTo, 'needs_review');
  assert.ok(verdict.reason.includes('deploy blocked by missing token'), verdict.reason);
  assert.equal(sidecar.verdict, 'sentinel_fail');
  assert.equal(sidecar.sentinel, 'fail');
});

test('(b) FAIL + committedDuringRun → sentinel_fail', async () => {
  const { verdict } = await run(FAIL, false, { committedDuringRun: true });
  assert.equal(verdict.verdict, 'sentinel_fail');
  assert.equal(verdict.downgradeTo, 'needs_review');
});

test('(c) FAIL + jobLandedCommitThisRun + transcript_errors hit → sentinel_fail', async () => {
  const { verdict } = await run(FAIL, true, { jobLandedCommitThisRun: 'abc1234', exitCode: 0 });
  assert.equal(verdict.verdict, 'sentinel_fail');
  assert.equal(verdict.downgradeTo, 'needs_review');
  assert.ok(Array.isArray(verdict.annotations) && verdict.annotations.length > 0, 'transcript hits kept as annotations');
});

test('(d) FAIL + allowPreSentinelHeal → sentinel_fail', async () => {
  const { verdict } = await run(FAIL, false, { committedDuringRun: true, allowPreSentinelHeal: true });
  assert.equal(verdict.verdict, 'sentinel_fail');
  assert.equal(verdict.downgradeTo, 'needs_review');
});

test('(e) PASS + commit + no hits stays clean (regression)', async () => {
  const { verdict } = await run('SCHEDULER_VERDICT: PASS', false, { committedDuringRun: true });
  assert.equal(verdict.verdict, 'clean');
  assert.equal(verdict.downgradeTo, null);
});

test('parseLog extracts deduplicated transcriptCommitShas from committed gitOperation events', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parselog-shas-'));
  const mk = (sha, kind) => ({ type: 'user', tool_use_result: { gitOperation: { commit: { sha, kind } } } });
  writeLog(dir, 's', [mk('347641f', 'committed'), mk('347641f', 'committed'), mk('abc1234', 'amended'), mk('9999999', 'committed')]);
  const r = parseLog(path.join(dir, 's.log'));
  assert.deepEqual(r.transcriptCommitShas, ['347641f', '9999999']);
  assert.equal(r.transcriptCommitLanded, true);
});
