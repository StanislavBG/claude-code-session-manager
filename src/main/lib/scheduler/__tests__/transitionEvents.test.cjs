// transitionEvents — transitionJob appends job.status_changed to the job's
// Epic event log for every accepted edge; refused edges and Epic-less jobs
// append nothing; an append failure never blocks the transition.
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const epicEventLog = require('../../epic/epicEventLog.cjs');
const opsErrorLog = require('../../telemetry/opsErrorLog.cjs');
const { transitionJob, emitJobEvent } = require('../scheduleJobTransitions.cjs');

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'transition-events-'));
  epicEventLog._resetForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const flush = () => new Promise((r) => setTimeout(r, 20));

test('accepted edge appends job.status_changed { slug, from, to, reason, source }', async () => {
  const job = { slug: '9001-x', status: 'pending', cwd: tmp, epicId: 'epic-abc' };
  expect(transitionJob(job, 'running', { reason: 'dispatch', source: 'test:dispatch' })).toBe(true);
  expect(job.status).toBe('running');
  await flush();
  const { events } = await epicEventLog.readEpicEvents(tmp, 'epic-abc');
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    seq: 1,
    epicId: 'epic-abc',
    kind: 'job.status_changed',
    slug: '9001-x',
    from: 'pending',
    to: 'running',
    reason: 'dispatch',
    source: 'test:dispatch',
  });
});

test('refused edge appends nothing', () => {
  const spy = vi.spyOn(epicEventLog, 'appendEpicEvent');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const job = { slug: '9001-x', status: 'completed', cwd: tmp, epicId: 'epic-abc' };
  expect(transitionJob(job, 'running', { reason: 'bad', source: 'test' })).toBe(false);
  expect(job.status).toBe('completed');
  expect(spy).not.toHaveBeenCalled();
});

test('identity transition appends nothing', () => {
  const spy = vi.spyOn(epicEventLog, 'appendEpicEvent');
  const job = { slug: '9001-x', status: 'pending', cwd: tmp, epicId: 'epic-abc' };
  expect(transitionJob(job, 'pending', { reason: 'noop', source: 'test' })).toBe(true);
  expect(spy).not.toHaveBeenCalled();
});

test('job without epicId (or cwd) appends nothing but still transitions', () => {
  const spy = vi.spyOn(epicEventLog, 'appendEpicEvent');
  const noEpic = { slug: '9001-x', status: 'pending', cwd: tmp };
  expect(transitionJob(noEpic, 'running', { reason: 'dispatch', source: 'test' })).toBe(true);
  expect(noEpic.status).toBe('running');
  const noCwd = { slug: '9002-y', status: 'pending', epicId: 'epic-abc' };
  expect(transitionJob(noCwd, 'running', { reason: 'dispatch', source: 'test' })).toBe(true);
  expect(spy).not.toHaveBeenCalled();
});

test('append failure (rejection or sync throw) never blocks the transition; logged via opsErrorLog', async () => {
  const errSpy = vi.spyOn(opsErrorLog, 'appendError').mockImplementation(() => {});
  vi.spyOn(epicEventLog, 'appendEpicEvent').mockImplementationOnce(() => Promise.reject(new Error('disk full')));
  const a = { slug: '9001-x', status: 'pending', cwd: tmp, epicId: 'epic-abc' };
  expect(transitionJob(a, 'running', { reason: 'dispatch', source: 'test' })).toBe(true);
  expect(a.status).toBe('running');
  await flush();
  expect(errSpy).toHaveBeenCalledTimes(1);
  expect(errSpy.mock.calls[0][0]).toMatchObject({ cwd: tmp, scope: 'scheduler', level: 'error', epicId: 'epic-abc' });
  expect(errSpy.mock.calls[0][0].message).toMatch(/job\.status_changed.*disk full/);

  epicEventLog.appendEpicEvent.mockImplementationOnce(() => { throw new Error('sync boom'); });
  const b = { slug: '9002-y', status: 'running', cwd: tmp, epicId: 'epic-abc' };
  expect(transitionJob(b, 'completed', { reason: 'ok', source: 'test' })).toBe(true);
  expect(b.status).toBe('completed');
  expect(errSpy).toHaveBeenCalledTimes(2);
  expect(errSpy.mock.calls[1][0].message).toMatch(/sync boom/);
});

test('emitJobEvent writes job.queued { slug, agentType } for the queue-row insert', async () => {
  emitJobEvent({ slug: '9003-z', cwd: tmp, epicId: 'epic-abc', agentType: 'dev-lead' },
    { kind: 'job.queued', slug: '9003-z', agentType: 'dev-lead' });
  await flush();
  const { events } = await epicEventLog.readEpicEvents(tmp, 'epic-abc', { kinds: ['job.queued'] });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ kind: 'job.queued', slug: '9003-z', agentType: 'dev-lead' });
});
