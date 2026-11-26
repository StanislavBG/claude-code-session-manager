const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('architect seed → snapshot → chat gear args', () => {
  it('carries session-manager-scheduler and does not deny develop/send-feedback', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'snapgear-'));
    const { buildAgentSnapshot } = require('../agentSnapshot.cjs');
    const { gearChatArgs } = require('../../../chatRunner.cjs');
    const seedPath = path.join(__dirname, '../../../../seed/agents/architect.md');
    const text = fs.readFileSync(seedPath, 'utf8');
    const fmText = text.split('---')[1] || '';
    const fm = {};
    for (const line of fmText.split('\n')) {
      const m = /^([A-Za-z]+):\s*(.*)$/.exec(line);
      if (m) fm[m[1]] = m[2].trim();
    }
    const tools = fm.tools.split(',').map((t) => t.trim());
    const { id, snapshot, refusal } = await buildAgentSnapshot({
      cwd,
      agentType: 'architect',
      packs: [],
      deps: {
        resolvePrdPersonaForSpawn: async () => ({ refusal: null, systemPrompt: 'x', model: 'opus', tools }),
        resolveEpicEffort: () => ({ effort: 'medium' }),
        readOverlayAwarePersona: () => ({ fm }),
        loadEnvironment: () => ({ id: 'open-web', hash: 'h' }),
      },
    });
    expect(refusal).toBeNull();
    expect(id).toBeTruthy();
    expect(snapshot.mcpServers).toContain('session-manager-scheduler');
    expect(snapshot.packs).toContain('session-manager-dev');

    const gear = gearChatArgs({
      snapshot,
      deps: {
        knownMcpServers: { 'session-manager-scheduler': { command: 'node', args: [] } },
        listPacks: () => ({ packs: [{ id: 'session-manager-dev', skills: ['session-manager-dev:develop', 'session-manager-dev:send-feedback'] }] }),
        listUnpackedSkills: () => [],
        log: () => {},
      },
    });
    const joined = gear.args.join('\n');
    expect(joined).toContain('session-manager-scheduler');
    expect(joined).toContain('--strict-mcp-config');
    expect(joined).not.toContain('Skill(session-manager-dev:develop)');
    expect(joined).not.toContain('Skill(session-manager-dev:send-feedback)');
  });
});
