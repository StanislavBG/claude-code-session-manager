// The leak report comes from the job-marker scan, not a process-group ps.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { listJobSurvivors } = require('../lib/scheduler/jobLeftovers.cjs');

function addProc(root, pid, { slug, ppid = 1, pgrp, session, comm = 'node', startTicks = 100 }) {
  const dir = path.join(root, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  const tail = [ 'S', ppid, pgrp, session, 0, 0, 0, 0, 0, 0, 0, 5, 5, 0, 0, 20, 0, 1, 0, startTicks ];
  fs.writeFileSync(path.join(dir, 'stat'), `${pid} (${comm}) ${tail.join(' ')} 0 0 0\n`);
  fs.writeFileSync(path.join(dir, 'environ'), `PATH=/bin\0SM_SCHEDULER_JOB_SLUG=${slug}\0`);
  fs.writeFileSync(path.join(dir, 'cmdline'), `${comm}\0`);
}

describe('listJobSurvivors', () => {
  it('reports a survivor in a different session/group and excludes the job pid and other slugs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-leak-report-'));
    try {
      fs.writeFileSync(path.join(root, 'uptime'), '1000.00 0\n');
      addProc(root, 500, { slug: 'job-a', pgrp: 500, session: 500, comm: 'claude' });
      addProc(root, 601, { slug: 'job-a', pgrp: 601, session: 601, comm: 'tsx' }); // setsid escapee
      addProc(root, 700, { slug: 'job-b', pgrp: 700, session: 700, comm: 'vite' });
      const out = listJobSurvivors('job-a', 500, { procRoot: root, platform: 'linux' });
      expect(out.map((p) => p.pid)).toEqual([601]);
      expect(out[0].comm).toBe('tsx');
      expect(typeof out[0].pcpu).toBe('number');
      expect(typeof out[0].etimes).toBe('number');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns [] off linux', () => {
    expect(listJobSurvivors('job-a', 1, { platform: 'win32' })).toEqual([]);
  });
});
