/**
 * schedulerSettle.cjs — settle the real scheduler between test cases.
 *
 * A job launched by tickQueue is fire-and-forget; when it finishes, spawnJob's
 * `finally` releases its slot and calls tickQueue(), and the broadcast coalescer
 * also runs reconcile(). Fixtures write queue.json for a brand-new project
 * directly to disk. If a reconcile's read missed that project on queueStore's
 * cached project list, it treats the project's PRDs as new and overwrites its
 * queue.json (rows come back quarantined). The cure is to drain every in-flight
 * tick/broadcast, wipe the fixture state, and bust queueStore's cwd cache so the
 * next test's project is seen. Call settleScheduler in afterEach, and call
 * queueStore.bustCwdCache() right after each fixture writes queue.json.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STEPS = 400;
const STEP_MS = 25;
const PRDS_REL = ['session-manager-operations', 'scheduler', 'epics', 'fixture-epic', 'prds'];
const QUEUE_REL = ['session-manager-operations', 'scheduler', 'state', 'queue.json'];

async function settleScheduler({ scheduler, holdGate, projectsDir }) {
  // Requires resolve at call time: tests load modules under their own HOME.
  const sessionSlots = require('../../src/main/lib/scheduler/sessionSlots.cjs');
  const queueStore = require('../../src/main/lib/scheduler/queueStore.cjs');

  scheduler.attachWindow(null);
  // A gate that holds everything, so the flush tick below cannot launch a leftover row.
  scheduler._setLoadGateForTests(holdGate);

  // spawnJob's finally releases the slot and calls tickQueue() in one synchronous
  // block, so at 0 that tick is already on the chain.
  for (let i = 0; i < STEPS && sessionSlots.inUse() > 0; i += 1) {
    await new Promise((r) => setTimeout(r, STEP_MS));
  }
  if (sessionSlots.inUse() > 0) {
    throw new Error(`settleScheduler: sessionSlots.inUse()=${sessionSlots.inUse()} still in use after ${STEPS * STEP_MS}ms`);
  }

  await scheduler.tickQueue();
  await scheduler.broadcast({ flush: true });

  let names = [];
  try { names = fs.readdirSync(projectsDir); } catch { /* no projects yet */ }
  for (const name of names) {
    const dir = path.join(projectsDir, name);
    try {
      fs.writeFileSync(path.join(dir, ...QUEUE_REL), JSON.stringify({ jobs: [] }));
    } catch { /* not a project dir */ }
    const prds = path.join(dir, ...PRDS_REL);
    let files = [];
    try { files = fs.readdirSync(prds); } catch { /* none */ }
    for (const f of files) fs.rmSync(path.join(prds, f), { recursive: true, force: true });
  }
  queueStore.bustCwdCache();
}

module.exports = { settleScheduler };
