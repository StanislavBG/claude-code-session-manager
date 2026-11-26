'use strict';

const { buildArmory } = require('../agentArmory.cjs');

const marks = { system: { ok: true, marks: { 'mcp__pay__*': 'money' }, interactive: false }, project: null };
const baseDeps = (over = {}) => ({
  getBuiltinTools: async () => ({ tools: ['Read', 'Agent', 'Bash'], skills: ['loop'] }),
  listPacks: () => ({ packs: [{ id: 'p1', label: 'P1', source: 'shipped', skills: ['a', 'b'] }], errors: [] }),
  listUnpackedSkills: () => ['loose'],
  listMcpServers: async () => [{ name: 'pay', scope: 'user' }, { name: 'bad', scope: 'project' }, { name: 'new', scope: 'plugin' }],
  getMcpProbe: async ({ name }) => (name === 'pay' ? { ok: true, tools: [{ name: 'charge' }] } : name === 'bad' ? { ok: false } : null),
  loadMarks: () => marks,
  bannedTools: ['Bash'],
  ...over,
});

describe('buildArmory', () => {
  it('covers every group and badge kind', async () => {
    const r = await buildArmory({ cwd: '/x', deps: baseDeps() });
    expect(r.errors).toEqual([]);
    expect(r.builtins).toEqual([
      { id: 'Read', label: 'Read', badges: [] },
      { id: 'Agent', label: 'Agent', badges: ['floor'] },
      { id: 'Bash', label: 'Bash', badges: ['banned'] },
    ]);
    expect(r.bundledSkills).toEqual([{ id: 'loop', label: 'loop', badges: [] }]);
    expect(r.packs).toEqual([{ id: 'p1', label: 'P1', badges: [], skills: ['a', 'b'], source: 'shipped' }]);
    expect(r.unpackedSkills).toEqual(['loose']);
    expect(r.mcpServers.map((s) => [s.id, s.status, s.scope])).toEqual([['pay', 'checked', 'user'], ['bad', 'failing', 'project'], ['new', 'not-checked', 'plugin']]);
    expect(r.mcpServers[0].tools).toEqual([{ id: 'mcp__pay__charge', label: 'charge', badges: ['risky'] }]);
    expect(r.mcpServers[1].tools).toEqual([]);
  });

  it('a failing source records an error and empties only that group', async () => {
    const r = await buildArmory({ cwd: '/x', deps: baseDeps({ listPacks: () => { throw new Error('boom'); } }) });
    expect(r.packs).toEqual([]);
    expect(r.errors).toEqual([expect.stringContaining('packs: boom')]);
    expect(r.builtins).toHaveLength(3);
  });

  it('serves environment profiles; a failure adds to errors', async () => {
    const ok = await buildArmory({ cwd: '/x', deps: baseDeps() });
    expect(ok.environments.map((e) => e.name)).toEqual(expect.arrayContaining(['headless-default', 'validator-readonly', 'open-web']));
    expect(typeof ok.environments[0].summary).toBe('string');
    const bad = await buildArmory({ cwd: '/x', deps: baseDeps({ listEnvironments: () => { throw new Error('envboom'); } }) });
    expect(bad.environments).toEqual([]);
    expect(bad.errors).toEqual([expect.stringContaining('environments: envboom')]);
  });

  it('never throws when every source fails', async () => {
    const bad = () => { throw new Error('x'); };
    const r = await buildArmory({ cwd: '/x', deps: { getBuiltinTools: bad, listPacks: bad, listUnpackedSkills: bad, listMcpServers: bad, loadMarks: bad } });
    expect(r.builtins).toEqual([]);
    expect(r.mcpServers).toEqual([]);
    expect(r.errors.length).toBe(5);
  });
});

describe('buildArmory default probe', () => {
  it('defaults getMcpProbe to mcpToolsProbe.lastProbe', async () => {
    const probe = require('../../mcpToolsProbe.cjs');
    const { getMcpProbe, ...rest } = baseDeps();
    const run = () => buildArmory({ cwd: '/x', deps: { ...rest, listMcpServers: async () => [{ name: 'zz', scope: 'plugin' }] } });
    expect((await run()).mcpServers[0].status).toBe('not-checked');
    const check = async () => ({ ok: true, status: 'connected', tools: [{ name: 't' }], checkedAt: 1 });
    // seed through the real writer with a stubbed plugin resolution
    const pluginInstall = require('../../../pluginInstall.cjs');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'armory-plug-'));
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { zz: { command: 'x' } } }));
    const spy = vi.spyOn(pluginInstall, 'listInstalled').mockReturnValue([{ key: 'k@m', installPath: root }]);
    await probe.checkConfiguredMcpServer({ source: 'plugin', name: 'zz', pluginKey: 'k@m' }, { home: root, check });
    spy.mockRestore();
    const r = await run();
    expect(r.mcpServers[0]).toMatchObject({ status: 'checked', scope: 'plugin' });
    expect(r.mcpServers[0].tools[0].id).toBe('mcp__zz__t');
  });
});
