/**
 * epicMint.test.cjs — unit tests for ensureEpic's sourcePromptId join
 * semantics (see PRD authoring notes: sourcePromptId must be an existing
 * Epic's promptSessionId, i.e. its active-index.json sessions key — NOT a
 * PromptTicket.id).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/epicMint.test.cjs
 */

'use strict';

import { test, expect, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ensureEpic, removeEpic, readActiveIndex, findJoinableEpic } = require('../lib/epicMint.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkCwd() {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-epicmint-cwd-'));
  tmpDirs.push(cwd);
  return cwd;
}

test('ensureEpic mints a new Epic when explicit epicId matches no existing Epic (documents current behavior for a stray PromptTicket.id)', async () => {
  const cwd = await mkCwd();
  const notAPromptSessionId = 'ticket-abc123';

  const result = await ensureEpic(cwd, { goalText: 'do the thing', epicId: notAPromptSessionId });

  expect(result.created).toBe(true);
  expect(result.epicId).not.toBe(notAPromptSessionId);

  const index = readActiveIndex(cwd);
  expect(index.sessions[notAPromptSessionId]).toBeUndefined();
  expect(index.sessions[result.epicId]).toBeDefined();
  expect(Object.keys(index.sessions)).toHaveLength(1);
});

test('ensureEpic joins the existing Epic when explicit epicId equals its promptSessionId', async () => {
  const cwd = await mkCwd();

  const first = await ensureEpic(cwd, { goalText: 'initial epic goal' });
  expect(first.created).toBe(true);

  const second = await ensureEpic(cwd, { goalText: 'a different PRD title', epicId: first.epicId });

  expect(second.created).toBe(false);
  expect(second.epicId).toBe(first.epicId);
  expect(second.prdDir).toBe(first.prdDir);

  const index = readActiveIndex(cwd);
  expect(Object.keys(index.sessions)).toHaveLength(1);
});

test('removeEpic deletes a minted Epic from both sessions and events maps', async () => {
  const cwd = await mkCwd();
  const minted = await ensureEpic(cwd, { goalText: 'to be rolled back' });
  expect(readActiveIndex(cwd).sessions[minted.epicId]).toBeDefined();

  const removed = await removeEpic(cwd, minted.epicId);

  expect(removed).toBe(true);
  const index = readActiveIndex(cwd);
  expect(index.sessions[minted.epicId]).toBeUndefined();
  expect(index.events[minted.epicId]).toBeUndefined();
});

test('removeEpic is a no-op (returns false) for an unknown epicId', async () => {
  const cwd = await mkCwd();
  await ensureEpic(cwd, { goalText: 'unrelated epic' });

  const removed = await removeEpic(cwd, 'nonexistent-epic-id');

  expect(removed).toBe(false);
  expect(Object.keys(readActiveIndex(cwd).sessions)).toHaveLength(1);
});

// A plain object's bracket lookup with a prototype-chain key like
// "__proto__"/"constructor" returns a truthy Object.prototype member even
// when no such Epic was ever written — without an own-property check, this
// would make mintIfMissing:false's "join an existing Epic" gate falsely
// report a match, defeating the restriction that a PRD write may only join
// a real, already-approved Epic.
for (const pollutedKey of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
  test(`ensureEpic refuses to "join" the prototype-chain key "${pollutedKey}" (mintIfMissing:false)`, async () => {
    const cwd = await mkCwd();

    await expect(
      ensureEpic(cwd, { epicId: pollutedKey, mintIfMissing: false }),
    ).rejects.toThrow(/no existing Epic found/);

    const index = readActiveIndex(cwd);
    expect(Object.keys(index.sessions)).toHaveLength(0);
  });
}

test('removeEpic refuses to report success for the prototype-chain key "__proto__"', async () => {
  const cwd = await mkCwd();
  const removed = await removeEpic(cwd, '__proto__');
  expect(removed).toBe(false);
});

test('ensureEpic persists the passed source onto the written active-index.json session record', async () => {
  const cwd = await mkCwd();
  const source = { producer: 'rca-hook', prdSlug: 'x', runId: 'y' };

  const minted = await ensureEpic(cwd, { goalText: 'auto-filed epic', source });

  const index = readActiveIndex(cwd);
  expect(index.sessions[minted.epicId].source).toEqual(source);
});

test('ensureEpic omits source from the written record when not passed', async () => {
  const cwd = await mkCwd();

  const minted = await ensureEpic(cwd, { goalText: 'human-filed epic' });

  const index = readActiveIndex(cwd);
  expect('source' in index.sessions[minted.epicId]).toBe(false);
});

test('ensureEpic joins an existing open Epic when goalText is a near-identical paraphrase (no preferEpicId)', async () => {
  const cwd = await mkCwd();

  const first = await ensureEpic(cwd, { goalText: 'Fix the login button color' });
  expect(first.created).toBe(true);

  const second = await ensureEpic(cwd, { goalText: 'Fix login button colour issue' });

  expect(second.created).toBe(false);
  expect(second.epicId).toBe(first.epicId);

  const index = readActiveIndex(cwd);
  expect(Object.keys(index.sessions)).toHaveLength(1);
});

test('ensureEpic mints a distinct Epic when goalText is genuinely unrelated', async () => {
  const cwd = await mkCwd();

  const first = await ensureEpic(cwd, { goalText: 'Fix the login button color' });
  expect(first.created).toBe(true);

  const second = await ensureEpic(cwd, { goalText: 'Add CSV export to History tab' });

  expect(second.created).toBe(true);
  expect(second.epicId).not.toBe(first.epicId);

  const index = readActiveIndex(cwd);
  expect(Object.keys(index.sessions)).toHaveLength(2);
});

test('findJoinableEpic joins the preferEpicId Epic even when goalText similarity is near-zero', async () => {
  const cwd = await mkCwd();

  const first = await ensureEpic(cwd, { goalText: 'Fix the login button color' });
  expect(first.created).toBe(true);

  const joined = findJoinableEpic(cwd, {
    goalText: 'Completely unrelated topic about database migrations',
    preferEpicId: first.epicId,
  });

  expect(joined).toEqual({ epicId: first.epicId, matchedBy: 'preferEpicId' });
});

test('findJoinableEpic falls through to the similarity check when preferEpicId points at a completed Epic', async () => {
  const cwd = await mkCwd();

  const first = await ensureEpic(cwd, { goalText: 'Fix the login button color' });
  const index = readActiveIndex(cwd);
  index.sessions[first.epicId].status = 'completed';
  fs.writeFileSync(
    path.join(cwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json'),
    JSON.stringify(index, null, 2),
  );

  // No other open Epic shares tokens with the completed one, so the
  // fall-through similarity check finds nothing rather than joining the
  // dead (completed) preferEpicId Epic.
  const joined = findJoinableEpic(cwd, { goalText: 'Fix login button colour issue', preferEpicId: first.epicId });

  expect(joined).toBeNull();
});

test('findJoinableEpic falls through to the similarity check when preferEpicId points at a nonexistent Epic, and can still find a match there', async () => {
  const cwd = await mkCwd();
  const sibling = await ensureEpic(cwd, { goalText: 'Fix the login button color' });

  const joined = findJoinableEpic(cwd, { goalText: 'Fix login button colour issue', preferEpicId: 'nonexistent-epic-id' });

  expect(joined).toEqual({ epicId: sibling.epicId, matchedBy: 'similarity', score: expect.any(Number) });
});

test('ensureEpic mints with status "proposed" by default', async () => {
  const cwd = await mkCwd();

  const minted = await ensureEpic(cwd, { goalText: 'default status epic' });

  const index = readActiveIndex(cwd);
  expect(index.sessions[minted.epicId].status).toBe('proposed');
});

test('ensureEpic throws when a mint is requested with status "active" (born-proposed law), and appends an audit event', async () => {
  const cwd = await mkCwd();
  const auditLog = require('../lib/auditLog.cjs');

  await expect(
    ensureEpic(cwd, { goalText: 'should never mint active', status: 'active' }),
  ).rejects.toThrow(/born 'proposed'/);

  const index = readActiveIndex(cwd);
  expect(Object.keys(index.sessions)).toHaveLength(0);

  const records = fs.readFileSync(auditLog.AUDIT_LOG_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((r) => r.cwd === cwd);
  expect(records).toHaveLength(1);
  expect(records[0].kind).toBe('epic_mint_refused');
  expect(records[0].status).toBe('active');
});

test('ensureEpic still joins an existing active Epic via preferEpicId even when status:"active" is requested', async () => {
  const cwd = await mkCwd();
  const first = await ensureEpic(cwd, { goalText: 'already running epic' });
  const index = readActiveIndex(cwd);
  index.sessions[first.epicId].status = 'active';
  fs.writeFileSync(
    path.join(cwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json'),
    JSON.stringify(index, null, 2),
  );

  const second = await ensureEpic(cwd, { goalText: 'unrelated text', epicId: first.epicId, status: 'active' });

  expect(second.created).toBe(false);
  expect(second.epicId).toBe(first.epicId);
});

test('ensureEpic falls through to a "proposed" mint when explicit epicId is archived/completed, never throwing', async () => {
  const cwd = await mkCwd();
  const first = await ensureEpic(cwd, { goalText: 'completed epic' });
  const index = readActiveIndex(cwd);
  index.sessions[first.epicId].status = 'completed';
  fs.writeFileSync(
    path.join(cwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json'),
    JSON.stringify(index, null, 2),
  );

  const second = await ensureEpic(cwd, { goalText: 'totally unrelated goal text here', epicId: first.epicId });

  expect(second.created).toBe(true);
  expect(second.epicId).not.toBe(first.epicId);
  const after = readActiveIndex(cwd);
  expect(after.sessions[second.epicId].status).toBe('proposed');
});

function readAuditRecordsForCwd(auditLog, cwd) {
  if (!fs.existsSync(auditLog.AUDIT_LOG_PATH)) return [];
  return fs.readFileSync(auditLog.AUDIT_LOG_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((record) => record && record.cwd === cwd);
}

test('mintIfMissing:false refusal appends an epic_mint_refused audit event', async () => {
  const cwd = await mkCwd();
  const auditLog = require('../lib/auditLog.cjs');

  await expect(ensureEpic(cwd, { goalText: 'no epic yet', mintIfMissing: false })).rejects.toThrow();

  const records = readAuditRecordsForCwd(auditLog, cwd);
  expect(records).toHaveLength(1);
  expect(records[0].kind).toBe('epic_mint_refused');
  expect(records[0].cwd).toBe(cwd);
});

test('not-open explicit-epicId fall-through appends an epic_mint_refused audit event', async () => {
  const cwd = await mkCwd();
  const first = await ensureEpic(cwd, { goalText: 'to be completed' });
  const index = readActiveIndex(cwd);
  index.sessions[first.epicId].status = 'completed';
  fs.writeFileSync(
    path.join(cwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json'),
    JSON.stringify(index, null, 2),
  );
  const auditLog = require('../lib/auditLog.cjs');

  await ensureEpic(cwd, { goalText: 'unrelated fresh goal xyz', epicId: first.epicId });

  const records = readAuditRecordsForCwd(auditLog, cwd);
  const refusal = records.find((r) => r.kind === 'epic_mint_refused');
  expect(refusal).toBeDefined();
  expect(refusal.epicId).toBe(first.epicId);
});

test('ensureEpic with forceNewEpic:true mints even when a near-identical open Epic exists', async () => {
  const cwd = await mkCwd();

  const first = await ensureEpic(cwd, { goalText: 'Fix the login button color' });
  expect(first.created).toBe(true);

  const second = await ensureEpic(cwd, { goalText: 'Fix login button colour issue', forceNewEpic: true });

  expect(second.created).toBe(true);
  expect(second.epicId).not.toBe(first.epicId);

  const index = readActiveIndex(cwd);
  expect(Object.keys(index.sessions)).toHaveLength(2);
});

test('ensureEpic mints successfully for a real-world call shape carrying tag, openingPrompt, and source (schema validation does not reject valid records)', async () => {
  const cwd = await mkCwd();

  const minted = await ensureEpic(cwd, {
    goalText: 'RCA-filed proposal',
    tag: 'bug',
    openingPrompt: 'full RCA body text',
    source: { producer: 'rca-hook', runId: 'run-42' },
  });

  expect(minted.created).toBe(true);
  const index = readActiveIndex(cwd);
  const session = index.sessions[minted.epicId];
  expect(session.tag).toBe('bug');
  expect(session.openingPrompt).toBe('full RCA body text');
  expect(session.source).toEqual({ producer: 'rca-hook', runId: 'run-42' });
});

test('ensureEpic refuses the mint and appends an epic_mint_refused audit event when the constructed session object fails schema validation', async () => {
  const cwd = await mkCwd();
  const auditLog = require('../lib/auditLog.cjs');
  const schema = require('../lib/promptSessionSchema.cjs');

  // The real construction in ensureEpic is hardcoded and always produces a
  // valid PromptSession, so to exercise the fail-closed wiring we simulate
  // a corrupted construction by monkeypatching the schema module's exported
  // validator in place — epicMint.cjs reads `schema.assertValidPromptSession`
  // off the same exports object at call time (property lookup, not a
  // destructured copy), so mutating it here is visible to ensureEpic.
  const original = schema.assertValidPromptSession;
  schema.assertValidPromptSession = () => {
    throw new Error('assertValidPromptSession: invalid PromptSession shape — forced test failure');
  };
  try {
    await expect(
      ensureEpic(cwd, { goalText: 'should be refused by schema validation' }),
    ).rejects.toThrow(/forced test failure/);
  } finally {
    schema.assertValidPromptSession = original;
  }

  const index = readActiveIndex(cwd);
  expect(Object.keys(index.sessions)).toHaveLength(0);

  const records = fs.readFileSync(auditLog.AUDIT_LOG_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((r) => r.cwd === cwd);
  expect(records).toHaveLength(1);
  expect(records[0].kind).toBe('epic_mint_refused');
  expect(records[0].reason).toMatch(/forced test failure/);
});
