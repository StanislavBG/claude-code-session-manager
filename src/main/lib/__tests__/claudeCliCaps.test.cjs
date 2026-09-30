'use strict';

// Run: timeout 120 npx vitest run src/main/lib/__tests__/claudeCliCaps.test.cjs

const assert = require('node:assert/strict');
const {
  headlessPermissionArgs,
  ensureCliCapsProbed,
  _setExecFileForTest,
  _resetForTest,
} = require('../claudeCliCaps.cjs');

beforeEach(() => {
  _resetForTest();
  _setExecFileForTest(null);
});

test('supported help text → flag args', async () => {
  _setExecFileForTest((_bin, _args, _opts, cb) => {
    cb(null, '--permission-prompts <mode>  Auto-deny prompts headlessly\n');
  });
  const args = await ensureCliCapsProbed();
  assert.deepEqual(args, ['--permission-prompts', 'none']);
  assert.deepEqual(headlessPermissionArgs(), ['--permission-prompts', 'none']);
});

test('unsupported help text → []', async () => {
  _setExecFileForTest((_bin, _args, _opts, cb) => {
    cb(null, '--dangerously-skip-permissions  Bypass permission checks\n');
  });
  const args = await ensureCliCapsProbed();
  assert.deepEqual(args, []);
  assert.deepEqual(headlessPermissionArgs(), []);
});

test('execFile error → []', async () => {
  _setExecFileForTest((_bin, _args, _opts, cb) => {
    cb(new Error('ENOENT'));
  });
  const args = await ensureCliCapsProbed();
  assert.deepEqual(args, []);
  assert.deepEqual(headlessPermissionArgs(), []);
});

test('second call does not re-probe', async () => {
  let calls = 0;
  _setExecFileForTest((_bin, _args, _opts, cb) => {
    calls += 1;
    cb(null, '--permission-prompts <mode>\n');
  });
  const first = await ensureCliCapsProbed();
  const second = await ensureCliCapsProbed();
  assert.deepEqual(first, ['--permission-prompts', 'none']);
  assert.deepEqual(second, ['--permission-prompts', 'none']);
  assert.equal(calls, 1);
  assert.deepEqual(headlessPermissionArgs(), ['--permission-prompts', 'none']);
});
