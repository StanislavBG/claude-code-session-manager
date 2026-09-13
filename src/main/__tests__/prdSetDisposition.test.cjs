/**
 * prdSetDisposition.test.cjs — scheduler wave-disposition PRD:
 * scheduler.remote.setPrdDisposition (backing the renderer's
 * `schedule:set-prd-disposition` IPC action) is how a human changes an
 * already-written PRD's disposition from the Scheduler UI — promoting an
 * appended wave to its own head, or re-attaching a head behind another
 * chain. Validates via prdDisposition.cjs's computeDispositionRewrite
 * (cycle-safety, running/completed rows untouched) before delegating the
 * actual write to the SAME remote.updatePrd every other PRD edit path uses.
 *
 * Mirrors prdUpdateDependsOn.test.cjs's HOME-isolation fixture.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdSetDisposition.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;
let queueStore;
let config;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-set-disposition-home-'));
  process.env.HOME = tmpHome;

  scheduler = require('../scheduler.cjs');
  queueStore = require('../lib/queueStore.cjs');
  config = require('../config.cjs');

  if (!scheduler.PRDS_DIR.startsWith(tmpHome)) {
    throw new Error(`refusing to run: PRDS_DIR (${scheduler.PRDS_DIR}) is not under the temp HOME (${tmpHome})`);
  }
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function registerActiveProject(cwd) {
  const projectsDir = path.join(tmpHome, '.claude', 'projects');
  const slugDir = path.join(projectsDir, `fake-project-slug-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
}

function makeFixtureProject(prefix) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  registerActiveProject(cwd);
  config.addAllowedRoot(cwd);
  const opsRoot = path.join(cwd, 'session-manager-operations');
  const prdsDir = path.join(opsRoot, 'scheduler', 'epics', 'test-epic-1', 'prds');
  const stateDir = path.join(opsRoot, 'scheduler', 'state');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs: [] }, null, 2), 'utf8');
  queueStore.bustCwdCache();
  return { cwd, prdsDir, stateDir };
}

function writePrd(prdsDir, filename, cwd, extraFrontmatter = '') {
  fs.writeFileSync(
    path.join(prdsDir, filename),
    `---\ntitle: ${filename}\ncwd: ${cwd}\nestimateMinutes: 10\ncreatedVia: scheduler-api\n${extraFrontmatter}---\n\n# Goal\nDo the thing.\n`,
    'utf8',
  );
}

/** Seeds a queue.json row for `slug` with the given status — setPrdDisposition
 *  (like updatePrd) reads job status off the live queue, not the PRD file. */
function seedQueueJob(stateDir, slug, status) {
  fs.writeFileSync(
    path.join(stateDir, 'queue.json'),
    JSON.stringify({ jobs: [{ slug, status, title: slug, cwd: '' }] }, null, 2),
    'utf8',
  );
  queueStore.bustCwdCache();
}

test('append sets the expected edges', async () => {
  const { cwd, prdsDir } = makeFixtureProject('sm-set-disposition-append-');
  try {
    writePrd(prdsDir, '3-wave1-tail.md', cwd);
    writePrd(prdsDir, '4-wave2-root.md', cwd);

    const result = await scheduler.remote.setPrdDisposition({
      slug: '4-wave2-root',
      cwd,
      disposition: 'append',
      dependsOn: ['3-wave1-tail'],
    });

    expect(result.ok).toBe(true);
    const written = fs.readFileSync(path.join(prdsDir, '4-wave2-root.md'), 'utf8');
    expect(written).toMatch(/^dependsOn: \[3-wave1-tail\]$/m);
    expect(written).toMatch(/^disposition: append$/m);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('new-head sets none', async () => {
  const { cwd, prdsDir } = makeFixtureProject('sm-set-disposition-new-head-');
  try {
    writePrd(prdsDir, '3-wave1-tail.md', cwd);
    writePrd(prdsDir, '4-wave2-root.md', cwd, 'dependsOn: [wave1-tail]\ndisposition: append\n');

    const result = await scheduler.remote.setPrdDisposition({
      slug: '4-wave2-root',
      cwd,
      disposition: 'new-head',
    });

    expect(result.ok).toBe(true);
    const written = fs.readFileSync(path.join(prdsDir, '4-wave2-root.md'), 'utf8');
    expect(written).not.toContain('dependsOn');
    expect(written).toMatch(/^disposition: new-head$/m);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('promoting a wave to a head removes exactly its root edges', async () => {
  const { cwd, prdsDir } = makeFixtureProject('sm-set-disposition-promote-');
  try {
    writePrd(prdsDir, '3-wave1-tail.md', cwd);
    writePrd(prdsDir, '5-other-head.md', cwd);
    writePrd(prdsDir, '4-wave2-root.md', cwd, 'dependsOn: [wave1-tail]\ndisposition: append\n');

    const result = await scheduler.remote.setPrdDisposition({
      slug: '4-wave2-root',
      cwd,
      disposition: 'new-head',
    });

    expect(result.ok).toBe(true);
    const promoted = fs.readFileSync(path.join(prdsDir, '4-wave2-root.md'), 'utf8');
    expect(promoted).not.toContain('dependsOn');
    // The unrelated sibling head is untouched by this call.
    const other = fs.readFileSync(path.join(prdsDir, '5-other-head.md'), 'utf8');
    expect(other).not.toContain('dependsOn');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a change that would create a cycle is rejected, and nothing is written', async () => {
  const { cwd, prdsDir } = makeFixtureProject('sm-set-disposition-cycle-');
  try {
    writePrd(prdsDir, '3-a.md', cwd, 'dependsOn: [b]\n');
    writePrd(prdsDir, '4-b.md', cwd);
    const before = fs.readFileSync(path.join(prdsDir, '4-b.md'), 'utf8');

    const result = await scheduler.remote.setPrdDisposition({
      slug: '4-b',
      cwd,
      disposition: 'append',
      dependsOn: ['3-a'],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cycle/i);
    const after = fs.readFileSync(path.join(prdsDir, '4-b.md'), 'utf8');
    expect(after).toBe(before);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('running rows are untouched', async () => {
  const { cwd, prdsDir, stateDir } = makeFixtureProject('sm-set-disposition-running-');
  try {
    writePrd(prdsDir, '3-wave1-tail.md', cwd);
    writePrd(prdsDir, '4-wave2-root.md', cwd, 'dependsOn: [wave1-tail]\ndisposition: append\n');
    seedQueueJob(stateDir, '4-wave2-root', 'running');
    const before = fs.readFileSync(path.join(prdsDir, '4-wave2-root.md'), 'utf8');

    const result = await scheduler.remote.setPrdDisposition({
      slug: '4-wave2-root',
      cwd,
      disposition: 'new-head',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/running/i);
    const after = fs.readFileSync(path.join(prdsDir, '4-wave2-root.md'), 'utf8');
    expect(after).toBe(before);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('completed rows are untouched', async () => {
  const { cwd, prdsDir, stateDir } = makeFixtureProject('sm-set-disposition-completed-');
  try {
    writePrd(prdsDir, '3-wave1-tail.md', cwd);
    writePrd(prdsDir, '4-wave2-root.md', cwd, 'dependsOn: [wave1-tail]\ndisposition: append\n');
    seedQueueJob(stateDir, '4-wave2-root', 'completed');
    const before = fs.readFileSync(path.join(prdsDir, '4-wave2-root.md'), 'utf8');

    const result = await scheduler.remote.setPrdDisposition({
      slug: '4-wave2-root',
      cwd,
      disposition: 'new-head',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/completed/i);
    const after = fs.readFileSync(path.join(prdsDir, '4-wave2-root.md'), 'utf8');
    expect(after).toBe(before);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
