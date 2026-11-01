/**
 * schedulerSettle.cjs — settle the real scheduler between test cases.
 *
 * A job launched by tickQueue is fire-and-forget: it holds a session slot, keeps
 * runningSet non-empty, and its mutate() rewrites queue.json, overwriting rows the
 * next test wrote directly to disk. Call settleScheduler in afterEach.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sessionSlots = require('../../src/main/lib/scheduler/sessionSlots.cjs');

const POLL_MS = 20;
const EPIC_REL = ['session-manager-operations', 'scheduler', 'epics'];
const QUEUE_REL = ['session-manager-operations', 'scheduler', 'state', 'queue.json'];

function projectDirs(projectsDir) {
  try {
    return fs.readdirSync(projectsDir).map((n) => path.join(projectsDir, n));
  } catch {
    return [];
  }
}

function runningRows(projectsDir) {
  const busy = [];
  for (const dir of projectDirs(projectsDir)) {
    try {
      const q = JSON.parse(fs.readFileSync(path.join(dir, ...QUEUE_REL), 'utf8'));
      for (const j of q.jobs || []) if (j.status === 'running') busy.push(`${path.basename(dir)}:${j.slug}`);
    } catch { /* missing or mid-write: not running for this poll */ }
  }
  return busy;
}

async function settleScheduler({ scheduler, projectsDir, maxWaitMs = 20000 }) {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const slots = sessionSlots.inUse();
    const running = runningRows(projectsDir);
    if (slots === 0 && running.length === 0) break;
    if (Date.now() >= deadline) {
      throw new Error(`settleScheduler: still busy after ${maxWaitMs}ms — sessionSlots.inUse()=${slots}, running rows=[${running.join(', ')}]`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  for (const dir of projectDirs(projectsDir)) {
    const epics = path.join(dir, ...EPIC_REL);
    fs.rmSync(epics, { recursive: true, force: true });
    fs.mkdirSync(path.join(epics, 'fixture-epic', 'prds'), { recursive: true });
  }
  await scheduler._mutateForTests((s) => { s.jobs = []; });
  await scheduler.tickQueue();
}

module.exports = { settleScheduler };
