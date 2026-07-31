/**
 * queueOps-interactive-ac-lint.test.cjs — lint for AC checkboxes that
 * instruct an interactive/GUI-rendering step (xvfb-run, playwright test,
 * electron.launch, screenshot, ...) that a headless claude -p executor can
 * never satisfy (see the 776/779 exit143 incidents, 2026-07-30). Must key off
 * AC-checkbox context specifically — a PRD's Out-of-scope/notes prose telling
 * the executor NOT to do this (PRDs 780/787/788's pattern) must not trigger.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/queueOps-interactive-ac-lint.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lintOneAsync } = require('../queueOps.cjs');

function writeTmpPrd(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-lint-interactive-'));
  const p = path.join(dir, 'test-prd.md');
  const raw = `---\ntitle: "test"\ncwd: ~\nestimateMinutes: 10\n---\n\n${body}\n`;
  fs.writeFileSync(p, raw, 'utf8');
  return p;
}

test('flags a PRD with xvfb-run as an AC checkbox line', async () => {
  const p = writeTmpPrd(
    '# Acceptance criteria\n\n- [ ] `xvfb-run -a npx playwright test tests/e2e/foo.spec.ts` passes\n',
  );
  const { findings } = await lintOneAsync(p);
  expect(findings.some((f) => f.rule === 'interactive-xvfb')).toBe(true);
});

test('flags a PRD with playwright electron.launch as an AC checkbox line', async () => {
  const p = writeTmpPrd(
    '# Acceptance criteria\n\n- [ ] Playwright `electron.launch` boots the app and captures a screenshot of the Scheduler tab\n',
  );
  const { findings } = await lintOneAsync(p);
  expect(findings.some((f) => f.rule === 'interactive-electron-launch')).toBe(true);
});

test('does NOT flag Out-of-scope/notes prose that mentions xvfb without being a checkbox line', async () => {
  const p = writeTmpPrd(
    '# Acceptance criteria\n\n- [ ] `timeout 300 npm run typecheck` passes\n' +
    '- [ ] `timeout 300 npx vitest run src/foo.test.ts` passes\n\n' +
    'NOTE: do NOT add a `playwright test ... under xvfb` acceptance criterion here. Two prior\n' +
    'links in this chain stalled and were SIGTERM\'d (exit 143) on exactly that step — a headless\n' +
    '`claude -p` executor spawning `xvfb-run`/Playwright hits a tool-use rejection and hangs.\n\n' +
    '# Out of scope\n\n' +
    '- Making xvfb-run/Playwright actually work inside a headless claude -p job — out of scope\n',
  );
  const { findings } = await lintOneAsync(p);
  expect(findings.filter((f) => f.rule.startsWith('interactive-')).length).toBe(0);
});

test('a clean PRD with only typecheck/vitest AC is not flagged', async () => {
  const p = writeTmpPrd(
    '# Acceptance criteria\n\n- [ ] `timeout 300 npm run typecheck` passes\n' +
    '- [ ] `timeout 300 npx vitest run src/foo.test.ts` passes\n',
  );
  const { findings } = await lintOneAsync(p);
  expect(findings.filter((f) => f.rule.startsWith('interactive-')).length).toBe(0);
});
