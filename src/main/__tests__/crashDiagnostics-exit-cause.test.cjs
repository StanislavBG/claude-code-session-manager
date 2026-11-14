import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test, expect, beforeEach, afterEach } from 'vitest';

const require = createRequire(import.meta.url);
const { checkPreviousRun } = require('../crashDiagnostics.cjs');
const { classifyUncleanShutdown } = require('../lib/telemetry/crashTelemetry.cjs');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exitcause-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function run({ open = true, exit, stderr, scope, platform = 'linux', sampleTs = new Date().toISOString(), uptime } = {}) {
  const sentinelPath = path.join(dir, 'last-run.json');
  fs.writeFileSync(sentinelPath, JSON.stringify({ open, pid: 4242, startedAt: 't', lastSample: { totalMb: 100, ts: sampleTs } }));
  if (exit) fs.writeFileSync(path.join(dir, 'main-exit.jsonl'), exit.map((e) => JSON.stringify(e)).join('\n') + '\n');
  if (stderr !== undefined) fs.writeFileSync(path.join(dir, 'electron-stderr.log'), stderr);
  const lines = []; const reports = []; const calls = [];
  checkPreviousRun({
    sentinelPath, platform,
    ...(uptime !== undefined ? { uptime: () => uptime } : {}),
    logs: { writeLine: (l) => lines.push(l) },
    reportCrash: (r) => reports.push(r),
    spawnSync: (...a) => { calls.push(a); return scope === undefined ? { error: new Error('x'), status: null } : { status: 0, stdout: scope + '\n' }; },
  });
  return { lines, reports, calls };
}

test('classify: compositor-disconnect, signal, then existing rules', () => {
  expect(classifyUncleanShutdown({ stderrTail: 'x Fatal Wayland communication error y', exitRecord: { signal: 'SIGTERM' } })).toBe('compositor-disconnect');
  expect(classifyUncleanShutdown({ exitRecord: { signal: 'SIGKILL' }, lastTotalMb: 9999 })).toBe('signal:SIGKILL');
  expect(classifyUncleanShutdown({ exitRecord: { signal: null }, lastLoopDelayMaxMs: 20000 })).toBe('main-hang');
  expect(classifyUncleanShutdown({ lastTotalMb: 4000 })).toBe('memory-pressure');
  expect(classifyUncleanShutdown({})).toBe('unknown');
});

test('wayland stderr tail names compositor-disconnect', () => {
  const { lines, reports } = run({ stderr: 'a'.repeat(40000) + 'Fatal Wayland communication error' });
  expect(lines[0].meta.likelyCause).toBe('compositor-disconnect');
  expect(reports[0].meta.likelyCause).toBe('compositor-disconnect');
});

test('exit record signal for prev pid names signal cause, no extra fields', () => {
  const { lines, reports } = run({ exit: [{ pid: 1, signal: 'SIGHUP' }, { pid: 4242, code: null, signal: 'SIGKILL', uptimeMs: 5, path: '/secret' }] });
  expect(lines[0].meta.likelyCause).toBe('signal:SIGKILL');
  expect(reports[0].meta.exitRecord).toEqual({ code: null, signal: 'SIGKILL', uptimeMs: 5 });
  expect(JSON.stringify(reports[0])).not.toContain('/secret');
});

test('oom-kill scope logs oom-scope-stop even when sentinel is clean', () => {
  const { lines, calls } = run({ open: false, scope: 'oom-kill' });
  expect(lines).toHaveLength(1);
  expect(lines[0].level).toBe('error');
  expect(lines[0].message).toContain('oom-scope-stop');
  expect(calls[0][1]).toContain('app-claude-code-session-manager-4242.scope');
});

test('missing files, no systemctl: unknown, no throw', () => {
  const { lines, reports } = run({});
  expect(lines[0].meta.likelyCause).toBe('unknown');
  expect(reports[0].reason).toBe('unclean-shutdown:unknown');
  expect(lines[0].meta.exitRecord).toBeNull();
});

test('postmortem is named by its cause; context keeps likelyCause', () => {
  const { reports } = run({ exit: [{ pid: 4242, signal: 'SIGKILL' }] });
  expect(reports[0].reason).toBe('unclean-shutdown:signal:SIGKILL');
  expect(reports[0].meta.likelyCause).toBe('signal:SIGKILL');
  expect(`crash.${reports[0].reason}`.length).toBeLessThan(60);
});

test('machine booted after the last sample: os-restart', () => {
  const sampleTs = new Date(Date.now() - 3600 * 1000).toISOString();
  const { lines, reports } = run({ sampleTs, uptime: 120 });
  expect(lines[0].meta.likelyCause).toBe('os-restart');
  expect(lines[0].meta.bootUptimeSec).toBe(120);
  expect(reports[0].reason).toBe('unclean-shutdown:os-restart');
  expect(reports[0].meta.likelyCause).toBe('os-restart');
  expect(reports[0].meta.bootUptimeSec).toBe(120);
  // Up longer than the sample age: not a reboot.
  expect(run({ sampleTs, uptime: 7200 }).reports[0].reason).toBe('unclean-shutdown:unknown');
});

test('non-linux skips systemctl; success scope result is not an oom line', () => {
  expect(run({ open: false, platform: 'darwin', scope: 'oom-kill' }).calls).toHaveLength(0);
  expect(run({ open: false, scope: 'success' }).lines).toHaveLength(0);
});
