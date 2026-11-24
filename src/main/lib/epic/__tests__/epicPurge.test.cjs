/**
 * epicPurge.test.cjs — the human-only Epic purge (lib/epic/epicPurge.cjs).
 *
 * Seeds every artifact an Epic leaves behind (Epic JSON + index row, archived
 * transcript, CLI JSONL, run logs, event log, outcome records, PRD sources,
 * agent snapshot, history rows) in a temp ops root + temp ~/.claude + temp
 * scheduler home, purges, and proves no file anywhere still holds the Epic's
 * title, objective or transcript text.
 *
 * Run: timeout 300 npx vitest run src/main/lib/epic/__tests__/epicPurge.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const EPIC = 'epic-purge-me';
const OTHER = 'epic-keep-me';
const TITLE = 'Zebra-Quantum-Title-7f3a';
const OBJECTIVE = 'Objective-Marmalade-Secret-91bc';
const TRANSCRIPT = 'Transcript-Hidden-Words-55de';
const SLUG = '4001-purge-me-thing';
const OTHER_SLUG = '4002-keep-me-thing';

let cwd;
let home;
let schedHome;
let savedSchedHome;
let savedHistOverride;

function freshModules() {
  vi.resetModules();
  return {
    purge: require('../epicPurge.cjs'),
    ops: require('../../opsOwnership.cjs'),
    events: require('../epicEventLog.cjs'),
    outcome: require('../../scheduler/prdOutcomeRecord.cjs'),
    snap: require('../../claude/agentSnapshot.cjs'),
    archived: require('../archivedTranscript.cjs'),
    queueStore: require('../../scheduler/queueStore.cjs'),
    schedulerPaths: require('../../scheduler/schedulerPaths.cjs'),
    queueHistory: require('../../scheduler/queueHistory.cjs'),
    encodeCwd: require('../../util/encodeCwd.cjs').encodeCwd,
  };
}

beforeEach(() => {
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-purge-proj-')));
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-purge-home-')));
  schedHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-purge-sched-')));
  savedSchedHome = process.env.SM_SCHEDULER_HOME;
  savedHistOverride = process.env.SM_HISTORY_PATH_OVERRIDE;
  process.env.SM_SCHEDULER_HOME = schedHome;
  delete process.env.SM_HISTORY_PATH_OVERRIDE;
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedSchedHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = savedSchedHome;
  if (savedHistOverride === undefined) delete process.env.SM_HISTORY_PATH_OVERRIDE;
  else process.env.SM_HISTORY_PATH_OVERRIDE = savedHistOverride;
  for (const d of [cwd, home, schedHome]) fs.rmSync(d, { recursive: true, force: true });
});

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Seed every artifact for EPIC plus a control set for OTHER. Returns paths to check. */
async function seed(m, { jobStatus = 'completed' } = {}) {
  const { ops } = m;
  const wtDir = path.join(home, 'gone-worktree', EPIC);

  const mine = await m.snap.writeAgentSnapshot(cwd, { name: 'dev-lead', body: `persona for ${TITLE}` });
  const theirs = await m.snap.writeAgentSnapshot(cwd, { name: 'architect', body: 'other persona' });

  const session = {
    id: EPIC, claudeSessionId: EPIC, title: TITLE, objective: OBJECTIVE, cwd,
    status: 'completed', agentSnapshotId: mine.id, worktree: { dir: wtDir },
  };
  const other = {
    id: OTHER, claudeSessionId: OTHER, title: 'Other title', objective: 'other', cwd,
    status: 'completed', agentSnapshotId: theirs.id,
  };
  writeFile(ops.opsPath(cwd, 'prompt-sessions', 'active-index.json'), JSON.stringify({
    sessions: { [EPIC]: session, [OTHER]: other },
    events: { [EPIC]: [{ type: 'response', text: OBJECTIVE }], [OTHER]: [{ type: 'response', text: 'x' }] },
    tombstones: {},
  }));
  writeFile(ops.opsPath(cwd, 'prompt-sessions', `${EPIC}.json`), JSON.stringify({ session, status: 'completed' }));
  writeFile(ops.opsPath(cwd, 'prompt-sessions', `${OTHER}.json`), JSON.stringify({ session: other, status: 'completed' }));

  m.archived.writeSidecar(cwd, EPIC, `{"text":"${TRANSCRIPT}"}\n`);

  const projects = path.join(home, '.claude', 'projects');
  const cliMain = path.join(projects, m.encodeCwd(cwd), `${EPIC}.jsonl`);
  const cliWt = path.join(projects, m.encodeCwd(wtDir), `${EPIC}.jsonl`);
  const cliSub = path.join(projects, m.encodeCwd(cwd), EPIC, 'subagents', 'a.jsonl');
  const cliOther = path.join(projects, m.encodeCwd(cwd), `${OTHER}.jsonl`);
  writeFile(cliMain, `{"message":"${TRANSCRIPT} ${OBJECTIVE}"}\n`);
  writeFile(cliWt, `{"message":"${TRANSCRIPT}"}\n`);
  writeFile(cliSub, `{"message":"${TRANSCRIPT}"}\n`);
  writeFile(cliOther, '{"message":"other"}\n');

  await m.events.appendEpicEvent(cwd, EPIC, { kind: 'epic.minted', summary: TITLE });
  await m.events.appendEpicEvent(cwd, OTHER, { kind: 'epic.minted', summary: 'other' });

  await m.outcome.writeOutcomeRecord({
    cwd, epicId: EPIC, slug: SLUG, verdict: 'completed', extra: { title: TITLE }, appendEvent: async () => {},
  });
  writeFile(ops.opsPath(cwd, 'scheduler', 'epics', EPIC, 'prds', `${SLUG}.md`), `# ${TITLE}\n${OBJECTIVE}\n`);
  writeFile(ops.opsPath(cwd, 'scheduler', 'epics', OTHER, 'prds', `${OTHER_SLUG}.md`), '# other\n');
  writeFile(ops.opsPath(cwd, 'plan-records', EPIC, 'validate.md'), `${TITLE}\n`);
  writeFile(ops.opsPath(cwd, 'artifacts', EPIC, 'clip.mp4'), 'clip\n');
  writeFile(ops.opsPath(cwd, 'artifacts', EPIC, 'index.json'), JSON.stringify({ version: 1, entries: [{ name: 'clip.mp4', pinned: true }] }));
  writeFile(ops.opsPath(cwd, 'artifacts', OTHER, 'keep.png'), 'other\n');

  const runs = m.schedulerPaths.runsDir();
  writeFile(path.join(runs, 'run-a', `${SLUG}.log`), `${TRANSCRIPT}\n`);
  writeFile(path.join(runs, 'run-a', `${SLUG}.meta.json`), JSON.stringify({ slug: SLUG, title: TITLE }));
  writeFile(path.join(runs, 'run-a', `${OTHER_SLUG}.log`), 'other log\n');
  writeFile(path.join(runs, 'run-a', `${OTHER_SLUG}.meta.json`), JSON.stringify({ slug: OTHER_SLUG }));

  const hist = m.queueStore.projectHistoryPath(cwd);
  writeFile(hist, [
    JSON.stringify({ slug: SLUG, epicId: EPIC, title: TITLE, status: 'completed' }),
    JSON.stringify({ slug: OTHER_SLUG, epicId: OTHER, title: 'other', status: 'completed' }),
  ].join('\n') + '\n');
  const legacy = m.queueHistory.historyPath();
  writeFile(legacy, JSON.stringify({ slug: SLUG, epicId: EPIC, title: TITLE, status: 'completed' }) + '\n');

  writeFile(m.queueStore.projectQueuePath(cwd), JSON.stringify({
    jobs: [
      { slug: SLUG, epicId: EPIC, status: jobStatus, cwd },
      { slug: OTHER_SLUG, epicId: OTHER, status: 'completed', cwd },
    ],
  }));

  return { mine, theirs, cliMain, cliWt, cliSub, cliOther, hist, legacy, runs };
}

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function readAny(file) {
  const buf = fs.readFileSync(file);
  if (file.endsWith('.gz')) {
    try { return zlib.gunzipSync(buf).toString('utf8'); } catch { return buf.toString('utf8'); }
  }
  return buf.toString('utf8');
}

test('purge removes every artifact and leaves only a content-free audit tombstone', async () => {
  const m = freshModules();
  const s = await seed(m);

  // Sanity: the seeded tree really carries the Epic's text before the purge.
  const before = [cwd, home, schedHome].flatMap((d) => walk(d)).map(readAny).join('\n');
  expect(before).toContain(TITLE);
  expect(before).toContain(OBJECTIVE);
  expect(before).toContain(TRANSCRIPT);

  const res = await m.purge.purgeEpic({ cwd, epicId: EPIC, authority: m.purge.PURGE_AUTHORITY_IPC });
  expect(res.ok).toBe(true);

  const files = [cwd, home, schedHome].flatMap((d) => walk(d));
  for (const f of files) {
    const text = readAny(f);
    expect(text, f).not.toContain(TITLE);
    expect(text, f).not.toContain(OBJECTIVE);
    expect(text, f).not.toContain(TRANSCRIPT);
  }

  // Each artifact is gone.
  expect(fs.existsSync(m.ops.opsPath(cwd, 'prompt-sessions', `${EPIC}.json`))).toBe(false);
  expect(fs.existsSync(m.archived.sidecarPath(cwd, EPIC))).toBe(false);
  for (const p of [s.cliMain, s.cliWt, s.cliSub]) expect(fs.existsSync(p), p).toBe(false);
  expect(fs.existsSync(m.ops.opsPath(cwd, 'events', EPIC))).toBe(false);
  expect(fs.existsSync(m.ops.opsPath(cwd, 'scheduler', 'epics', EPIC))).toBe(false);
  expect(fs.existsSync(m.ops.opsPath(cwd, 'plan-records', EPIC))).toBe(false);
  expect(fs.existsSync(m.ops.opsPath(cwd, 'artifacts', EPIC))).toBe(false);
  expect(fs.existsSync(m.ops.opsPath(cwd, 'artifacts', OTHER, 'keep.png'))).toBe(true);
  expect(fs.existsSync(path.join(s.runs, 'run-a', `${SLUG}.log`))).toBe(false);
  expect(fs.existsSync(path.join(s.runs, 'run-a', `${SLUG}.meta.json`))).toBe(false);
  expect(fs.existsSync(m.ops.opsPath(cwd, 'agents', 'snapshots', `${s.mine.id}.json`))).toBe(false);

  const index = JSON.parse(fs.readFileSync(m.ops.opsPath(cwd, 'prompt-sessions', 'active-index.json'), 'utf8'));
  expect(index.sessions[EPIC]).toBeUndefined();
  expect(index.events[EPIC]).toBeUndefined();
  expect(typeof index.tombstones[EPIC]).toBe('string');

  // Another Epic's artifacts survive untouched.
  expect(index.sessions[OTHER].title).toBe('Other title');
  expect(fs.existsSync(m.ops.opsPath(cwd, 'prompt-sessions', `${OTHER}.json`))).toBe(true);
  expect(fs.existsSync(s.cliOther)).toBe(true);
  expect(fs.existsSync(m.ops.opsPath(cwd, 'events', OTHER, 'events.jsonl'))).toBe(true);
  expect(fs.existsSync(m.ops.opsPath(cwd, 'scheduler', 'epics', OTHER, 'prds', `${OTHER_SLUG}.md`))).toBe(true);
  expect(fs.existsSync(path.join(s.runs, 'run-a', `${OTHER_SLUG}.log`))).toBe(true);
  expect(fs.existsSync(m.ops.opsPath(cwd, 'agents', 'snapshots', `${s.theirs.id}.json`))).toBe(true);
  const histRows = fs.readFileSync(s.hist, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(histRows.map((r) => r.epicId)).toEqual([OTHER]);

  // Exactly one audit record, content-free.
  const audit = fs.readFileSync(m.schedulerPaths.auditLogPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const purged = audit.filter((r) => r.kind === 'epic_purged');
  expect(purged).toHaveLength(1);
  const { caller, ...rec } = purged[0];
  expect(Object.keys(rec).sort()).toEqual(['at', 'epicId', 'kind']);
  expect(rec.epicId).toBe(EPIC);
  expect(new Date(rec.at).toISOString()).toBe(rec.at);
});

test('refuses a non-human authority and touches nothing', async () => {
  const m = freshModules();
  await seed(m);
  for (const authority of [undefined, null, 'scheduler', 'mcp', 'promptSessions:purge-epic ']) {
    const res = await m.purge.purgeEpic({ cwd, epicId: EPIC, authority });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('not_human');
  }
  expect(fs.existsSync(m.ops.opsPath(cwd, 'prompt-sessions', `${EPIC}.json`))).toBe(true);
  expect(fs.existsSync(m.ops.opsPath(cwd, 'events', EPIC, 'events.jsonl'))).toBe(true);
  expect(fs.existsSync(m.schedulerPaths.auditLogPath())).toBe(false);
});

test('refuses an Epic with a running job and touches nothing', async () => {
  const m = freshModules();
  const s = await seed(m, { jobStatus: 'running' });
  const res = await m.purge.purgeEpic({ cwd, epicId: EPIC, authority: m.purge.PURGE_AUTHORITY_IPC });
  expect(res.ok).toBe(false);
  expect(res.code).toBe('epic_running');
  expect(fs.existsSync(m.ops.opsPath(cwd, 'prompt-sessions', `${EPIC}.json`))).toBe(true);
  expect(fs.existsSync(s.cliMain)).toBe(true);
  expect(fs.existsSync(path.join(s.runs, 'run-a', `${SLUG}.log`))).toBe(true);
  expect(fs.existsSync(m.schedulerPaths.auditLogPath())).toBe(false);
});

test('refuses an unsafe epicId', async () => {
  const m = freshModules();
  const res = await m.purge.purgeEpic({ cwd, epicId: '../x', authority: m.purge.PURGE_AUTHORITY_IPC });
  expect(res.ok).toBe(false);
  expect(res.code).toBe('invalid_epic_id');
});
