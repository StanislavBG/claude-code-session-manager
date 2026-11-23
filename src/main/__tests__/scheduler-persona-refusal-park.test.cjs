'use strict';

/**
 * scheduler-persona-refusal-park.test.cjs — PRD 3773: a persona refusal at
 * dispatch parks the running row needs_review through transitionJob, with
 * reason '<code>: <detail>' recorded on its statusHistory.
 *
 * Run: npx vitest run src/main/__tests__/scheduler-persona-refusal-park.test.cjs
 */

import { afterAll, beforeAll, expect, test } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let applyPersonaRefusalPark;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-persona-refusal-'));
  process.env.HOME = tmpHome;
  ({ applyPersonaRefusalPark } = require('../scheduler.cjs'));
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('a refused running row parks needs_review with reason "<code>: <detail>" via transitionJob', () => {
  const row = { slug: '3773-refused-job', status: 'running', runtime: { pid: 1 } };
  expect(applyPersonaRefusalPark(row, { code: 'persona_missing', detail: "agentType 'ghost' does not resolve" })).toBe(true);
  expect(row.status).toBe('needs_review');
  expect(row.runtime).toBeUndefined();
  expect(row.terminalReason).toBe('persona_missing');
  expect(row.error).toBe("persona_missing: agentType 'ghost' does not resolve");
  expect(row.statusHistory.at(-1)).toMatchObject({
    from: 'running', to: 'needs_review',
    reason: "persona_missing: agentType 'ghost' does not resolve",
    source: 'executeJob:persona-refusal',
  });
});

test('an illegal edge (e.g. from completed) is refused and the row is left untouched', () => {
  const row = { slug: '3773-done', status: 'completed' };
  expect(applyPersonaRefusalPark(row, { code: 'persona_invalid', detail: 'x' })).toBe(false);
  expect(row.status).toBe('completed');
  expect(row.error).toBeUndefined();
});
