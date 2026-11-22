// buildFinishTail wording: git add -f only for a # Files path outside
// session-manager-operations/, and plan records are never staged.
import { test, expect } from 'vitest';
const { buildFinishProtocol } = require('../scheduler.cjs');

const variants = [
  buildFinishProtocol({ reviewInRun: true }),
  buildFinishProtocol({ reviewInRun: false }),
  buildFinishProtocol({ reviewInRun: false, isFixPlan: true }),
  buildFinishProtocol({ reviewInRun: false, isArtifactOnly: true }),
];

function flat(text) {
  return text.replace(/\s+/g, ' ');
}

test('force-add is allowed only for a # Files path not under session-manager-operations/', { timeout: 10_000 }, () => {
  for (const text of variants) {
    expect(flat(text)).toContain(
      "unless the PRD's # Files section names that exact path AND that path is not under session-manager-operations/.",
    );
  }
});

test('plan records are written in the worktree, never staged, and copied by the scheduler', { timeout: 10_000 }, () => {
  for (const text of variants) {
    expect(flat(text)).toContain(
      'A record under session-manager-operations/plan-records/<epic-id>/ is written in this worktree and never staged; the scheduler copies it to the main checkout.',
    );
  }
});

test('the runtime-folders ban sentence is kept', { timeout: 10_000 }, () => {
  for (const text of variants) {
    expect(flat(text)).toMatch(/Never commit any file under these folders/);
  }
});
