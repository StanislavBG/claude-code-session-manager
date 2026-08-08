/**
 * prdMigrationLegacyAdopt.test.cjs — legacyAdoptExistingPrds() (PRD-authoring-
 * lockdown rollout migration): every PRD .md already on disk when the
 * provenance gate ships must be stamped `createdVia: legacy-adopted` before
 * reconcile() ever runs its quarantine check against it, so the rollout
 * itself never quarantines pre-existing work.
 *
 * HOME-isolated (mirrors scheduler-reconcile-quarantine.test.cjs): stamping
 * relies on resolvePrdsDirs(), which discovers projects via
 * ~/.claude/projects transcripts.
 *
 * Run: timeout 60 npx vitest run src/main/__tests__/prdMigrationLegacyAdopt.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let legacyAdoptExistingPrds;
let parsePrdFile;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-legacy-adopt-home-'));
  process.env.HOME = tmpHome;
  ({ legacyAdoptExistingPrds } = require('../lib/prdMigration.cjs'));
  ({ parsePrdFile } = require('../lib/prdFrontmatter.cjs'));
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
  const prdsDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  return { cwd, prdsDir };
}

test('stamps a pre-existing unstamped PRD as createdVia: legacy-adopted', async () => {
  const { cwd, prdsDir } = makeFixtureProject('sm-legacy-adopt-proj-');
  try {
    const prdPath = path.join(prdsDir, '01-old.md');
    fs.writeFileSync(prdPath, `---\ntitle: Old PRD\ncwd: ${cwd}\nestimateMinutes: 15\n---\n\n# Goal\nOld work.\n`, 'utf8');

    const result = await legacyAdoptExistingPrds();
    expect(result.stamped).toBeGreaterThanOrEqual(1);
    expect(result.failed).toEqual([]);

    const { frontmatter } = parsePrdFile(fs.readFileSync(prdPath, 'utf8'));
    expect(frontmatter.createdVia).toBe('legacy-adopted');
    expect(typeof frontmatter.issuedAt).toBe('string');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('is idempotent — never overwrites an already-stamped PRD', async () => {
  const { cwd, prdsDir } = makeFixtureProject('sm-legacy-adopt-idempotent-');
  try {
    const prdPath = path.join(prdsDir, '02-already-stamped.md');
    fs.writeFileSync(
      prdPath,
      `---\ntitle: Already stamped\ncwd: ${cwd}\nestimateMinutes: 15\ncreatedVia: scheduler-api\nissuedAt: 2026-08-01T00:00:00.000Z\n---\n\n# Goal\nDone.\n`,
      'utf8',
    );

    await legacyAdoptExistingPrds();

    const { frontmatter } = parsePrdFile(fs.readFileSync(prdPath, 'utf8'));
    expect(frontmatter.createdVia).toBe('scheduler-api'); // unchanged
    expect(frontmatter.issuedAt).toBe('2026-08-01T00:00:00.000Z'); // unchanged
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
