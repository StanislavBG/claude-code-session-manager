// Real `systemd-run --scope` execs the job in place: pid + start time survive,
// cmdline changes. isDifferentProcess must therefore stay false.
import { describe, it, expect } from 'vitest';

const { spawn } = require('node:child_process');
const { identity, isDifferentProcess } = require('../procIdentity.cjs');
const memoryScope = require('../memoryScope.cjs');

const supported = memoryScope.scopeSupported();

describe('procIdentity across systemd-run --scope exec', () => {
  it.skipIf(!supported)('same pid + startTicks after exec is not a different process', async () => {
    const unit = `sm-procid-exec-${process.pid}-${Date.now()}.scope`;
    const child = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, '--', 'sleep', '3'], { stdio: 'ignore' });
    try {
      const recorded = identity(child.pid);
      let live = identity(child.pid);
      const deadline = Date.now() + 3000;
      while (live.cmdline === recorded.cmdline && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        live = identity(child.pid);
      }
      expect(live.pid).toBe(recorded.pid);
      expect(isDifferentProcess(recorded, live)).toBe(false);
    } finally {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
  }, 10000);
});
