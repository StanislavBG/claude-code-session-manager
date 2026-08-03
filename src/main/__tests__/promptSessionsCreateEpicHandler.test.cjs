/**
 * promptSessionsCreateEpicHandler.test.cjs — unit tests for the
 * 'promptSessions:create-epic' IPC handler (lib/promptSessionsCreateEpic.cjs),
 * PRD 953: an additive-only IPC channel letting the renderer mint an Epic
 * through main's own ensureEpic() instead of hand-constructing the
 * PromptSession record itself. Nothing in the app calls this yet.
 *
 * Exercises the handler the same way index.cjs wires it — schema validation
 * (ipcSchemas.cjs's `validated` wrapper) in front of the business logic —
 * without touching Electron's `ipcMain`, mirroring activeIndexMerge.test.cjs's
 * pattern of testing the underlying function directly.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/promptSessionsCreateEpicHandler.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { schemas, validated } = require('../ipcSchemas.cjs');
const { createEpicViaIpc } = require('../lib/promptSessionsCreateEpic.cjs');
const { readActiveIndex } = require('../lib/epicMint.cjs');
const { PromptSessionSchema } = require('../lib/promptSessionSchema.cjs');
const config = require('../config.cjs');

const handler = validated(schemas.promptSessionsCreateEpic, ({ cwd, goalText, tag, agentType, source }) =>
  createEpicViaIpc(cwd, { goalText, tag, agentType, source }));

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkCwd() {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-promptsessions-create-epic-'));
  config.addAllowedRoot(cwd);
  tmpDirs.push(cwd);
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
// (config:read-json/write-json, lib/activeIndexMerge.cjs's own merge); this
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
