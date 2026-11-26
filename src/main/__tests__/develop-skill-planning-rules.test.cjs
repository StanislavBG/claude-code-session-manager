/**
 * develop-skill-planning-rules.test.cjs — drift guard for five planning rules in the
 * /develop skill and PRD_AUTHORING.md (art tag, gate purity, test-file allowance,
 * plan-review wording, validate criteria by slug).
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

test('step 4 holds plans for the independent plan review; rule 13 and Phase 2 name it', () => {
  const s = flat(skill());
  expect(s).not.toMatch(/completeness pass/);
  expect(s).toMatch(/held for|held: plan-review/);
  expect(s).toMatch(/SM_PLAN_REVIEW=0/);
  expect(s).toMatch(/SM_PLAN_REVIEW_HOLD_MINUTES/);
  expect(s).toMatch(/plan reviewer reviews before dispatch and the validator after/);
  expect(s).toMatch(/PLAN REVIEWED digest/);
  expect(s).toMatch(/scheduler_release_plan/);
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

test('step 1 decides instead of asking and never repeats an unanswered question', () => {
  const s = flat(skill());
  const step1 = s.slice(s.indexOf('1. **Clarify only what a wrong guess'), s.indexOf('2. **Explore broadly.**'));
  expect(step1).toMatch(/Clarify only what a wrong guess would cost rework on\./);
  expect(step1).toMatch(/Never use AskUserQuestion\./);
  expect(step1).toMatch(
    /Decide instead of asking when the human's own words, the project laws or memory, or the code already settle the choice, or when git can revert a wrong guess; report it under Decided \(rule 6\)\./
  );
  expect(step1).toMatch(
    /Ask only about what is irreversible outside git \(data loss, a public publish, money, contacting people\) or what the project laws reserve for the human\./
  );
  expect(step1).toMatch(
    /Never repeat an unanswered question in a later turn: take the option you recommended, unless the choice is reserved\./
  );
});

test('Plan objective queues off-goal defects as side plans in this Epic', () => {
  const s = flat(skill());
  const obj = s.slice(s.indexOf('### Plan objective'), s.indexOf('### Preflight'));
  expect(obj).toMatch(
    /A defect you find in this project outside the Epic's goal is such a second plan, queued in this Epic \(a side plan with its own `Validate: <goal>` PRD\); the Epic's title and objective stay unchanged\./
  );
  expect(obj).toMatch(/Never hand it back as needing a new Epic\./);
  expect(obj).toMatch(/A defect in another project goes to `\/send-feedback`\./);
});

test('step 6 queues left-out gaps as later waves or holds, never "stage 2"', () => {
  const s = flat(skill());
  const step6 = s.slice(s.indexOf('6. **Pick a shape.**'), s.indexOf('7. **Keep each PRD small**'));
  expect(step6).toMatch(
    /A gap you leave out of the first plan is queued in the same turn as a later wave that `dependsOn` the PRDs it builds on, or held by `preflight` or a date when it must wait for something\./
  );
  expect(step6).toMatch(/Never list it as "not covered" or "stage 2"\./);
});

test('step 12 names a warning only when a PRD changed because of it', () => {
  const s = flat(skill());
  const step12 = s.slice(s.indexOf('12. **Read the warnings'), s.indexOf('13. **Never stop for review'));
  expect(step12).toMatch(
    /Then post one short message: each PRD's number and slug, the validate slug, and that no per-PRD check will come from this session\. Name a warning only if you changed a PRD because of it\./
  );
  expect(step12).not.toMatch(/the warnings you kept/);
  expect(s).not.toMatch(/none-gate warning and its size warning \(8 or more criteria\) are expected/);
});

test('preflight Rule lines: no shell / --env-file, TMPDIR, and marker path names the step', () => {
  const a = authoring();
  const sec = flat(a.slice(a.indexOf('### preflight'), a.indexOf('### What the API writes')));
  expect(sec).toMatch(/Rule: no shell runs it, so it cannot `source` a file/);
  expect(sec).toMatch(/Node's `--env-file` expands no variables/);
  expect(sec).toMatch(/put `NAME=value` words before `timeout`/);
  expect(sec).toMatch(/The scheduler sets `TMPDIR` itself and drops a `TMPDIR=` word/);
  expect(sec).toMatch(/check a marker file whose path names the step/);
  expect(sec).toMatch(/`test -f \/abs\/path\/apple-paid-apps-agreement-accepted`/);
  expect(sec).toMatch(/The PRECONDITION HOLD notice prints the command, so that path is what tells the person what to do/);
  expect(sec).not.toMatch(/names that one action/);
});

test('step 5 puts the Field Manual chapter inside the plan as a sibling doc PRD', () => {
  const s = flat(skill());
  const step5 = s.slice(s.indexOf("5. **Tests and security go inside the feature's own PRD**"), s.indexOf('6. **Pick a shape.**'));
  expect(step5).toMatch(/When the project has a Field Manual \(`session-manager-operations\/manual\/manual\.json` exists\)/);
  expect(step5).toMatch(/a plan that ships or changes a user-visible surface includes one sibling `doc` PRD that writes or revises its chapter under `session-manager-operations\/manual\/chapters\/`/);
  expect(step5).toMatch(/covered by the plan's `validate` PRD/);
  expect(step5).toMatch(/Skip it when the project has no `manual\.json`\./);
  expect(step5).toMatch(/a release never finds a gap/);
});
