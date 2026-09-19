/**
 * scheduler-integration-failure-stamp.test.cjs — a worktree_integration_failed
 * finalize stamps integrateBranch's failure subtype onto the job row, and the
 * RCA report names it.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-integration-failure-stamp.test.cjs
 */

'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const { stampIntegrationFailure } = require('../scheduler.cjs');
const { buildRcaMarkdown } = require('../lib/rcaReport.cjs');

test('stamps content_conflict kind and conflicted paths', () => {
  const row = { slug: 'x' };
  stampIntegrationFailure(row, { ok: false, failureKind: 'content_conflict', conflictedPaths: ['a.md'] });
  assert.equal(row.integrationFailureKind, 'content_conflict');
  assert.deepEqual(row.integrationConflictPaths, ['a.md']);
});

test('blocking_paths stamps kind only; no failure clears stale fields', () => {
  const row = { integrationConflictPaths: ['old'] };
  stampIntegrationFailure(row, { ok: false, failureKind: 'blocking_paths', blockingPaths: { tracked: ['f'], untracked: [] } });
  assert.equal(row.integrationFailureKind, 'blocking_paths');
  assert.equal('integrationConflictPaths' in row, false);
  stampIntegrationFailure(row, null);
  assert.equal('integrationFailureKind' in row, false);
});

test('RCA markdown names the subtype and conflicted paths', () => {
  const job = {
    slug: 'x', runId: 'r', integrationFailureKind: 'content_conflict',
    integrationConflictPaths: ['docs/asset-pipeline.md'],
  };
  const md = buildRcaMarkdown({
    job, verdict: 'worktree_integration_failed', meta: null, logTail: '', acText: '', failureClass: 'unknown',
  });
  assert.ok(md.includes('Integration failure subtype: content_conflict (conflicted paths: docs/asset-pipeline.md)'));
});
