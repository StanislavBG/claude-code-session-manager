'use strict';
// The job sandbox sets NODE_USE_ENV_PROXY=1; tests/setup/schedulerSandbox.cjs must scrub it
// so spawned node children do not print an UNDICI-EHPA warning on stderr.
// vitest globals (describe/it/expect)
const { spawnSync } = require('node:child_process');

describe('scheduler sandbox env scrub', () => {
  it('NODE_USE_ENV_PROXY is unset inside a test', () => {
    expect(process.env.NODE_USE_ENV_PROXY).toBeUndefined();
  });
  it('a spawned node child prints empty stderr', () => {
    const r = spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},10)'], { env: process.env, encoding: 'utf8' });
    expect(r.stderr).toBe('');
  });
});
