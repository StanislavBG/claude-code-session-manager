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
    estimateMinutes: 60, macroId: 'builtin-demo-video', sourcePromptId: 'epic-1', cwd: '/tmp/proj',
    disposition: 'new-head',
  });
  const id1 = /Entry id: (vid-[0-9a-z]+)\. Save with videoId = \1\.$/.exec(i.goal)[1];
  expect(i.goal.startsWith(macro.prompt)).toBe(true);
  expect(i.artifactPaths).toEqual([`session-manager-operations/project-pages/videos/${id1}/index.html`]);
  expect(i.files).toEqual(i.artifactPaths);
  expect(i.slug).toBe(r.slug);
  const r2 = await dispatchMacroJob(base, mk());
  expect(r2.slug).not.toBe(r.slug);
  const e = mk();
  await dispatchMacroJob({ ...base, extraInstructions: 'Video style: Fun' }, e);
  expect(e.createPrd.mock.calls[0][0].goal).toMatch(/^[\s\S]*\n\nAdditional instructions: Video style: Fun\n\nEntry id: vid-/);
});

test('two dispatches get different video ids and gates', async () => {
  const a = mk(); const b = mk();
  await dispatchMacroJob(base, a);
  await dispatchMacroJob(base, b);
  const [x, y] = [a, b].map((d) => d.createPrd.mock.calls[0][0]);
  expect(x.artifactPaths[0]).not.toBe(y.artifactPaths[0]);
  expect(x.gate[0]).not.toBe(y.gate[0]);
});

test('knowledge ids follow the Page line', async () => {
  const cases = [
    [undefined, 'overview'], ['Page: How it works', 'how-it-works'], ['Page: FAQ', 'faq'],
    ['Page: Custom topic: Billing & Plans', 'billing-plans'],
  ];
  for (const [extra, id] of cases) {
    const d = mk();
    await dispatchMacroJob({ ...base, macroId: 'builtin-project-home', extraInstructions: extra }, d);
    const i = d.createPrd.mock.calls[0][0];
    expect(i.artifactPaths).toEqual([`session-manager-operations/project-pages/knowledge/${id}/index.html`]);
    expect(i.goal.endsWith(`Entry id: ${id}. Save with pageId = ${id}.`)).toBe(true);
    expect(i.gate[0]).toContain(`/knowledge/${id}/index.html`);
  }
});

const inputFor = async (extraInstructions, macroId = 'builtin-demo-video') => {
  const d = mk();
  expect((await dispatchMacroJob({ ...base, macroId, extraInstructions }, d)).ok).toBe(true);
  return d.createPrd.mock.calls[0][0];
};

test('a valid Replace entry line rebuilds the same video on every press', async () => {
  for (const id of ['vid-mh1abc2def', 'a'.repeat(64)]) {
    for (let press = 0; press < 2; press++) {
      const i = await inputFor(`Video style: Fun\nReplace entry: ${id}`);
      expect(i.artifactPaths).toEqual([`session-manager-operations/project-pages/videos/${id}/index.html`]);
      expect(i.goal.endsWith(`Entry id: ${id}. Save with videoId = ${id}.`)).toBe(true);
      expect(i.gate[0]).toContain(`/videos/${id}/index.html`);
    }
  }
});

test('a valid Replace entry line overrides the Page line for knowledge', async () => {
  for (const extra of ['Page: FAQ\nReplace entry: billing-plans', '  Replace entry:  billing-plans  \nPage: How it works']) {
    const i = await inputFor(extra, 'builtin-project-home');
    expect(i.artifactPaths).toEqual(['session-manager-operations/project-pages/knowledge/billing-plans/index.html']);
    expect(i.goal.endsWith('Entry id: billing-plans. Save with pageId = billing-plans.')).toBe(true);
    expect(i.gate[0]).toContain('/knowledge/billing-plans/index.html');
  }
});

test('an invalid Replace entry value is ignored and never becomes the id', async () => {
  for (const bad of ['../x', 'A B', 'vid_1', 'a'.repeat(65)]) {
    const video = await inputFor(`Replace entry: ${bad}`);
    const id = /Entry id: (vid-[0-9a-z]+)\. Save with videoId = \1\.$/.exec(video.goal)?.[1];
    expect(id).toBeTruthy();
    expect(video.artifactPaths).toEqual([`session-manager-operations/project-pages/videos/${id}/index.html`]);
    const page = await inputFor(`Page: FAQ\nReplace entry: ${bad}`, 'builtin-project-home');
    expect(page.artifactPaths).toEqual(['session-manager-operations/project-pages/knowledge/faq/index.html']);
    expect(page.goal.endsWith('Entry id: faq. Save with pageId = faq.')).toBe(true);
    for (const i of [video, page]) {
      expect(i.artifactPaths[0]).not.toContain(bad);
      expect(i.gate[0]).not.toContain(bad);
      expect(i.goal.slice(i.goal.lastIndexOf('\n\nEntry id: '))).not.toContain(bad);
    }
  }
});

test('gate is one quoted node entry with absolute path and baked time', async () => {
  const d = mk();
  await dispatchMacroJob(base, d);
  const { gate } = d.createPrd.mock.calls[0][0];
  expect(gate).toHaveLength(1);
  expect(gate[0].startsWith("timeout 60 node -e '")).toBe(true);
  expect(gate[0]).toContain('/tmp/proj/session-manager-operations/project-pages/videos/vid-');
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
