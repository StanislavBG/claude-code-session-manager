'use strict';

import { test, beforeAll, afterAll } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memtool-native-')));
const origHome = process.env.HOME;
process.env.HOME = tmpHome; // before memoryTool/config load: allowedRoots = homedir()

const proj = path.join(tmpHome, 'proj');
let tool;

beforeAll(() => {
  fs.mkdirSync(path.join(proj, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: proj });
  fs.writeFileSync(path.join(tmpHome, '.claude', 'agents', 'u.md'), '---\nname: u-agent\nmemory: user\n---\nbody');
  fs.writeFileSync(path.join(proj, '.claude', 'agents', 'p.md'), '---\nmemory: project\n---\nbody');
  tool = require('../memoryTool.cjs');
});

afterAll(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('workspace-only falls back to ~/.claude/projects/<ws>/memory', async () => {
  const r = await tool.resolveDir({ workspace: 'my-ws' });
  assert.equal(r.dir, path.join(tmpHome, '.claude', 'projects', 'my-ws', 'memory'));
  assert.equal(r.autoMemoryEnabled, true);
});

test('cwd resolves the native encoded git-root dir', async () => {
  const sub = path.join(proj, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  const r = await tool.resolveDir({ cwd: sub });
  assert.equal(r.dir, path.join(tmpHome, '.claude', 'projects', proj.replace(/[^a-zA-Z0-9]/g, '-'), 'memory'));
});

test('cwd + autoMemoryDirectory (and autoMemoryEnabled) come from settings', async () => {
  const custom = path.join(tmpHome, '.claude', 'custom-mem');
  fs.writeFileSync(path.join(proj, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: custom, autoMemoryEnabled: false }));
  const r = await tool.resolveDir({ cwd: proj });
  assert.equal(r.dir, custom);
  assert.equal(r.autoMemoryEnabled, false);
  const l = await tool.stale({ cwd: proj });
  assert.equal(l.error, null);
  fs.rmSync(path.join(proj, '.claude', 'settings.local.json'));
});

test('agent targets resolve per scope; missing dir lists empty', async () => {
  const u = await tool.resolveDir({ cwd: proj, agent: { name: 'u', scope: 'user' } });
  assert.equal(u.dir, path.join(tmpHome, '.claude', 'agent-memory', 'u'));
  const p = await tool.resolveDir({ cwd: proj, agent: { name: 'p', scope: 'project' } });
  assert.equal(p.dir, path.join(proj, '.claude', 'agent-memory', 'p'));
  const l = await tool.resolveDir({ cwd: proj, agent: { name: 'p', scope: 'local' } });
  assert.equal(l.dir, path.join(proj, '.claude', 'agent-memory-local', 'p'));
  await assert.rejects(() => tool.resolveDir({ cwd: proj, agent: { name: '../x', scope: 'user' } }));
});

test('write/read/list round-trip in a not-yet-existing agent dir', async () => {
  const agent = { name: 'p', scope: 'project' };
  const empty = await tool.resolveDir({ cwd: proj, agent });
  assert.ok(!fs.existsSync(empty.dir));
  const l0 = await tool.list({ cwd: proj, agent });
  assert.deepEqual(l0.entries, []);
  assert.equal(l0.error, null);
  assert.equal(l0.dir, empty.dir);
  const w = await tool.write({ cwd: proj, agent, name: 'note.md', content: 'hello' });
  assert.deepEqual(w, { ok: true, error: null });
  assert.equal(fs.readFileSync(path.join(empty.dir, 'note.md'), 'utf8'), 'hello');
  const r = await tool.read({ cwd: proj, agent, name: 'note.md' });
  assert.equal(r.content, 'hello');
  const l1 = await tool.list({ cwd: proj, agent });
  assert.deepEqual(l1.entries.map((e) => e.name), ['note.md']);
  assert.equal(l1.autoMemoryEnabled, true);
});

test('stale(): tracked-file suffix refs resolve; missing refs are stale', async () => {
  fs.mkdirSync(path.join(proj, 'src', 'renderer', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'renderer', 'lib', 'x.ts'), 'export {};');
  execFileSync('git', ['add', 'src/renderer/lib/x.ts'], { cwd: proj });
  const { dir } = await tool.resolveDir({ cwd: proj });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ok.md'), 'See `lib/x.ts` for the helper.');
  fs.writeFileSync(path.join(dir, 'dead.md'), 'See `nope/missing.ts` for details.');
  const r = await tool.stale({ cwd: proj });
  assert.equal(r.error, null);
  const byName = Object.fromEntries(r.entries.map((e) => [e.name, e]));
  assert.equal(byName['ok.md'].deadRefs.length, 0);
  assert.equal(byName['dead.md'].deadRefs.length, 1);
  assert.equal(byName['dead.md'].stale, true);
});

test('memory:agents lists user + project agents with memory scope', async () => {
  const { agents } = await tool.agents({ cwd: proj });
  const byName = Object.fromEntries(agents.map((a) => [a.name, a]));
  assert.equal(byName['u-agent'].memoryScope, 'user');
  assert.equal(byName['u-agent'].origin, 'user');
  assert.equal(byName.p.memoryScope, 'project');
  assert.equal(byName.p.origin, 'project');
});
