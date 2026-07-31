/**
 * scheduler-sigterm-commit.test.cjs — a run SIGTERM'd (exit 143) mid an
 * interactive/headless-incompatible AC step (xvfb Electron screenshot,
 * playwright electron.launch — see the 776/779 incidents, 2026-07-30) can
 * still have landed its deliverable commit before it died. classifySigtermWithCommit
 * decides whether that run should be routed to needs_review (commit found —
 * a human should verify the rest of the AC) instead of staying `failed`
 * forever, without ever silently auto-promoting to `completed`.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-sigterm-commit.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { classifySigtermWithCommit } = require('../scheduler.cjs');

test('classifySigtermWithCommit: exit 143 + commit found in window → needs_review', () => {
  const decision = classifySigtermWithCommit(143, true);
  expect(decision.status).toBe('needs_review');
  expect(decision.reason).toMatch(/SIGTERM/);
  expect(decision.reason).toMatch(/verify AC/i);
});

test('classifySigtermWithCommit: exit 143 + no commit found in window → still failed (regression check)', () => {
  const decision = classifySigtermWithCommit(143, false);
  expect(decision).toBeNull();
});

test('classifySigtermWithCommit: exit 1 (non-143 code) is unaffected even with a commit found', () => {
  const decision = classifySigtermWithCommit(1, true);
  expect(decision).toBeNull();
});

test('classifySigtermWithCommit: exit 137 (SIGKILL) is unaffected — scoped narrowly to 143', () => {
  const decision = classifySigtermWithCommit(137, true);
  expect(decision).toBeNull();
});

test('classifySigtermWithCommit: exit 0 is unaffected', () => {
  const decision = classifySigtermWithCommit(0, true);
  expect(decision).toBeNull();
});
