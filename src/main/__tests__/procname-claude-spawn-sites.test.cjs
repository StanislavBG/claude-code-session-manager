/**
 * procname-claude-spawn-sites.test.cjs — PRD pn-02: every `claude` spawn site
 * execs a role alias (sm-claude-job/-chat/-aux) with a labelled argv0, WITHOUT
 * breaking the four /\bclaude\b/ cmdline gates the reapers depend on.
 *
 * HOME is redirected BEFORE procName/claudeBin/scheduler load (ALIAS_ROOT is
 * computed at require time) — never the real ~/.claude. Linux-only for the
 * /proc readbacks; the stubs never touch process.cwd().
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/procname-claude-spawn-sites.test.cjs
 */
'use strict';

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HAS_PROC = process.platform === 'linux' && fs.existsSync('/proc/self/comm');

let tmpHome;
let realHome;
let realClaudeBin;
let procName;
let claudeBin;
let scheduler;
let reaper;
let cr;
let childWithLog;
let procIdentity;

beforeAll(() => {
  realHome = process.env.HOME;
  realClaudeBin = process.env.SM_CLAUDE_BIN;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-pn02-'));
  process.env.HOME = tmpHome;
  for (const m of ['procName', 'claudeBin']) {
    delete require.cache[require.resolve(`../lib/${m}.cjs`)];
  }
  procName = require('../lib/procName.cjs');
  claudeBin = require('../lib/claudeBin.cjs');
  scheduler = require('../scheduler.cjs');
  reaper = require('../lib/reaperHelpers.cjs');
  cr = require('../chatRunner.cjs');
  childWithLog = require('../lib/childWithLog.cjs');
  procIdentity = require('../lib/procIdentity.cjs');
});

afterAll(() => {
  process.env.HOME = realHome;
  if (realClaudeBin === undefined) delete process.env.SM_CLAUDE_BIN;
  else process.env.SM_CLAUDE_BIN = realClaudeBin;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
  if (cr) { cr.__resetQueueForTests(); cr.attachWindow(null); }
});

// Stub `claude`: reports its OWN comm + cmdline (+ prompt) to `capturePath`,
// emits one stream-json result and exits 0. With `linger` it stays alive so a
// test can inspect it from outside.
function writeStub({ capturePath, linger = false } = {}) {
  const stubPath = path.join(tmpHome, `stub-${Math.floor(Math.random() * 1e9)}.cjs`);
  const body = `
    const fs = require('fs');
    ${capturePath ? `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
      comm: fs.readFileSync('/proc/self/comm', 'utf8').trim(),
      cmdline: fs.readFileSync('/proc/self/cmdline', 'utf8').replace(/\\0/g, ' ').trim(),
    }));` : ''}
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
    ${linger ? 'setTimeout(() => process.exit(0), 30000);' : 'process.exit(0);'}
  `;
  fs.writeFileSync(stubPath, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return stubPath;
}

async function waitFor(fn, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

function setupProject() {
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-pn02-project-'));
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'pn02-run-'));
  return { projectCwd, runDir };
}

function writePrd(projectCwd, slug) {
  const dir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'prds');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.md`), 'do the thing', 'utf8');
}

// Regexes replicated from the live gates; the reaperHelpers functions are ALSO
// exercised for real below.
const GATE = /\bclaude\b/;

describe('claudeSpawnTarget', () => {
  it('skips aliasing entirely and returns the raw value when SM_CLAUDE_BIN is set', () => {
    process.env.SM_CLAUDE_BIN = '/tmp/some stub/with spaces';
    expect(claudeBin.claudeSpawnTarget('job', 'slug')).toEqual({ command: '/tmp/some stub/with spaces' });
  });

  it('aliases each role to its comm and labels argv0 (SM_CLAUDE_BIN unset)', () => {
    const real = writeStub();
    for (const [role, alias] of [['job', 'sm-claude-job'], ['chat', 'sm-claude-chat'], ['aux', 'sm-claude-aux']]) {
      const t = claudeBin.claudeSpawnTarget(role, 'abc', real);
      expect(path.basename(t.command)).toBe(alias);
      expect(t.argv0).toBe(`sm-claude-${role}:abc`);
      expect(fs.readlinkSync(t.command)).toBe(real);
    }
  });

  it('every real alias name and argv0 label satisfies /\\bclaude\\b/ (round-trip)', () => {
    for (const alias of ['sm-claude-job', 'sm-claude-chat', 'sm-claude-aux']) {
      expect(GATE.test(alias)).toBe(true);
      expect(GATE.test(path.join(procName.procnamesRoot(), alias))).toBe(true);
    }
    for (const role of ['job', 'chat', 'aux']) {
      expect(GATE.test(procName.smArgv0(role, 'a-slug'))).toBe(true);
      expect(GATE.test(procName.smArgv0(role, undefined))).toBe(true);
    }
  });

  it('falls back to the unchanged bin with NO argv0 when aliasing fails open', () => {
    expect(claudeBin.claudeSpawnTarget('job', 's', 'definitely-not-a-real-cmd-xyz')).toEqual({ command: 'definitely-not-a-real-cmd-xyz' });
  });
});

describe.skipIf(!HAS_PROC)('real aliased processes vs the reaper gates', () => {
  const kids = [];
  afterAll(() => { for (const k of kids) { try { process.kill(-k.pid, 'SIGKILL'); } catch { /* gone */ } } });

  function spawnAliased(role, detail, { detached = true } = {}) {
    const real = writeStub({ linger: true });
    const t = claudeBin.claudeSpawnTarget(role, detail, real);
    const child = spawn(t.command, ['-p', `prompt mentioning ${detail}`], {
      cwd: os.tmpdir(), stdio: 'ignore', detached, ...(t.argv0 ? { argv0: t.argv0 } : {}),
    });
    kids.push(child);
    return child;
  }

  const comm = (pid) => { try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return null; } };
  const cmdline = (pid) => fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');

  it('kernel comm is the alias, cmdline carries the label + slug, and all four gates match', async () => {
    const slug = `pn02-slug-${process.pid}-${Date.now()}`;
    const child = spawnAliased('job', slug);
    await waitFor(() => comm(child.pid) === 'sm-claude-job');
    const cmd = cmdline(child.pid);
    // A shebang stub's cmdline[0] is the interpreter and [1] the ALIAS PATH (the
    // kernel rewrites argv for scripts, so argv0 is not visible); a native
    // binary shows the label instead — see the ELF test below.
    expect(cmd.includes(path.join(procName.procnamesRoot(), 'sm-claude-job'))).toBe(true);
    expect(cmd.includes(slug)).toBe(true);
    // scheduler.cjs killOrphanClaudePid + reaperHelpers.cjs:31 / :105 / :107 regexes
    expect(GATE.test(cmd)).toBe(true);
    expect(reaper.claudePidAlive(child.pid)).toBe(true);
    expect(reaper.findLiveProcessForJob({ slug })).toBe(child.pid);
  });

  it('a native (ELF) binary shows the smArgv0 label as cmdline[0] and passes every gate', async () => {
    const sleepBin = ['/bin/sleep', '/usr/bin/sleep'].find((p) => fs.existsSync(p));
    if (!sleepBin) return;
    const slug = `pn02-elf-${process.pid}-${Date.now()}`;
    const t = claudeBin.claudeSpawnTarget('job', slug, sleepBin);
    const child = spawn(t.command, ['30'], { cwd: os.tmpdir(), stdio: 'ignore', detached: true, argv0: t.argv0 });
    kids.push(child);
    await waitFor(() => comm(child.pid) === 'sm-claude-job');
    const cmd = cmdline(child.pid);
    expect(cmd.startsWith(`sm-claude-job:${slug}`)).toBe(true);
    expect(GATE.test(cmd)).toBe(true);
    expect(reaper.claudePidAlive(child.pid)).toBe(true);
    expect(reaper.findLiveProcessForJob({ slug })).toBe(child.pid);
    expect(scheduler.killOrphanClaudePid(child.pid)).toBe('killed');
  });

  it('findLiveProcessForJob still finds the job by slug when the argv0 label is absent (fail-open path)', async () => {
    const slug = 'pn02-noargv0-slug';
    const real = writeStub({ linger: true });
    const child = spawn(real, ['-p', `claude prompt ${slug}`], { cwd: os.tmpdir(), stdio: 'ignore', detached: true });
    kids.push(child);
    await waitFor(() => { try { return cmdline(child.pid).includes(slug); } catch { return false; } });
    expect(reaper.findLiveProcessForJob({ slug })).toBe(child.pid);
  });

  it('killOrphanClaudePid kills an aliased process group', async () => {
    const child = spawnAliased('job', 'pn02-kill');
    await waitFor(() => comm(child.pid) === 'sm-claude-job');
    expect(scheduler.killOrphanClaudePid(child.pid)).toBe('killed');
    await waitFor(() => child.exitCode !== null || child.signalCode !== null);
  });

  it('pid-recycling migration: identity recorded pre-alias OR post-alias for the same pid never vetoes its own kill', async () => {
    // Legacy (unaliased) process, identity recorded "before", kill compared "after".
    const legacyReal = writeStub({ linger: true });
    const legacy = spawn(legacyReal, ['-p', 'claude legacy'], { cwd: os.tmpdir(), stdio: 'ignore', detached: true });
    kids.push(legacy);
    await waitFor(() => { try { return cmdline(legacy.pid).includes('legacy'); } catch { return false; } });
    const recordedLegacy = procIdentity.identity(legacy.pid);
    expect(recordedLegacy.complete).toBe(true);
    expect(scheduler.killOrphanClaudePid(legacy.pid, recordedLegacy)).toBe('killed');

    const aliased = spawnAliased('job', 'pn02-mig');
    await waitFor(() => comm(aliased.pid) === 'sm-claude-job');
    const recorded = procIdentity.identity(aliased.pid);
    expect(procIdentity.isDifferentProcess(recorded, procIdentity.identity(aliased.pid))).toBe(false);
    expect(scheduler.killOrphanClaudePid(aliased.pid, recorded)).toBe('killed');
    // A genuinely recycled pid (different cmdline/starttime) is still vetoed.
    expect(procIdentity.isDifferentProcess({ ...recorded, cmdline: '/usr/bin/claude -p old' }, { ...recorded, cmdline: 'sm-claude-job:new' })).toBe(true);
  });

  it('process-group semantics unchanged: detached child leads its own group; killTree/cancel reaps it', async () => {
    const real = writeStub({ linger: true });
    const t = claudeBin.claudeSpawnTarget('job', 'pn02-pgid', real);
    const fd = fs.openSync(path.join(tmpHome, 'pgid.log'), 'a');
    let exit = null;
    const { child } = childWithLog.withChildAndLog({
      fd, logPath: path.join(tmpHome, 'pgid.log'), safeLog() {}, closeFd() { try { fs.closeSync(fd); } catch { /* */ } },
      spawn: { command: t.command, args: ['-p', 'claude x'], options: { cwd: os.tmpdir(), detached: true, ...(t.argv0 ? { argv0: t.argv0 } : {}) } },
      onExit(info) { exit = info; },
    });
    await waitFor(() => comm(child.pid) === 'sm-claude-job');
    const stat = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8');
    const pgrp = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
    expect(pgrp).toBe(child.pid);
    process.kill(-child.pid, 'SIGTERM');
    await waitFor(() => exit);
    expect(exit.signal).toBe('SIGTERM');
    expect(exit.leakedDescendants).toEqual([]);
  });
});

describe.skipIf(!HAS_PROC)('comm assertions through the real runners', () => {
  it('executeJob: the spawned claude has comm sm-claude-job', async () => {
    const { projectCwd, runDir } = setupProject();
    try {
      const slug = `pn02-comm-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
      writePrd(projectCwd, slug);
      const capturePath = path.join(runDir, 'cap.json');
      const stub = writeStub({ capturePath });
      // SM_CLAUDE_BIN skips aliasing by design; the test aliases explicitly.
      process.env.SM_CLAUDE_BIN = procName.aliasBinFor(stub, 'sm-claude-job');
      expect(path.basename(process.env.SM_CLAUDE_BIN)).toBe('sm-claude-job');
      const result = await scheduler.executeJob({ slug, cwd: projectCwd }, runDir, projectCwd, () => Promise.resolve());
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(fs.readFileSync(capturePath, 'utf8')).comm).toBe('sm-claude-job');
    } finally {
      fs.rmSync(projectCwd, { recursive: true, force: true });
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('chatRunner: the spawned claude has comm sm-claude-chat', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-pn02-chat-'));
    try {
      const capturePath = path.join(tmpHome, 'chat-cap.json');
      const stub = writeStub({ capturePath });
      process.env.SM_CLAUDE_BIN = procName.aliasBinFor(stub, 'sm-claude-chat');
      cr.run({ tabId: 'pn02-tab', sessionId: `pn02-sess-${process.pid}`, prompt: 'hello', cwd, resume: false });
      await waitFor(() => fs.existsSync(capturePath));
      expect(JSON.parse(fs.readFileSync(capturePath, 'utf8')).comm).toBe('sm-claude-chat');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('fail-open: an unusable ALIAS_ROOT still lets the job run to completion', async () => {
    const { projectCwd, runDir } = setupProject();
    fs.rmSync(procName.procnamesRoot(), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(procName.procnamesRoot()), { recursive: true });
    fs.writeFileSync(procName.procnamesRoot(), 'not a directory'); // mkdir/symlink under it must fail
    try {
      const slug = `pn02-failopen-${process.pid}`;
      writePrd(projectCwd, slug);
      const capturePath = path.join(runDir, 'cap.json');
      const stub = writeStub({ capturePath });
      const aliased = procName.aliasBinFor(stub, 'sm-claude-job');
      expect(aliased).toBe(stub); // failed open
      process.env.SM_CLAUDE_BIN = aliased;
      const result = await scheduler.executeJob({ slug, cwd: projectCwd }, runDir, projectCwd, () => Promise.resolve());
      expect(result.exitCode).toBe(0);
      // Unaliased: comm is the stub's own basename, not an sm-claude-* name.
      expect(JSON.parse(fs.readFileSync(capturePath, 'utf8')).comm).not.toMatch(/^sm-claude-/);
      // And the target helper degrades to the raw bin with no argv0.
      delete process.env.SM_CLAUDE_BIN;
      expect(claudeBin.claudeSpawnTarget('job', slug, stub)).toEqual({ command: stub });
    } finally {
      fs.rmSync(procName.procnamesRoot(), { force: true });
      fs.rmSync(projectCwd, { recursive: true, force: true });
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });
});
