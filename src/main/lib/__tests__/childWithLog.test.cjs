// PRD 1065 — post-exit process-group sweep. A detached job's descendants must
// not outlive the job (2026-08-31 starry-night-ships incident: orphaned test
// batteries reparented to init after their job exited normally).
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { openLog, withChildAndLog, POST_EXIT_GROUP_SWEEP_GRACE_MS } = require('../childWithLog.cjs');

let dir;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('childWithLog post-exit group sweep (PRD 1065)', () => {
  it.skipIf(process.platform !== 'linux')(
    'kills a detached child\'s backgrounded grandchild after exit + grace',
    async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-child-sweep-'));
      const logPath = path.join(dir, 'job.log');
      const pidFile = path.join(dir, 'grandchild.pid');
      const { fd, safeLog, closeFd } = openLog(logPath);

      const exited = new Promise((resolve) => {
        withChildAndLog({
          fd,
          logPath,
          safeLog,
          closeFd,
          spawn: {
            command: 'sh',
            args: [
              '-c',
              `sleep 30 & echo $! > ${pidFile}; exec sleep 0.2`,
            ],
            options: { detached: true },
          },
          onExit: () => resolve(),
        });
      });

      await exited;

      // Grandchild pid file is written by a backgrounded subshell that may
      // race the parent's own exit; give it a moment to land.
      for (let i = 0; i < 20 && !fs.existsSync(pidFile); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(fs.existsSync(pidFile)).toBe(true);
      const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      expect(Number.isInteger(grandchildPid) && grandchildPid > 1).toBe(true);

      // Wait past the SIGTERM->SIGKILL grace window.
      await new Promise((r) => setTimeout(r, POST_EXIT_GROUP_SWEEP_GRACE_MS + 1000));

      expect(() => process.kill(grandchildPid, 0)).toThrow();
    },
    15000,
  );
});
