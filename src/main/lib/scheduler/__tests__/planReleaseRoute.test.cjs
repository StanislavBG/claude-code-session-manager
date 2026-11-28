/**
 * planReleaseRoute.test.cjs — POST /admin/scheduler/release-plan.
 * Run: timeout 300 npx vitest run src/main/lib/scheduler/__tests__/planReleaseRoute.test.cjs
 */
'use strict';

import { test, expect, describe, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { registerPlanReleaseRoute } = require('../planReleaseRoute.cjs');
const { savePlanReviewResult, readPlanReview } = require('../planReviewStore.cjs');

const IDS = { epicId: 'abc123', validateSlug: 'validate-x' };
let cwd;
let handler;

function fakeReq(body) {
  const req = new EventEmitter();
  req.setTimeout = () => {};
  req.destroy = () => {};
  setImmediate(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}
function fakeRes() {
  const res = new EventEmitter();
  res.writeHead = (s) => { res.status = s; };
  res.end = (b) => { res.body = JSON.parse(b); };
  return res;
}
async function call(body) {
  const res = fakeRes();
  await handler(fakeReq({ cwd, ...IDS, ...body }), res);
  return res;
}
const review = (decision) => ({
  prds: [{ prd: 'p1', decision, findings: decision === 'ok' ? [] : [{ severity: 'Critical', check: 'edge-case', text: 't' }] }],
  planFindings: [],
});
const save = (round, decision) => savePlanReviewResult({
  cwd, ...IDS, round, reviewer: 'r', runId: 'x', model: 'm', review: review(decision),
});

const prdDir = (sub = 'prds') => path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', IDS.epicId, sub);
function writePrd(name, sub = 'prds') {
  fs.mkdirSync(path.dirname(path.join(prdDir(sub), name)), { recursive: true });
  fs.writeFileSync(path.join(prdDir(sub), name), '# x\n');
}

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-release-'));
  fs.mkdirSync(path.join(cwd, 'session-manager-operations'), { recursive: true });
  writePrd('validate-x.md');
  registerPlanReleaseRoute({ registerRoute: (m, p, h) => { if (m === 'POST' && p === '/admin/scheduler/release-plan') handler = h; } });
});
afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

describe('release-plan', () => {
  test('releases with by planner and records reasons + accepted', async () => {
    await save(1, 'amend');
    const res = await call({ accepted: 2, rejected: [{ finding: 'f1', reason: ' out of scope ' }] });
    expect(res.status).toBe(200);
    expect(res.body.released).toBe(true);
    const rec = readPlanReview(cwd, IDS.epicId, IDS.validateSlug);
    expect(rec.release.by).toBe('planner');
    expect(rec.release.accepted).toBe(2);
    expect(rec.release.rejected).toEqual([{ finding: 'f1', reason: 'out of scope' }]);
  });

  test('a second release returns alreadyReleased', async () => {
    await call({ accepted: 1 });
    const res = await call({ accepted: 5 });
    expect(res.status).toBe(200);
    expect(res.body.alreadyReleased).toBe(true);
    expect(readPlanReview(cwd, IDS.epicId, IDS.validateSlug).release.accepted).toBe(1);
  });

  test('rereview allowed after a round-1 block', async () => {
    await save(1, 'block');
    const res = await call({ rereview: true });
    expect(res.status).toBe(200);
    expect(readPlanReview(cwd, IDS.epicId, IDS.validateSlug).rereviewRequested).toBe(true);
    expect((await call({ rereview: true })).status).toBe(400);
  });

  test('rereview refused without a block, at round 2, or when released', async () => {
    await save(1, 'amend');
    const a = await call({ rereview: true });
    expect(a.status).toBe(400);
    expect(a.body.reason).toMatch(/block/);
    await save(2, 'block');
    const b = await call({ rereview: true });
    expect(b.status).toBe(400);
    expect(b.body.reason).toMatch(/round 2/);
    await call({ accepted: 0 });
    expect((await call({ rereview: true })).status).toBe(400);
  });

  test('rereview refused when no review exists', async () => {
    expect((await call({ rereview: true })).status).toBe(400);
  });

  test('a rejected entry without a reason is 400 and writes nothing', async () => {
    const res = await call({ accepted: 1, rejected: [{ finding: 'f', reason: '  ' }] });
    expect(res.status).toBe(400);
    expect(readPlanReview(cwd, IDS.epicId, IDS.validateSlug)).toBeNull();
  });

  test('unsafe ids are 400', async () => {
    expect((await call({ epicId: '../x' })).status).toBe(400);
    expect((await call({ validateSlug: '../../etc' })).status).toBe(400);
    expect((await call({ validateSlug: 'a/b' })).status).toBe(400);
  });

  describe('bad cwd', () => {
    const cases = () => [
      ['relative', 'relative/dir'],
      ['missing directory', path.join(cwd, 'nope', 'missing')],
      ['inside session-manager-operations', path.join(cwd, 'session-manager-operations', 'scheduler')],
    ];
    test.each([0, 1, 2])('case %i is 400 bad_cwd and writes nothing', async (i) => {
      const [, bad] = cases()[i];
      const res = await call({ cwd: bad, accepted: 1 });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: 'bad_cwd' });
      expect(readPlanReview(cwd, IDS.epicId, IDS.validateSlug)).toBeNull();
      expect(fs.existsSync(path.join(cwd, 'nope'))).toBe(false);
      expect(fs.existsSync(path.join(cwd, 'session-manager-operations', 'scheduler', 'scheduler'))).toBe(false);
    });
  });

  describe('slug resolution', () => {
    beforeEach(() => { fs.rmSync(path.join(prdDir(), 'validate-x.md')); });

    test('bare slug resolves to the numbered PRD', async () => {
      writePrd('5013-validate-x.md');
      const res = await call({ accepted: 1 });
      expect(res.status).toBe(200);
      expect(res.body.validateSlug).toBe('5013-validate-x');
      expect(readPlanReview(cwd, IDS.epicId, '5013-validate-x').release.by).toBe('planner');
      expect(readPlanReview(cwd, IDS.epicId, 'validate-x')).toBeNull();
    });

    test('numbered slug in an archived timestamped folder is used as-is', async () => {
      writePrd('2026-11-27T00-00/5013-validate-x.md', 'prds-archived');
      const res = await call({ validateSlug: '5013-validate-x', accepted: 0 });
      expect(res.status).toBe(200);
      expect(res.body.validateSlug).toBe('5013-validate-x');
      expect(readPlanReview(cwd, IDS.epicId, '5013-validate-x')).not.toBeNull();
    });

    test('unknown slug is 404 and writes nothing', async () => {
      const res = await call({ accepted: 1 });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ ok: false, error: 'unknown_plan' });
      expect(readPlanReview(cwd, IDS.epicId, IDS.validateSlug)).toBeNull();
    });

    test('two numbered matches is 400 ambiguous_plan', async () => {
      writePrd('1-validate-x.md');
      writePrd('2-validate-x.md');
      const res = await call({ accepted: 1 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('ambiguous_plan');
      expect(res.body.candidates).toEqual(['1-validate-x', '2-validate-x']);
      expect(readPlanReview(cwd, IDS.epicId, IDS.validateSlug)).toBeNull();
    });
  });
});
