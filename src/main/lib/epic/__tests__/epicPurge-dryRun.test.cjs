/**
 * epicPurge-dryRun.test.cjs — purgeEpic({ dryRun: true }) (lib/epic/epicPurge.cjs).
 *
 * Seeds every artifact kind an Epic leaves behind in a temp ops root + temp
 * ~/.claude + temp scheduler home, then proves the dry run:
 *   - lists every artifact the real purge removes (same kinds, same paths),
 *   - leaves every file byte-for-byte in place (no tombstone, no audit record),
 *   - needs no purge authority (a script may call it), while a real purge still does.
 *
 * Run: timeout 300 npx vitest run src/main/lib/epic/__tests__/epicPurge-dryRun.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EPIC = 'epic-dry-run';
const OTHER = 'epic-bystander';
const SLUG = '4101-dry-run-thing';
const OTHER_SLUG = '4102-bystander-thing';

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
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-dryrun-proj-')));
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-dryrun-home-')));
  schedHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-dryrun-sched-')));
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

/** Seed one artifact of every kind for EPIC, plus a bystander Epic. */
async function seed(m) {
  const { ops } = m;
  const wtDir = path.join(home, 'gone-worktree', EPIC);
  const mine = await m.snap.writeAgentSnapshot(cwd, { name: 'dev-lead', body: 'dry-run persona' });
  const theirs = await m.snap.writeAgentSnapshot(cwd, { name: 'architect', body: 'other persona' });
  const session = {
    id: EPIC, claudeSessionId: EPIC, title: 't', objective: 'o', cwd,
    status: 'completed', agentSnapshotId: mine.id, worktree: { dir: wtDir },
  };
  const other = { id: OTHER, claudeSessionId: OTHER, title: 'x', objective: 'x', cwd, status: 'completed', agentSnapshotId: theirs.id };
  writeFile(ops.opsPath(cwd, 'prompt-sessions', 'active-index.json'), JSON.stringify({
    sessions: { [EPIC]: session, [OTHER]: other },
    events: { [EPIC]: [{ type: 'response', text: 'o' }], [OTHER]: [] },
    tombstones: {},
  }));
  writeFile(ops.opsPath(cwd, 'prompt-sessions', `${EPIC}.json`), JSON.stringify({ session, status: 'completed' }));
  writeFile(ops.opsPath(cwd, 'prompt-sessions', `${OTHER}.json`), JSON.stringify({ session: other, status: 'completed' }));
  m.archived.writeSidecar(cwd, EPIC, '{"text":"transcript"}\n');

  const projects = path.join(home, '.claude', 'projects');
  writeFile(path.join(projects, m.encodeCwd(cwd), `${EPIC}.jsonl`), '{"m":1}\n');
  writeFile(path.join(projects, m.encodeCwd(wtDir), `${EPIC}.jsonl`), '{"m":2}\n');
  writeFile(path.join(projects, m.encodeCwd(cwd), EPIC, 'subagents', 'a.jsonl'), '{"m":3}\n');
  writeFile(path.join(projects, m.encodeCwd(cwd), `${OTHER}.jsonl`), '{"m":4}\n');

  await m.events.appendEpicEvent(cwd, EPIC, { kind: 'epic.minted', summary: 't' });
  await m.events.appendEpicEvent(cwd, OTHER, { kind: 'epic.minted', summary: 'x' });
  await m.outcome.writeOutcomeRecord({ cwd, epicId: EPIC, slug: SLUG, verdict: 'completed', appendEvent: async () => {} });
  writeFile(ops.opsPath(cwd, 'scheduler', 'epics', EPIC, 'prds', `${SLUG}.md`), '# t\n');
  writeFile(ops.opsPath(cwd, 'scheduler', 'epics', OTHER, 'prds', `${OTHER_SLUG}.md`), '# x\n');
  writeFile(ops.opsPath(cwd, 'plan-records', EPIC, 'validate.md'), 'v\n');
  writeFile(ops.opsPath(cwd, 'artifacts', EPIC, 'clip.mp4'), 'clip\n');
  writeFile(ops.opsPath(cwd, 'artifacts', EPIC, 'index.json'), JSON.stringify({ version: 1, entries: [{ name: 'clip.mp4', pinned: true }] }));
  writeFile(ops.opsPath(cwd, 'artifacts', OTHER, 'keep.png'), 'other\n');

  const runs = m.schedulerPaths.runsDir();
  writeFile(path.join(runs, 'run-a', `${SLUG}.log`), 'log\n');
  writeFile(path.join(runs, 'run-a', `${SLUG}.meta.json`), JSON.stringify({ slug: SLUG }));
  writeFile(path.join(runs, 'run-a', `${OTHER_SLUG}.log`), 'other\n');

  writeFile(m.queueStore.projectHistoryPath(cwd), [
    JSON.stringify({ slug: SLUG, epicId: EPIC, status: 'completed' }),
    JSON.stringify({ slug: OTHER_SLUG, epicId: OTHER, status: 'completed' }),
  ].join('\n') + '\n');
  writeFile(m.queueHistory.historyPath(), JSON.stringify({ slug: SLUG, epicId: EPIC, status: 'completed' }) + '\n');
  writeFile(m.queueStore.projectQueuePath(cwd), JSON.stringify({
    jobs: [{ slug: SLUG, epicId: EPIC, status: 'completed', cwd }, { slug: OTHER_SLUG, epicId: OTHER, status: 'completed', cwd }],
  }));
}

/** Every file + dir under the temp roots, with content + mtime for files. */
function snapshotTree() {
  const out = new Map();
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { out.set(p, 'dir'); walk(p); } else if (e.isFile()) {
        out.set(p, `${fs.statSync(p).mtimeMs}:${fs.readFileSync(p).toString('base64')}`);
      }
    }
  };
  for (const d of [cwd, home, schedHome]) walk(d);
  return out;
}

const sortArtifacts = (list) => [...list].sort((a, b) => (a.kind + a.path).localeCompare(b.kind + b.path));

test('dry run lists every artifact kind the real purge removes and leaves every file in place', async () => {
  const m = freshModules();
  await seed(m);
  const before = snapshotTree();

  const dry = await m.purge.purgeEpic({ cwd, epicId: EPIC, dryRun: true });
  expect(dry.ok).toBe(true);
  expect(dry.dryRun).toBe(true);
  expect(dry.removed).toEqual([]);

  // Nothing written, nothing deleted: same files, same bytes, same mtimes; no audit log.
  expect(snapshotTree()).toEqual(before);
  expect(fs.existsSync(m.schedulerPaths.auditLogPath())).toBe(false);
  const index = JSON.parse(fs.readFileSync(m.ops.opsPath(cwd, 'prompt-sessions', 'active-index.json'), 'utf8'));
  expect(index.tombstones[EPIC]).toBeUndefined();
  expect(index.sessions[EPIC]).toBeDefined();

  // Every kind is present (the seed has one of each), counts add up.
  const kinds = new Set(dry.artifacts.map((a) => a.kind));
  for (const k of m.purge.PURGE_ARTIFACT_KINDS) expect(kinds.has(k), k).toBe(true);
  expect(Object.keys(dry.counts).sort()).toEqual([...m.purge.PURGE_ARTIFACT_KINDS].sort());
  for (const k of m.purge.PURGE_ARTIFACT_KINDS) {
    expect(dry.counts[k]).toBe(dry.artifacts.filter((a) => a.kind === k).length);
  }
  expect(dry.total).toBe(dry.artifacts.length);
  for (const a of dry.artifacts) expect(fs.existsSync(a.path), a.path).toBe(true);
  // The bystander's artifacts are never listed.
  expect(dry.artifacts.some((a) => a.path.includes(OTHER) || a.path.includes(OTHER_SLUG))).toBe(false);

  // The real purge removes exactly what the dry run listed.
  const real = await m.purge.purgeEpic({ cwd, epicId: EPIC, authority: m.purge.PURGE_AUTHORITY_IPC });
  expect(real.ok).toBe(true);
  expect(real.dryRun).toBe(false);
  expect(sortArtifacts(real.artifacts)).toEqual(sortArtifacts(dry.artifacts));
  expect(real.counts).toEqual(dry.counts);
  expect([...real.removed].sort()).toEqual(dry.artifacts.map((a) => a.path).sort());
  for (const a of dry.artifacts) {
    if (a.kind === 'history-rows' || a.kind === 'index-row') continue; // rewritten, not deleted
    expect(fs.existsSync(a.path), a.path).toBe(false);
  }
});

test('dry run needs no authority; a real purge still refuses without it', async () => {
  const m = freshModules();
  await seed(m);
  const dry = await m.purge.purgeEpic({ cwd, epicId: EPIC, dryRun: true, authority: 'script' });
  expect(dry.ok).toBe(true);
  for (const dryRun of [false, 'true', 1, undefined]) {
    const res = await m.purge.purgeEpic({ cwd, epicId: EPIC, dryRun, authority: 'script' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('not_human');
  }
  expect(fs.existsSync(m.ops.opsPath(cwd, 'prompt-sessions', `${EPIC}.json`))).toBe(true);
});

test('dry run of an unknown Epic lists nothing and writes nothing', async () => {
  const m = freshModules();
  await seed(m);
  const before = snapshotTree();
  const dry = await m.purge.purgeEpic({ cwd, epicId: 'epic-never-existed', dryRun: true });
  expect(dry.ok).toBe(true);
  expect(dry.total).toBe(0);
  expect(snapshotTree()).toEqual(before);
});

test('dry run still refuses an unsafe id', async () => {
  const m = freshModules();
  const res = await m.purge.purgeEpic({ cwd, epicId: '../x', dryRun: true });
  expect(res.code).toBe('invalid_epic_id');
});
