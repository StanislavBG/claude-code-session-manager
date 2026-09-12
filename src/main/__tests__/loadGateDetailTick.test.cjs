/**
 * loadGateDetailTick.test.cjs — unit test for the human-readable detail
 * string a `reason: 'load-deferred'` tick surfaces to the renderer via
 * lastTick.detail (buildScheduleStatePayload). Extracted as a pure function
 * (formatLoadGateDetail) so this is testable without driving tickQueue's
 * full fs/worktree machinery or launching the app.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/loadGateDetailTick.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { formatLoadGateDetail } = require('../scheduler.cjs');

test('names the load gate, the measured ratio, the threshold and how long it has been held', () => {
  const detail = formatLoadGateDetail({
    loadavg1: 13.31,
    cores: 14,
    ratio: 0.951,
    threshold: 0.85,
    gatedSinceMs: 83 * 60_000,
  });

  expect(detail).toMatch(/load gate/i);
  expect(detail).toContain('13.31');
  expect(detail).toContain('14');
  expect(detail).toContain('0.951');
  expect(detail).toContain('0.85');
  expect(detail).toMatch(/83m/);
});
