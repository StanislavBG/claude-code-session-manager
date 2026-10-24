const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const { selfHealDelegation, _resetForTests } = require('../delegationSelfHeal.cjs');

let home;
beforeEach(() => {
  _resetForTests();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'selfheal-'));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function mk(over = {}) {
  return {
    install: vi.fn(async () => ({ ok: true })),
    mcpRepair: vi.fn(async () => ({ ok: true })),
    writeMarker: vi.fn(),
    readSettings: vi.fn(() => null),
    log: vi.fn(),
    ...over,
  };
}
const fail = (id) => [{ id, ok: false }];

describe('selfHealDelegation', () => {
  it('installs the plugin once per process', async () => {
    const deps = mk();
    await selfHealDelegation({ checks: fail('dev-plugin'), homeDir: home, deps });
    await selfHealDelegation({ checks: fail('dev-plugin'), homeDir: home, deps });
    expect(deps.install).toHaveBeenCalledTimes(1);
    expect(deps.install).toHaveBeenCalledWith({ slug: 'session-manager-dev', marketplace: { add: 'bundled', name: 'session-manager' } });
    expect(deps.writeMarker).toHaveBeenCalledWith('dev-plugin', expect.objectContaining({ done: true }));
  });

  it('respects an explicit disable', async () => {
    const deps = mk({ readSettings: () => ({ enabledPlugins: { 'session-manager-dev@session-manager': false } }) });
    await selfHealDelegation({ checks: fail('dev-plugin'), homeDir: home, deps });
    expect(deps.install).not.toHaveBeenCalled();
  });

  it('repairs despite an exhausted marker and awaits boot seeding first', async () => {
    const order = [];
    const deps = mk({
      awaitBootSeeding: async () => { order.push('boot'); },
      install: vi.fn(async () => { order.push('install'); return { ok: true }; }),
    });
    fs.mkdirSync(path.join(home, '.claude', 'session-manager'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'session-manager', '.dev-plugin-seeded'), '{"done":false,"attempts":3}');
    await selfHealDelegation({ checks: fail('dev-plugin'), homeDir: home, deps });
    expect(order).toEqual(['boot', 'install']);
  });

  it('runs mcp repair for a failing scheduler-mcp check', async () => {
    const deps = mk();
    await selfHealDelegation({ checks: fail('scheduler-mcp'), homeDir: home, deps });
    expect(deps.mcpRepair).toHaveBeenCalledTimes(1);
    expect(deps.install).not.toHaveBeenCalled();
    expect(deps.writeMarker).toHaveBeenCalledWith('scheduler-mcp', expect.objectContaining({ done: true }));
  });

  it('logs failures and never throws', async () => {
    const deps = mk({ install: vi.fn(async () => ({ ok: false, error: 'no claude' })) });
    await expect(selfHealDelegation({ checks: fail('dev-plugin'), homeDir: home, deps })).resolves.toBeDefined();
    expect(deps.log).toHaveBeenCalledWith(expect.objectContaining({ scope: 'delegationSelfHeal' }));
    expect(deps.writeMarker).not.toHaveBeenCalled();
  });

  it('does nothing when all checks pass', async () => {
    const deps = mk();
    await selfHealDelegation({ checks: [{ id: 'dev-plugin', ok: true }, { id: 'scheduler-mcp', ok: true }], homeDir: home, deps });
    expect(deps.install).not.toHaveBeenCalled();
    expect(deps.mcpRepair).not.toHaveBeenCalled();
  });
});
