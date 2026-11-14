'use strict';

/**
 * scheduler-row-artifact-fields.test.cjs — PRD 3114: queue rows must carry a
 * PRD's `deliverable` + `artifactPaths` frontmatter (beside macroId), or the
 * row-based artifact-only checks (applyOrphanOutcomeInner's artifactOnly, the
 * artifactVerified flag) always read false.
 *
 * Run: npx vitest run src/main/__tests__/scheduler-row-artifact-fields.test.cjs
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clearMainModuleCache, registerActiveProject } = require('./_helpers/schedulerHarness.cjs');

describe('queue rows carry deliverable + artifactPaths', () => {
  let tmpHome;
  let originalHome;
  let reconcile;
  let applyOrphanOutcome;
  let parsePrd;

  beforeAll(() => {
    clearMainModuleCache();
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-row-artifact-fields-'));
    process.env.HOME = tmpHome;
    ({ reconcile, applyOrphanOutcome } = require('../scheduler.cjs'));
    ({ parsePrd } = require('../scheduler/prdParser.cjs'));
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function writePrd(frontmatter) {
    const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-row-artifact-fields-project-'));
    registerActiveProject(projectCwd);
    const slug = `3114-row-artifact-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const prdsDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'epics', 'test-fixture-epic', 'prds');
    fs.mkdirSync(prdsDir, { recursive: true });
    const file = path.join(prdsDir, `${slug}.md`);
    fs.writeFileSync(file, `---\n${frontmatter}---\n\n# Goal\n\nArtifact-only build.\n`, 'utf8');
    return { projectCwd, slug, file };
  }

  test('parsePrd returns deliverable + artifactPaths; null when absent', async () => {
    const a = writePrd('deliverable: artifact\nartifactPaths: [out/page.html, out/data.json]\n');
    const pa = await parsePrd(a.file);
    expect(pa.deliverable).toBe('artifact');
    expect(pa.artifactPaths).toEqual(['out/page.html', 'out/data.json']);

    const b = writePrd('title: plain\n');
    const pb = await parsePrd(b.file);
    expect(pb.deliverable).toBeNull();
    expect(pb.artifactPaths).toBeNull();

    const c = writePrd('deliverable: code\n');
    const pc = await parsePrd(c.file);
    expect(pc.deliverable).toBeNull();
  });

  test('a freshly reconciled artifact-only PRD yields a row carrying both, and a successful orphan completes with no commit', async () => {
    const { slug } = writePrd('deliverable: artifact\nartifactPaths: [out/page.html]\n');
    const state = { jobs: [] };
    await reconcile(state);
    const row = state.jobs.find((j) => j.slug === slug);
    expect(row).toBeDefined();
    expect(row.deliverable).toBe('artifact');
    expect(row.artifactPaths).toEqual(['out/page.html']);

    row.status = 'running';
    row.runtime = { pid: 1 };
    applyOrphanOutcome(row, 'success');
    expect(row.status).toBe('completed');
    expect(row.exitCode).toBe(0);
    expect(row.runtime).toBeUndefined();
  });

  test('an existing row refreshed by reconcile picks up the fields', async () => {
    const { slug, projectCwd } = writePrd('deliverable: artifact\nartifactPaths: [out/page.html]\n');
    const state = { jobs: [{ slug, title: 'x', cwd: projectCwd, status: 'pending' }] };
    await reconcile(state);
    const row = state.jobs.find((j) => j.slug === slug);
    expect(row.deliverable).toBe('artifact');
    expect(row.artifactPaths).toEqual(['out/page.html']);
  });
});
