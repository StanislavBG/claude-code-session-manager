/**
 * develop-skill-planning-rules.test.cjs — drift guard for five planning rules in the
 * /develop skill and PRD_AUTHORING.md (art tag, gate purity, test-file allowance,
 * completeness-pass timing, validate criteria by slug).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/develop-skill-planning-rules.test.cjs
 */

'use strict';

const fs = require('fs');
const path = require('path');

import { test, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const skill = () =>
  fs.readFileSync(
    path.join(ROOT, 'plugins', 'session-manager-dev', 'skills', 'develop', 'SKILL.md'),
    'utf8'
  );
const authoring = () =>
  fs.readFileSync(path.join(ROOT, 'src', 'main', 'templates', 'PRD_AUTHORING.md'), 'utf8');

const flat = (s) => s.replace(/\s+/g, ' ');

test('rule 2 and step 10 treat art like feature and bug', () => {
  const s = flat(skill());
  expect(s).toMatch(/On a `feature`, `bug` or `art` Epic, PRDs are the expected path/);
  expect(s).toMatch(/Queue at once when the Epic is `feature`, `bug` or `art` and scope is clear/);
});

test('gate must not write tracked files (SKILL.md, PRD_AUTHORING.md §6 and §14)', () => {
  const s = flat(skill());
  expect(s).toMatch(/gate command must not create or modify tracked files/);
  expect(s).toMatch(/per-gate TMPDIR or a gitignored path/);
  const a = authoring();
  const sec6 = a.slice(a.indexOf('## §6'), a.indexOf('## §7'));
  expect(flat(sec6)).toMatch(/gate command must not create or modify tracked files/);
  expect(flat(sec6)).toMatch(/per-gate TMPDIR or a gitignored path/);
  const sec14 = a.slice(a.indexOf('## §14'));
  expect(flat(sec14)).toMatch(/must not create or modify tracked files/);
});

test('step 7 exempts lockstep test files from the file limit', () => {
  expect(flat(skill())).toMatch(
    /Test files edited or added in lockstep with the PRD's own code do not count toward the 3-edited \/ 1-new file limit/
  );
});

test('step 4 starts the completeness pass in the background with the turn deadline', () => {
  const s = flat(skill());
  expect(s).toMatch(/background sub-agent as soon as the draft list exists/);
  expect(s).toMatch(/keep exploring while it runs/);
  expect(s).toMatch(/hard-killed at 30 minutes with a warning at 24/);
  expect(s).toMatch(/late gaps become sibling PRDs/);
});

test('validate criterion 4 cites PRDs by slug, no NN in the path', () => {
  const s = skill();
  expect(flat(s)).toMatch(/find it by slug under prds\/ or prds-archived\//);
  expect(s).not.toMatch(/prds\/<NN>-<slug>\.md/);
});

test('batch create, validated update fields and files-overlap are documented', () => {
  const s = flat(skill());
  expect(s).toMatch(/one `scheduler_create_prds` call; `dependsOn` may name other entries of that call/);
  expect(s).toMatch(/only if the batch tool is absent/);
  expect(s).toMatch(/in a single `scheduler_create_prd`, `dependsOn` accepts only slugs that already exist/i);
  expect(s).toMatch(/`gate`, `files` and `acceptanceCriteria` fields are validated and re-rendered/);
  expect(s).not.toMatch(/does not check them|copy the `# Gate` and/);
  expect(s).toMatch(/never runs two PRDs with overlapping files at once \(held as `files-overlap`\)/);
  const a = flat(authoring());
  expect(a).toMatch(/never runs two PRDs with overlapping files at once \(held as `files-overlap`\)/);
  expect(a).toMatch(/`worktreeSetup`/);
});
