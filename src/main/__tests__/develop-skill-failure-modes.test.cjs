/**
 * develop-skill-failure-modes.test.cjs — drift guard for the two
 * scheduler_create_prd failure-mode branches in the /develop skill.
 *
 * PRD 1024-1030 incident (2026-08-08): social-signals-trader's session
 * hand-wrote 7 PRDs because scheduler_create_prd was ABSENT from its tool
 * list (the project's .mcp.json didn't register the server yet) — not
 * because the tool errored as unreachable. The old wording only named the
 * "tool errors ... unreachable" case, which an absent tool never matches,
 * so an agent in that situation had no documented path except hand-writing.
 * This test asserts the fix (two named failure modes, with the absent-tool
 * case explicitly forbidding hand-writing) is present and doesn't silently
 * regress back to the single-case wording.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/develop-skill-failure-modes.test.cjs
 */

'use strict';

const fs = require('fs');
const path = require('path');

import { test, expect } from 'vitest';

const SKILL_MD = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'plugins',
  'session-manager-dev',
  'skills',
  'develop',
  'SKILL.md'
);

function readSkill() {
  return fs.readFileSync(SKILL_MD, 'utf8');
}

test('SKILL.md names both failure modes explicitly', () => {
  const text = readSkill();
  expect(text).toMatch(/tool PRESENT but ERRORS/i);
  expect(text).toMatch(/tool ABSENT from your tool list/i);
});

test('the absent-tool branch explicitly forbids hand-writing and says STOP', () => {
  const text = readSkill();
  const absentIdx = text.search(/tool ABSENT from your tool list/i);
  expect(absentIdx).toBeGreaterThan(-1);
  const nearby = text.slice(absentIdx, absentIdx + 1200);
  expect(nearby).toMatch(/STOP/);
  expect(nearby).toMatch(/[Dd]o not write any PRD file/);
  expect(nearby).toMatch(/misconfiguration/i);
});

test('the present-but-erroring branch is the only one pointed at the manual-write fallback', () => {
  const text = readSkill();
  expect(text).toMatch(/Fallback for case \(a\) only/);
});

test('the standalone preflight check appears before PRD composition begins', () => {
  const text = readSkill();
  expect(text).toMatch(/Preflight — confirm the tool is even in your tool list/);
});

test('a preflight-tool-registration fix is named for the human (user-scope claude mcp add)', () => {
  const text = readSkill();
  expect(text).toMatch(/claude mcp add session-manager-scheduler --scope\s*\n?\s*user/);
});
