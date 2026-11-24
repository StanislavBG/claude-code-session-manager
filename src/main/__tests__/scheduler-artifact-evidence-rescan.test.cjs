/**
 * scheduler-artifact-evidence-rescan.test.cjs — rescanArtifactEvidence hands
 * the stale needs_review rescan the artifact evidence spawnJob persisted on the
 * job row, but only when it was captured for the SAME run being re-verified.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-artifact-evidence-rescan.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { rescanArtifactEvidence } = require('../scheduler.cjs');

const evidence = {
  runId: 'run-a',
  ok: true,
  verified: [{ path: 'out/report.txt', size: 7, mtime: '2026-11-24T00:00:00.000Z' }],
  paths: ['out/report.txt'],
  capturedAt: '2026-11-24T00:00:01.000Z',
};

test('same runId returns the persisted evidence', () => {
  expect(rescanArtifactEvidence({ slug: 's', artifactEvidence: evidence }, 'run-a')).toBe(evidence);
});

test('a different runId returns null', () => {
  expect(rescanArtifactEvidence({ slug: 's', artifactEvidence: evidence }, 'run-b')).toBeNull();
});

test('a missing field returns null', () => {
  expect(rescanArtifactEvidence({ slug: 's' }, 'run-a')).toBeNull();
});

test('null evidence returns null', () => {
  expect(rescanArtifactEvidence({ slug: 's', artifactEvidence: null }, 'run-a')).toBeNull();
});

test('a non-object value returns null', () => {
  expect(rescanArtifactEvidence({ slug: 's', artifactEvidence: 'run-a' }, 'run-a')).toBeNull();
  expect(rescanArtifactEvidence({ slug: 's', artifactEvidence: 42 }, 'run-a')).toBeNull();
});

test('never throws on a missing or malformed job', () => {
  expect(rescanArtifactEvidence(null, 'run-a')).toBeNull();
  expect(rescanArtifactEvidence(undefined, 'run-a')).toBeNull();
  const hostile = {};
  Object.defineProperty(hostile, 'artifactEvidence', { get() { throw new Error('boom'); } });
  expect(rescanArtifactEvidence(hostile, 'run-a')).toBeNull();
});
