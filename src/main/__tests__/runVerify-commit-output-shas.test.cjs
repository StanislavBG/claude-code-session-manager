/**
 * parseLog transcriptCommitOutputShas — SHAs git printed for a `git commit` Bash call.
 */
import { test, afterAll } from 'vitest';
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { parseLog, commitMessageSubjects } = require('../runVerify.cjs');

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

test('sibling subject that is only a substring of the command is not collected', () => {
  const cmd = 'git add src/main/some-long-path-name && git commit -m "feat: real subject line" -m "Co-Authored-By: Claude <x>"';
  const out = '4444444 some-long-path-name\n5555555 Co-Authored-By: Claude\n6666666 feat: real subject line';
  assert.deepEqual(run('substr', cmd, out).transcriptCommitOutputShas, ['6666666']);
});

test('heredoc -m message is matched on its first line', () => {
  const cmd = "git commit -m \"$(cat <<'EOF'\nfix(x): heredoc subject line\n\nbody text\nEOF\n)\"";
  const out = '7777777 fix(x): heredoc subject line\n8888888 body text here';
  assert.deepEqual(run('heredoc', cmd, out).transcriptCommitOutputShas, ['7777777']);
});

test('single-quoted and --message= forms', () => {
  const cmd = "git commit -m 'single quoted subj' --message=\"eq form subject\"";
  const out = '9999999 single quoted subj\naaaaaaa eq form subject\nbbbbbbb quoted';
  assert.deepEqual(run('forms', cmd, out).transcriptCommitOutputShas, ['9999999', 'aaaaaaa']);
});

test('-am / -qam short-flag clusters and attached -m"subj" values are collected', () => {
  const out = 'cccccc1 fix: a thing here\nddddddd other sibling subject';
  assert.deepEqual(run('am', 'git commit -am "fix: a thing here"', out).transcriptCommitOutputShas, ['cccccc1']);
  assert.deepEqual(run('qam', 'git commit -qam "fix: a thing here"', out).transcriptCommitOutputShas, ['cccccc1']);
  assert.deepEqual(run('attached', 'git commit -m"fix: a thing here"', out).transcriptCommitOutputShas, ['cccccc1']);
  assert.deepEqual(run('attached-sq', "git commit -m'fix: a thing here'", out).transcriptCommitOutputShas, ['cccccc1']);
});

test('clusters not ending in m and long options containing m yield no subject', () => {
  const out = 'eeeeee1 fix: a thing here';
  assert.deepEqual(run('F', 'git commit -a -F "fix: a thing here"', out).transcriptCommitOutputShas, []);
  assert.deepEqual(run('amend', 'git commit --amend "fix: a thing here"', out).transcriptCommitOutputShas, []);
  assert.deepEqual(run('noverify', 'git commit --no-verify "fix: a thing here"', out).transcriptCommitOutputShas, []);
});

test('clusters where a value-taking letter precedes m (-Cm, -Fm) yield no subject', () => {
  assert.deepEqual(commitMessageSubjects('git commit -Cm "x subj here"'), []);
  assert.deepEqual(commitMessageSubjects('git commit -Fm "x subj here"'), []);
  assert.deepEqual(commitMessageSubjects('git commit -cm "x subj here"'), []);
  assert.deepEqual(commitMessageSubjects('git commit -tm "x subj here"'), []);
  assert.deepEqual(commitMessageSubjects('git commit -am "x subj here"'), ['x subj here']);
  assert.deepEqual(commitMessageSubjects('git commit -sm "x subj here"'), ['x subj here']);
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
