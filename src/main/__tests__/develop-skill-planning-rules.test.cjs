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

test('gate must not write tracked files (PRD_AUTHORING.md §6 and §14; SKILL.md points there)', () => {
  const s = flat(skill());
  expect(s).toMatch(/syntax rules for `gate` and `files` are in PRD_AUTHORING\.md §6/);
  expect(s).not.toMatch(/Do not start a word with `#` or `~`/);
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
  const a = flat(authoring());
  expect(a).toMatch(/never runs two PRDs with overlapping files at once \(held as `files-overlap`\)/);
  expect(a).toMatch(/`worktreeSetup`/);
  expect(a).toMatch(/--path/);
  expect(a).toMatch(/worktree setup:/);
});

test('rule 6 No residue names the four outcomes and limits Needs you', () => {
  const s = flat(skill());
  const rules = s.slice(s.indexOf('## Rules that always apply'), s.indexOf('## Phase 1'));
  expect(rules).toMatch(/6\. \*\*No residue\.\*\*/);
  expect(rules).toMatch(/\*\*queued\*\* \(its PRD slug\)/);
  expect(rules).toMatch(/\*\*decided\*\* \(what you chose and a one-line revert\)/);
  expect(rules).toMatch(/\*\*scheduled\*\* \(what fires it later/);
  expect(rules).toMatch(/\*\*closed\*\* \(a one-line reason\)/);
  expect(rules).toMatch(/needs the human's own hands or authority/);
  for (const w of ['sudo', 'a vendor agreement', 'a 2FA code', 'a public publish nobody approved', 'a switch the project laws reserve for a human']) {
    expect(rules).toContain(w);
  }
  expect(rules).toMatch(/Never write "deferred", "follow-up for later", "needs a new Epic from you" or "say the word"/);
  expect(rules).toMatch(/Why: a list nobody owns becomes debt/);
});

test('PLAN SETTLED fix wave and Done cover every severity', () => {
  const s = flat(skill());
  expect(s).toMatch(/a finding at any severity \(Critical, Important or Minor\), means a fix wave/);
  expect(s).toMatch(/A finding with nothing to fix gets a one-line close reason in the report instead\./);
  expect(s).toMatch(/every finding at every severity is fixed or closed with a reason/);
  expect(s).not.toMatch(/no Critical or Important finding is open/);
  expect(s).toMatch(/Never "done with caveats"/);
});

test('Final report has exactly Landed, Decided, Queued, Scheduled, Needs you', () => {
  const raw = skill();
  const sec = raw.slice(raw.indexOf('### Final report'), raw.indexOf('## Never'));
  const items = sec.split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => l.match(/^\d+\. \*\*([^:*]+):/)?.[1]);
  expect(items).toEqual(['Landed', 'Decided', 'Queued', 'Scheduled', 'Needs you']);
  expect(sec).not.toMatch(/Minor findings deferred|Anything still open|Any warning kept/);
  expect(flat(sec)).toMatch(/Expected API warnings and skipped optional steps are not reported\./);
});
