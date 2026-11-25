// opsOwnership.cjs — the single-writer law over a project's ops root.
// vitest globals (test/beforeEach) — same convention as the other .cjs tests.
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { parseOpsPath, checkOpsWrite, assertOpsWrite, OWNERS } = require('../opsOwnership.cjs');

const P = '/home/u/Projects/demo/session-manager-operations';

test('parseOpsPath: splits namespace and remainder, ignores non-ops paths', () => {
  assert.deepEqual(parseOpsPath(`${P}/prompt-sessions/active-index.json`), {
    inOps: true, namespace: 'prompt-sessions', relative: 'active-index.json',
  });
  assert.deepEqual(parseOpsPath(`${P}/scheduler/epics/e1/prds/900-x.md`), {
    inOps: true, namespace: 'scheduler', relative: 'epics/e1/prds/900-x.md',
  });
  assert.equal(parseOpsPath('/home/u/.claude/settings.json').inOps, false);
  assert.equal(parseOpsPath(null).inOps, false);
});

test('paths outside any ops root are not governed by ownership', () => {
  assert.deepEqual(checkOpsWrite('/home/u/.claude/settings.json', undefined), { ok: true, error: null });
});

test('the owner of a namespace may write it', () => {
  assert.equal(checkOpsWrite(`${P}/prompt-sessions/active-index.json`, 'epics').ok, true);
  assert.equal(checkOpsWrite(`${P}/scheduler/state/queue.json`, 'scheduler').ok, true);
  assert.equal(checkOpsWrite(`${P}/project-brief/brief.json`, 'project-home').ok, true);
  // project-pages: declared owner is 'project-home', same as project-brief —
  // this governs only the app's own /admin/project-home/render write path
  // (config.cjs), NOT a project-home-builder Epic's own Write-tool authoring
  // of summary.json/picks.json, which never goes through config.cjs at all
  // and so is unaffected by this table either way (see project-pages/README.md).
  assert.equal(checkOpsWrite(`${P}/project-pages/output/manifest.json`, 'project-home').ok, true);
});

test('a non-owner is refused, and the error names the owner', () => {
  const res = checkOpsWrite(`${P}/project-brief/brief.json`, 'scheduler');
  assert.equal(res.ok, false);
  assert.match(res.error, /owned by 'project-home'/);
  // The exact cross-write this law exists to prevent: another surface
  // rewriting the Epic store out from under Epics.
  assert.equal(checkOpsWrite(`${P}/prompt-sessions/psess-1.json`, 'scheduler').ok, false);
  assert.equal(checkOpsWrite(`${P}/project-pages/output/manifest.json`, 'scheduler').ok, false);
});

test('an undeclared writer is refused (fail-closed)', () => {
  const res = checkOpsWrite(`${P}/scheduler/state/queue.json`, undefined);
  assert.equal(res.ok, false);
  assert.match(res.error, /did not declare a writer/);
});

test('a namespace with no declared owner is refused, not silently allowed', () => {
  const res = checkOpsWrite(`${P}/brand-new-thing/state.json`, 'scheduler');
  assert.equal(res.ok, false);
  assert.match(res.error, /no declared owner/);
});

test('the ops root itself is unownable', () => {
  assert.equal(checkOpsWrite(`${P}/loose-file.json`, 'epics').ok, false);
});

test('the scheduler delegation covers active-index.json and nothing else', () => {
  assert.equal(checkOpsWrite(`${P}/prompt-sessions/active-index.json`, 'scheduler').ok, true);
  // Not the archives, and not a lookalike nested path.
  assert.equal(checkOpsWrite(`${P}/prompt-sessions/psess-9.json`, 'scheduler').ok, false);
  assert.equal(checkOpsWrite(`${P}/prompt-sessions/nested/active-index.json`, 'scheduler').ok, false);
});

test('assertOpsWrite throws for a refused write and is silent for an allowed one', () => {
  assert.throws(() => assertOpsWrite(`${P}/project-brief/brief.json`, 'epics'), /single-writer law/);
  assert.doesNotThrow(() => assertOpsWrite(`${P}/project-brief/brief.json`, 'project-home'));
});

test('assertOpsWrite fails closed (not a raw crash) on a relative path that looks like it is inside an ops root', () => {
  // A caller that skips opsPath/resolveProjectRoot (which already throw on a
  // relative cwd) and builds its own path string by hand must still get a
  // graceful, catchable refusal here — this is the last line of defense
  // (PRD 1082). Before this guard, classifyCwd's absolute-path check (added
  // for the worktree-relative-cwd hazard) left innermostOpsRoot null for a
  // relative path, and path.dirname(null) threw an untagged TypeError
  // instead of the intended `unknownCwd`-tagged Error.
  assert.throws(
    () => assertOpsWrite('session-manager-operations/scheduler/state/queue.json', 'scheduler'),
    (e) => e.unknownCwd === true && /absolute/.test(e.message),
  );
});

test("tasks/ is owned by 'tasks' (taskLedger.cjs) and is a runtime namespace", () => {
  const { RUNTIME_NAMESPACES } = require('../opsOwnership.cjs');
  assert.equal(OWNERS.tasks, 'tasks');
  assert.ok(RUNTIME_NAMESPACES.includes('tasks'));
  assert.equal(checkOpsWrite(`${P}/tasks/2026-11-22.jsonl`, 'tasks').ok, true);
  assert.equal(checkOpsWrite(`${P}/tasks/bodies/t1.json`, 'scheduler').ok, false);
  assert.equal(checkOpsWrite(`${P}/tasks/.gitignore`, 'runtime-ignore').ok, true);
});

test("plan-records/ is owned by 'scheduler' and is a runtime namespace", () => {
  const { RUNTIME_NAMESPACES } = require('../opsOwnership.cjs');
  assert.equal(OWNERS['plan-records'], 'scheduler');
  assert.ok(RUNTIME_NAMESPACES.includes('plan-records'));
  assert.equal(checkOpsWrite(`${P}/plan-records/epic-1/3579-x.md`, 'scheduler').ok, true);
  assert.equal(checkOpsWrite(`${P}/plan-records/epic-1/3579-x.md`, 'epics').ok, false);
  assert.equal(checkOpsWrite(`${P}/plan-records/.gitignore`, 'runtime-ignore').ok, true);
});

test("events/ is owned by 'event-log' (epicEventLog.cjs) and is a runtime namespace", () => {
  const { RUNTIME_NAMESPACES } = require('../opsOwnership.cjs');
  assert.equal(OWNERS.events, 'event-log');
  assert.ok(RUNTIME_NAMESPACES.includes('events'));
  assert.equal(checkOpsWrite(`${P}/events/epic-1/events.jsonl`, 'event-log').ok, true);
  assert.equal(checkOpsWrite(`${P}/events/epic-1/events.jsonl`, 'epics').ok, false);
  assert.equal(checkOpsWrite(`${P}/events/.gitignore`, 'runtime-ignore').ok, true);
});

test("agents/ is owned by 'agents' (agentSnapshot.cjs) and is a runtime namespace", () => {
  const { RUNTIME_NAMESPACES } = require('../opsOwnership.cjs');
  assert.equal(OWNERS.agents, 'agents');
  assert.ok(RUNTIME_NAMESPACES.includes('agents'));
  assert.equal(checkOpsWrite(`${P}/agents/snapshots/${'a'.repeat(64)}.json`, 'agents').ok, true);
  assert.equal(checkOpsWrite(`${P}/agents/snapshots/${'a'.repeat(64)}.json`, 'scheduler').ok, false);
  assert.equal(checkOpsWrite(`${P}/agents/.gitignore`, 'runtime-ignore').ok, true);
});

test("webhooks/ is owned by 'webhooks' (webhookRegistry.cjs) and is a runtime namespace", () => {
  const { RUNTIME_NAMESPACES } = require('../opsOwnership.cjs');
  assert.equal(OWNERS.webhooks, 'webhooks');
  assert.ok(RUNTIME_NAMESPACES.includes('webhooks'));
  assert.equal(checkOpsWrite(`${P}/webhooks/subscriptions.json`, 'webhooks').ok, true);
  assert.equal(checkOpsWrite(`${P}/webhooks/subscriptions.json`, 'event-log').ok, false);
  assert.equal(checkOpsWrite(`${P}/webhooks/.gitignore`, 'runtime-ignore').ok, true);
});

test("feedback-inbox/ is owned by 'feedback-inbox' and is a self-ignored runtime namespace", () => {
  const { RUNTIME_NAMESPACES, ensureRuntimeIgnores } = require('../opsOwnership.cjs');
  assert.equal(OWNERS['feedback-inbox'], 'feedback-inbox');
  assert.ok(RUNTIME_NAMESPACES.includes('feedback-inbox'));
  assert.equal(checkOpsWrite(`${P}/feedback-inbox/item-1.json`, 'feedback-inbox').ok, true);
  assert.equal(checkOpsWrite(`${P}/feedback-inbox/item-1.json`, 'scheduler').ok, false);
  assert.equal(checkOpsWrite(`${P}/feedback-inbox/.gitignore`, 'runtime-ignore').ok, true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-fbinbox-'));
  try {
    fs.mkdirSync(path.join(root, 'session-manager-operations', 'feedback-inbox'), { recursive: true });
    ensureRuntimeIgnores(root);
    const gi = path.join(root, 'session-manager-operations', 'feedback-inbox', '.gitignore');
    assert.equal(fs.readFileSync(gi, 'utf8').trim(), '*');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("artifacts/ is owned by 'artifacts' (artifactStore.cjs) and is a self-ignored runtime namespace", () => {
  const { RUNTIME_NAMESPACES, ensureRuntimeIgnores } = require('../opsOwnership.cjs');
  assert.equal(OWNERS.artifacts, 'artifacts');
  assert.ok(RUNTIME_NAMESPACES.includes('artifacts'));
  assert.equal(checkOpsWrite(`${P}/artifacts/epic-1/clip.mp4`, 'artifacts').ok, true);
  assert.equal(checkOpsWrite(`${P}/artifacts/_tasks/t1/index.json`, 'artifacts').ok, true);
  assert.equal(checkOpsWrite(`${P}/artifacts/epic-1/clip.mp4`, 'scheduler').ok, false);
  assert.equal(checkOpsWrite(`${P}/artifacts/.gitignore`, 'runtime-ignore').ok, true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-artifacts-'));
  try {
    fs.mkdirSync(path.join(root, 'session-manager-operations', 'artifacts'), { recursive: true });
    ensureRuntimeIgnores(root);
    const gi = path.join(root, 'session-manager-operations', 'artifacts', '.gitignore');
    assert.equal(fs.readFileSync(gi, 'utf8').trim(), '*');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The root .gitignore mirrors RUNTIME_NAMESPACES: each namespace's contents are
// ignored with its README kept tracked.
test('root .gitignore mirrors every runtime namespace', () => {
  const { RUNTIME_NAMESPACES } = require('../opsOwnership.cjs');
  const lines = fs.readFileSync(path.join(__dirname, '../../../../.gitignore'), 'utf8')
    .split('\n').map((l) => l.trim());
  for (const ns of RUNTIME_NAMESPACES) {
    assert.ok(lines.includes(`session-manager-operations/${ns}/*`), `${ns}/* missing`);
    assert.ok(lines.includes(`!session-manager-operations/${ns}/README.md`), `${ns} README unignore missing`);
  }
});

test("root .gitignore keeps this repo's retired feedback/ folder ignored", () => {
  const lines = fs.readFileSync(path.join(__dirname, '../../../../.gitignore'), 'utf8')
    .split('\n').map((l) => l.trim());
  assert.ok(lines.includes('session-manager-operations/feedback/'));
});

test('GIT_CLASS classifies every owned namespace; feedback/ belongs to the project', () => {
  const { GIT_CLASS, DELEGATIONS, RUNTIME_NAMESPACES } = require('../opsOwnership.cjs');
  for (const ns of RUNTIME_NAMESPACES) assert.ok(OWNERS[ns], `${ns} has no OWNERS entry`);
  for (const ns of Object.keys(OWNERS)) assert.ok(GIT_CLASS[ns], `${ns} has no GIT_CLASS entry`);
  for (const [ns, cls] of Object.entries(GIT_CLASS)) {
    assert.ok(cls === 'runtime' || cls === 'tracked', `${ns}: ${cls}`);
  }
  assert.ok(Object.isFrozen(GIT_CLASS));
  assert.deepEqual([...RUNTIME_NAMESPACES], [
    'scheduler', 'prompt-sessions', 'logs', 'ui-prefs', 'memory-clusters', 'tasks',
    'plan-records', 'events', 'agents', 'webhooks', 'feedback-inbox', 'artifacts',
  ]);
  for (const table of [GIT_CLASS, OWNERS, DELEGATIONS]) {
    assert.equal(Object.prototype.hasOwnProperty.call(table, 'feedback'), false);
  }
});

test('every declared owner is a non-empty string (table sanity)', () => {
  for (const [ns, owner] of Object.entries(OWNERS)) {
    assert.equal(typeof owner, 'string', `${ns} owner must be a string`);
    assert.ok(owner.length > 0, `${ns} owner must be non-empty`);
  }
});

// Integration: config.cjs must enforce the law on its real write path, not
// just expose it — a write with the wrong writer has to actually fail.
test('config.writeJson refuses an ops write from a non-owner', async () => {
  const config = require('../../config.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-law-'));
  config.addAllowedRoot(root);
  const target = path.join(root, 'session-manager-operations', 'project-brief', 'brief.json');

  await assert.rejects(() => config.writeJson(target, { a: 1 }, { writer: 'epics' }), /single-writer law/);
  await assert.rejects(() => config.writeJson(target, { a: 1 }), /did not declare a writer/);

  const res = await config.writeJson(target, { a: 1 }, { writer: 'project-home' });
  assert.equal(res.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).a, 1);

  fs.rmSync(root, { recursive: true, force: true });
});
