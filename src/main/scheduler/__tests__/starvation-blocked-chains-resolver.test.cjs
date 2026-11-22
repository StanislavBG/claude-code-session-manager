'use strict';

// computeBlockedChains must resolve dependsOn with the SAME rule dispatch uses
// (depSlugResolve.cjs makeDepResolver). Self, 2026-11-22: the human-cancelled
// 1056-sm-contract-client row froze the dependents of the completed (retired
// to history) 1047-sm-contract-client, and the stall monitor reported a bogus
// blocked chain behind 1056.

const { computeBlockedChains } = require('../starvation.cjs');
const { findBlockingDep } = require('../../lib/scheduler/schedulerBatch.cjs');
const { checkDeps } = require('../../runVerify.cjs');

const CWD = '/proj/self';
const EPIC = 'epic-self';

function fixture() {
  const cancelled = {
    slug: '1056-sm-contract-client', cwd: CWD, epicId: EPIC, status: 'failed',
    cancelledAt: '2026-11-22T10:00:00Z', error: 'cancelled via admin API',
  };
  const dependents = Array.from({ length: 3 }, (_, i) => ({
    slug: `${1060 + i}-consumer-${i}`, cwd: CWD, epicId: EPIC, status: 'pending', dependsOn: ['sm-contract-client'],
  }));
  const jobs = [cancelled, ...dependents];
  const satisfiedSlugsByCwd = new Map([[CWD, new Set(['1047-sm-contract-client'])]]);
  return { jobs, dependents, satisfiedSlugsByCwd };
}

describe('computeBlockedChains uses the shared dep resolver', () => {
  it('1047 completed + 1056 cancelled: no blocked chain', () => {
    const { jobs, satisfiedSlugsByCwd } = fixture();
    expect(computeBlockedChains(jobs, satisfiedSlugsByCwd)).toEqual([]);
  });

  it('agrees with dispatch: findBlockingDep releases the same dependents', () => {
    const { jobs, dependents, satisfiedSlugsByCwd } = fixture();
    for (const d of dependents) {
      expect(findBlockingDep(d, jobs, satisfiedSlugsByCwd.get(CWD))).toBeUndefined();
    }
  });

  it('without the completion record the cancelled row is still a terminal blocker', () => {
    const { jobs } = fixture();
    expect(computeBlockedChains(jobs)).toEqual([
      { cwd: CWD, blockedBy: ['1056-sm-contract-client'], blocked: 3 },
    ]);
  });

  it('an exact dependsOn on a satisfied record is never blocked by a same-bare failed row', () => {
    const { jobs, satisfiedSlugsByCwd } = fixture();
    const exactDep = { slug: '1070-exact', cwd: CWD, epicId: EPIC, status: 'pending', dependsOn: ['1047-sm-contract-client'] };
    expect(computeBlockedChains([...jobs, exactDep], satisfiedSlugsByCwd)).toEqual([]);
    const failed = { ...jobs[0], cancelledAt: undefined, error: 'exit 1' };
    expect(checkDeps(exactDep, [failed, exactDep], satisfiedSlugsByCwd.get(CWD))).toEqual({ ok: true });
  });

  it('an auto-resolved skip is satisfied, as dispatch treats it', () => {
    const jobs = [
      { slug: '10-a', cwd: CWD, status: 'skipped', needsReviewAutoResolvedSkip: true },
      { slug: '11-b', cwd: CWD, status: 'pending', dependsOn: ['a'] },
    ];
    expect(computeBlockedChains(jobs)).toEqual([]);
  });
});
