/**
 * promptSessionsCreateEpicHandler.test.cjs — unit tests for the
 * 'promptSessions:create-epic' IPC handler (lib/epic/promptSessionsCreateEpic.cjs),
 * PRD 953: an additive-only IPC channel letting the renderer mint an Epic
 * through main's own ensureEpic() instead of hand-constructing the
 * PromptSession record itself. Nothing in the app calls this yet.
 *
 * Exercises the handlers exactly as index.cjs wires them: the ones
 * registerPromptSessionsCreateEpicHandlers really registers, with Electron's
 * `ipcMain` stubbed through the require cache — schema validation
 * (ipcSchemas.cjs's `validated` wrapper) in front of the business logic. Also
 * covers 'promptSessions:list-restorable' and restoreSessionId (restore a
 * Claude Code CLI session as a new Epic).
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/promptSessionsCreateEpicHandler.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { schemas } = require('../ipcSchemas.cjs');
const {
  createEpicViaIpc,
  listRestorableViaIpc,
  registerPromptSessionsCreateEpicHandlers,
} = require('../lib/epic/promptSessionsCreateEpic.cjs');
const { readActiveIndex } = require('../lib/epic/epicMint.cjs');
const { listRestorableSessions } = require('../lib/epic/restorableSessions.cjs');
const { encodeCwd } = require('../lib/util/encodeCwd.cjs');
const { PromptSessionSchema } = require('../lib/promptSessionSchema.cjs');
const config = require('../config.cjs');

/**
 * Every channel registerPromptSessionsCreateEpicHandlers registers, by name.
 * The stub only lives for the register call; the prior cache entry is put back.
 * @returns {Map<string, Function>}
 */
function registeredHandlers() {
  const electronPath = require.resolve('electron');
  const prior = require.cache[electronPath];
  const handlers = new Map();
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } },
  };
  try {
    registerPromptSessionsCreateEpicHandlers();
  } finally {
    if (prior) require.cache[electronPath] = prior;
    else delete require.cache[electronPath];
  }
  return handlers;
}

const handlers = registeredHandlers();
const handler = handlers.get('promptSessions:create-epic');
const listRestorableHandler = handlers.get('promptSessions:list-restorable');

const tmpDirs = [];
/** HOME as it was before useTempHome() moved it; null when this test never moved it. */
let homeToRestore = null;
afterEach(async () => {
  if (homeToRestore) {
    if (homeToRestore.value === undefined) delete process.env.HOME;
    else process.env.HOME = homeToRestore.value;
    homeToRestore = null;
  }
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkCwd() {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-promptsessions-create-epic-'));
  config.addAllowedRoot(cwd);
  tmpDirs.push(cwd);
  // Project-overlay fixture so the 'architect' agentType used below resolves
  // via ensureEpic's write-time persona-existence check without depending on
  // the host's ~/.claude/agents/ (epicMint.cjs).
  const agentsDir = path.join(cwd, '.claude', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'architect.md'), '---\nname: architect\n---\nFixture persona for tests.\n');
  return cwd;
}

test('a valid request mints a new proposed Epic and returns a schema-valid session read back from disk', async () => {
  const cwd = await mkCwd();
  const result = await handler(null, {
    cwd,
    goalText: 'Ship the widget',
    tag: 'feature',
    agentType: 'architect',
    source: { producer: 'scheduler-dispatch' },
  });

  expect(result.epicId).toBeTruthy();
  expect(result.session.id).toBe(result.epicId);
  expect(result.session.status).toBe('proposed');
  expect(result.session.goalText).toBe('Ship the widget');
  expect(result.session.tag).toBe('feature');
  expect(result.session.agentType).toBe('architect');
  expect(result.session.source).toEqual({ producer: 'scheduler-dispatch' });

  // Response is the just-written record read back from disk, not a second
  // independently re-derived copy.
  const index = readActiveIndex(cwd);
  expect(index.sessions[result.epicId]).toEqual(result.session);

  const parsed = PromptSessionSchema.safeParse(result.session);
  expect(parsed.success).toBe(true);
});

test('a request with no tag/agentType/source still mints and validates cleanly', async () => {
  const cwd = await mkCwd();
  const result = await handler(null, { cwd, goalText: 'Minimal request' });

  expect(result.session.goalText).toBe('Minimal request');
  expect(PromptSessionSchema.safeParse(result.session).success).toBe(true);
});

// ipcSchemas.cjs's `validated` wrapper calls schema.parse synchronously
// before invoking the handler — a ZodError throws synchronously from the
// call itself (not a rejected promise), which is exactly the "rejected
// before ensureEpic ever runs" guarantee this test asserts.
test('a request missing cwd is rejected by ipcSchemas validation before ensureEpic ever runs', () => {
  expect(() => handler(null, { goalText: 'No cwd here' })).toThrow();
});

test('a request missing goalText is rejected by ipcSchemas validation before ensureEpic ever runs', async () => {
  const cwd = await mkCwd();
  expect(() => handler(null, { cwd })).toThrow();

  const index = readActiveIndex(cwd);
  expect(Object.keys(index.sessions)).toHaveLength(0);
});

test('an unknown tag value is rejected by ipcSchemas validation', () => {
  expect(() => handler(null, { cwd: '/tmp/whatever', goalText: 'x', tag: 'not-a-real-tag' })).toThrow();
});

test('an unknown source.producer value is rejected by ipcSchemas validation', () => {
  expect(() => handler(null, {
    cwd: '/tmp/whatever',
    goalText: 'x',
    source: { producer: 'bogus-producer' },
  })).toThrow();
});

// createEpicViaIpc's whole point is forceNewEpic: true — it must never join
// an existing Epic via ensureEpic's goalText-similarity join branch, even
// when called twice with the identical goalText for the same cwd.
test('two requests with identical goalText for the same cwd mint two distinct Epics, never joining', async () => {
  const cwd = await mkCwd();
  const first = await handler(null, { cwd, goalText: 'Same title both times' });
  const second = await handler(null, { cwd, goalText: 'Same title both times' });

  expect(first.epicId).not.toBe(second.epicId);
  const index = readActiveIndex(cwd);
  expect(index.sessions[first.epicId]).toBeDefined();
  expect(index.sessions[second.epicId]).toBeDefined();
});

// The renderer can send an arbitrary `cwd` string over IPC — config.cjs's
// validatePath (allowedRoots = home dir + every cwd a TAB has opened) is the
// boundary every other renderer-facing path IPC already passes through
// (config:read-json/write-json, lib/epic/activeIndexMerge.cjs's own merge); this
// handler must be gated by the same boundary rather than handing an
// unvalidated path straight to epicMint.cjs's raw `fs` writes.
test('a cwd outside every allowed root is rejected before anything is minted', async () => {
  const unregistered = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-promptsessions-create-epic-unregistered-'));
  tmpDirs.push(unregistered);

  await expect(handler(null, { cwd: unregistered, goalText: 'Should never mint' })).rejects.toThrow(
    /outside allowed boundaries/,
  );

  const index = readActiveIndex(unregistered);
  expect(Object.keys(index.sessions)).toHaveLength(0);
});

test('model/effort overrides persist on the minted Epic; without them the record gains no such keys', async () => {
  const cwd = await mkCwd();
  const payload = schemas.promptSessionsCreateEpic.parse({ cwd, goalText: 'Override run', agentType: 'architect', model: 'claude-opus-5', effort: 'max' });
  const withOverride = await createEpicViaIpc(cwd, payload);
  expect(withOverride.session).toMatchObject({ model: 'claude-opus-5', effort: 'max' });
  expect(readActiveIndex(cwd).sessions[withOverride.epicId]).toEqual(withOverride.session);
  expect(PromptSessionSchema.safeParse(withOverride.session).success).toBe(true);

  const plain = await createEpicViaIpc(cwd, schemas.promptSessionsCreateEpic.parse({ cwd, goalText: 'Plain run', agentType: 'architect' }));
  expect('model' in plain.session).toBe(false);
  expect('effort' in plain.session).toBe(false);
});

test('promptSessionsCreateEpic schema accepts developLoop false and rejects a string', () => {
  const base = { cwd: '/tmp/x', goalText: 'g', agentType: 'architect' };
  expect(schemas.promptSessionsCreateEpic.parse({ ...base, developLoop: false }).developLoop).toBe(false);
  expect(schemas.promptSessionsCreateEpic.safeParse({ ...base, developLoop: 'no' }).success).toBe(false);
});

test('developLoop false is forwarded and stored; true or omitted writes no key', async () => {
  const cwd = await mkCwd();
  const off = await createEpicViaIpc(cwd, { goalText: 'Loop off', agentType: 'architect', developLoop: false });
  expect(off.session.developLoop).toBe(false);
  expect(readActiveIndex(cwd).sessions[off.epicId].developLoop).toBe(false);
  const on = await createEpicViaIpc(cwd, { goalText: 'Loop on', agentType: 'architect', developLoop: true });
  expect('developLoop' in on.session).toBe(false);
  const none = await createEpicViaIpc(cwd, { goalText: 'Loop omitted', agentType: 'architect' });
  expect('developLoop' in none.session).toBe(false);
});

// ── Restore a Claude Code CLI session as a new Epic ─────────────────────────
// restoreSessionId rides 'promptSessions:create-epic' into ensureEpic, and
// 'promptSessions:list-restorable' lists the candidates. Neither IPC function
// takes deps, so a CLI transcript fixture is reached the way the app reaches
// it: through os.homedir(), pointed at a temp HOME for one test.

const RESTORE_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

/** Point HOME (os.homedir()) at a fresh temp dir; afterEach puts it back. */
async function useTempHome() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-promptsessions-home-'));
  tmpDirs.push(home);
  if (!homeToRestore) homeToRestore = { value: process.env.HOME };
  process.env.HOME = home;
  expect(os.homedir()).toBe(home);
  return home;
}

/** A CLI transcript for `sessionId`, recorded in `cwd`, as `claude` writes it. */
function writeCliTranscript(home, cwd, sessionId) {
  const dir = path.join(home, '.claude', 'projects', encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const rows = [
    { type: 'user', cwd, sessionId, entrypoint: 'cli', isSidechain: false, message: { role: 'user', content: 'pick up the refactor' } },
    { type: 'assistant', cwd, sessionId, entrypoint: 'cli', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] } },
  ];
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('the registered create-epic handler carries restoreSessionId into ensureEpic: the new Epic adopts that CLI session', async () => {
  const cwd = await mkCwd();
  writeCliTranscript(await useTempHome(), cwd, RESTORE_ID);

  const result = await handler(null, { cwd, goalText: 'Carry on the CLI refactor', restoreSessionId: RESTORE_ID });

  expect(result.session.claudeSessionId).toBe(RESTORE_ID);
  expect(result.session.restoredSession).toBe(true);
  expect(result.session.status).toBe('proposed');
  expect(readActiveIndex(cwd).sessions[result.epicId]).toEqual(result.session);
  expect(PromptSessionSchema.safeParse(result.session).success).toBe(true);
});

test('a restoreSessionId with no transcript is refused by ensureEpic, never swapped for a fresh session', async () => {
  const cwd = await mkCwd();
  await useTempHome();

  await expect(createEpicViaIpc(cwd, { goalText: 'Restore a ghost', restoreSessionId: RESTORE_ID }))
    .rejects.toThrow(/No CLI transcript for session/);
  expect(Object.keys(readActiveIndex(cwd).sessions)).toHaveLength(0);
});

test('a malformed restoreSessionId is rejected by ipcSchemas validation before ensureEpic ever runs', async () => {
  const cwd = await mkCwd();
  const bad = ['', 'not-a-uuid', '../../etc/passwd', `${RESTORE_ID}.jsonl`, `${RESTORE_ID}/x`, RESTORE_ID.replace(/-/g, ''), 42, null];
  for (const restoreSessionId of bad) {
    expect(schemas.promptSessionsCreateEpic.safeParse({ cwd, goalText: 'x', restoreSessionId }).success).toBe(false);
    expect(() => handler(null, { cwd, goalText: 'Bad restore id', restoreSessionId })).toThrow();
  }
  expect(Object.keys(readActiveIndex(cwd).sessions)).toHaveLength(0);
  // Well-formed ids pass (either case); ensureEpic's restore gate then decides.
  expect(schemas.promptSessionsCreateEpic.parse({ cwd, goalText: 'x', restoreSessionId: RESTORE_ID }).restoreSessionId).toBe(RESTORE_ID);
  expect(schemas.promptSessionsCreateEpic.safeParse({ cwd, goalText: 'x', restoreSessionId: RESTORE_ID.toUpperCase() }).success).toBe(true);
});

test('list-restorable payload is a strict { cwd }', () => {
  const s = schemas.promptSessionsListRestorable;
  expect(s.parse({ cwd: '/tmp/x' })).toEqual({ cwd: '/tmp/x' });
  expect(s.safeParse({}).success).toBe(false);
  expect(s.safeParse({ cwd: '' }).success).toBe(false);
  expect(s.safeParse({ cwd: '/'.repeat(4097) }).success).toBe(false);
  expect(s.safeParse({ cwd: '/tmp/x', limit: 5 }).success).toBe(false);
});

test('list-restorable rejects a cwd outside every allowed root', async () => {
  const unregistered = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-promptsessions-list-restorable-unregistered-'));
  tmpDirs.push(unregistered);
  expect(listRestorableHandler).toBeTypeOf('function');

  await expect(listRestorableHandler(null, { cwd: unregistered })).rejects.toThrow(/outside allowed boundaries/);
  await expect(listRestorableViaIpc(unregistered)).rejects.toThrow(/outside allowed boundaries/);
});

test('list-restorable returns listRestorableSessions\' result for an allowed project cwd', async () => {
  const cwd = await mkCwd();
  writeCliTranscript(await useTempHome(), cwd, RESTORE_ID);
  expect(listRestorableHandler).toBeTypeOf('function');

  const result = await listRestorableHandler(null, { cwd });

  expect(result.sessions.map((s) => s.sessionId)).toEqual([RESTORE_ID]);
  expect(result.sessions[0].firstPrompt).toBe('pick up the refactor');
  expect(result).toEqual(await listRestorableSessions({ cwd }));
});

// ── Agent CLI choice (New Session card) ─────────────────────────────────────
// agentCli/agentCliModel ride 'promptSessions:create-epic' into ensureEpic,
// which owns the Claude-only rules (non-Claude ⇒ developLoop false; no restore).

test('a codex create through the registered handler persists agentCli codex with developLoop false', async () => {
  const cwd = await mkCwd();
  const result = await handler(null, { cwd, goalText: 'Codex run', agentCli: 'codex', agentCliModel: 'gpt-5-codex' });
  expect(result.session.agentCli).toBe('codex');
  expect(result.session.agentCliModel).toBe('gpt-5-codex');
  expect(result.session.developLoop).toBe(false);
  expect(readActiveIndex(cwd).sessions[result.epicId]).toEqual(result.session);
  expect(PromptSessionSchema.safeParse(result.session).success).toBe(true);
});

test('an unknown agentCli or a malformed agentCliModel is rejected by ipcSchemas validation', async () => {
  const cwd = await mkCwd();
  const s = schemas.promptSessionsCreateEpic;
  expect(s.safeParse({ cwd, goalText: 'x', agentCli: 'copilot' }).success).toBe(false);
  expect(s.safeParse({ cwd, goalText: 'x', agentCli: 'codex', agentCliModel: '' }).success).toBe(false);
  expect(s.safeParse({ cwd, goalText: 'x', agentCli: 'codex', agentCliModel: 'm'.repeat(129) }).success).toBe(false);
  for (const id of ['claude', 'codex', 'gemini', 'antigravity', 'cursor', 'opencode']) {
    expect(s.parse({ cwd, goalText: 'x', agentCli: id }).agentCli).toBe(id);
  }
  expect(() => handler(null, { cwd, goalText: 'Bad cli', agentCli: 'copilot' })).toThrow();
  expect(Object.keys(readActiveIndex(cwd).sessions)).toHaveLength(0);
});

test('codex plus restoreSessionId comes back as the handler error result and mints nothing', async () => {
  const cwd = await mkCwd();
  writeCliTranscript(await useTempHome(), cwd, RESTORE_ID);
  await expect(handler(null, { cwd, goalText: 'Restore into codex', agentCli: 'codex', restoreSessionId: RESTORE_ID }))
    .rejects.toThrow(/Claude Code only/);
  expect(Object.keys(readActiveIndex(cwd).sessions)).toHaveLength(0);
});

test('omitting agentCli and agentCliModel leaves the minted record unchanged', async () => {
  const cwd = await mkCwd();
  const result = await handler(null, { cwd, goalText: 'Plain Claude run', agentType: 'architect' });
  expect('agentCli' in result.session).toBe(false);
  expect('agentCliModel' in result.session).toBe(false);
  expect('developLoop' in result.session).toBe(false);
  expect(result.session.status).toBe('proposed');
});
