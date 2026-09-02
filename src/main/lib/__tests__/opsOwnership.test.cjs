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
