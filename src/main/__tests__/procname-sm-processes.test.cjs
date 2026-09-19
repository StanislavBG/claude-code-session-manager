/**
 * procname-sm-processes.test.cjs — PRD pn-03: Session Manager's own processes
 * (main, MCP server, watchdog, inhibit holder, terminal shells) get
 * self-describing kernel `comm` names. Headless: reads /proc/<pid>/comm.
 * HOME is redirected BEFORE procName loads (ALIAS_ROOT is fixed at require time).
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/procname-sm-processes.test.cjs
 */
'use strict';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const LINUX = process.platform === 'linux' && fs.existsSync('/proc/self/comm');
const REPO = path.resolve(__dirname, '..', '..', '..');
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const commOf = (pid) => fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();

let tmpHome; let realHome; let names; let procName;

beforeAll(() => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-pn03-'));
  process.env.HOME = tmpHome;
  for (const m of ['procName', 'smProcNames']) delete require.cache[require.resolve(`../lib/${m}.cjs`)];
  procName = require('../lib/procName.cjs');
  names = require('../lib/smProcNames.cjs');
});
afterAll(() => {
  process.env.HOME = realHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function waitComm(pid, want, ms = 8000) {
  const end = Date.now() + ms;
  let last = '';
  while (Date.now() < end) {
    try { last = commOf(pid); if (last === want) return last; } catch { /* not yet */ }
    await sleepMs(50);
  }
  return last;
}

describe('names', () => {
  it('every name is <= 15 chars and distinct', () => {
    const vals = Object.values(names.PROC_NAMES);
    for (const v of vals) expect(v.length).toBeLessThanOrEqual(15);
    expect(new Set(vals).size).toBe(vals.length);
    expect(names.PROC_NAMES.main).toBe('session-manager');
    expect(names.PROC_NAMES.main.length).toBe(15);
  });
});

describe.skipIf(!LINUX)('process.title', () => {
  it('sets comm and does not disturb process.argv', () => {
    const out = execFileSync(process.execPath, ['-e', `
      const n = require(${JSON.stringify(path.join(REPO, 'src/main/lib/smProcNames.cjs'))});
      n.setProcessTitle(n.PROC_NAMES.main);
      console.log(require('fs').readFileSync('/proc/self/comm','utf8').trim() + '|' + process.argv.slice(1).join(','));
    `, 'a', '--simple'], { encoding: 'utf8', env: { ...process.env, HOME: tmpHome } }).trim();
    expect(out).toBe('session-manager|a,--simple');
  });

  it('scheduler-mcp-server.cjs reports sm-mcp-server', async () => {
    const child = spawn(process.execPath, [path.join(REPO, 'scripts/scheduler-mcp-server.cjs')], { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, HOME: tmpHome } });
    try { expect(await waitComm(child.pid, 'sm-mcp-server')).toBe('sm-mcp-server'); } finally { child.kill('SIGKILL'); }
  });

  it('scheduler-watchdog.cjs names itself before any other work (static) and the setter yields sm-watchdog', async () => {
    // Not spawned for real: a stale-heartbeat run relaunches the app via npx.
    const src = fs.readFileSync(path.join(REPO, 'scripts/scheduler-watchdog.cjs'), 'utf8');
    const first = src.indexOf('setProcessTitle(PROC_NAMES.watchdog)');
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(src.indexOf("require('node:fs')"));
    const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(path.join(REPO, 'src/main/lib/smProcNames.cjs'))}).setProcessTitle('sm-watchdog'); setTimeout(()=>{},20000)`], { stdio: 'ignore', env: { ...process.env, HOME: tmpHome } });
    try { expect(await waitComm(child.pid, 'sm-watchdog')).toBe('sm-watchdog'); } finally { child.kill('SIGKILL'); }
  });

  it('inhibit holder shell aliased to sm-inhibit-hold runs the poll loop', async () => {
    const child = spawn(names.inhibitHolderShell(), ['-c', `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done`], { stdio: 'ignore' });
    try { expect(await waitComm(child.pid, 'sm-inhibit-hold')).toBe('sm-inhibit-hold'); } finally { child.kill('SIGKILL'); }
  });

  it('bash login shell via sm-shell still sources rc files and keeps $SHELL', () => {
    const bash = ['/bin/bash', '/usr/bin/bash'].find((p) => fs.existsSync(p));
    if (!bash) return;
    const bin = names.aliasedShellBin(bash);
    expect(path.basename(bin)).toBe('sm-shell');
    fs.writeFileSync(path.join(tmpHome, '.bash_profile'), 'export SM_RC_MARK=sourced\n');
    fs.writeFileSync(path.join(tmpHome, '.bashrc'), 'export SM_RC_MARK=sourced\n');
    const r = spawnSync(bin, ['-il', '-c', 'echo "$SM_RC_MARK|$SHELL|$(cat /proc/$$/comm)"'], { encoding: 'utf8', env: { HOME: tmpHome, SHELL: bash, PATH: process.env.PATH } });
    expect(r.stdout.trim().split('\n').pop()).toBe(`sourced|${bash}|sm-shell`);
  });

  it('loadGate top-CPU line (ps comm) shows an aliased process', async () => {
    const child = spawn(names.inhibitHolderShell(), ['-c', 'while :; do :; done'], { stdio: 'ignore' });
    try {
      await waitComm(child.pid, 'sm-inhibit-hold');
      const out = execFileSync('ps', ['-eo', 'pid,pcpu,comm', '--sort=-pcpu'], { encoding: 'utf8' });
      expect(out).toMatch(new RegExp(`^\\s*${child.pid}\\s+\\S+\\s+sm-inhibit-hold$`, 'm'));
    } finally { child.kill('SIGKILL'); }
  });
});

describe('shell aliasing rules', () => {
  it('skips non-bash/zsh shells (fish, nu, unknown) and non-strings', () => {
    for (const s of ['/usr/bin/fish', '/usr/bin/nu', '/opt/weird/xsh', '', undefined]) expect(names.aliasedShellBin(s)).toBe(s);
  });
  it('aliases zsh by path basename', () => {
    const fake = path.join(tmpHome, 'zsh');
    fs.writeFileSync(fake, '#!/bin/sh\n', { mode: 0o755 });
    expect(path.basename(names.aliasedShellBin(fake))).toBe('sm-shell');
  });
  it('fails open when ALIAS_ROOT is unwritable', () => {
    fs.rmSync(procName.procnamesRoot(), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(procName.procnamesRoot()), { recursive: true });
    fs.writeFileSync(procName.procnamesRoot(), 'a file, so mkdir/symlink under it fails');
    try {
      expect(names.inhibitHolderShell()).toBe('/bin/sh');
      const bash = ['/bin/bash', '/usr/bin/bash'].find((p) => fs.existsSync(p));
      if (bash) expect(names.aliasedShellBin(bash)).toBe(bash);
    } finally { fs.rmSync(procName.procnamesRoot(), { force: true }); }
  });
});
