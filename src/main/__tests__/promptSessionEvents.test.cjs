/**
 * promptSessionEvents.test.cjs — unit tests for appendResponseEventIfKnown
 * (PRD 814): the scheduler's main-process counterpart to promptSessions.ts's
 * event chain, used to route a PRD-finished notification into a known
 * PromptSession's own event chain instead of an unrelated tab.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/promptSessionEvents.test.cjs
 */

'use strict';

import { test, expect, beforeEach, vi } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../config.cjs');
const {
  appendResponseEventIfKnown,
  promptSessionActiveIndexPath,
  attachWindow,
  EVENT_APPENDED_CHANNEL,
} = require('../promptSessionEvents.cjs');

let cwd;

beforeEach(async () => {
  cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prompt-session-events-'));
  config.addAllowedRoot(cwd);
});

async function writeIndex(index) {
  const indexPath = promptSessionActiveIndexPath(cwd);
  await fsp.mkdir(path.dirname(indexPath), { recursive: true });
  await fsp.writeFile(indexPath, JSON.stringify(index, null, 2));
}

test('returns false when no active-index.json exists for the cwd', async () => {
  const routed = await appendResponseEventIfKnown(cwd, 'psess-unknown', 'hi');
  expect(routed).toBe(false);
});

test('returns false when the sourcePromptId is not in the index', async () => {
  await writeIndex({ sessions: {}, events: {} });
  const routed = await appendResponseEventIfKnown(cwd, 'psess-unknown', 'hi');
  expect(routed).toBe(false);
});

test('returns false when the session is completed (no longer active)', async () => {
  await writeIndex({
    sessions: { 'psess-1': { id: 'psess-1', cwd, status: 'completed' } },
    events: { 'psess-1': [{ id: 'pevt-1', promptSessionId: 'psess-1', kind: 'prompt', causedByEventId: null, at: '2026-01-01T00:00:00.000Z' }] },
  });
  const routed = await appendResponseEventIfKnown(cwd, 'psess-1', 'hi');
  expect(routed).toBe(false);
});

test('appends a response event chained to the current tail and returns true', async () => {
  await writeIndex({
    sessions: { 'psess-1': { id: 'psess-1', cwd, status: 'active' } },
    events: {
      'psess-1': [
        { id: 'pevt-1', promptSessionId: 'psess-1', kind: 'prompt', causedByEventId: null, at: '2026-01-01T00:00:00.000Z' },
        { id: 'pevt-2', promptSessionId: 'psess-1', kind: 'prd_created', causedByEventId: 'pevt-1', at: '2026-01-01T00:01:00.000Z', prdSlug: '814-foo' },
      ],
    },
  });

  const routed = await appendResponseEventIfKnown(cwd, 'psess-1', 'PRD 814-foo finished: completed.');
  expect(routed).toBe(true);

  const onDisk = JSON.parse(await fsp.readFile(promptSessionActiveIndexPath(cwd), 'utf8'));
  const events = onDisk.events['psess-1'];
  expect(events).toHaveLength(3);
  expect(events[2].kind).toBe('response');
  expect(events[2].causedByEventId).toBe('pevt-2');
  expect(events[2].text).toBe('PRD 814-foo finished: completed.');
});

test('two different PromptSessions in the same cwd each get their own non-interleaved event appended', async () => {
  await writeIndex({
    sessions: {
      'psess-a': { id: 'psess-a', cwd, status: 'active' },
      'psess-b': { id: 'psess-b', cwd, status: 'active' },
    },
    events: {
      'psess-a': [{ id: 'pevt-a1', promptSessionId: 'psess-a', kind: 'prompt', causedByEventId: null, at: '2026-01-01T00:00:00.000Z' }],
      'psess-b': [{ id: 'pevt-b1', promptSessionId: 'psess-b', kind: 'prompt', causedByEventId: null, at: '2026-01-01T00:00:00.000Z' }],
    },
  });

  const [routedA, routedB] = await Promise.all([
    appendResponseEventIfKnown(cwd, 'psess-a', 'PRD A finished'),
    appendResponseEventIfKnown(cwd, 'psess-b', 'PRD B finished'),
  ]);
  expect(routedA).toBe(true);
  expect(routedB).toBe(true);

  const onDisk = JSON.parse(await fsp.readFile(promptSessionActiveIndexPath(cwd), 'utf8'));
  expect(onDisk.events['psess-a']).toHaveLength(2);
  expect(onDisk.events['psess-b']).toHaveLength(2);
  expect(onDisk.events['psess-a'][1].text).toBe('PRD A finished');
  expect(onDisk.events['psess-a'][1].causedByEventId).toBe('pevt-a1');
  expect(onDisk.events['psess-b'][1].text).toBe('PRD B finished');
  expect(onDisk.events['psess-b'][1].causedByEventId).toBe('pevt-b1');
});

test('returns false (never throws) when cwd or sourcePromptId is missing', async () => {
  await expect(appendResponseEventIfKnown(null, 'psess-1', 'hi')).resolves.toBe(false);
  await expect(appendResponseEventIfKnown(cwd, null, 'hi')).resolves.toBe(false);
});

test('broadcasts EVENT_APPENDED_CHANNEL to the attached window on a successful append', async () => {
  await writeIndex({
    sessions: { 'psess-1': { id: 'psess-1', cwd, status: 'active' } },
    events: {
      'psess-1': [
        { id: 'pevt-1', promptSessionId: 'psess-1', kind: 'prompt', causedByEventId: null, at: '2026-01-01T00:00:00.000Z' },
      ],
    },
  });

  const send = vi.fn();
  const fakeWindow = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } };
  attachWindow(fakeWindow);
  try {
    const routed = await appendResponseEventIfKnown(cwd, 'psess-1', 'PRD finished');
    expect(routed).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const [channel, payload] = send.mock.calls[0];
    expect(channel).toBe(EVENT_APPENDED_CHANNEL);
    expect(payload.cwd).toBe(cwd);
    expect(payload.promptSessionId).toBe('psess-1');
    expect(payload.event.kind).toBe('response');
    expect(payload.event.text).toBe('PRD finished');
    expect(payload.event.causedByEventId).toBe('pevt-1');
  } finally {
    attachWindow(null);
  }
});

test('appending with { prdSlug, outcome } persists both onto the event on disk', async () => {
  await writeIndex({
    sessions: { 'psess-1': { id: 'psess-1', cwd, status: 'active' } },
    events: {
      'psess-1': [
        { id: 'pevt-1', promptSessionId: 'psess-1', kind: 'prompt', causedByEventId: null, at: '2026-01-01T00:00:00.000Z' },
      ],
    },
  });

  const routed = await appendResponseEventIfKnown(cwd, 'psess-1', 'PRD 976-foo finished: completed.', {
    prdSlug: '976-foo',
    outcome: 'completed',
  });
  expect(routed).toBe(true);

  const onDisk = JSON.parse(await fsp.readFile(promptSessionActiveIndexPath(cwd), 'utf8'));
  const event = onDisk.events['psess-1'][1];
  expect(event.prdSlug).toBe('976-foo');
  expect(event.outcome).toBe('completed');
});

test('appending without { prdSlug, outcome } persists an event with neither key set', async () => {
  await writeIndex({
    sessions: { 'psess-1': { id: 'psess-1', cwd, status: 'active' } },
    events: {
      'psess-1': [
        { id: 'pevt-1', promptSessionId: 'psess-1', kind: 'prompt', causedByEventId: null, at: '2026-01-01T00:00:00.000Z' },
      ],
    },
  });

  const routed = await appendResponseEventIfKnown(cwd, 'psess-1', 'no meta here');
  expect(routed).toBe(true);

  const raw = await fsp.readFile(promptSessionActiveIndexPath(cwd), 'utf8');
  const onDisk = JSON.parse(raw);
  const event = onDisk.events['psess-1'][1];
  expect('prdSlug' in event).toBe(false);
  expect('outcome' in event).toBe(false);
  // Also assert the raw JSON text has no undefined-valued keys serialized in.
  expect(raw).not.toMatch(/"prdSlug"/);
  expect(raw).not.toMatch(/"outcome"/);
});

test('does not throw broadcasting before a window is attached, or after it is destroyed', async () => {
  await writeIndex({
    sessions: { 'psess-1': { id: 'psess-1', cwd, status: 'active' } },
    events: {
      'psess-1': [
        { id: 'pevt-1', promptSessionId: 'psess-1', kind: 'prompt', causedByEventId: null, at: '2026-01-01T00:00:00.000Z' },
      ],
    },
  });

  attachWindow(null);
  await expect(appendResponseEventIfKnown(cwd, 'psess-1', 'no window yet')).resolves.toBe(true);

  const destroyedWindow = { isDestroyed: () => true, webContents: { isDestroyed: () => false, send: vi.fn() } };
  attachWindow(destroyedWindow);
  await expect(appendResponseEventIfKnown(cwd, 'psess-1', 'window destroyed')).resolves.toBe(true);
  expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();
  attachWindow(null);
});
