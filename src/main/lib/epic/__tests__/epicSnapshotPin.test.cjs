/**
 * epicSnapshotPin.test.cjs — ma-agent-snapshot-pin-epic: mint freezes the Epic's persona as an
 * AgentSnapshot and stamps agentSnapshotId; every later chat turn's plan builds its persona body
 * and --model from that snapshot, so a persona edit after mint reaches only NEW Epics. An Epic
 * with no agentSnapshotId keeps the live read; a persona refusal fails the mint with its code.
 *
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/epicSnapshotPin.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ensureEpic, readActiveIndex, writeActiveIndex, MINT_AUTHORITY_NEW_EPIC_UI } = require('../epicMint.cjs');
const { planEpicSpawn, resolveEpicTurnModel, __resetForTests } = require('../epicSpawnPlan.cjs');
const { readAgentSnapshot } = require('../../claude/agentSnapshot.cjs');
const { PromptSessionSchema } = require('../../promptSessionSchema.cjs');

let cwd;
let persona;
beforeEach(() => {
  __resetForTests();
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-snappin-')));
  // Unique name so no global ~/.claude/agents persona can merge into the project overlay.
  // Persona reads go through config.cjs's validatePath (allowed roots = home + opened TABs);
  // opening this temp project as a TAB is what makes its overlay readable, as in the app.
  require('../../../config.cjs').addAllowedRoot(cwd);
  persona = `pin-test-${crypto.randomUUID().slice(0, 8)}`;
});
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

function writePersona(model, body) {
  const dir = path.join(cwd, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const fm = model ? `name: ${persona}\ndescription: pin test persona\nmodel: ${model}\n` : `name: ${persona}\ndescription: pin test persona\n`;
  fs.writeFileSync(path.join(dir, `${persona}.md`), `---\n${fm}---\n${body}\n`);
}

const mint = (opts) => ensureEpic(cwd, { mintAuthority: MINT_AUTHORITY_NEW_EPIC_UI, goalText: 'pin test', ...opts });
const turnPlan = (sid) => planEpicSpawn({ cwd, claudeSessionId: sid, worktreeDirHint: cwd, deps: { homeDir: cwd } });

test('mint stamps agentSnapshotId and writes the snapshot for the agentType + packs', async () => {
  writePersona('opus', 'ORIGINAL BODY');
  const { epicId } = await mint({ agentType: persona });
  const epic = readActiveIndex(cwd).sessions[epicId];
  expect(epic.agentSnapshotId).toMatch(/^[0-9a-f]{64}$/);
  const snap = await readAgentSnapshot(cwd, epic.agentSnapshotId);
  expect(snap).not.toBeNull();
  expect(snap.name).toBe(persona);
  expect(snap.model).toBe('opus');
  expect(snap.body).toContain('ORIGINAL BODY');
  expect(snap.packs).toEqual([]);
});

test('a persona edit after mint does not reach the next turn: plan uses the pinned body + model', async () => {
  writePersona('opus', 'ORIGINAL BODY');
  const { epicId } = await mint({ agentType: persona });
  const epic = readActiveIndex(cwd).sessions[epicId];

  writePersona('haiku', 'EDITED BODY');

  const plan = turnPlan(epic.claudeSessionId);
  expect(plan.ok).toBe(true);
  expect(plan.persona.source).toBe('snapshot');
  expect(plan.persona.agentSnapshotId).toBe(epic.agentSnapshotId);
  expect(plan.persona.body).toContain('ORIGINAL BODY');
  expect(plan.persona.body).not.toContain('EDITED BODY');
  expect(plan.persona.model).toBe('opus');
  expect(resolveEpicTurnModel({ cwd, claudeSessionId: epic.claudeSessionId })).toBe('opus');

  // A NEW Epic minted after the edit pins the edited persona.
  const secondId = (await mint({ agentType: persona, goalText: 'second' })).epicId;
  const second = readActiveIndex(cwd).sessions[secondId];
  expect(second.agentSnapshotId).not.toBe(epic.agentSnapshotId);
  const plan2 = turnPlan(second.claudeSessionId);
  expect(plan2.persona.body).toContain('EDITED BODY');
  expect(plan2.persona.model).toBe('haiku');
});

test("the Epic's own model override still beats the pinned model", async () => {
  writePersona('opus', 'BODY');
  const { epicId } = await mint({ agentType: persona, model: 'sonnet' });
  const epic = readActiveIndex(cwd).sessions[epicId];
  expect(turnPlan(epic.claudeSessionId).persona.model).toBe('sonnet');
});

test('an Epic without agentSnapshotId keeps the live persona read', async () => {
  writePersona('opus', 'BODY');
  const { epicId } = await mint({ agentType: persona });
  const index = readActiveIndex(cwd);
  delete index.sessions[epicId].agentSnapshotId; // a pre-pinning Epic
  writeActiveIndex(cwd, index);
  writePersona('haiku', 'EDITED BODY');

  const plan = turnPlan(index.sessions[epicId].claudeSessionId);
  expect(plan.ok).toBe(true);
  expect(plan.persona.source).toBe('live');
  expect(plan.persona.agentSnapshotId).toBeNull();
  expect(plan.persona.model).toBe('haiku');
});

test('a missing snapshot file falls back to the live read and says so', async () => {
  writePersona('opus', 'BODY');
  const { epicId } = await mint({ agentType: persona });
  const epic = readActiveIndex(cwd).sessions[epicId];
  fs.rmSync(path.join(cwd, 'session-manager-operations', 'agents', 'snapshots', `${epic.agentSnapshotId}.json`));
  writePersona('haiku', 'EDITED');
  const plan = turnPlan(epic.claudeSessionId);
  expect(plan.persona.source).toBe('live');
  expect(plan.persona.snapshotMissing).toBe(true);
  expect(plan.persona.model).toBe('haiku');
});

test('an agentType-less Epic is not pinned', async () => {
  const { epicId } = await mint({});
  expect(readActiveIndex(cwd).sessions[epicId].agentSnapshotId).toBeUndefined();
});

test('a persona refusal fails the mint with the refusal code and writes no Epic', async () => {
  writePersona(null, 'BODY WITHOUT MODEL');
  await expect(mint({ agentType: persona })).rejects.toMatchObject({ code: 'persona_invalid' });
  await expect(mint({ agentType: persona })).rejects.toThrow(/persona_invalid/);
  expect(Object.keys(readActiveIndex(cwd).sessions)).toHaveLength(0);
});

test('schema: agentSnapshotId is optional', () => {
  const base = { id: 'e', cwd: '/x', goalText: 'g', claudeSessionId: 's', status: 'proposed', createdAt: 'now', completedAt: null };
  expect(PromptSessionSchema.safeParse(base).success).toBe(true);
  expect(PromptSessionSchema.safeParse({ ...base, agentSnapshotId: 'a'.repeat(64) }).success).toBe(true);
  expect(PromptSessionSchema.safeParse({ ...base, agentSnapshotId: 7 }).success).toBe(false);
});
