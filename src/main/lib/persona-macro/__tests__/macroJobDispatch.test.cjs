/**
 * macroJobDispatch.test.cjs — Run: timeout 120 npx vitest run src/main/lib/persona-macro/__tests__/macroJobDispatch.test.cjs
 */
'use strict';

import { test, expect, vi } from 'vitest';
const path = require('node:path');
const { dispatchMacroJob } = require('../macroJobDispatch.cjs');
const { BUILTIN_MACROS } = require('../builtinMacros.cjs');

const macro = BUILTIN_MACROS.find((m) => m.id === 'builtin-demo-video');
const base = { cwd: '/tmp/proj', macroId: 'builtin-demo-video', epicId: 'epic-1' };
const mk = (over = {}) => ({
  createPrd: vi.fn(async () => ({ ok: true })),
  listRows: vi.fn(async () => []),
  archivePrd: vi.fn(async () => ({ ok: true })),
  now: () => 1700000000000,
  ...over,
});

test('builds the PRD input from the macro', async () => {
  const d = mk();
  const r = await dispatchMacroJob(base, d);
  expect(r).toMatchObject({ ok: true, epicId: 'epic-1' });
  const i = d.createPrd.mock.calls[0][0];
  expect(i).toMatchObject({
    agentType: 'demo-video-builder', tag: macro.tag, deliverable: 'artifact',
    artifactPaths: macro.job.artifactPaths, files: macro.job.artifactPaths,
    estimateMinutes: 60, macroId: 'builtin-demo-video', sourcePromptId: 'epic-1', cwd: '/tmp/proj',
    disposition: 'new-head', goal: macro.prompt,
  });
  expect(i.slug).toBe(r.slug);
  const r2 = await dispatchMacroJob(base, mk());
  expect(r2.slug).not.toBe(r.slug);
  const e = mk();
  await dispatchMacroJob({ ...base, extraInstructions: 'Video style: Fun' }, e);
  expect(e.createPrd.mock.calls[0][0].goal).toBe(`${macro.prompt}\n\nAdditional instructions: Video style: Fun`);
});

test('gate is one quoted node entry with absolute path and baked time', async () => {
  const d = mk();
  await dispatchMacroJob(base, d);
  const { gate } = d.createPrd.mock.calls[0][0];
  expect(gate).toHaveLength(1);
  expect(gate[0].startsWith("timeout 60 node -e '")).toBe(true);
  expect(gate[0]).toContain(JSON.stringify(path.join('/tmp/proj', macro.job.artifactPaths[0])));
  expect(gate[0]).toContain('1700000000000');
  expect(gate[0].length).toBeLessThanOrEqual(500);
  const q = mk();
  expect((await dispatchMacroJob({ ...base, cwd: "/tmp/it's" }, q)).ok).toBe(false);
  expect(q.createPrd).not.toHaveBeenCalled();
});

test('active row refuses; stale newest row is archived', async () => {
  for (const status of ['pending', 'held', 'running']) {
    const d = mk({ listRows: async () => [{ slug: 'x', status, macroId: 'builtin-demo-video', cwd: '/tmp/proj' }] });
    const r = await dispatchMacroJob(base, d);
    expect(r).toEqual({ ok: false, error: 'Demo Video is already building', activeSlug: 'x' });
    expect(d.createPrd).not.toHaveBeenCalled();
  }
  const other = mk({ listRows: async () => [{ slug: 'y', status: 'running', macroId: 'other', cwd: '/tmp/proj' }] });
  expect((await dispatchMacroJob(base, other)).ok).toBe(true);
  const d = mk({ listRows: async () => [{ slug: 'old', status: 'needs_review', macroId: 'builtin-demo-video', cwd: '/tmp/proj' }] });
  expect((await dispatchMacroJob(base, d)).ok).toBe(true);
  expect(d.archivePrd).toHaveBeenCalledWith('old', '/tmp/proj');
});

test('errors: no job, empty epic, createPrd failure', async () => {
  const d = mk();
  expect((await dispatchMacroJob({ ...base, macroId: 'nope' }, d)).ok).toBe(false);
  expect(await dispatchMacroJob({ ...base, epicId: '' }, d)).toMatchObject({ ok: false });
  expect(d.createPrd).not.toHaveBeenCalled();
  const f = mk({ createPrd: async () => ({ ok: false, error: 'boom' }) });
  expect(await dispatchMacroJob(base, f)).toEqual({ ok: false, error: 'boom' });
  const t = mk({ createPrd: async () => { throw new Error('bad'); } });
  expect((await dispatchMacroJob(base, t)).error).toContain('bad');
});
