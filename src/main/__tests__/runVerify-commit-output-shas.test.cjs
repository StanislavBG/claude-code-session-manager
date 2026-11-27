/**
 * parseLog transcriptCommitOutputShas — SHAs git printed for a `git commit` Bash call.
 */
import { test, afterAll } from 'vitest';
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { parseLog } = require('../runVerify.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-verify-output-shas-'));
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

function run(name, command, output, toolName = 'Bash') {
  const p = path.join(dir, name + '.log');
  const lines = [
    '[scheduler] starting',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: toolName, input: { command } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: output }] } }),
  ];
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return parseLog(p);
}

test('Self 1458 shape: git log --oneline -1 line whose subject is in the command', () => {
  const subj = 'fix(email): undo groom restores only exact-note delete_rule row';
  const cmd = `git add a b && git commit -q -m "${subj}" -m "Co-Authored-By: X" && git log --oneline -1`;
  const r = run('self1458', cmd, `5b526d8 ${subj}`);
  assert.deepEqual(r.transcriptCommitOutputShas, ['5b526d8']);
  assert.deepEqual(r.transcriptCommitShas, []);
  assert.equal(r.transcriptCommitLanded, false);
});

test('commit summary line shape, incl. root-commit, deduped', () => {
  const r = run('summary', 'git commit -m "subj"', '[main abc1234] subj\n 1 file changed\n[main (root-commit) ABC1234] subj');
  assert.deepEqual(r.transcriptCommitOutputShas, ['abc1234']);
  const r2 = run('root', 'git -C /x commit -m "subj"', '[feat/x (root-commit) deadbeef01] first');
  assert.deepEqual(r2.transcriptCommitOutputShas, ['deadbeef01']);
});

test('git log -5 sibling commits are not collected', () => {
  const cmd = 'git commit -m "my own change here" && git log --oneline -5';
  const out = '1111111 sibling one subject\n2222222 another sibling subject\n3333333 my own change here';
  assert.deepEqual(run('siblings', cmd, out).transcriptCommitOutputShas, ['3333333']);
});

test('non-commit command is ignored', () => {
  const r = run('noncommit', 'git log --oneline -3', '[main abc1234] subj\nabc1234 subj subject');
  assert.deepEqual(r.transcriptCommitOutputShas, []);
});

test('missing log file yields []', () => {
  const r = parseLog(path.join(dir, 'nope.log'));
  assert.ok(r.error);
  assert.deepEqual(r.transcriptCommitOutputShas, []);
});
