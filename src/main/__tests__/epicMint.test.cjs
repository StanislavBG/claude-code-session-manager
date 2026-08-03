/**
 * epicMint.test.cjs — unit tests for ensureEpic's two behaviors: JOIN (every
 * automated caller, by explicit epicId) and MINT (the New Epic UI alone, via
 * mintAuthority — epicMint.cjs's SINGLE-CREATOR LAW).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/epicMint.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ensureEpic, removeEpic, readActiveIndex, MINT_AUTHORITY_NEW_EPIC_UI } = require('../lib/epicMint.cjs');

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

/** The New Epic UI's call shape — the only caller allowed to mint. */
function mint(cwd, opts = {}) {
  return ensureEpic(cwd, { mintAuthority: MINT_AUTHORITY_NEW_EPIC_UI, ...opts });
}

function writeIndex(cwd, index) {
  fs.writeFileSync(
    path.join(cwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json'),
    JSON.stringify(index, null, 2),
  );
}

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

// ─── SINGLE-CREATOR LAW ──────────────────────────────────────────────────────

test('ensureEpic refuses to mint without mintAuthority, and appends an epic_mint_refused audit event', async () => {
  const cwd = await mkCwd();
  const auditLog = require('../lib/auditLog.cjs');

  await expect(ensureEpic(cwd, { goalText: 'agent wants work done' }))
    .rejects.toThrow(/no open Epic to join/);

  expect(Object.keys(readActiveIndex(cwd).sessions)).toHaveLength(0);
  const records = readAuditRecordsForCwd(auditLog, cwd);
  expect(records).toHaveLength(1);
  expect(records[0].kind).toBe('epic_mint_refused');
});

test('ensureEpic refuses to mint when mintAuthority is a wrong/guessed value', async () => {
  const cwd = await mkCwd();

  await expect(ensureEpic(cwd, { goalText: 'sneaky', mintAuthority: 'agent' }))
    .rejects.toThrow(/no open Epic to join/);

  expect(Object.keys(readActiveIndex(cwd).sessions)).toHaveLength(0);
});

test('ensureEpic mints when the New Epic UI presents mintAuthority', async () => {
  const cwd = await mkCwd();

  const minted = await mint(cwd, { goalText: 'human-created epic' });

  expect(minted.created).toBe(true);
  const index = readActiveIndex(cwd);
  expect(index.sessions[minted.epicId].status).toBe('proposed');
  expect(index.events[minted.epicId]).toHaveLength(1);
});

test('a mint never joins a near-identical open Epic — the human asked for a new one', async () => {
  const cwd = await mkCwd();

  const first = await mint(cwd, { goalText: 'Fix the login button color' });
  const second = await mint(cwd, { goalText: 'Fix login button colour issue' });

  expect(second.created).toBe(true);
  expect(second.epicId).not.toBe(first.epicId);
  expect(Object.keys(readActiveIndex(cwd).sessions)).toHaveLength(2);
});

// ─── JOIN ────────────────────────────────────────────────────────────────────

test('ensureEpic joins the existing Epic when explicit epicId equals its promptSessionId', async () => {
  const cwd = await mkCwd();

  const first = await mint(cwd, { goalText: 'initial epic goal' });
  const second = await ensureEpic(cwd, { goalText: 'a different PRD title', epicId: first.epicId });

  expect(second.created).toBe(false);
  expect(second.epicId).toBe(first.epicId);
  expect(second.prdDir).toBe(first.prdDir);
  expect(Object.keys(readActiveIndex(cwd).sessions)).toHaveLength(1);
});

test('ensureEpic joins an already-active Epic via explicit epicId', async () => {
  const cwd = await mkCwd();
  const first = await mint(cwd, { goalText: 'already running epic' });
  const index = readActiveIndex(cwd);
  index.sessions[first.epicId].status = 'active';
  writeIndex(cwd, index);

  const second = await ensureEpic(cwd, { goalText: 'unrelated text', epicId: first.epicId });

  expect(second.created).toBe(false);
  expect(second.epicId).toBe(first.epicId);
});

test('ensureEpic refuses to join a completed Epic and does NOT mint a replacement', async () => {
  const cwd = await mkCwd();
  const first = await mint(cwd, { goalText: 'completed epic' });
  const index = readActiveIndex(cwd);
  index.sessions[first.epicId].status = 'completed';
  writeIndex(cwd, index);
  const auditLog = require('../lib/auditLog.cjs');

  await expect(ensureEpic(cwd, { goalText: 'follow-up work', epicId: first.epicId }))
    .rejects.toThrow(/no open Epic to join/);

  expect(Object.keys(readActiveIndex(cwd).sessions)).toHaveLength(1);
  const refusal = readAuditRecordsForCwd(auditLog, cwd).find((r) => r.kind === 'epic_mint_refused');
  expect(refusal).toBeDefined();
});

test('ensureEpic refuses an unknown explicit epicId rather than minting a sibling', async () => {
  const cwd = await mkCwd();

  await expect(ensureEpic(cwd, { goalText: 'do the thing', epicId: 'ticket-abc123' }))
    .rejects.toThrow(/no open Epic to join/);

  expect(Object.keys(readActiveIndex(cwd).sessions)).toHaveLength(0);
});

// A plain object's bracket lookup with a prototype-chain key like
// "__proto__"/"constructor" returns a truthy Object.prototype member even
// when no such Epic was ever written — without an own-property check, this
// would make the join gate falsely report a match.
for (const pollutedKey of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
  test(`ensureEpic refuses to "join" the prototype-chain key "${pollutedKey}"`, async () => {
    const cwd = await mkCwd();

    await expect(ensureEpic(cwd, { epicId: pollutedKey })).rejects.toThrow(/no open Epic to join/);

    expect(Object.keys(readActiveIndex(cwd).sessions)).toHaveLength(0);
  });
}

// ─── removeEpic ──────────────────────────────────────────────────────────────

test('removeEpic deletes a minted Epic from both sessions and events maps', async () => {
  const cwd = await mkCwd();
  const minted = await mint(cwd, { goalText: 'to be rolled back' });

  const removed = await removeEpic(cwd, minted.epicId);

  expect(removed).toBe(true);
  const index = readActiveIndex(cwd);
  expect(index.sessions[minted.epicId]).toBeUndefined();
  expect(index.events[minted.epicId]).toBeUndefined();
});

test('removeEpic is a no-op (returns false) for an unknown epicId', async () => {
  const cwd = await mkCwd();
  await mint(cwd, { goalText: 'unrelated epic' });

  expect(await removeEpic(cwd, 'nonexistent-epic-id')).toBe(false);
  expect(Object.keys(readActiveIndex(cwd).sessions)).toHaveLength(1);
});

test('removeEpic refuses to report success for the prototype-chain key "__proto__"', async () => {
  const cwd = await mkCwd();
  expect(await removeEpic(cwd, '__proto__')).toBe(false);
});

// ─── written record ──────────────────────────────────────────────────────────

test('ensureEpic persists the passed source onto the written active-index.json session record', async () => {
  const cwd = await mkCwd();
  const source = { producer: 'new-epic-ui' };

  const minted = await mint(cwd, { goalText: 'epic with source', source });

  expect(readActiveIndex(cwd).sessions[minted.epicId].source).toEqual(source);
});

test('ensureEpic omits source from the written record when not passed', async () => {
  const cwd = await mkCwd();

  const minted = await mint(cwd, { goalText: 'sourceless epic' });

  expect('source' in readActiveIndex(cwd).sessions[minted.epicId]).toBe(false);
});

test('ensureEpic mints successfully for a real-world call shape carrying tag, openingPrompt, and source', async () => {
  const cwd = await mkCwd();

  const minted = await mint(cwd, {
    goalText: 'Fix the merge validation',
    tag: 'bug',
    openingPrompt: 'full opening prompt text',
    source: { producer: 'new-epic-ui' },
  });

  const session = readActiveIndex(cwd).sessions[minted.epicId];
  expect(session.tag).toBe('bug');
  expect(session.openingPrompt).toBe('full opening prompt text');
  expect(session.source).toEqual({ producer: 'new-epic-ui' });
});

// ─── BORN-PROPOSED LAW ───────────────────────────────────────────────────────

test('ensureEpic mints with status "proposed" by default', async () => {
  const cwd = await mkCwd();

  const minted = await mint(cwd, { goalText: 'default status epic' });

  expect(readActiveIndex(cwd).sessions[minted.epicId].status).toBe('proposed');
});

test('ensureEpic throws when a mint is requested with status "active", and appends an audit event', async () => {
  const cwd = await mkCwd();
  const auditLog = require('../lib/auditLog.cjs');

  await expect(mint(cwd, { goalText: 'should never mint active', status: 'active' }))
    .rejects.toThrow(/born 'proposed'/);

  expect(Object.keys(readActiveIndex(cwd).sessions)).toHaveLength(0);
  const records = readAuditRecordsForCwd(auditLog, cwd);
  expect(records).toHaveLength(1);
  expect(records[0].kind).toBe('epic_mint_refused');
  expect(records[0].status).toBe('active');
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
    await expect(mint(cwd, { goalText: 'should be refused by schema validation' }))
      .rejects.toThrow(/forced test failure/);
  } finally {
    schema.assertValidPromptSession = original;
  }

  expect(Object.keys(readActiveIndex(cwd).sessions)).toHaveLength(0);
  const records = readAuditRecordsForCwd(auditLog, cwd);
  expect(records).toHaveLength(1);
  expect(records[0].kind).toBe('epic_mint_refused');
  expect(records[0].reason).toMatch(/forced test failure/);
});
