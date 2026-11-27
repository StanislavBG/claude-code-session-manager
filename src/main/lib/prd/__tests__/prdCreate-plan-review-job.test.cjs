/**
 * prdCreate-plan-review-job.test.cjs — the plan-review input passes prdCreate's
 * disposition gate while the plan's own PRDs are still pending.
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../../../config.cjs');
const { createPrd } = require('../prdCreate.cjs');
const { buildPlanReviewInput } = require('../../epic/planReviewInput.cjs');

let savedJobSlug;
beforeEach(() => { savedJobSlug = process.env.SM_SCHEDULER_JOB_SLUG; delete process.env.SM_SCHEDULER_JOB_SLUG; });
afterEach(() => {
  if (savedJobSlug === undefined) delete process.env.SM_SCHEDULER_JOB_SLUG;
  else process.env.SM_SCHEDULER_JOB_SLUG = savedJobSlug;
});

test('a no-disposition input is refused when the env is cleared', async () => {
  expect(process.env.SM_SCHEDULER_JOB_SLUG).toBeUndefined();
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-plan-review-'));
  config.addAllowedRoot(cwd);
  const rows = [{ slug: '10-a', epicId: 'epic-x', sourcePromptId: 'epic-x', status: 'pending' }];
  const remote = {
    async allocateParallelGroup() { return 300; },
    async readPrd() { return { ok: false }; },
    async writePrd() { return { ok: true, path: path.join(cwd, 'x.md') }; },
    async listPrds() { return { prds: rows, total: 1, limit: 1, offset: 0, hasMore: false }; },
  };
  const r = await createPrd({
    cwd, slug: '12-plain', title: 't', goal: 'g', sourcePromptId: 'epic-x',
    acceptanceCriteria: ['c'], files: ['x.cjs'], gate: ['true'],
  }, remote, { internalMint: true });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/disposition/);
});

test('plan-review input is created (not refused) while the Epic has pending PRDs', async () => {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-plan-review-'));
  const outDir = path.join(cwd, 'out');
  await fsp.mkdir(outDir, { recursive: true });
  config.addAllowedRoot(cwd);
  await fsp.mkdir(path.join(cwd, '.claude', 'agents'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../../../../seed/agents/plan-reviewer.md'), path.join(cwd, '.claude', 'agents', 'plan-reviewer.md'));
  const rows = [
    { slug: '10-a', epicId: 'epic-x', sourcePromptId: 'epic-x', status: 'pending' },
    { slug: '11-validate', epicId: 'epic-x', sourcePromptId: 'epic-x', status: 'pending' },
  ];
  const remote = {
    async allocateParallelGroup() { return 300; },
    async readPrd() { return { ok: false }; },
    async writePrd(slug, body) {
      const p = path.join(outDir, `${slug}.md`);
      await fsp.writeFile(p, body);
      return { ok: true, path: p };
    },
    async listPrds() { return { prds: rows, total: rows.length, limit: rows.length, offset: 0, hasMore: false }; },
  };
  const input = buildPlanReviewInput({
    epicId: 'epic-x', cwd, epicGoal: 'g', validateSlug: '11-validate', baseSha: 'abc',
    members: [{ slug: '10-a', goal: 'build', files: ['x.cjs'], acceptanceCriteria: ['c'], gate: ['true'], dependsOn: [], prdPath: 'p.md' }],
    round: 1,
  });
  const r = await createPrd(input, remote, { internalMint: true });
  expect(r.ok).toBe(true);
  expect(fs.readdirSync(outDir).some((f) => f.includes('plan-review-validate'))).toBe(true);
});
