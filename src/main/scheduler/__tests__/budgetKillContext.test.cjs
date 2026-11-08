/**
 * budgetKillContext.test.cjs — describeBudgetKillContext (did the budget kill
 * land inside the finish-protocol review, and what side effects had already
 * run) and the finish-review reason shape classifyBudgetKill builds from it.
 *
 * Run: timeout 120 npx vitest run src/main/scheduler/__tests__/budgetKillContext.test.cjs
 */
'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const budget = require('../budget.cjs');

const BASE_REASON = 'wall-clock budget exceeded: ran 45m against a 45m budget (estimateMinutes=0)';

function toolUse(id, name, input, parent = null) {
  return JSON.stringify({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name, input }] } });
}
function toolResult(id, isError = false, parent = null) {
  return JSON.stringify({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'ok' }] } });
}
const log = (...lines) => lines.join('\n') + '\n';

test('unanswered Skill code-review as the last tool call → inFinishReview true', () => {
  const ctx = budget.describeBudgetKillContext(log(
    toolUse('t1', 'Bash', { command: 'git commit -m x' }), toolResult('t1'),
    toolUse('t2', 'Skill', { skill: 'code-review', args: '--fix' }),
  ));
  assert.equal(ctx.inFinishReview, true);
  assert.equal(ctx.reviewSkill, 'code-review --fix');
});

test('subagent tool_use after the review Skill does not displace it as the last top-level call', () => {
  const ctx = budget.describeBudgetKillContext(log(
    toolUse('t2', 'Skill', { skill: 'code-review' }),
    toolUse('sub1', 'Read', { file_path: '/x' }, 't2'), toolResult('sub1', false, 't2'),
  ));
  assert.equal(ctx.inFinishReview, true);
  assert.equal(ctx.reviewSkill, 'code-review');
});

test('Skill code-review WITH a tool_result → inFinishReview false', () => {
  const ctx = budget.describeBudgetKillContext(log(
    toolUse('t2', 'Skill', { skill: 'code-review', args: '--fix' }), toolResult('t2'),
  ));
  assert.equal(ctx.inFinishReview, false);
  assert.equal(ctx.reviewSkill, null);
});

test('last tool call is Bash → inFinishReview false', () => {
  const ctx = budget.describeBudgetKillContext(log(
    toolUse('t2', 'Skill', { skill: 'code-review' }), toolResult('t2'),
    toolUse('t3', 'Bash', { command: 'npx vitest run' }),
  ));
  assert.equal(ctx.inFinishReview, false);
});

test('a non-review Skill does not count', () => {
  const ctx = budget.describeBudgetKillContext(log(toolUse('t1', 'Skill', { skill: 'simplify' })));
  assert.equal(ctx.inFinishReview, false);
});

test('security-review counts', () => {
  const ctx = budget.describeBudgetKillContext(log(toolUse('t1', 'Skill', { skill: 'security-review' })));
  assert.equal(ctx.inFinishReview, true);
  assert.equal(ctx.reviewSkill, 'security-review');
});

test('push/publish detection: succeeded ones listed, is_error true and unanswered excluded, deduped, capped and cut', () => {
  const long = `git push origin main ${'x'.repeat(200)}`;
  const ctx = budget.describeBudgetKillContext(log(
    toolUse('b1', 'Bash', { command: 'git push origin main' }), toolResult('b1'),
    toolUse('b2', 'Bash', { command: 'npm publish --access public' }), toolResult('b2', true),
    toolUse('b3', 'Bash', { command: 'npm publish' }), toolResult('b3'),
    toolUse('b4', 'Bash', { command: 'git push origin main' }), toolResult('b4'),
    toolUse('b5', 'Bash', { command: 'git status' }), toolResult('b5'),
    toolUse('b6', 'Bash', { command: 'git push --tags' }),
    toolUse('b7', 'Bash', { command: long }), toolResult('b7'),
    toolUse('b8', 'Bash', { command: 'git push a' }), toolResult('b8'),
    toolUse('b9', 'Bash', { command: 'git push b' }), toolResult('b9'),
    toolUse('b10', 'Bash', { command: 'git push c' }), toolResult('b10'),
    toolUse('s1', 'Skill', { skill: 'code-review', args: '--fix' }),
  ));
  assert.deepEqual(ctx.sideEffects, ['git push origin main', 'npm publish', long.slice(0, 120), 'git push a', 'git push b']);
  assert.equal(ctx.sideEffects[2].length, 120);
  assert.equal(ctx.inFinishReview, true);
});

test('malformed / non-JSON lines are skipped and junk input never throws', () => {
  const ctx = budget.describeBudgetKillContext([
    '{"type":"assistant","message":{"content":[{"typ', // torn tail start
    'plain stderr text',
    'null',
    '{"type":"assistant","message":null}',
    '{"type":"assistant","message":{"content":[null, 7]}}',
    toolUse('b1', 'Bash', { command: 'git push' }), toolResult('b1'),
    '{not json',
    toolUse('s1', 'Skill', { skill: 'code-review' }),
    '',
  ].join('\n'));
  assert.equal(ctx.inFinishReview, true);
  assert.deepEqual(ctx.sideEffects, ['git push']);
  for (const junk of [undefined, null, '', 42, {}]) {
    assert.deepEqual(budget.describeBudgetKillContext(/** @type {any} */ (junk)), { inFinishReview: false, reviewSkill: null, sideEffects: [] });
  }
});

const RES = { killedByWatchdog: 'budget', exitCode: 143, budgetKillReason: BASE_REASON };

test('non-review budget kill keeps today\'s reason exactly (no context, or inFinishReview false)', () => {
  assert.equal(budget.classifyBudgetKill(RES, 'abc1234def').reason, BASE_REASON);
  assert.equal(budget.classifyBudgetKill(RES, 'abc1234def', null).reason, BASE_REASON);
  assert.equal(budget.classifyBudgetKill(RES, null, { inFinishReview: false, reviewSkill: null, sideEffects: ['git push'] }).reason, BASE_REASON);
});

test('finish-review reason with landed commits and side effects', () => {
  const out = budget.classifyBudgetKill(RES, 'db5825d8aaaa', {
    inFinishReview: true,
    reviewSkill: 'code-review --fix',
    sideEffects: ['git push origin main', 'npm publish'],
    commits: [{ sha: 'db5825d8aaaabbbb', subject: 'chore(release): host-kit 0.11.0' }, { sha: '1234567890ab', subject: 'feat: x' }],
  });
  assert.equal(out.status, 'needs_review');
  assert.equal(out.landedCommit, 'db5825d8aaaa');
  assert.equal(out.reason,
    'wall-clock budget exceeded inside the finish-protocol review (/code-review --fix never returned): ran 45m against a 45m budget (estimateMinutes=0)'
    + '; work already landed: db5825d chore(release): host-kit 0.11.0, 1234567 feat: x'
    + '; side effects already run: git push origin main | npm publish');
});

test('finish-review reason with no commit landed and no side effects', () => {
  const out = budget.classifyBudgetKill(RES, null, { inFinishReview: true, reviewSkill: 'security-review', sideEffects: [] });
  assert.equal(out.reason,
    'wall-clock budget exceeded inside the finish-protocol review (/security-review never returned): ran 45m against a 45m budget (estimateMinutes=0); no commit landed on the job branch');
});

test('finish-review reason falls back to the landed sha alone when commits could not be read', () => {
  const out = budget.classifyBudgetKill(RES, 'db5825d8aaaa', { inFinishReview: true, reviewSkill: 'code-review', sideEffects: [], commits: null });
  assert.match(out.reason, /; work already landed: db5825d$/);
});

test('real-shaped compound commands: the entry is the push/publish segment itself', () => {
  const ctx = budget.describeBudgetKillContext(log(
    toolUse('b1', 'Bash', { command: 'cd /tmp/release && git add a b && git commit -m x && git push origin HEAD:main' }), toolResult('b1'),
    toolUse('b2', 'Bash', { command: 'cd pkg && test -f x.tgz && npm publish x.tgz --access public' }), toolResult('b2'),
    toolUse('b3', 'Bash', { command: 'cd pkg && npm publish --dry-run; git status' }), toolResult('b3', true),
    toolUse('s1', 'Skill', { skill: 'code-review' }),
  ));
  assert.deepEqual(ctx.sideEffects, ['git push origin HEAD:main', 'npm publish x.tgz --access public']);
});

test('two matching segments in one command give two entries; separators ;, ||, | and newline split too', () => {
  const ctx = budget.describeBudgetKillContext(log(
    toolUse('b1', 'Bash', { command: 'git push origin HEAD:main && npm publish --access public' }), toolResult('b1'),
    toolUse('b2', 'Bash', { command: 'git push origin HEAD:main; echo ok\ngit push --tags || true | cat' }), toolResult('b2'),
  ));
  assert.deepEqual(ctx.sideEffects, ['git push origin HEAD:main', 'npm publish --access public', 'git push --tags']);
});

test('finish-review reason cuts a long reviewSkill to 80 chars plus an ellipsis', () => {
  const skill = `code-review --fix ${Array.from({ length: 6 }, (_, i) => `src/main/scheduler/some/long/path/file${i}.cjs`).join(' ')}`;
  const out = budget.classifyBudgetKill(RES, null, { inFinishReview: true, reviewSkill: skill, sideEffects: [] });
  assert.ok(out.reason.startsWith(`wall-clock budget exceeded inside the finish-protocol review (/${skill.slice(0, 80)}… never returned): `));
  const short = budget.classifyBudgetKill(RES, null, { inFinishReview: true, reviewSkill: 'x'.repeat(80), sideEffects: [] });
  assert.ok(short.reason.includes(`(/${'x'.repeat(80)} never returned)`));
});

test('classifyBudgetKill still returns null for a non-budget outcome', () => {
  assert.equal(budget.classifyBudgetKill({ killedByWatchdog: null, exitCode: 1 }, null, { inFinishReview: true }), null);
});
