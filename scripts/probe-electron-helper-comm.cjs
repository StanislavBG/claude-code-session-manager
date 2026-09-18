#!/usr/bin/env node
/**
 * Probe: do Electron helper processes inherit the comm of a symlink alias the main
 * process was exec'd through? Launches a MINIMAL throwaway Electron app (never the
 * Session Manager app itself — a second SM instance clobbers live scheduler jobs)
 * under xvfb-run, once via the real binary and once via a `session-manager` alias,
 * then walks /proc PPID chains and prints a comm table. Linux only.
 *   node scripts/probe-electron-helper-comm.cjs
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const electronBin = require('electron');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-comm-probe-'));
fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"probeapp","main":"main.js"}');
fs.writeFileSync(path.join(dir, 'main.js'),
  "const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({show:true});w.loadURL('data:text/html,<h1>hi</h1>');setTimeout(()=>app.quit(),9000);});");

function procs() {
  const out = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const m = stat.match(/^\d+ \((.*)\) \S+ (\d+)/s);
      const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split(/[\0 ]/);
      const arg = (pre) => cmd.find((a) => a.startsWith(pre));
      const sub = arg('--utility-sub-type=');
      const type = (arg('--type=') || '--type=main').slice(7) + (sub ? ':' + sub.slice(19).split('.').pop() : '');
      out.set(Number(d), { comm: m[1], ppid: Number(m[2]), type });
    } catch { /* raced exit */ }
  }
  return out;
}

function run(label, bin) {
  return new Promise((resolve) => {
    const child = spawn('xvfb-run', ['-a', bin, '--no-sandbox', dir], { stdio: 'ignore' });
    const seen = new Map();
    let rootPid = null;
    const t = setInterval(() => {
      const all = procs();
      if (rootPid == null) {
        const root = [...all].find(([, p]) => /^(electron|session-manager)$/.test(p.comm) && all.get(p.ppid) && all.get(p.ppid).comm === 'xvfb-run');
        if (!root) return;
        rootPid = root[0];
      }
      seen.clear(); // re-snapshot each tick: helpers fork (inheriting main's cmdline) before they exec
      const stack = [rootPid];
      while (stack.length) {
        const pid = stack.pop();
        if (all.has(pid)) seen.set(pid, all.get(pid));
        for (const [c, p] of all) if (p.ppid === pid) stack.push(c);
      }
    }, 300);
    child.on('close', () => {
      clearInterval(t);
      console.log(`\n== ${label} (${bin}) ==`);
      const rows = new Map();
      for (const p of seen.values()) rows.set(`${p.type}\t${p.comm}`, (rows.get(`${p.type}\t${p.comm}`) || 0) + 1);
      for (const [k, n] of rows) console.log(`${k}\t x${n}`);
      resolve(seen);
    });
  });
}

(async () => {
  const aliasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-alias-'));
  const alias = path.join(aliasDir, 'session-manager');
  fs.symlinkSync(fs.realpathSync(electronBin), alias);
  await run('before (real binary)', electronBin);
  const after = await run('after (alias)', alias);
  const inherited = [...after.values()].filter((p) => p.type !== 'main' && p.comm === 'session-manager').length;
  console.log(`\nhelpers inheriting 'session-manager': ${inherited}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(aliasDir, { recursive: true, force: true });
})();
