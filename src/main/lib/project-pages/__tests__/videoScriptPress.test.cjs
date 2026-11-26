/**
 * videoScriptPress.test.cjs — the machine-level 'Scripts may run Demo Video'
 * switch and the scripted-press ledger (lib/project-pages/videoScriptPress.cjs)
 * over a tmp SM_SCHEDULER_HOME.
 *
 * Run: timeout 300 npx vitest run src/main/lib/project-pages/__tests__/videoScriptPress.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  videoScriptSwitchesPath, videoScriptRunsPath, taskSwitchesPath,
} = require('../../scheduler/schedulerPaths.cjs');
const vsp = require('../videoScriptPress.cjs');

const AGENT_BY = { via: 'agent', claudeSessionId: 'sess-1', quote: 'yes let scripts run it', promptAt: '2026-11-24T10:00:00.000Z' };

let home;
let prevHome;
beforeEach(() => {
  prevHome = process.env.SM_SCHEDULER_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-videoscript-'));
  process.env.SM_SCHEDULER_HOME = home;
  vsp._resetForTests();
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test('both paths sit beside task-switches.json under the home override', () => {
  expect(videoScriptSwitchesPath()).toBe(path.join(home, 'video-script-switches.json'));
  expect(videoScriptRunsPath()).toBe(path.join(home, 'video-script-runs.json'));
  expect(path.dirname(videoScriptSwitchesPath())).toBe(path.dirname(taskSwitchesPath()));
});

test('off by default with no file', () => {
  expect(vsp.isVideoScriptSwitchOn('/p/a')).toBe(false);
  expect(vsp.getVideoScriptSwitch('/p/a')).toEqual({ cwd: '/p/a', enabled: false, changedAt: null, by: null });
  expect(vsp.getVideoScriptSwitch('')).toBeNull();
  expect(vsp.isVideoScriptSwitchOn(42)).toBe(false);
});

test('on/off round trip with attribution; keyed by path.resolve', () => {
  const on = vsp.setVideoScriptSwitch('/p/a/', true, AGENT_BY);
  expect(on).toMatchObject({ cwd: '/p/a', enabled: true, by: AGENT_BY });
  expect(vsp.isVideoScriptSwitchOn('/p/a')).toBe(true);
  expect(vsp.isVideoScriptSwitchOn('/p/x/../a')).toBe(true);
  const file = JSON.parse(fs.readFileSync(videoScriptSwitchesPath(), 'utf8'));
  expect(file.v).toBe(1);
  expect(file.projects['/p/a']).toMatchObject({ enabled: true, by: AGENT_BY });
  expect(vsp.getVideoScriptSwitch('/p/a').by).toEqual(AGENT_BY);

  vsp.setVideoScriptSwitch('/p/a', false, { via: 'ui' });
  expect(vsp.isVideoScriptSwitchOn('/p/a')).toBe(false);
  const got = vsp.getVideoScriptSwitch('/p/a');
  expect(got).toMatchObject({ cwd: '/p/a', enabled: false, by: { via: 'ui' } });
  expect(Number.isNaN(Date.parse(got.changedAt))).toBe(false);
});

test('malformed by on disk reads as via unknown', () => {
  fs.writeFileSync(videoScriptSwitchesPath(), JSON.stringify({
    v: 1, projects: { '/p/a': { enabled: true, changedAt: '2026-11-24T00:00:00.000Z', by: { via: 'hacker' } } },
  }));
  expect(vsp.isVideoScriptSwitchOn('/p/a')).toBe(true);
  expect(vsp.getVideoScriptSwitch('/p/a').by).toEqual({ via: 'unknown' });
});

test('corrupt file reads as off and never throws', () => {
  fs.writeFileSync(videoScriptSwitchesPath(), '{not json');
  expect(vsp.isVideoScriptSwitchOn('/p/a')).toBe(false);
  expect(vsp.getVideoScriptSwitch('/p/a')).toMatchObject({ enabled: false });
  fs.writeFileSync(videoScriptRunsPath(), '{not json');
  expect(vsp.findScriptRun('/p/a', { entryId: 'e1' })).toBeNull();
});

test('invalid by throws before any write', () => {
  for (const bad of [undefined, null, {}, { via: 'ui', extra: 1 }, { via: 'agent', claudeSessionId: 's', quote: '', promptAt: '2026-11-24T00:00:00Z' },
    { via: 'agent', claudeSessionId: 's', quote: 'q', promptAt: 'nope' }, { via: 'unknown' }]) {
    expect(() => vsp.setVideoScriptSwitch('/p/a', true, bad)).toThrow(/by must be/);
  }
  expect(fs.existsSync(videoScriptSwitchesPath())).toBe(false);
});

test('ledger record/find by entryId and by externalRef, per project', () => {
  vsp.recordScriptRun('/p/a', { entryId: 'e1', epicId: 'ep1', slug: 'demo-1', externalRef: 'post-42', kind: 'blog-post', at: '2026-11-24T01:00:00.000Z' });
  vsp.recordScriptRun('/p/a', { entryId: 'e2', epicId: 'ep2', slug: 'demo-2', kind: 'tiktok', at: '2026-11-24T02:00:00.000Z' });
  const file = JSON.parse(fs.readFileSync(videoScriptRunsPath(), 'utf8'));
  expect(file.v).toBe(1);
  expect(file.projects['/p/a']).toHaveLength(2);

  expect(vsp.findScriptRun('/p/a', { entryId: 'e1' })).toMatchObject({ entryId: 'e1', epicId: 'ep1', slug: 'demo-1', externalRef: 'post-42', kind: 'blog-post' });
  expect(vsp.findScriptRun('/p/a/', { externalRef: 'post-42' })).toMatchObject({ entryId: 'e1' });
  expect(vsp.findScriptRun('/p/a', { entryId: 'e2' }).externalRef).toBeUndefined();
  expect(vsp.findScriptRun('/p/a', { entryId: 'nope' })).toBeNull();
  expect(vsp.findScriptRun('/p/b', { entryId: 'e1' })).toBeNull();
  expect(vsp.findScriptRun('/p/a', {})).toBeNull();
});

test('re-recording an entryId replaces it; latest externalRef match wins', () => {
  vsp.recordScriptRun('/p/a', { entryId: 'e1', epicId: 'ep1', slug: 's1', externalRef: 'r', kind: 'k', at: '2026-11-24T01:00:00.000Z' });
  vsp.recordScriptRun('/p/a', { entryId: 'e2', epicId: 'ep2', slug: 's2', externalRef: 'r', kind: 'k', at: '2026-11-24T02:00:00.000Z' });
  expect(vsp.findScriptRun('/p/a', { externalRef: 'r' }).entryId).toBe('e2');
  vsp.recordScriptRun('/p/a', { entryId: 'e1', epicId: 'ep9', slug: 's1', kind: 'k', at: '2026-11-24T03:00:00.000Z' });
  expect(vsp.findScriptRun('/p/a', { entryId: 'e1' }).epicId).toBe('ep9');
  expect(JSON.parse(fs.readFileSync(videoScriptRunsPath(), 'utf8')).projects['/p/a']).toHaveLength(2);
});

test('invalid run records throw', () => {
  expect(() => vsp.recordScriptRun('/p/a', { epicId: 'ep', slug: 's', kind: 'k', at: '2026-11-24T00:00:00Z' })).toThrow();
  expect(() => vsp.recordScriptRun('', { entryId: 'e', epicId: 'ep', slug: 's', kind: 'k', at: '2026-11-24T00:00:00Z' })).toThrow();
  expect(() => vsp.recordScriptRun('/p/a', { entryId: 'e', epicId: 'ep', slug: 's', kind: 'k', at: 'nope' })).toThrow();
});

test('keeps at most 200 runs per project, oldest dropped', () => {
  for (let i = 0; i < 205; i++) {
    vsp.recordScriptRun('/p/a', { entryId: `e${i}`, epicId: `ep${i}`, slug: `s${i}`, kind: 'k', at: new Date(Date.UTC(2026, 10, 24, 0, 0, i)).toISOString() });
  }
  vsp.recordScriptRun('/p/b', { entryId: 'b1', epicId: 'epb', slug: 'sb', kind: 'k', at: '2026-11-24T00:00:00.000Z' });
  expect(vsp.MAX_RUNS_PER_PROJECT).toBe(200);
  const file = JSON.parse(fs.readFileSync(videoScriptRunsPath(), 'utf8'));
  expect(file.projects['/p/a']).toHaveLength(200);
  expect(vsp.findScriptRun('/p/a', { entryId: 'e4' })).toBeNull();
  expect(vsp.findScriptRun('/p/a', { entryId: 'e5' })).toMatchObject({ epicId: 'ep5' });
  expect(vsp.findScriptRun('/p/a', { entryId: 'e204' })).toMatchObject({ epicId: 'ep204' });
  expect(vsp.findScriptRun('/p/b', { entryId: 'b1' })).toMatchObject({ epicId: 'epb' });
});

test('ledger keeps a valid caller and fromEpicId; drops an invalid caller; legacy run unchanged', () => {
  const base = { slug: 's', kind: 'k', at: '2026-11-24T01:00:00.000Z' };
  const caller = { pipeline: 'blog_publish', runId: 'r1' };
  vsp.recordScriptRun('/p/a', { ...base, entryId: 'c1', epicId: 'ep1', caller, fromEpicId: 'chat-1' });
  expect(vsp.findScriptRun('/p/a', { entryId: 'c1' })).toEqual({ ...base, entryId: 'c1', epicId: 'ep1', caller, fromEpicId: 'chat-1' });

  const kept = vsp.recordScriptRun('/p/a', { ...base, entryId: 'c2', epicId: 'ep2', caller: { bogus: 1 }, fromEpicId: '' });
  expect(kept).toEqual({ ...base, entryId: 'c2', epicId: 'ep2' });
  expect(vsp.findScriptRun('/p/a', { entryId: 'c2' })).toEqual({ ...base, entryId: 'c2', epicId: 'ep2' });

  vsp.recordScriptRun('/p/a', { ...base, entryId: 'c3', epicId: 'ep3' });
  expect(vsp.findScriptRun('/p/a', { entryId: 'c3' })).toEqual({ ...base, entryId: 'c3', epicId: 'ep3' });
});
