'use strict';

// Run: timeout 120 npx vitest run src/main/lib/__tests__/claudeCliCaps.test.cjs

const assert = require('node:assert/strict');
const {
  headlessPermissionArgs,
  ensureCliCapsProbed,
  _setExecFileForTest,
  _resetForTest,
  _setReprobeBackoffMsForTest,
} = require('../claudeCliCaps.cjs');
const claudeBinLib = require('../claudeBin.cjs');

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

test('a probe error is never cached: an immediate second call still gets [] (within the backoff window), but a call after the backoff window re-probes for real', async () => {
  _setReprobeBackoffMsForTest(20);
  let calls = 0;
  _setExecFileForTest((_bin, _args, _opts, cb) => {
    calls += 1;
    cb(new Error('ENOENT'));
  });
  const first = await ensureCliCapsProbed();
  assert.deepEqual(first, []);
  assert.equal(calls, 1);

  // Still inside the backoff window — must not spawn again.
  const second = await ensureCliCapsProbed();
  assert.deepEqual(second, []);
  assert.equal(calls, 1);

  // Past the backoff window and the binary now works — this call must
  // actually re-probe (not stay wedged on a permanently-cached error) and
  // this time land a real, cacheable success.
  await new Promise((resolve) => setTimeout(resolve, 30));
  _setExecFileForTest((_bin, _args, _opts, cb) => {
    calls += 1;
    cb(null, '--permission-prompts <mode>\n');
  });
  const third = await ensureCliCapsProbed();
  assert.deepEqual(third, ['--permission-prompts', 'none']);
  assert.equal(calls, 2);

  // The successful result is now cached — a further call must not re-probe.
  const fourth = await ensureCliCapsProbed();
  assert.deepEqual(fourth, ['--permission-prompts', 'none']);
  assert.equal(calls, 2);
});

test('probes via claudeSpawnTarget — the same spawn target real headless spawn sites use — not a bare resolveClaudeBin() call', async () => {
  const spy = vi.spyOn(claudeBinLib, 'claudeSpawnTarget');
  let capturedCommand = null;
  _setExecFileForTest((command, _args, _opts, cb) => {
    capturedCommand = command;
    cb(null, '--permission-prompts <mode>\n');
  });
  await ensureCliCapsProbed();
  expect(spy).toHaveBeenCalledWith('aux', expect.any(String), expect.any(String));
  const target = spy.mock.results[0].value;
  assert.equal(capturedCommand, target.command);
  spy.mockRestore();
});
