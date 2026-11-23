/**
 * needsYouIpc.confirmTool.test.cjs — 'scheduler:confirm-tool' answers the
 * tool-risk confirmation item for (tool, argsDigest) with Approve / Deny.
 *
 * Run: timeout 180 npx vitest run src/main/lib/feedback-remote/__tests__/needsYouIpc.confirmTool.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIGEST = 'cd'.repeat(32);
let tmp;
let prevHome;
let handlers;
let onChanged;
let store;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-tool-'));
  prevHome = process.env.SM_SCHEDULER_HOME;
  process.env.SM_SCHEDULER_HOME = tmp;
  store = require('../needsYouStore.cjs');
  const audit = require('../../telemetry/auditLog.cjs');
  vi.spyOn(audit, 'appendAuditEvent').mockImplementation(() => {});
  handlers = {};
  onChanged = vi.fn();
  require('../needsYouIpc.cjs').registerNeedsYouIpc({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    onChanged,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const invoke = (payload) => handlers['scheduler:confirm-tool']({}, payload);

test('Approve answers the confirmation item for that tool + digest', async () => {
  await store.postConfirmationRequest({ tool: 'Bash', argsDigest: DIGEST, jobSlug: 'j-1', summary: 'git push' });
  const r = await invoke({ tool: 'Bash', argsDigest: DIGEST, approved: true });
  expect(r.ok).toBe(true);
  const [item] = await store.listNeedsYou({ app: store.CONFIRM_APP });
  expect(item.id).toBe(store.confirmationItemId('Bash', DIGEST));
  expect(item.status).toBe('answered');
  expect(item.answer).toBe('Approve');
  expect(onChanged).toHaveBeenCalledTimes(1);
});

test('Deny answers Deny', async () => {
  await store.postConfirmationRequest({ tool: 'Bash', argsDigest: DIGEST, jobSlug: 'j-1' });
  expect((await invoke({ tool: 'Bash', argsDigest: DIGEST, approved: false })).ok).toBe(true);
  const [item] = await store.listNeedsYou({ app: store.CONFIRM_APP });
  expect(item.answer).toBe('Deny');
});

test('no open item → ok:false in words, nothing changed', async () => {
  const r = await invoke({ tool: 'Bash', argsDigest: DIGEST, approved: true });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/no open confirmation/i);
  expect(onChanged).not.toHaveBeenCalled();
});

test('the payload is zod-validated (bad digest refused)', async () => {
  expect(() => invoke({ tool: 'Bash', argsDigest: 'nope', approved: true })).toThrow(/sha256/);
});

test('the item `why` keeps the shape the renderer parses (homeNeedsYou parseToolConfirmation)', async () => {
  const { item } = await store.postConfirmationRequest({ tool: 'Bash', argsDigest: DIGEST, jobSlug: 'j-1', summary: 'git push' });
  expect(item.why).toContain('tried `Bash: git push`');
  expect(item.why).toContain(`Args digest: ${DIGEST}.`);
});
