// jobDeclaredArtifactPaths + harvestJobPlanRecords (scheduler.cjs): the job
// PRD's frontmatter artifactPaths (live PRD, else its archived copy, only
// plan-records/ entries) feed harvestPlanRecords. The scheduler loop is never
// started; PRD lookup is pointed at a temp dir via prdPaths spies, and
// harvestPlanRecords is swapped through require.cache before scheduler.cjs
// loads (it destructures the function at require time).
import { test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SLUG = '4588-harvest-job-plan-records-test';
const EPIC = 'epic-abc123';
const PR = 'session-manager-operations/plan-records/';

const harvestModPath = require.resolve('../lib/scheduler/planRecordHarvest.cjs');
const schedulerPath = require.resolve('../scheduler.cjs');
const harvestCalls = [];
let harvestImpl;
let savedHarvestCache;
let scheduler;
let prdPaths;
let tmp;
let liveDir;
let archiveDir;

beforeAll(() => {
  const real = require(harvestModPath);
  savedHarvestCache = require.cache[harvestModPath];
  const stubExports = {
    ...real,
    harvestPlanRecords: (args) => {
      harvestCalls.push(args);
      return harvestImpl(args);
    },
  };
  require.cache[harvestModPath] = { ...savedHarvestCache, exports: stubExports };
  delete require.cache[schedulerPath];
  scheduler = require(schedulerPath);
  prdPaths = require('../scheduler/prdPaths.cjs');
});

afterAll(() => {
  require.cache[harvestModPath] = savedHarvestCache;
  delete require.cache[schedulerPath];
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-plan-record-harvest-'));
  liveDir = path.join(tmp, 'live');
  archiveDir = path.join(tmp, 'archived');
  fs.mkdirSync(liveDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });
  harvestCalls.length = 0;
  harvestImpl = () => ({ copied: [], skipped: [] });
  vi.spyOn(prdPaths, 'findPrdDir').mockImplementation(async (slug) => (
    fs.existsSync(path.join(liveDir, `${slug}.md`)) ? liveDir : null));
  vi.spyOn(prdPaths, 'archivedPrdPathForJob').mockImplementation((job) => {
    const p = path.join(archiveDir, `${job.slug}.md`);
    return fs.existsSync(p) ? p : null;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function prd(paths) {
  return `---\ntitle: test\nartifactPaths: ${JSON.stringify(paths)}\n---\n\n# Goal\n\nx\n`;
}

const job = () => ({ slug: SLUG, epicId: EPIC, cwd: tmp });

test('live PRD: returns only plan-records/ artifactPaths', async () => {
  fs.writeFileSync(path.join(liveDir, `${SLUG}.md`), prd([
    `${PR}${EPIC}/plan.md`,
    'out/report.md',
    `${PR}other-epic/verdicts.json`,
    'session-manager-operations/artifacts/x.png',
  ]));
  expect(await scheduler.__jobDeclaredArtifactPaths(job())).toEqual([
    `${PR}${EPIC}/plan.md`,
    `${PR}other-epic/verdicts.json`,
  ]);
});

test('archived copy is used when the live PRD is gone', async () => {
  fs.writeFileSync(path.join(archiveDir, `${SLUG}.md`), prd([`${PR}${EPIC}/archived.md`, 'out/a.md']));
  expect(await scheduler.__jobDeclaredArtifactPaths(job())).toEqual([`${PR}${EPIC}/archived.md`]);
});

test('live PRD wins over the archived copy', async () => {
  fs.writeFileSync(path.join(liveDir, `${SLUG}.md`), prd([`${PR}${EPIC}/live.md`]));
  fs.writeFileSync(path.join(archiveDir, `${SLUG}.md`), prd([`${PR}${EPIC}/archived.md`]));
  expect(await scheduler.__jobDeclaredArtifactPaths(job())).toEqual([`${PR}${EPIC}/live.md`]);
});

test('[] when no PRD exists anywhere', async () => {
  expect(await scheduler.__jobDeclaredArtifactPaths(job())).toEqual([]);
});

test('[] when the PRD is unparsable or has no artifactPaths list', async () => {
  fs.writeFileSync(path.join(liveDir, `${SLUG}.md`), '---\nartifactPaths: [unclosed\n  : : :\n---\n');
  expect(await scheduler.__jobDeclaredArtifactPaths(job())).toEqual([]);
  fs.writeFileSync(path.join(liveDir, `${SLUG}.md`), '---\ntitle: t\nartifactPaths: nope\n---\nbody\n');
  expect(await scheduler.__jobDeclaredArtifactPaths(job())).toEqual([]);
  fs.writeFileSync(path.join(liveDir, `${SLUG}.md`), 'no frontmatter at all\n');
  expect(await scheduler.__jobDeclaredArtifactPaths(job())).toEqual([]);
});

test('[] (never throws) when PRD lookup itself throws', async () => {
  prdPaths.archivedPrdPathForJob.mockImplementation(() => { throw new Error('boom'); });
  expect(await scheduler.__jobDeclaredArtifactPaths(job())).toEqual([]);
});

test('harvestJobPlanRecords passes epicId + declared paths to harvestPlanRecords', async () => {
  fs.writeFileSync(path.join(liveDir, `${SLUG}.md`), prd([`${PR}other-epic/plan.md`, 'out/report.md']));
  const worktreeDir = path.join(tmp, 'wt');
  const projectRoot = path.join(tmp, 'project');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  harvestImpl = () => ({ copied: ['a'], skipped: [] });
  await scheduler.__harvestJobPlanRecords(job(), worktreeDir, projectRoot);
  expect(harvestCalls).toHaveLength(1);
  expect(harvestCalls[0]).toEqual({
    worktreeDir,
    projectRoot,
    epicId: EPIC,
    declaredPaths: [`${PR}other-epic/plan.md`],
  });
});

test('harvestJobPlanRecords falls back to sourcePromptId for the epicId', async () => {
  await scheduler.__harvestJobPlanRecords(
    { slug: SLUG, sourcePromptId: 'epic-src999', cwd: tmp }, path.join(tmp, 'wt'), path.join(tmp, 'project'));
  expect(harvestCalls).toHaveLength(1);
  expect(harvestCalls[0].epicId).toBe('epic-src999');
  expect(harvestCalls[0].declaredPaths).toEqual([]);
});

test('harvestJobPlanRecords skips when worktree is the project root or epicId is missing', async () => {
  await scheduler.__harvestJobPlanRecords(job(), tmp, tmp);
  await scheduler.__harvestJobPlanRecords({ slug: SLUG, cwd: tmp }, path.join(tmp, 'wt'), path.join(tmp, 'p'));
  expect(harvestCalls).toHaveLength(0);
});

test('harvestJobPlanRecords never throws on a harvest error (logs it)', async () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  harvestImpl = () => { throw new Error('disk on fire'); };
  await expect(scheduler.__harvestJobPlanRecords(job(), path.join(tmp, 'wt'), path.join(tmp, 'project')))
    .resolves.toBeUndefined();
  expect(harvestCalls).toHaveLength(1);
  expect(err).toHaveBeenCalledWith(expect.stringContaining('plan record harvest failed'), expect.any(Error));
});
