'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { registerIpc, readSidecar } = require('../archivedTranscript.cjs');

let cwd;
let handler;
let jsonl;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-ipc-'));
  jsonl = path.join(cwd, 'session.jsonl');
  const ipcMain = { handle: (ch, fn) => { if (ch === 'promptSessions:archiveTranscript') handler = fn; } };
  registerIpc(ipcMain, { resolvePath: () => jsonl });
});
afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

test('writes the sidecar and returns a pointer whose sha matches', async () => {
  const text = '{"type":"user","message":"hi"}\n'.repeat(20);
  fs.writeFileSync(jsonl, text);
  const ref = await handler({}, { cwd, epicId: 'e1', claudeSessionId: 's1' });
  expect(ref.sha256).toBe(crypto.createHash('sha256').update(text, 'utf8').digest('hex'));
  expect(ref.bytes).toBe(Buffer.byteLength(text));
  expect(readSidecar(cwd, 'e1')).toBe(text);
});

test('missing or empty JSONL resolves null', async () => {
  expect(await handler({}, { cwd, epicId: 'e1', claudeSessionId: 's1' })).toBeNull();
  fs.writeFileSync(jsonl, '');
  expect(await handler({}, { cwd, epicId: 'e1', claudeSessionId: 's1' })).toBeNull();
});

test('rejects epicId with path separators and non-absolute cwd', async () => {
  fs.writeFileSync(jsonl, 'x\n');
  await expect(handler({}, { cwd, epicId: '../evil', claudeSessionId: 's1' })).rejects.toThrow(/invalid epicId/);
  await expect(handler({}, { cwd, epicId: 'a/b', claudeSessionId: 's1' })).rejects.toThrow(/invalid epicId/);
  await expect(handler({}, { cwd: 'relative/dir', epicId: 'e1', claudeSessionId: 's1' })).rejects.toThrow(/absolute/);
});
