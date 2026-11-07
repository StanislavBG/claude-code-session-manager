/**
 * health.retentionSource.test.cjs — health's run-log retention component must
 * resolve the policy through runLogRetention.cjs (ops-retention.json first),
 * not the legacy queueState.config.schedulerRunLogRetention key.
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { evaluateRunLogRetention } = require('../health.cjs');

let home;
let prevHome;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'health-retention-'));
  prevHome = process.env.HOME;
  process.env.HOME = home;
  mkdirSync(join(home, '.claude', 'session-manager'), { recursive: true });
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

test('policy present only in ops-retention.json appears in the health report', () => {
  writeFileSync(
    join(home, '.claude', 'session-manager', 'ops-retention.json'),
    JSON.stringify({ runLogs: { maxAgeDays: 7, keepPerSlug: 2 } })
  );
  const r = evaluateRunLogRetention({ config: {}, jobs: [] });
  expect(r.policyConfigured).toBe(true);
  expect(r.retentionEnabled).toBe(true);
  expect(r.policy).toEqual({ maxAgeDays: 7, keepPerSlug: 2 });
});
