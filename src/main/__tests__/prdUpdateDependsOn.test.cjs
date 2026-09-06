/**
 * prdUpdateDependsOn.test.cjs — PRD 1124: scheduler.remote.updatePrd accepts
 * a `dependsOn` array patch, validates it write-time against the SAME
 * resolver (depSlugResolve.cjs) scheduler_create_prd's prdCreate.cjs uses,
 * and accepts an explicit empty array to CLEAR the dependency.
 *
 * Mirrors scheduler-reconcile-quarantine.test.cjs's HOME-isolation fixture.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdUpdateDependsOn.test.cjs
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-update-prd-dependson-home-'));
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
  // updatePrd writes through config.writeTextAtomic, which enforces
  // validatePath's allowed-write-root boundary (os.homedir() by default).
  // The live app widens this via pty.cjs's spawn / activeIndexMerge.cjs's
  // boot registration as a side effect of opening the project; a test that
  // never spawns a PTY has to register it explicitly, same as
  // prdCreate.cjs's own createPrd does for a chat-only Epic.
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

test('updatePrd patches dependsOn to a new valid list naming an existing bare slug', async () => {
  const { cwd, prdsDir } = makeFixtureProject('sm-update-dependson-valid-');
  try {
    writePrd(prdsDir, '3-widget-base.md', cwd);
    writePrd(prdsDir, '4-widget-follow-up.md', cwd);

    const result = await scheduler.remote.updatePrd({
      slug: '4-widget-follow-up',
      cwd,
      frontmatter: { dependsOn: ['widget-base'] },
    });

    expect(result.ok).toBe(true);
    const written = fs.readFileSync(path.join(prdsDir, '4-widget-follow-up.md'), 'utf8');
    expect(written).toMatch(/^dependsOn: \[widget-base\]$/m);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('updatePrd refuses a dependsOn entry that resolves to no existing PRD, with a near-match suggestion, and writes nothing', async () => {
  const { cwd, prdsDir } = makeFixtureProject('sm-update-dependson-invalid-');
  try {
    writePrd(prdsDir, '3-widget-base.md', cwd);
    writePrd(prdsDir, '4-widget-follow-up.md', cwd);
    const before = fs.readFileSync(path.join(prdsDir, '4-widget-follow-up.md'), 'utf8');

    const result = await scheduler.remote.updatePrd({
      slug: '4-widget-follow-up',
      cwd,
      frontmatter: { dependsOn: ['wigdet-bsae'] },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not resolve to any existing PRD/);
    expect(result.error).toMatch(/widget-base/);
    const after = fs.readFileSync(path.join(prdsDir, '4-widget-follow-up.md'), 'utf8');
    expect(after).toBe(before);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('updatePrd patches dependsOn to an explicit empty array, clearing a previously-set dependency without validation', async () => {
  const { cwd, prdsDir } = makeFixtureProject('sm-update-dependson-clear-');
  try {
    writePrd(prdsDir, '3-widget-base.md', cwd);
    writePrd(prdsDir, '4-widget-follow-up.md', cwd, 'dependsOn: [widget-base]\n');

    const result = await scheduler.remote.updatePrd({
      slug: '4-widget-follow-up',
      cwd,
      frontmatter: { dependsOn: [] },
    });

    expect(result.ok).toBe(true);
    const written = fs.readFileSync(path.join(prdsDir, '4-widget-follow-up.md'), 'utf8');
    expect(written).not.toContain('dependsOn');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('updatePrd patching an unrelated field leaves a PRD with no dependsOn unaffected', async () => {
  const { cwd, prdsDir } = makeFixtureProject('sm-update-dependson-unrelated-');
  try {
    writePrd(prdsDir, '3-standalone.md', cwd);

    const result = await scheduler.remote.updatePrd({
      slug: '3-standalone',
      cwd,
      frontmatter: { estimateMinutes: 25 },
    });

    expect(result.ok).toBe(true);
    const written = fs.readFileSync(path.join(prdsDir, '3-standalone.md'), 'utf8');
    expect(written).not.toContain('dependsOn');
    expect(written).toMatch(/^estimateMinutes: 25$/m);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
