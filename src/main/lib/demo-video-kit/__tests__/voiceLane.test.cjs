/**
 * voiceLane.test.cjs — cross-process voice lane: FIFO across two child
 * processes, heavy/light independence, dead-pid + stale sweep, timeout, usage.
 * Run: timeout 120 npx vitest run src/main/lib/demo-video-kit/__tests__/voiceLane.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const LANE_MODULE = path.join(__dirname, '..', 'voiceLane.cjs');
const lane = require(LANE_MODULE);

let root;
const prevEnv = {};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-voicelane-'));
  for (const k of ['SM_VOICE_LANE_DIR', 'SM_VOICES_HOME']) prevEnv[k] = process.env[k];
  process.env.SM_VOICES_HOME = path.join(root, 'voices');
  process.env.SM_VOICE_LANE_DIR = path.join(root, 'lane');
});
afterEach(() => {
  for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(root, { recursive: true, force: true });
});

const TICKET_RE = /^\d{15}-\d+-[0-9a-f]{6}\.json$/;

function laneFiles(name) {
  try { return fs.readdirSync(path.join(process.env.SM_VOICE_LANE_DIR, name)).filter((f) => f.endsWith('.json')); } catch { return []; }
}

function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', timeout: 20000 });
  return Number(r.stdout);
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function runChild(voiceId) {
  const src = `
    const lane = require(${JSON.stringify(LANE_MODULE)});
    const t = lane.enterLane({ lane: 'heavy', voiceId: ${JSON.stringify(voiceId)}, label: ${JSON.stringify(voiceId)}, projectRoot: '/proj/x', kind: 'line' });
    const positions = [];
    const r = lane.waitTurn(t, { timeoutMs: 20000, pollMs: 25, onPosition: (p) => positions.push(p.position) });
    const start = Date.now();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    const end = Date.now();
    lane.leaveLane(t, { ok: true, audioSeconds: 1.5 });
    process.stdout.write(JSON.stringify({ ok: r.ok, positions, start, end }));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', src], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`child ${voiceId} timed out: ${err}`)); }, 20000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`child ${voiceId} exit ${code}: ${err}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(`child ${voiceId} bad output ${out} ${err}`)); }
    });
  });
}

test('exports the lane API', () => {
  for (const k of ['laneFor', 'enterLane', 'lanePosition', 'waitTurn', 'leaveLane', 'laneSnapshot', 'readUsage']) {
    expect(typeof lane[k]).toBe('function');
  }
});

test('requires only node built-ins and the sibling voiceLibrary (both ship in the kit)', () => {
  const src = fs.readFileSync(LANE_MODULE, 'utf8');
  const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  expect(reqs.length).toBeGreaterThan(0);
  for (const r of reqs) expect(r.startsWith('node:') || r === './voiceLibrary.cjs').toBe(true);
});

test('laneFor: entry.heavy wins, else kokoro is light and everything else heavy', () => {
  expect(lane.laneFor({ engine: 'kokoro' })).toBe('light');
  expect(lane.laneFor({ engine: 'chatterbox' })).toBe('heavy');
  expect(lane.laneFor({})).toBe('heavy');
  expect(lane.laneFor({ engine: 'kokoro' }, { heavy: true })).toBe('heavy');
  expect(lane.laneFor({ engine: 'xtts' }, { heavy: false })).toBe('light');
});

test('enterLane writes one well-named ticket; lane dir falls back to <voices home>/lane', () => {
  delete process.env.SM_VOICE_LANE_DIR;
  const t = lane.enterLane({ lane: 'heavy', voiceId: 'v1', label: 'Voice 1', projectRoot: '/p', kind: 'line' });
  const dir = path.join(process.env.SM_VOICES_HOME, 'lane', 'heavy');
  const files = fs.readdirSync(dir);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(TICKET_RE);
  expect(files[0]).toContain(`-${process.pid}-`);
  const body = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  expect(body).toMatchObject({ voiceId: 'v1', label: 'Voice 1', projectRoot: '/p', kind: 'line' });
  expect(typeof body.since).toBe('string');
  lane.leaveLane(t, { ok: true, record: false });
  expect(fs.readdirSync(dir)).toHaveLength(0);
});

test('two child processes: the second heavy holder starts only after the first leaves and saw position 1', async () => {
  const first = runChild('first');
  // Wait (bounded) until the first child's ticket exists, so order is fixed.
  const deadline = Date.now() + 20000;
  while (laneFiles('heavy').length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  expect(laneFiles('heavy').length).toBe(1);
  const second = runChild('second');
  const [a, b] = await Promise.all([first, second]);
  expect(a.ok).toBe(true);
  expect(b.ok).toBe(true);
  expect(a.positions[0]).toBe(0);
  expect(b.positions).toContain(1);
  expect(b.positions[b.positions.length - 1]).toBe(0);
  expect(b.start).toBeGreaterThanOrEqual(a.end);
  expect(laneFiles('heavy')).toEqual([]);
  const usage = lane.readUsage({ projectRoot: '/proj/x', limit: 10 });
  expect(usage.map((u) => u.voiceId)).toEqual(['second', 'first']);
  expect(usage[0]).toMatchObject({ lane: 'heavy', kind: 'line', ok: true, audioSeconds: 1.5, projectRoot: '/proj/x' });
  expect(usage[0].waitedMs).toBeGreaterThan(0);
  expect(usage[0].wallMs).toBeGreaterThanOrEqual(250);
}, 30000);

test('a light ticket does not wait behind a heavy one', () => {
  const heavy = lane.enterLane({ lane: 'heavy', voiceId: 'h', projectRoot: '/p' });
  const light = lane.enterLane({ lane: 'light', voiceId: 'l', projectRoot: '/p' });
  expect(lane.lanePosition(heavy).position).toBe(0);
  expect(lane.lanePosition(light)).toMatchObject({ position: 0, total: 1, ahead: [] });
  const r = lane.waitTurn(light, { timeoutMs: 2000, pollMs: 20 });
  expect(r.ok).toBe(true);
  const snap = lane.laneSnapshot();
  expect(snap.heavy.map((s) => s.voiceId)).toEqual(['h']);
  expect(snap.light.map((s) => s.voiceId)).toEqual(['l']);
  expect(snap.heavy[0]).toMatchObject({ projectRoot: '/p', pid: process.pid, position: 0 });
  lane.leaveLane(light, { ok: true, audioSeconds: 0.5 });
  lane.leaveLane(heavy, { ok: false });
  expect(lane.laneSnapshot()).toEqual({ heavy: [], light: [] });
});

test('dead-pid and >6 h tickets are swept; ahead lists live holders', () => {
  const dir = path.join(process.env.SM_VOICE_LANE_DIR, 'heavy');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const pad = (n) => String(n).padStart(15, '0');
  const dead = `${pad(now - 5000)}-${deadPid()}-aaaaaa.json`;
  const stale = `${pad(now - 7 * 3600 * 1000)}-${process.pid}-bbbbbb.json`;
  const live = `${pad(now - 1000)}-${process.pid}-cccccc.json`;
  fs.writeFileSync(path.join(dir, dead), JSON.stringify({ voiceId: 'dead' }));
  fs.writeFileSync(path.join(dir, stale), JSON.stringify({ voiceId: 'stale' }));
  fs.writeFileSync(path.join(dir, live), JSON.stringify({ voiceId: 'live', label: 'Live one', since: 'x' }));
  const t = lane.enterLane({ lane: 'heavy', voiceId: 'me' });
  const p = lane.lanePosition(t);
  expect(p.position).toBe(1);
  expect(p.total).toBe(2);
  expect(p.ahead).toEqual([{ voiceId: 'live', label: 'Live one', since: 'x' }]);
  expect(fs.existsSync(path.join(dir, dead))).toBe(false);
  expect(fs.existsSync(path.join(dir, stale))).toBe(false);
  expect(fs.existsSync(path.join(dir, live))).toBe(true);
  lane.leaveLane(t, { record: false });
});

test('timeout leaves the lane and names the position', () => {
  const holder = lane.enterLane({ lane: 'heavy', voiceId: 'holder' });
  const waiter = lane.enterLane({ lane: 'heavy', voiceId: 'waiter' });
  const seen = [];
  const t0 = Date.now();
  const r = lane.waitTurn(waiter, { timeoutMs: 300, pollMs: 50, onPosition: (p) => seen.push(p.position) });
  expect(Date.now() - t0).toBeLessThan(5000);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/position 1/);
  expect(seen).toEqual([1]);
  expect(laneFiles('heavy')).toHaveLength(1);
  expect(() => lane.waitTurn(holder, {})).toThrow(/timeoutMs/);
  lane.leaveLane(holder, { record: false });
});

test('usage rotates past 2 MB and readUsage filters by project, newest first', () => {
  const home = process.env.SM_VOICES_HOME;
  fs.mkdirSync(home, { recursive: true });
  const old = JSON.stringify({ at: '2026-01-01T00:00:00.000Z', voiceId: 'old', projectRoot: '/a' }) + '\n';
  fs.writeFileSync(path.join(home, 'usage.jsonl'), old + 'x'.repeat(2 * 1024 * 1024 + 10) + '\n');
  const t1 = lane.enterLane({ lane: 'light', voiceId: 'a1', projectRoot: '/a' });
  lane.leaveLane(t1, { ok: true, audioSeconds: 2 });
  expect(fs.existsSync(path.join(home, 'usage.1.jsonl'))).toBe(true);
  sleepSync(5);
  const t2 = lane.enterLane({ lane: 'light', voiceId: 'b1', projectRoot: '/b' });
  lane.leaveLane(t2, { ok: true });
  const t3 = lane.enterLane({ lane: 'light', voiceId: 'a2', projectRoot: '/a' });
  lane.leaveLane(t3, { ok: false });
  expect(lane.readUsage({ projectRoot: '/a' }).map((u) => u.voiceId)).toEqual(['a2', 'a1', 'old']);
  expect(lane.readUsage({ projectRoot: '/a', limit: 1 }).map((u) => u.voiceId)).toEqual(['a2']);
  const line = lane.readUsage({ projectRoot: '/a' })[1];
  expect(Object.keys(line).sort()).toEqual(['at', 'audioSeconds', 'kind', 'lane', 'ok', 'projectRoot', 'voiceId', 'waitedMs', 'wallMs'].sort());
});
