/**
 * chatRunner-epic-state-poke.test.cjs — a non-silent chat turn pokes the Epic
 * outside-state emitter when it is accepted and again when its lane frees (the
 * only moments that time 'working' / 'needs_input'); a silent probe pokes
 * neither time. Also: scheduler.remote.listJobRowsSettled resolves only after
 * a pending mutate() has written its rows.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/chatRunner-epic-state-poke.test.cjs
 */

'use strict';

delete process.env.SM_CHAT_CONCURRENCY;

import { test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const originalHome = process.env.HOME;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-epic-state-poke-home-'));
process.env.HOME = tmpHome;

const emitter = require('../lib/epic/epicStateEmitter.cjs');
const cr = require('../chatRunner.cjs');

const realPoke = emitter.pokeEpicState;
const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-epic-state-poke-'));
const EPIC = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let poke;
beforeAll(() => {
  poke = vi.fn();
  emitter.pokeEpicState = poke;
});

afterEach(() => {
  cr.__setExecutor(null);
  cr.__resetQueueForTests();
  poke.mockClear();
});

afterAll(() => {
  emitter.pokeEpicState = realPoke;
  process.env.HOME = originalHome;
  fs.rmSync(scratchCwd, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function waitFor(fn, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

test('a non-silent turn pokes at acceptance and again when it settles', async () => {
  const gate = deferred();
  let started = false;
  cr.__setExecutor(() => { started = true; return gate.promise; });

  const res = cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'hi', cwd: scratchCwd, resume: false });
  expect(res.accepted).toBe(true);
  expect(poke).toHaveBeenCalledTimes(1);
  expect(poke).toHaveBeenLastCalledWith(scratchCwd, EPIC);

  await waitFor(() => started);
  expect(started).toBe(true);
  expect(poke).toHaveBeenCalledTimes(1); // still running: no settle poke yet

  gate.resolve();
  expect(await waitFor(() => poke.mock.calls.length >= 2)).toBe(true);
  expect(poke).toHaveBeenCalledTimes(2);
  expect(poke).toHaveBeenLastCalledWith(scratchCwd, EPIC);
});

test('a silent probe pokes neither at acceptance nor at settle', async () => {
  let done = false;
  cr.__setExecutor(() => Promise.resolve().then(() => { done = true; }));

  const res = cr.run({ tabId: EPIC, sessionId: EPIC, prompt: '/context', cwd: scratchCwd, resume: true, silent: true });
  expect(res.accepted).toBe(true);
  await waitFor(() => done);
  await new Promise((r) => setTimeout(r, 30));
  expect(done).toBe(true);
  expect(poke).not.toHaveBeenCalled();
});

test('a throwing emitter never alters a turn', async () => {
  poke.mockImplementation(() => { throw new Error('boom'); });
  let done = false;
  cr.__setExecutor(() => Promise.resolve().then(() => { done = true; }));
  const res = cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'hi again', cwd: scratchCwd, resume: true });
  expect(res).toMatchObject({ accepted: true });
  await waitFor(() => poke.mock.calls.length >= 2);
  expect(done).toBe(true);
  poke.mockReset();
});

test('listJobRowsSettled resolves only after a pending mutate() has written its rows', async () => {
  const sched = require('../scheduler.cjs');
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-epic-state-settled-'));
  try {
    const slugDir = path.join(tmpHome, '.claude', 'projects', `fake-slug-${path.basename(projectCwd)}`);
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd: projectCwd }) + '\n');
    const qp = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'state', 'queue.json');
    fs.mkdirSync(path.dirname(qp), { recursive: true });
    const slug = `4304-settled-${process.pid}`;
    fs.writeFileSync(qp, JSON.stringify({ jobs: [{ slug, status: 'pending', cwd: projectCwd, agentType: 'dev-lead' }] }, null, 2));

    const before = await sched.remote.listJobRows();
    expect(before.find((j) => j.slug === slug)?.status).toBe('pending');

    const gate = deferred();
    const mut = sched._mutateForTests(async (st) => {
      await gate.promise;
      const row = st.jobs.find((j) => j.slug === slug);
      row.status = 'running';
    });

    let settled = null;
    const p = sched.remote.listJobRowsSettled().then((rows) => { settled = rows; });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBeNull(); // still waiting on the pending mutate

    gate.resolve();
    await mut;
    await p;
    expect(settled.find((j) => j.slug === slug)?.status).toBe('running');
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
  }
});
