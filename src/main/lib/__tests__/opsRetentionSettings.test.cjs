/**
 * opsRetentionSettings.test.cjs — machine-level ops retention settings + read-only preview.
 *
 * Run: timeout 300 npx vitest run src/main/lib/__tests__/opsRetentionSettings.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const settings = require('../opsRetentionSettings.cjs');
const { resolveRetentionConfig } = require('../scheduler/runLogRetention.cjs');
const { pruneRunsArchive } = require('../scheduler/staleTmpSweep.cjs');

let home;
const DAY = 86400000;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-ops-retention-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function writeRaw(text) {
  fs.mkdirSync(path.dirname(settings.storePath()), { recursive: true });
  fs.writeFileSync(settings.storePath(), text);
}

test('read returns DEFAULTS when the file is missing', () => {
  expect(settings.read()).toEqual({
    runLogs: { maxAgeDays: 14, keepPerSlug: 3 },
    runsArchiveDays: 30,
    auditLogMonths: 6,
    reservedMarkersKeep: 100,
    tasksDays: 30,
    planRecordsDays: 14,
    feedbackInboxDays: 90,
  });
  expect(settings.DEFAULTS).not.toHaveProperty('archivedTranscripts');
  expect(settings.storePath()).toBe(path.join(home, '.claude', 'session-manager', 'ops-retention.json'));
});

test('write merges a patch, clamps and rounds integers, persists', () => {
  const out = settings.write({ runLogs: { maxAgeDays: 1 }, runsArchiveDays: 45.6, auditLogMonths: 0 });
  expect(out.runLogs).toEqual({ maxAgeDays: 3, keepPerSlug: 3 });
  expect(out.runsArchiveDays).toBe(46);
  expect(out.auditLogMonths).toBe(1);
  expect(settings.read()).toEqual(out);
});

test('write rejects unknown keys (incl. archivedTranscripts) and bad types', () => {
  expect(() => settings.write({ nope: 1 })).toThrow();
  expect(() => settings.write({ runsArchiveDays: 'x' })).toThrow();
  expect(() => settings.write({ archivedTranscripts: { mode: 'forever' } })).toThrow(/unknown key/);
  expect(() => settings.write(null)).toThrow();
});

test('a legacy stored archivedTranscripts key is dropped on read', () => {
  writeRaw(JSON.stringify({ auditLogMonths: 12, archivedTranscripts: { mode: 'forever' } }));
  const out = settings.read();
  expect(out.auditLogMonths).toBe(12);
  expect(out).not.toHaveProperty('archivedTranscripts');
  expect(settings.readStored()).not.toHaveProperty('archivedTranscripts');
});

test('corrupt file falls back to DEFAULTS', () => {
  writeRaw('{not json');
  expect(settings.read()).toEqual(settings.DEFAULTS);
  writeRaw('[1,2]');
  expect(settings.read()).toEqual(settings.DEFAULTS);
});

test('invalid stored fields are dropped per-field and clamped', () => {
  writeRaw(JSON.stringify({ runLogs: { maxAgeDays: 1, keepPerSlug: 'x' }, runsArchiveDays: 'bad', auditLogMonths: 12 }));
  const r = settings.read();
  expect(r.runLogs).toEqual({ maxAgeDays: 3, keepPerSlug: 3 });
  expect(r.runsArchiveDays).toBe(30);
  expect(r.auditLogMonths).toBe(12);
});

test('ops-retention.json runLogs takes precedence over legacy config; absent falls back', () => {
  const legacy = { schedulerRunLogRetention: { enabled: true, policy: { maxAgeDays: 99, keepPerSlug: 9 } } };
  expect(resolveRetentionConfig(legacy).policy.maxAgeDays).toBe(99);
  settings.write({ runLogs: { maxAgeDays: 20, keepPerSlug: 2 } });
  expect(resolveRetentionConfig(legacy)).toEqual({ enabled: true, policy: { maxAgeDays: 20, keepPerSlug: 2 } });
});

test('pruneRunsArchive default age comes from runsArchiveDays', () => {
  const dir = path.join(home, 'runs-archive');
  fs.mkdirSync(dir);
  const f = path.join(dir, 'old.txt');
  fs.writeFileSync(f, 'x');
  const t = (Date.now() - 10 * DAY) / 1000;
  fs.utimesSync(f, t, t);
  expect(pruneRunsArchive(dir, { dryRun: true }).removedFiles).toBe(0); // default 30d
  settings.write({ runsArchiveDays: 5 });
  expect(pruneRunsArchive(dir, { dryRun: true }).removedFiles).toBe(1);
  expect(fs.existsSync(f)).toBe(true);
});

function snapshot(root) {
  const out = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      out.push(`${p}:${st.isDirectory() ? 'd' : st.size}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out.sort();
}

test('preview reports eligible bytes and deletes nothing', () => {
  const plansRoot = path.join(home, 'plans');
  const runsDir = path.join(plansRoot, 'runs');
  const archive = path.join(plansRoot, 'runs-archive');
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(archive);
  const old = (Date.now() - 60 * DAY) / 1000;
  const age = (p) => fs.utimesSync(p, old, old);

  const runDir = path.join(runsDir, 'run-old');
  fs.mkdirSync(runDir);
  fs.writeFileSync(path.join(runDir, 'slug-a.log'), 'x'.repeat(100));
  fs.writeFileSync(path.join(runDir, 'slug-a.log.meta.json'), '{}');
  age(path.join(runDir, 'slug-a.log'));
  age(path.join(runDir, 'slug-a.log.meta.json'));

  fs.writeFileSync(path.join(archive, 'a.json'), 'y'.repeat(50));
  age(path.join(archive, 'a.json'));

  const tmpFile = path.join(plansRoot, 'queue.json.tmp-99999999-abc');
  fs.writeFileSync(tmpFile, 'z'.repeat(20));
  age(tmpFile);

  const before = snapshot(home);
  const r = settings.preview({ runsDir, plansRoot, jobs: [] });
  expect(r.runsArchive).toEqual({ entries: 1, bytes: 50 });
  expect(r.tmp.files).toBe(1);
  expect(r.tmp.bytes).toBe(20);
  expect(r.runLogs).toEqual({ files: expect.any(Number), bytes: expect.any(Number) });
  expect(snapshot(home)).toEqual(before);
});

test('feedbackInboxDays: default 90, clamps to [1, 3650], validates, sanitizes stored', () => {
  expect(settings.DEFAULTS.feedbackInboxDays).toBe(90);
  expect(settings.BOUNDS.feedbackInboxDays).toEqual([1, 3650]);
  expect(settings.validatePatch({ feedbackInboxDays: 0 })).toEqual({ feedbackInboxDays: 1 });
  expect(settings.validatePatch({ feedbackInboxDays: 99999 })).toEqual({ feedbackInboxDays: 3650 });
  expect(() => settings.validatePatch({ feedbackInboxDays: 'x' })).toThrow(/feedbackInboxDays/);
  expect(settings.write({ feedbackInboxDays: 30.4 }).feedbackInboxDays).toBe(30);
  expect(settings.read().feedbackInboxDays).toBe(30);
  writeRaw(JSON.stringify({ feedbackInboxDays: 'bad', tasksDays: 9 }));
  expect(settings.read().feedbackInboxDays).toBe(90);
  expect(settings.read().tasksDays).toBe(9);
  writeRaw(JSON.stringify({ feedbackInboxDays: -5 }));
  expect(settings.read().feedbackInboxDays).toBe(1);
});

test('planRecordsDays: default 14, clamps to [1, 3650], validates, sanitizes stored', () => {
  expect(settings.DEFAULTS.planRecordsDays).toBe(14);
  expect(settings.BOUNDS.planRecordsDays).toEqual([1, 3650]);
  expect(settings.validatePatch({ planRecordsDays: 0 })).toEqual({ planRecordsDays: 1 });
  expect(settings.validatePatch({ planRecordsDays: 99999 })).toEqual({ planRecordsDays: 3650 });
  expect(() => settings.validatePatch({ planRecordsDays: 'x' })).toThrow(/planRecordsDays/);
  expect(settings.write({ planRecordsDays: 7.4 }).planRecordsDays).toBe(7);
  expect(settings.read().planRecordsDays).toBe(7);
  writeRaw(JSON.stringify({ planRecordsDays: 'bad', tasksDays: 9 }));
  expect(settings.read().planRecordsDays).toBe(14);
  expect(settings.readStored()).toEqual({ tasksDays: 9 });
  writeRaw(JSON.stringify({ planRecordsDays: -5 }));
  expect(settings.read().planRecordsDays).toBe(1);
});

test('preview reports plan-record folders it would prune for a project root, deleting nothing', () => {
  const plansRoot = path.join(home, 'plans');
  fs.mkdirSync(path.join(plansRoot, 'runs'), { recursive: true });
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-ops-retention-proj-'));
  try {
    const ops = path.join(project, 'session-manager-operations');
    const records = path.join(ops, 'plan-records');
    const now = Date.now();
    const old = (now - 30 * DAY) / 1000;
    for (const id of ['done-epic', 'live-epic', 'orphan-epic', 'fresh-orphan']) {
      fs.mkdirSync(path.join(records, id), { recursive: true });
      const f = path.join(records, id, 'p.md');
      fs.writeFileSync(f, 'x');
      if (id !== 'fresh-orphan') fs.utimesSync(f, old, old);
    }
    fs.mkdirSync(path.join(ops, 'prompt-sessions'), { recursive: true });
    fs.writeFileSync(path.join(ops, 'prompt-sessions', 'done-epic.json'), JSON.stringify({
      session: { status: 'completed', completedAt: new Date(now - 20 * DAY).toISOString() },
    }));
    fs.writeFileSync(path.join(ops, 'prompt-sessions', 'live-epic.json'), JSON.stringify({ status: 'active' }));
    const base = { runsDir: path.join(plansRoot, 'runs'), plansRoot, jobs: [], now };
    expect(settings.preview(base)).not.toHaveProperty('planRecords');
    const before = snapshot(project);
    expect(settings.preview({ ...base, projectRoot: project }).planRecords).toEqual({ folders: 2 });
    expect(settings.preview({ ...base, projectRoot: project, epicStatus: () => ({ status: 'active' }) }).planRecords)
      .toEqual({ folders: 0 });
    settings.write({ planRecordsDays: 60 });
    expect(settings.preview({ ...base, projectRoot: project }).planRecords).toEqual({ folders: 0 });
    expect(snapshot(project)).toEqual(before);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('registerIpc wires get/set/preview; set validates', async () => {
  const handlers = {};
  settings.registerIpc({ handle: (ch, fn) => { handlers[ch] = fn; } });
  expect(Object.keys(handlers).sort()).toEqual(['opsRetention:get', 'opsRetention:preview', 'opsRetention:set']);
  expect(handlers['opsRetention:get']({}).runsArchiveDays).toBe(30);
  expect(handlers['opsRetention:set']({}, { runsArchiveDays: 7 }).runsArchiveDays).toBe(7);
  expect(() => handlers['opsRetention:set']({}, { bogus: 1 })).toThrow();
});
