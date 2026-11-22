/**
 * builder-skill-preflight-doc.test.cjs — doc drift check: the builder skill runs the publish
 * preflight before step 4's version bump, and the script it names exists.
 * Run: timeout 120 npx vitest run scripts/__tests__/builder-skill-preflight-doc.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');

const SKILL_DIR = path.resolve(__dirname, '../../plugins/session-manager-dev/skills/builder');
const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');

test('SKILL.md names the preflight script and its BLOCKED line', () => {
  expect(skill).toContain('scripts/publish-preflight.cjs');
  expect(skill).toContain('NPM_PUBLISH_PREFLIGHT: BLOCKED');
});

test('the preflight is mentioned before the version bump', () => {
  const preflight = skill.indexOf('publish-preflight.cjs');
  const bump = skill.indexOf('npm version <bump> --no-git-tag-version');
  expect(preflight).toBeGreaterThan(-1);
  expect(bump).toBeGreaterThan(-1);
  expect(preflight).toBeLessThan(bump);
});

test('the named preflight script exists on disk', () => {
  expect(fs.existsSync(path.join(SKILL_DIR, 'scripts/publish-preflight.cjs'))).toBe(true);
});
