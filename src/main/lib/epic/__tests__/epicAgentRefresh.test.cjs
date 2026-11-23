/**
 * epicAgentRefresh.test.cjs — ma-epic-agent-refresh-action: the explicit, audited refresh is the
 * only path a persona edit takes into an existing Epic. Changed persona → new agentSnapshotId +
 * one audit record; unchanged persona → no-op, no record; missing Epic → error.
 *
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/epicAgentRefresh.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ensureEpic, readActiveIndex, MINT_AUTHORITY_NEW_EPIC_UI } = require('../epicMint.cjs');
const { refreshEpicAgentSnapshot, AUDIT_KIND } = require('../epicAgentRefresh.cjs');
const { readAgentSnapshot } = require('../../claude/agentSnapshot.cjs');
const { epicMirrorPath } = require('../epicStatusMirror.cjs');

let cwd;
let persona;
let auditTarget;
beforeEach(() => {
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-agentrefresh-')));
  require('../../../config.cjs').addAllowedRoot(cwd);
  persona = `refresh-test-${crypto.randomUUID().slice(0, 8)}`;
  auditTarget = path.join(cwd, 'audit-log.jsonl');
});
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

function writePersona(model, body) {
  const dir = path.join(cwd, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${persona}.md`), `---\nname: ${persona}\ndescription: refresh test persona\nmodel: ${model}\n---\n${body}\n`);
}

const mint = () => ensureEpic(cwd, { mintAuthority: MINT_AUTHORITY_NEW_EPIC_UI, goalText: 'refresh test', agentType: persona });
const refresh = (epicId) => refreshEpicAgentSnapshot({ cwd, epicId, deps: { auditOpts: { target: auditTarget } } });
const auditRecords = () => (fs.existsSync(auditTarget)
  ? fs.readFileSync(auditTarget, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);

test('changed persona: new snapshot written, Epic re-stamped, one audit record', async () => {
  writePersona('opus', 'ORIGINAL BODY');
  const { epicId } = await mint();
  const from = readActiveIndex(cwd).sessions[epicId].agentSnapshotId;
  expect(from).toMatch(/^[0-9a-f]{64}$/);

  writePersona('haiku', 'EDITED BODY');
  const r = await refresh(epicId);
  expect(r.ok).toBe(true);
  expect(r.changed).toBe(true);
  expect(r.from).toBe(from);
  expect(r.to).not.toBe(from);

  const row = readActiveIndex(cwd).sessions[epicId];
  expect(row.agentSnapshotId).toBe(r.to);
  const mirror = JSON.parse(fs.readFileSync(epicMirrorPath(cwd, epicId), 'utf8'));
  expect(mirror.agentSnapshotId).toBe(r.to);
  const snap = await readAgentSnapshot(cwd, r.to);
  expect(snap.body).toContain('EDITED BODY');
  expect(snap.model).toBe('haiku');

  const recs = auditRecords().filter((x) => x.kind === AUDIT_KIND);
  expect(AUDIT_KIND).toBe('epic_agent_snapshot_updated');
  expect(recs).toHaveLength(1);
  expect(recs[0]).toMatchObject({ kind: 'epic_agent_snapshot_updated', epicId, from, to: r.to });
});

test('unchanged persona: no-op, same id, no audit record', async () => {
  writePersona('opus', 'BODY');
  const { epicId } = await mint();
  const before = readActiveIndex(cwd).sessions[epicId].agentSnapshotId;
  const r = await refresh(epicId);
  expect(r).toMatchObject({ ok: true, changed: false, from: before, to: before });
  expect(readActiveIndex(cwd).sessions[epicId].agentSnapshotId).toBe(before);
  expect(auditRecords().filter((x) => x.kind === AUDIT_KIND)).toHaveLength(0);
});

test('missing Epic: error, no audit record', async () => {
  const r = await refresh('no-such-epic-12345678');
  expect(r.ok).toBe(false);
  expect(r.code).toBe('not_found');
  expect(auditRecords()).toHaveLength(0);
});
