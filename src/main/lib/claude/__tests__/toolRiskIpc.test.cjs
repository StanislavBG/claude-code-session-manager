'use strict';

// Run: timeout 120 npx vitest run src/main/lib/claude/__tests__/toolRiskIpc.test.cjs

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  TOOL_RISK_GUARD_MATCHER,
  readToolRisk,
  writeToolRisk,
  registerToolRiskIpc,
} = require('../toolRiskIpc.cjs');
const { schemas, validated } = require('../../../ipcSchemas.cjs');

let tmp;
let home;
let proj;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-risk-ipc-'));
  home = path.join(tmp, 'home');
  proj = path.join(tmp, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const settingsFile = () => path.join(proj, '.claude', 'settings.json');
const readSettings = () => JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
const ourEntries = (s) => (s.hooks?.PreToolUse || []).filter((e) => (e.hooks || []).some((h) => String(h.command).includes('guard-tool-risk')));

describe('toolRisk:read', () => {
  it('missing file -> ok, exists:false, empty marks', async () => {
    const r = await readToolRisk({ scope: 'user' }, { homeDir: home });
    assert.deepEqual(r, { ok: true, path: path.join(home, '.claude', 'tool-risk.json'), exists: false, marks: {}, interactive: false });
  });

  it('valid project file', async () => {
    fs.mkdirSync(path.join(proj, '.claude'));
    fs.writeFileSync(path.join(proj, '.claude', 'tool-risk.json'), JSON.stringify({ version: 1, interactive: true, marks: { 'Bash(npm publish:*)': 'public' } }));
    const r = await readToolRisk({ scope: 'project', cwd: proj }, { homeDir: home });
    assert.equal(r.ok, true);
    assert.equal(r.exists, true);
    assert.equal(r.interactive, true);
    assert.deepEqual(r.marks, { 'Bash(npm publish:*)': 'public' });
  });

  it('invalid file -> ok:false with the toolRiskMarks error', async () => {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'tool-risk.json'), JSON.stringify({ version: 1, marks: { 'mcp__x__y': 'scary' } }));
    const r = await readToolRisk({ scope: 'user' }, { homeDir: home });
    assert.equal(r.ok, false);
    assert.equal(r.exists, true);
    assert.match(r.error, /unknown mark "scary"/);
  });

  it('project scope without cwd is refused', async () => {
    const r = await readToolRisk({ scope: 'project' }, { homeDir: home });
    assert.equal(r.ok, false);
    assert.match(r.error, /absolute cwd/);
  });
});

describe('toolRisk:write', () => {
  it('refuses invalid marks with the toolRiskMarks error text and writes nothing', async () => {
    const r = await writeToolRisk({ scope: 'user', marks: { 'not a rule': 'public' } }, { homeDir: home });
    assert.equal(r.ok, false);
    assert.match(r.error, /marks key "not a rule" is not a valid rule/);
    assert.equal(fs.existsSync(path.join(home, '.claude', 'tool-risk.json')), false);
  });

  it('refuses interactive for scope user', async () => {
    const r = await writeToolRisk({ scope: 'user', marks: {}, interactive: false }, { homeDir: home });
    assert.equal(r.ok, false);
    assert.match(r.error, /Project-only/);
    assert.equal(fs.existsSync(path.join(home, '.claude', 'tool-risk.json')), false);
  });

  it('writes a valid user layer', async () => {
    const r = await writeToolRisk({ scope: 'user', marks: { 'mcp__gmail__send': 'public' } }, { homeDir: home });
    assert.equal(r.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(r.path, 'utf8')), { version: 1, marks: { 'mcp__gmail__send': 'public' } });
  });

  it('settings.json install/remove round trip keeps other keys and hooks', async () => {
    fs.mkdirSync(path.join(proj, '.claude'));
    const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /x/other-hook.cjs' }] };
    fs.writeFileSync(settingsFile(), JSON.stringify({ model: 'opus', hooks: { PreToolUse: [other], Stop: [] } }));

    const on = await writeToolRisk({ scope: 'project', cwd: proj, marks: { 'Bash(git push:*)': 'public' }, interactive: true }, { homeDir: home });
    assert.equal(on.ok, true, on.error);
    let s = readSettings();
    assert.equal(s.model, 'opus');
    assert.deepEqual(s.hooks.Stop, []);
    assert.deepEqual(s.hooks.PreToolUse[0], other);
    const mine = ourEntries(s);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].matcher, TOOL_RISK_GUARD_MATCHER);
    assert.equal(mine[0].matcher, 'Bash|Write|Edit|NotebookEdit|mcp__.*');
    assert.equal(mine[0].hooks.length, 1);
    assert.equal(mine[0].hooks[0].type, 'command');
    assert.ok(mine[0].hooks[0].command.includes(path.join(home, '.claude', 'session-manager', 'hooks', 'guard-tool-risk.cjs')));
    assert.ok(fs.existsSync(path.join(home, '.claude', 'session-manager', 'hooks', 'guard-tool-risk.cjs')));
    const marksFile = JSON.parse(fs.readFileSync(on.path, 'utf8'));
    assert.equal(marksFile.interactive, true);

    // Idempotent: a second on-write adds nothing; an omitted interactive keeps true.
    await writeToolRisk({ scope: 'project', cwd: proj, marks: {}, interactive: true }, { homeDir: home });
    await writeToolRisk({ scope: 'project', cwd: proj, marks: {} }, { homeDir: home });
    s = readSettings();
    assert.equal(ourEntries(s).length, 1);
    assert.equal(ourEntries(s)[0].hooks.length, 1);
    assert.equal(s.hooks.PreToolUse.length, 2);
    assert.equal((await readToolRisk({ scope: 'project', cwd: proj }, { homeDir: home })).interactive, true);

    const off = await writeToolRisk({ scope: 'project', cwd: proj, marks: {}, interactive: false }, { homeDir: home });
    assert.equal(off.ok, true, off.error);
    s = readSettings();
    assert.deepEqual(s, { model: 'opus', hooks: { PreToolUse: [other], Stop: [] } });
    assert.equal((await readToolRisk({ scope: 'project', cwd: proj }, { homeDir: home })).interactive, false);
  });

  it('refuses a project hook change over unparseable settings.json', async () => {
    fs.mkdirSync(path.join(proj, '.claude'));
    fs.writeFileSync(settingsFile(), '{ nope');
    const r = await writeToolRisk({ scope: 'project', cwd: proj, marks: {}, interactive: true }, { homeDir: home });
    assert.equal(r.ok, false);
    assert.match(r.error, /not valid JSON/);
    assert.equal(fs.readFileSync(settingsFile(), 'utf8'), '{ nope');
  });
});

describe('registerToolRiskIpc', () => {
  function register() {
    const handlers = {};
    const changed = [];
    registerToolRiskIpc({ handle: (ch, fn) => { handlers[ch] = fn; } }, { schemas, validated, homeDir: home, onChanged: (i) => changed.push(i) });
    return { handlers, changed };
  }

  it('registers both channels with strict schemas', async () => {
    const { handlers, changed } = register();
    assert.deepEqual(Object.keys(handlers).sort(), ['toolRisk:read', 'toolRisk:write']);
    await assert.rejects(async () => handlers['toolRisk:read']({}, { scope: 'user', extra: 1 }));
    await assert.rejects(async () => handlers['toolRisk:write']({}, { scope: 'system', marks: {} }));
    const w = await handlers['toolRisk:write']({}, { scope: 'user', marks: { 'mcp__a__b': 'money' } });
    assert.equal(w.ok, true);
    assert.equal(changed.length, 1);
    const r = await handlers['toolRisk:read']({}, { scope: 'user' });
    assert.deepEqual(r.marks, { 'mcp__a__b': 'money' });
  });
});
