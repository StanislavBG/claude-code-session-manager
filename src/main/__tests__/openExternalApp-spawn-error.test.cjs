import { test, expect, vi } from 'vitest';
const Module = require('node:module');
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') return { shell: { openPath: async () => '' } };
  return origLoad.call(this, req, ...rest);
};
const { spawnDetached } = require('../lib/openExternalApp.cjs');
Module._load = origLoad;

test('non-existent command resolves ok:false with no uncaught exception', async () => {
  const onUncaught = vi.fn();
  process.on('uncaughtException', onUncaught);
  const r = await spawnDetached('sm-definitely-not-a-real-binary-xyz', ['/tmp']);
  await new Promise((res) => setTimeout(res, 20));
  process.off('uncaughtException', onUncaught);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/failed to launch/);
  expect(onUncaught).not.toHaveBeenCalled();
});

test('real command resolves ok:true with opener name', async () => {
  const r = await spawnDetached('true', []);
  expect(r).toEqual({ ok: true, opener: 'true' });
});
