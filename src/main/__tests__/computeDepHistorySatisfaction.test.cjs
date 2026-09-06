// PRD 1122 — scheduler.cjs's computeDepHistorySatisfaction: the once-per-tick
// history/archive lookup that findBlockingDep consults for a dependsOn slug
// with no live queue row.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-1122-home-'));
process.env.HOME = tmpHome;

const scheduler = require('../scheduler.cjs');
const queueHistory = require('../lib/queueHistory.cjs');
const { DEP_HISTORY_FAIL_OPEN } = require('../lib/schedulerBatch.cjs');

function tmpProjectCwd(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('computeDepHistorySatisfaction', () => {
  it('includes a slug completed in this project\'s history shard', async () => {
    const cwd = tmpProjectCwd('sm-1122-hist-');
    await queueHistory.appendHistory([
      { slug: '900-base', status: 'completed', runId: 'r1', finishedAt: new Date().toISOString(), cwd },
    ]);
    const state = { jobs: [{ slug: '901-next', status: 'pending', cwd, dependsOn: ['900-base'] }] };
    const byCwd = await scheduler.computeDepHistorySatisfaction(state);
    expect(byCwd.get(cwd).has('900-base')).toBe(true);
  });

  it('includes a slug found only under prds-archived/', async () => {
    const cwd = tmpProjectCwd('sm-1122-arch-');
    const archiveDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'prds-archived');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, '900-base.md'), '---\ntitle: x\n---\n# Goal\n');
    const state = { jobs: [{ slug: '901-next', status: 'pending', cwd, dependsOn: ['900-base'] }] };
    const byCwd = await scheduler.computeDepHistorySatisfaction(state);
    expect(byCwd.get(cwd).has('900-base')).toBe(true);
  });

  it('a slug in neither history nor archive is absent from the satisfied set', async () => {
    const cwd = tmpProjectCwd('sm-1122-none-');
    const state = { jobs: [{ slug: '901-next', status: 'pending', cwd, dependsOn: ['900-base'] }] };
    const byCwd = await scheduler.computeDepHistorySatisfaction(state);
    expect(byCwd.get(cwd).has('900-base')).toBe(false);
  });

  it('degrades to DEP_HISTORY_FAIL_OPEN for one project on a read failure, without throwing', async () => {
    // A relative cwd makes projectHistoryPath (via completedSlugsForCwd)
    // throw synchronously rather than ENOENT — the read-failure path, not
    // the "no history yet" path.
    const badCwd = 'relative/not-a-project-root';
    const goodCwd = tmpProjectCwd('sm-1122-good-');
    const state = {
      jobs: [
        { slug: '901-next', status: 'pending', cwd: badCwd, dependsOn: ['900-base'] },
        { slug: '801-next', status: 'pending', cwd: goodCwd, dependsOn: ['800-base'] },
      ],
    };
    const byCwd = await scheduler.computeDepHistorySatisfaction(state);
    expect(byCwd.get(badCwd)).toBe(DEP_HISTORY_FAIL_OPEN);
    // The other project's lookup is unaffected by the first one's failure.
    expect(byCwd.get(goodCwd)).not.toBe(DEP_HISTORY_FAIL_OPEN);
    expect(byCwd.get(goodCwd).has('800-base')).toBe(false);
  });
});
