'use strict';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
const { clearMainModuleCache, registerActiveProject } = require('./_helpers/schedulerHarness.cjs');

describe('reconcile parks fix plans that list protected .claude paths', () => {
  beforeAll(() => { clearMainModuleCache(); });

  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  let tmpHome;
  let originalHome;
  let reconcile;
  let selectAutoFixTargets;

  beforeAll(() => {
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-reconcile-fixplan-claude-'));
    process.env.HOME = tmpHome;
    ({ reconcile } = require('../scheduler.cjs'));
    ({ selectAutoFixTargets } = require('../scheduler/reviewLadder.cjs'));
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  async function mint(slug, files, createdVia) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-reconcile-fixplan-claude-proj-'));
    registerActiveProject(cwd);
    const dir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'test-fixture-epic', 'prds');
    fs.mkdirSync(dir, { recursive: true });
    const fm = createdVia ? `---\ncreatedVia: ${createdVia}\n---\n` : '';
    const list = files.map((f) => `- ${f}`).join('\n');
    fs.writeFileSync(path.join(dir, `${slug}.md`), `${fm}# Goal\n\nx\n\n# Files\n\n${list}\n`, 'utf8');
    const state = { jobs: [] };
    await reconcile(state);
    return state.jobs.find((j) => j.slug === slug);
  }

  const uniq = () => `${process.pid}-${Math.floor(Math.random() * 1e6)}`;

  test('fix plan with a protected path is minted needs_review with an environment limit', async () => {
    const row = await mint(`1442-fix-claude-${uniq()}`, ['.claude/agents/x.md', 'src/a.cjs']);
    expect(row.isFixPlan).toBe(true);
    expect(row.status).toBe('needs_review');
    expect(row.environmentLimit.kind).toBe('claude-dir-write');
    expect(row.environmentLimit.evidence).toContain('.claude/agents/x.md');
    expect(row.statusHistory[0]).toMatchObject({ from: null, to: 'needs_review', source: 'reconcile' });
    expect(row.statusHistory[0].reason).toContain('.claude/agents/x.md');
    expect(row.error).toBeTruthy();
    expect(row.reviewNotice).toMatchObject({ sentAt: null, firstParkedAt: row.statusHistory[0].at });
    expect(selectAutoFixTargets([row], { fixSlugExists: () => false })).toEqual([]);
  });

  test('a row minted by the real park branch is flushed once after the hold', async () => {
    const row = await mint(`1442-fix-flush-${uniq()}`, ['.claude/skills/x/SKILL.md']);
    expect(row.status).toBe('needs_review');
    const jobs = [row];
    const queueStore = require('../lib/scheduler/queueStore.cjs');
    const state = () => ({
      config: {}, jobs, scheduledFor: null, lastRunAt: null, lastDispatchAttemptAt: null,
      paused: null, drain: null, launchBlocks: {}, launchMitigations: {}, invalidJobs: [], unreadableCwds: [],
    });
    const spies = [
      vi.spyOn(queueStore, 'readMerged').mockImplementation(async () => state()),
      vi.spyOn(queueStore, 'readMergedSync').mockImplementation(() => state()),
      vi.spyOn(queueStore, 'writeSplit').mockResolvedValue(undefined),
    ];
    try {
      const { flushDueReviewNotices } = require('../scheduler.cjs');
      const appendResponseEvent = vi.fn().mockResolvedValue(true);
      const after = Date.parse(row.reviewNotice.firstParkedAt) + 250 * 60_000;
      await flushDueReviewNotices({ appendResponseEvent, now: after });
      await flushDueReviewNotices({ appendResponseEvent, now: after + 60_000 });
      expect(appendResponseEvent).toHaveBeenCalledTimes(1);
      expect(row.reviewNotice.sentAt).toBeTruthy();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  test('fix plan without a protected path stays pending', async () => {
    const row = await mint(`1442-fix-plain-${uniq()}`, ['src/a.cjs', '.claude/notes.md']);
    expect(row.isFixPlan).toBe(true);
    expect(row.status).toBe('pending');
    expect(row.environmentLimit).toBeUndefined();
  });

  test('non-fix-plan PRD with a protected path stays pending', async () => {
    const row = await mint(`1442-feature-${uniq()}`, ['.claude/agents/x.md'], 'scheduler-api');
    expect(row.isFixPlan).toBe(false);
    expect(row.status).toBe('pending');
  });
});
